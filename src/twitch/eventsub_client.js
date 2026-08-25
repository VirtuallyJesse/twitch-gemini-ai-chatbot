// src/twitch/eventsub_client.js
//
// Deep module owning Twitch EventSub WebSocket lifecycle, event normalization,
// message deduplication, and Helix subscription synchronization. Two session
// families share one private WebSocket engine: isolated per-broadcaster
// sessions for alert events (broadcaster tokens) and one shared bot-token
// session observing `channel.chat.message` across every joined channel.
// Pure dependencies: reads zero process.env.

const cleanName = (value) => String(value || '').replace('#', '').trim().toLowerCase();
const channelKey = (channel) => `#${cleanName(channel)}`;

function asText(data) {
    if (typeof data === 'string') return data;
    if (data instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(data))) {
        return data.toString('utf8');
    }
    if (data && typeof data.toString === 'function') return data.toString();
    return String(data ?? '');
}

function bindSocket(ws, { onMessage, onClose, onError, onOpen }) {
    if (typeof ws.on === 'function') {
        ws.on('open', () => onOpen?.());
        ws.on('message', (data) => onMessage(asText(data)));
        ws.on('close', () => onClose());
        ws.on('error', (err) => onError(err));
        return;
    }
    ws.onopen = () => onOpen?.();
    ws.onmessage = (event) => onMessage(asText(event?.data ?? event));
    ws.onclose = () => onClose();
    ws.onerror = (err) => onError(err);
}

function actorFrom(event, { anonymous = false, prefix = 'user' } = {}) {
    if (anonymous) return { id: '', login: 'anonymous', displayName: 'Anonymous' };
    return {
        id: event[`${prefix}_id`] || '',
        login: event[`${prefix}_login`] || '',
        displayName: event[`${prefix}_name`] || event[`${prefix}_login`] || ''
    };
}

function mapTier(tier) {
    const value = String(tier || '');
    if (value === '1000') return 'Tier 1';
    if (value === '2000') return 'Tier 2';
    if (value === '3000') return 'Tier 3';
    if (value.toLowerCase() === 'prime') return 'Prime';
    return value || 'Tier 1';
}

function normalizeNotification(message, nowFn) {
    const metadata = message?.metadata || {};
    const payload = message?.payload || {};
    const event = payload.event || {};
    const type = metadata.subscription_type || payload.subscription?.type;
    const id = String(metadata.message_id || '');
    if (!id || !type) return null;

    const occurredAt = Date.parse(metadata.message_timestamp) || nowFn();
    const channel = channelKey(event.broadcaster_user_login || event.to_broadcaster_user_login);
    const broadcasterUserId = event.broadcaster_user_id || event.to_broadcaster_user_id || '';
    const base = { id, channel, broadcasterUserId, occurredAt };

    switch (type) {
        case 'channel.subscribe': {
            if (event.is_gift) {
                return null;
            }
            const user = actorFrom(event);
            return { ...base, kind: 'subscription', user, details: { tier: mapTier(event.tier) } };
        }
        case 'channel.subscription.message':
            return {
                ...base,
                kind: 'resub',
                user: actorFrom(event),
                details: {
                    tier: mapTier(event.tier),
                    months: Number(event.cumulative_months) || 0,
                    streak: Number(event.streak_months) || 0,
                    message: event.message?.text || ''
                }
            };
        case 'channel.subscription.gift': {
            const count = Number(event.total) || 1;
            const recipient = (event.recipient_user_id || event.recipient_user_name || event.recipient_user_login)
                ? actorFrom(event, { prefix: 'recipient_user' })
                : undefined;
            return {
                ...base,
                kind: count > 1 ? 'community_sub_gift' : 'sub_gift',
                user: actorFrom(event, { anonymous: !!event.is_anonymous }),
                details: {
                    tier: mapTier(event.tier),
                    count,
                    ...(recipient ? { recipient } : {})
                }
            };
        }
        case 'channel.cheer':
            return {
                ...base,
                kind: 'cheer',
                user: actorFrom(event, { anonymous: !!event.is_anonymous }),
                details: { bits: Number(event.bits) || 0, message: event.message || '' }
            };
        case 'channel.channel_points_custom_reward_redemption.add':
            return {
                ...base,
                kind: 'channel_points',
                user: actorFrom(event),
                details: {
                    reward: {
                        id: event.reward?.id || '',
                        title: event.reward?.title || '',
                        cost: Number(event.reward?.cost) || 0,
                        userInput: event.user_input || ''
                    }
                }
            };
        case 'channel.raid':
            return {
                ...base,
                kind: 'raid',
                channel: channelKey(event.to_broadcaster_user_login),
                broadcasterUserId: event.to_broadcaster_user_id || '',
                user: actorFrom(event, { prefix: 'from_broadcaster_user' }),
                details: { viewers: Number(event.viewers) || 0 }
            };
        case 'channel.follow':
            return { ...base, kind: 'follow', user: actorFrom(event), details: {} };
        default:
            return null;
    }
}

const SUBSCRIPTION_SPECS = [
    { type: 'channel.subscribe', version: '1', condition: (id) => ({ broadcaster_user_id: id }) },
    { type: 'channel.subscription.gift', version: '1', condition: (id) => ({ broadcaster_user_id: id }) },
    { type: 'channel.subscription.message', version: '1', condition: (id) => ({ broadcaster_user_id: id }) },
    { type: 'channel.cheer', version: '1', condition: (id) => ({ broadcaster_user_id: id }) },
    {
        type: 'channel.channel_points_custom_reward_redemption.add',
        version: '1',
        condition: (id) => ({ broadcaster_user_id: id })
    },
    { type: 'channel.raid', version: '1', condition: (id) => ({ to_broadcaster_user_id: id }) },
    {
        type: 'channel.follow',
        version: '2',
        condition: (id, modId) => ({ broadcaster_user_id: id, moderator_user_id: modId || id })
    }
];

const BOT_CHAT_SUBSCRIPTION_TYPE = 'channel.chat.message';
const BOT_CHAT_SUBSCRIPTION_VERSION = '1';

/**
 * Normalizes a bot-session `channel.chat.message` notification into the
 * transport's uniform observation shape. Emote ranges are synthesized from
 * message fragments (fragment text concatenates to the full text), mirroring
 * the IRC tags.emotes shape so downstream processing stays single-path.
 */
function normalizeBotChatMessage(message, nowFn) {
    const metadata = message?.metadata || {};
    if (metadata.subscription_type !== BOT_CHAT_SUBSCRIPTION_TYPE) return null;
    const event = message?.payload?.event || {};

    // Canonical identity is Twitch's own chat message id; the envelope's
    // delivery id exists only for notification deduplication and must never
    // stand in for it.
    const id = String(event.message_id || '');
    if (!id) {
        console.warn('[EventSub] Dropping bot chat notification without event.message_id');
        return null;
    }

    const occurredAt = Date.parse(metadata.message_timestamp) || nowFn();
    const text = String(event.message?.text ?? '');

    const emotes = {};
    let offset = 0;
    const fragments = Array.isArray(event.message?.fragments) ? event.message.fragments : [];
    for (const fragment of fragments) {
        const length = String(fragment?.text ?? '').length;
        if (fragment?.type === 'emote' && fragment.emote?.id && length > 0) {
            (emotes[fragment.emote.id] ||= []).push(`${offset}-${offset + length - 1}`);
        }
        offset += length;
    }

    return {
        kind: 'chat_message',
        id,
        channel: channelKey(event.broadcaster_user_login),
        loginName: cleanName(event.chatter_user_login),
        username: event.chatter_user_name || event.chatter_user_login || '',
        text,
        timestamp: occurredAt,
        chatterUserId: String(event.chatter_user_id || ''),
        authoredByBot: true,
        tags: {
            emotes,
            badges: Array.isArray(event.badges) ? event.badges : [],
            color: typeof event.color === 'string' ? event.color : '',
            'display-name': event.chatter_user_name || ''
        }
    };
}

/**
 * Private WebSocket engine shared by every session family: welcome handshake,
 * keepalive watchdog, reconnect-url resume, and backoff reconnection.
 * Policy hooks: `onNotification` receives raw notification envelopes and
 * `onResubscribe` fires after an unexpected (non-resume) re-welcome so owners
 * can re-apply their Helix subscriptions against the new session.
 */
class WebSocketSession {
    #wsImpl;
    #setTimeoutFn;
    #clearTimeoutFn;
    #wsUrl;
    #welcomeTimeoutMs;
    #keepaliveGraceMs;
    #reconnectBaseMs;
    #reconnectMaxMs;
    #isStopped;
    #onNotification;
    #onResubscribe;

    #socket = null;
    #sessionId = null;
    #connectPromise = null;
    #connectResolve = null;
    #connectReject = null;
    #welcomeTimer = null;
    #keepaliveTimer = null;
    #keepaliveSec = 10;
    #reconnectTimer = null;
    #reconnectAttempt = 0;
    #hadLiveSession = false;
    #halted = false;

    constructor({
        wsImpl,
        nowFn,
        setTimeoutFn,
        clearTimeoutFn,
        wsUrl,
        welcomeTimeoutMs,
        keepaliveGraceMs,
        reconnectBaseMs,
        reconnectMaxMs,
        isStopped,
        onNotification,
        onResubscribe
    }) {
        this.#wsImpl = wsImpl;
        this.#setTimeoutFn = setTimeoutFn;
        this.#clearTimeoutFn = clearTimeoutFn;
        this.#wsUrl = wsUrl;
        this.#welcomeTimeoutMs = welcomeTimeoutMs;
        this.#keepaliveGraceMs = keepaliveGraceMs;
        this.#reconnectBaseMs = reconnectBaseMs;
        this.#reconnectMaxMs = reconnectMaxMs;
        this.#isStopped = isStopped;
        this.#onNotification = onNotification;
        this.#onResubscribe = onResubscribe;
    }

    get sessionId() {
        return this.#sessionId;
    }

    get connected() {
        return Boolean(this.#socket && this.#sessionId);
    }

    /**
     * Permanently stops this session: closes the socket and halts its
     * reconnection loop. Twitch deletes websocket-transport subscriptions
     * once their socket drops, so no Helix DELETE round-trip is needed here.
     */
    stop() {
        this.#halted = true;
        this.teardown();
    }

    /** True when either the owner (client-wide) or this session is stopped. */
    #reconnectHalted() {
        return this.#halted || this.#isStopped();
    }

    async ensureConnected() {
        if (this.#sessionId && this.#socket) return;
        if (this.#connectPromise) return this.#connectPromise;
        return this.open(this.#wsUrl);
    }

    async open(url, { isResume = false } = {}) {
        this.#clearTimers();
        const ws = new this.#wsImpl(url);
        this.#socket = ws;

        this.#connectPromise = new Promise((resolve, reject) => {
            this.#connectResolve = resolve;
            this.#connectReject = reject;
        });

        this.#welcomeTimer = this.#setTimeoutFn(() => {
            const err = new Error('EventSub connection timed out waiting for session_welcome');
            if (this.#connectReject) {
                this.#connectReject(err);
                this.#connectReject = null;
                this.#connectResolve = null;
            }
            this.#connectPromise = null;
            this.#cleanupSocket(ws);
            if (this.#socket === ws) {
                this.#socket = null;
                this.#sessionId = null;
            }
            if (!this.#reconnectHalted()) this.#scheduleReconnect();
        }, this.#welcomeTimeoutMs);
        this.#welcomeTimer?.unref?.();

        bindSocket(ws, {
            onOpen: () => {},
            onMessage: (data) => this.#handleRawMessage(data, ws, isResume),
            onClose: () => this.#handleSocketClose(ws, isResume),
            onError: (err) => this.#handleSocketError(err)
        });

        return this.#connectPromise;
    }

    teardown() {
        this.#clearTimers();
        if (this.#connectReject) {
            this.#connectReject(new Error('EventSub disconnected'));
            this.#connectReject = null;
            this.#connectResolve = null;
            this.#connectPromise = null;
        }
        this.#cleanupSocket(this.#socket);
        this.#socket = null;
        this.#sessionId = null;
    }

    #handleRawMessage(raw, ws, isResume) {
        let message;
        try {
            message = JSON.parse(raw);
            if (!message || typeof message !== 'object') throw new Error('Invalid JSON payload');
        } catch (error) {
            console.warn('[EventSub] Failed to parse message JSON:', error?.message || error);
            return;
        }

        const metadata = message?.metadata || {};
        const payload = message?.payload || {};

        switch (metadata.message_type) {
            case 'session_welcome': {
                if (this.#welcomeTimer) {
                    this.#clearTimeoutFn(this.#welcomeTimer);
                    this.#welcomeTimer = null;
                }
                this.#sessionId = payload.session?.id || null;
                this.#reconnectAttempt = 0;
                this.#keepaliveSec = Number(payload.session?.keepalive_timeout_seconds) || 10;
                this.#armKeepalive(this.#keepaliveSec);

                if (this.#connectResolve) {
                    this.#connectResolve();
                    this.#connectResolve = null;
                    this.#connectReject = null;
                }
                this.#connectPromise = null;

                // Resume migrations preserve server-side subscriptions; clean
                // reconnects land on a fresh session and must re-apply them.
                if (this.#hadLiveSession && !isResume) {
                    this.#onResubscribe();
                }
                this.#hadLiveSession = true;
                break;
            }
            case 'session_keepalive': {
                this.#resetKeepalive();
                break;
            }
            case 'notification': {
                this.#resetKeepalive();
                this.#onNotification(message);
                break;
            }
            case 'session_reconnect': {
                const reconnectUrl = payload.session?.reconnect_url;
                if (reconnectUrl) {
                    this.#resumeTo(reconnectUrl);
                }
                break;
            }
            case 'revocation': {
                console.warn(
                    `[EventSub] Subscription revoked: type=${payload.subscription?.type}, status=${payload.subscription?.status}`
                );
                break;
            }
            default:
                break;
        }
    }

    async #resumeTo(reconnectUrl) {
        const oldSocket = this.#socket;
        try {
            await this.open(reconnectUrl, { isResume: true });
            this.#cleanupSocket(oldSocket);
        } catch (err) {
            console.warn('[EventSub] Reconnect URL resume failed, falling back to clean reconnect:', err.message);
            this.#cleanupSocket(oldSocket);
            if (!this.#reconnectHalted()) this.#scheduleReconnect(0, false);
        }
    }

    #handleSocketClose(ws, isResume) {
        // Idempotent: cleanup-driven re-entrant closes and stale migrated
        // sockets must not re-trigger rejection or reconnection.
        if (ws !== this.#socket) return;
        this.#socket = null;
        this.#sessionId = null;
        this.#cleanupSocket(ws);
        if (this.#connectReject) {
            this.#connectReject(new Error('EventSub connection closed'));
            this.#connectReject = null;
            this.#connectResolve = null;
            this.#connectPromise = null;
        }
        if (!this.#reconnectHalted()) {
            this.#scheduleReconnect(undefined, false);
        }
    }

    #handleSocketError(err) {
        console.warn('[EventSub] WebSocket error:', err?.message || err);
    }

    #armKeepalive(keepaliveSec) {
        if (this.#keepaliveTimer) {
            this.#clearTimeoutFn(this.#keepaliveTimer);
            this.#keepaliveTimer = null;
        }
        const timeoutMs = keepaliveSec * 1000 + this.#keepaliveGraceMs;
        this.#keepaliveTimer = this.#setTimeoutFn(() => {
            console.warn('[EventSub] Keepalive watchdog timeout; reconnecting...');
            this.#cleanupSocket(this.#socket);
            this.#socket = null;
            this.#sessionId = null;
            if (!this.#reconnectHalted()) this.#scheduleReconnect(0, false);
        }, timeoutMs);
        this.#keepaliveTimer?.unref?.();
    }

    #resetKeepalive() {
        this.#armKeepalive(this.#keepaliveSec);
    }

    #scheduleReconnect(delayMs, isResume = false) {
        if (this.#reconnectTimer) {
            this.#clearTimeoutFn(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }
        if (this.#reconnectHalted()) return;

        let waitMs = delayMs;
        if (waitMs === undefined) {
            waitMs = Math.min(this.#reconnectBaseMs * Math.pow(2, this.#reconnectAttempt), this.#reconnectMaxMs);
            this.#reconnectAttempt++;
        }

        this.#reconnectTimer = this.#setTimeoutFn(async () => {
            this.#reconnectTimer = null;
            if (this.#reconnectHalted()) return;
            try {
                await this.open(this.#wsUrl, { isResume });
            } catch (err) {
                console.error('[EventSub] Reconnection attempt failed:', err?.message || err);
            }
        }, waitMs);
        this.#reconnectTimer?.unref?.();
    }

    #clearTimers() {
        if (this.#welcomeTimer) {
            this.#clearTimeoutFn(this.#welcomeTimer);
            this.#welcomeTimer = null;
        }
        if (this.#keepaliveTimer) {
            this.#clearTimeoutFn(this.#keepaliveTimer);
            this.#keepaliveTimer = null;
        }
        if (this.#reconnectTimer) {
            this.#clearTimeoutFn(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }
    }

    #cleanupSocket(ws) {
        if (!ws) return;
        try {
            if (typeof ws.close === 'function') ws.close();
        } catch {
            // ignore
        }
    }
}

class BroadcasterSession {
    #helix;
    #desired = null;
    #lifecycle;

    constructor(options) {
        this.#lifecycle = new WebSocketSession({
            ...options,
            onResubscribe: () => this.applySubscriptions().catch((err) => {
                console.warn('[EventSub] Failed to re-subscribe channel on reconnect:', err?.message || err);
            })
        });
        this.#helix = options.helix;
    }

    get sessionId() {
        return this.#lifecycle.sessionId;
    }

    get connected() {
        return this.#lifecycle.connected;
    }

    setDesired(item) {
        this.#desired = item;
    }

    stop() {
        this.#lifecycle.stop();
    }

    teardown() {
        this.#lifecycle.teardown();
    }

    async ensureConnected() {
        return this.#lifecycle.ensureConnected();
    }

    async applySubscriptions() {
        const desired = this.#desired;
        if (!desired || !this.#lifecycle.sessionId) return;
        for (const spec of SUBSCRIPTION_SPECS) {
            try {
                await this.#helix.request('/eventsub/subscriptions', {
                    method: 'POST',
                    accessToken: desired.accessToken,
                    broadcasterChannel: desired.broadcasterChannel,
                    body: {
                        type: spec.type,
                        version: spec.version,
                        condition: spec.condition(desired.broadcasterUserId, desired.moderatorUserId),
                        transport: { method: 'websocket', session_id: this.#lifecycle.sessionId }
                    }
                });
            } catch (err) {
                const status = err?.status;
                if (status === 409) continue;
                if (status === 401 || status === 403) {
                    console.warn(
                        `[EventSub] Skipping ${spec.type} for ${desired.broadcasterChannel}: missing scope (${status})`
                    );
                    continue;
                }
                console.warn(
                    `[EventSub] Failed to subscribe ${spec.type} for ${desired.broadcasterChannel}:`,
                    err?.message || err
                );
            }
        }
    }
}

/**
 * Shared bot-token chat session. One WebSocket carries
 * `channel.chat.message` subscriptions for every joined channel; access
 * tokens resolve fresh through `getAccessToken` because bot tokens rotate.
 * The socket exists only while at least one desired channel remains:
 * the first addition connects it, the final removal stops it terminally.
 */
class BotChatSession {
    #botUserId;
    #getAccessToken;
    #helix;
    #lifecycle;
    #desired = new Map(); // broadcasterUserId -> login
    #appliedIn = new Map(); // broadcasterUserId -> sessionId already subscribed

    constructor({ helix, botUserId, getAccessToken, onChatMessage, lifecycle }) {
        this.#helix = helix;
        this.#botUserId = String(botUserId || '');
        this.#getAccessToken = getAccessToken;
        this.#lifecycle = new WebSocketSession({
            ...lifecycle,
            onNotification: (message) => onChatMessage(message),
            onResubscribe: () => this.applySubscriptions().catch((err) => {
                console.warn('[EventSub] Failed to re-subscribe bot chat on reconnect:', err?.message || err);
            })
        });
    }

    get sessionId() {
        return this.#lifecycle.sessionId;
    }

    get connected() {
        return this.#lifecycle.connected;
    }

    get hasDesiredChannels() {
        return this.#desired.size > 0;
    }

    addChannel(broadcasterUserId, login) {
        this.#desired.set(String(broadcasterUserId), cleanName(login));
    }

    stop() {
        this.#lifecycle.stop();
    }

    teardown() {
        this.#lifecycle.teardown();
    }

    async ensureConnected() {
        return this.#lifecycle.ensureConnected();
    }

    async applySubscriptions() {
        const sessionId = this.#lifecycle.sessionId;
        if (!sessionId || this.#desired.size === 0) return;
        const pending = [...this.#desired.keys()].filter((id) => this.#appliedIn.get(id) !== sessionId);
        if (pending.length === 0) return;
        let token = null;
        try {
            token = await this.#getAccessToken();
        } catch (err) {
            console.warn('[EventSub] Bot chat subscription token unavailable:', err?.message || err);
            return;
        }
        for (const broadcasterUserId of pending) {
            const login = this.#desired.get(broadcasterUserId);
            try {
                await this.#createSubscription(token, broadcasterUserId, sessionId);
                this.#appliedIn.set(broadcasterUserId, sessionId);
            } catch (err) {
                const status = err?.status;
                if (status === 401 || status === 403) {
                    console.warn(`[EventSub] Skipping ${BOT_CHAT_SUBSCRIPTION_TYPE} for ${login}: missing scope (${status})`);
                    continue;
                }
                if (status === 409) {
                    await this.#recoverFromConflict(token, broadcasterUserId, login, sessionId);
                    continue;
                }
                console.warn(
                    `[EventSub] Failed to subscribe ${BOT_CHAT_SUBSCRIPTION_TYPE} for ${login}:`,
                    err?.message || err
                );
            }
        }
    }

    #createSubscription(token, broadcasterUserId, sessionId) {
        return this.#helix.request('/eventsub/subscriptions', {
            method: 'POST',
            accessToken: token,
            body: {
                type: BOT_CHAT_SUBSCRIPTION_TYPE,
                version: BOT_CHAT_SUBSCRIPTION_VERSION,
                condition: {
                    broadcaster_user_id: broadcasterUserId,
                    user_id: this.#botUserId
                },
                transport: { method: 'websocket', session_id: sessionId }
            }
        });
    }

    /**
     * Session-aware 409 recovery. A conflict is either an idempotent duplicate
     * already attached to the current socket (treat as applied, delete nothing)
     * or a stale leftover from a dead previous session (delete it, retry
     * creation once). Anything that cannot be proven deterministically stays
     * unapplied so the next reconnect resync retries it - never marked applied
     * merely to silence the error.
     */
    async #recoverFromConflict(token, broadcasterUserId, login, sessionId) {
        let matches;
        try {
            matches = await this.#findChatSubscriptions(token, broadcasterUserId);
        } catch (err) {
            console.warn(`[EventSub] Failed to inspect conflicting ${BOT_CHAT_SUBSCRIPTION_TYPE} for ${login}:`, err?.message || err);
            return false;
        }

        if (matches.some((sub) => sub?.status === 'enabled' && String(sub?.transport?.session_id || '') === sessionId)) {
            this.#appliedIn.set(broadcasterUserId, sessionId);
            return true;
        }

        const staleIds = matches.map((sub) => sub?.id).filter(Boolean);
        if (staleIds.length === 0) {
            console.warn(
                `[EventSub] Conflicting ${BOT_CHAT_SUBSCRIPTION_TYPE} for ${login} has no inspectable subscription; leaving unapplied`
            );
            return false;
        }

        for (const subId of staleIds) {
            try {
                await this.#helix.request('/eventsub/subscriptions', {
                    method: 'DELETE',
                    query: { id: subId },
                    accessToken: token
                });
            } catch (err) {
                if (err?.status !== 404) {
                    console.warn(`[EventSub] Failed to delete stale bot chat subscription ${subId}:`, err?.message || err);
                    return false;
                }
            }
        }

        try {
            await this.#createSubscription(token, broadcasterUserId, sessionId);
        } catch (err) {
            console.warn(
                `[EventSub] Failed to re-create ${BOT_CHAT_SUBSCRIPTION_TYPE} for ${login} after stale cleanup:`,
                err?.message || err
            );
            return false;
        }
        this.#appliedIn.set(broadcasterUserId, sessionId);
        return true;
    }

    async #findChatSubscriptions(token, broadcasterUserId) {
        const matches = [];
        let after = '';
        do {
            const page = await this.#helix.request('/eventsub/subscriptions', {
                query: { first: 100, ...(after ? { after } : {}) },
                accessToken: token
            });
            for (const sub of page?.data || []) {
                if (sub?.type !== BOT_CHAT_SUBSCRIPTION_TYPE) continue;
                if (sub?.transport?.method !== 'websocket') continue;
                if (String(sub?.condition?.broadcaster_user_id || '') !== broadcasterUserId) continue;
                if (String(sub?.condition?.user_id || '') !== this.#botUserId) continue;
                matches.push(sub);
            }
            after = page?.pagination?.cursor || '';
        } while (after);
        return matches;
    }

    /**
     * Removes one channel's chat subscriptions via Helix DELETE so the shared
     * socket stops delivering it while other channels remain subscribed.
     * Listing (instead of tracking created IDs) also cleans subscriptions
     * orphaned by lost 409 responses across restarts.
     */
    async removeChannel(broadcasterUserId) {
        const id = String(broadcasterUserId ?? '');
        this.#desired.delete(id);
        this.#appliedIn.delete(id);
        if (!id || !this.#botUserId) return;

        let token = null;
        try {
            token = await this.#getAccessToken();
        } catch (err) {
            console.warn('[EventSub] Bot chat unsubscription token unavailable:', err?.message || err);
            return;
        }

        let after = '';
        do {
            let page;
            try {
                page = await this.#helix.request('/eventsub/subscriptions', {
                    query: { first: 100, ...(after ? { after } : {}) },
                    accessToken: token
                });
            } catch (err) {
                console.warn('[EventSub] Failed to list bot chat subscriptions:', err?.message || err);
                return;
            }
            for (const sub of page?.data || []) {
                if (sub?.type !== BOT_CHAT_SUBSCRIPTION_TYPE) continue;
                if (sub?.transport?.method !== 'websocket') continue;
                if (String(sub?.condition?.broadcaster_user_id || '') !== id) continue;
                if (!sub?.id) continue;
                try {
                    await this.#helix.request('/eventsub/subscriptions', {
                        method: 'DELETE',
                        query: { id: sub.id },
                        accessToken: token
                    });
                } catch (err) {
                    if (err?.status !== 404) {
                        console.warn(`[EventSub] Failed to delete bot chat subscription ${sub.id}:`, err?.message || err);
                    }
                }
            }
            after = page?.pagination?.cursor || '';
        } while (after);
    }
}

export class EventSubClient {
    #helix;
    #wsImpl;
    #nowFn;
    #setTimeoutFn;
    #clearTimeoutFn;
    #wsUrl;
    #welcomeTimeoutMs;
    #keepaliveGraceMs;
    #reconnectBaseMs;
    #reconnectMaxMs;
    #dedupeTtlMs;
    #dedupeMaxSize;

    #sessions = new Map(); // broadcasterUserId -> BroadcasterSession
    #eventHandlers = [];
    #dedupeMap = new Map();
    #stopped = false;

    #botSession = null;
    #botUserId = null;
    #botTokenProvider = null;
    #botChatHandlers = [];

    constructor({
        helixClient,
        wsImpl = globalThis.WebSocket,
        nowFn = Date.now,
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout,
        wsUrl = 'wss://eventsub.wss.twitch.tv/ws',
        welcomeTimeoutMs = 10_000,
        keepaliveGraceMs = 5_000,
        reconnectBaseMs = 1_000,
        reconnectMaxMs = 60_000,
        dedupeTtlMs = 10 * 60 * 1000,
        dedupeMaxSize = 1_000
    } = {}) {
        if (!helixClient) throw new Error('EventSubClient requires helixClient');
        if (!wsImpl) throw new Error('EventSubClient requires wsImpl');

        this.#helix = helixClient;
        this.#wsImpl = wsImpl;
        this.#nowFn = nowFn;
        this.#setTimeoutFn = setTimeoutFn;
        this.#clearTimeoutFn = clearTimeoutFn;
        this.#wsUrl = wsUrl;
        this.#welcomeTimeoutMs = welcomeTimeoutMs;
        this.#keepaliveGraceMs = keepaliveGraceMs;
        this.#reconnectBaseMs = reconnectBaseMs;
        this.#reconnectMaxMs = reconnectMaxMs;
        this.#dedupeTtlMs = dedupeTtlMs;
        this.#dedupeMaxSize = dedupeMaxSize;
    }

    get connected() {
        for (const session of this.#sessions.values()) {
            if (session.connected) return true;
        }
        return false;
    }

    getSessionId(broadcasterUserId) {
        return this.#sessions.get(String(broadcasterUserId))?.sessionId || null;
    }

    onEvent(handler) {
        this.#eventHandlers.push(handler);
        return () => {
            this.#eventHandlers = this.#eventHandlers.filter((h) => h !== handler);
        };
    }

    /** Subscribes to normalized bot-authored chat observations from the shared session. */
    onBotChat(handler) {
        this.#botChatHandlers.push(handler);
        return () => {
            this.#botChatHandlers = this.#botChatHandlers.filter((h) => h !== handler);
        };
    }

    async connect() {
        this.#stopped = false;
    }

    async disconnect() {
        this.#stopped = true;
        for (const session of this.#sessions.values()) {
            session.teardown();
        }
        this.#sessions.clear();
        this.#botSession?.teardown();
        this.#botSession = null;
    }

    async subscribeChannel({ broadcasterUserId, broadcasterChannel, accessToken, moderatorUserId }) {
        if (!broadcasterUserId) return;
        this.#stopped = false;

        const id = String(broadcasterUserId);
        let session = this.#sessions.get(id);
        if (!session) {
            session = this.#createSession(id);
            this.#sessions.set(id, session);
        }

        session.setDesired({
            broadcasterUserId: id,
            broadcasterChannel: cleanName(broadcasterChannel),
            accessToken,
            moderatorUserId: moderatorUserId || id
        });

        await session.ensureConnected();
        if (this.#stopped) return;
        await session.applySubscriptions();
    }

    /** Forgets a broadcaster: closes its session socket and stops reconnects. */
    unsubscribeChannel(broadcasterUserId) {
        const id = String(broadcasterUserId ?? '');
        if (!id) return;
        const session = this.#sessions.get(id);
        if (!session) return;
        this.#sessions.delete(id);
        session.stop();
    }

    /**
     * Records the bot identity and token provider for the shared chat
     * session. Configuration only: no socket opens until the first desired
     * channel arrives, so a bot with zero joined channels never holds an
     * idle socket Twitch would close for lack of subscriptions.
     */
    async startBotChat({ userId, getAccessToken }) {
        this.#stopped = false;
        if (!userId) throw new Error('EventSubClient.startBotChat requires the bot user id');
        this.#botUserId = String(userId);
        this.#botTokenProvider = getAccessToken;
    }

    /** Adds one joined channel to the shared bot chat session (connecting it lazily). */
    async subscribeBotChannel({ broadcasterUserId, broadcasterChannel }) {
        if (!this.#botUserId || !this.#botTokenProvider) return;
        this.#stopped = false;
        if (!this.#botSession) this.#botSession = this.#createBotSession();
        this.#botSession.addChannel(broadcasterUserId, broadcasterChannel);
        await this.#botSession.ensureConnected();
        if (this.#stopped) return;
        await this.#botSession.applySubscriptions();
    }

    /**
     * Removes one channel's subscription. Other channels keep the shared
     * socket alive; removing the final one stops the session terminally and
     * releases it, so a later addition starts from a fresh object.
     */
    async unsubscribeBotChannel(broadcasterUserId) {
        const session = this.#botSession;
        if (!session) return;
        await session.removeChannel(broadcasterUserId);
        if (!session.hasDesiredChannels) {
            session.stop();
            this.#botSession = null;
        }
    }

    get botChatConnected() {
        return Boolean(this.#botSession?.connected);
    }

    #createSession(broadcasterUserId) {
        return new BroadcasterSession({
            broadcasterUserId,
            helix: this.#helix,
            wsImpl: this.#wsImpl,
            nowFn: this.#nowFn,
            setTimeoutFn: this.#setTimeoutFn,
            clearTimeoutFn: this.#clearTimeoutFn,
            wsUrl: this.#wsUrl,
            welcomeTimeoutMs: this.#welcomeTimeoutMs,
            keepaliveGraceMs: this.#keepaliveGraceMs,
            reconnectBaseMs: this.#reconnectBaseMs,
            reconnectMaxMs: this.#reconnectMaxMs,
            isStopped: () => this.#stopped,
            onNotification: (message) => this.#dispatchNotification(message)
        });
    }

    #createBotSession() {
        return new BotChatSession({
            helix: this.#helix,
            botUserId: this.#botUserId,
            getAccessToken: () => this.#botTokenProvider(),
            onChatMessage: (message) => {
                const messageId = message?.metadata?.message_id;
                if (this.#isDuplicate(messageId)) return;
                const observation = normalizeBotChatMessage(message, this.#nowFn);
                if (observation) this.#emitBotChat(observation);
            },
            lifecycle: {
                wsImpl: this.#wsImpl,
                nowFn: this.#nowFn,
                setTimeoutFn: this.#setTimeoutFn,
                clearTimeoutFn: this.#clearTimeoutFn,
                wsUrl: this.#wsUrl,
                welcomeTimeoutMs: this.#welcomeTimeoutMs,
                keepaliveGraceMs: this.#keepaliveGraceMs,
                reconnectBaseMs: this.#reconnectBaseMs,
                reconnectMaxMs: this.#reconnectMaxMs,
                isStopped: () => this.#stopped
            }
        });
    }

    #dispatchNotification(message) {
        const messageId = message?.metadata?.message_id;
        if (this.#isDuplicate(messageId)) return;
        const normalized = normalizeNotification(message, this.#nowFn);
        if (normalized) {
            this.#emit(normalized);
        }
    }

    #isDuplicate(messageId) {
        if (!messageId) return false;
        const now = this.#nowFn();
        for (const [id, exp] of this.#dedupeMap) {
            if (now >= exp) this.#dedupeMap.delete(id);
        }
        if (this.#dedupeMap.has(messageId)) return true;
        this.#dedupeMap.set(messageId, now + this.#dedupeTtlMs);
        if (this.#dedupeMap.size > this.#dedupeMaxSize) {
            const oldestKey = this.#dedupeMap.keys().next().value;
            if (oldestKey) this.#dedupeMap.delete(oldestKey);
        }
        return false;
    }

    #emitBotChat(observation) {
        for (const handler of this.#botChatHandlers) {
            try {
                const result = handler(observation);
                if (result && typeof result.catch === 'function') {
                    result.catch((err) => console.error('[EventSub] onBotChat handler failed:', err?.message || err));
                }
            } catch (err) {
                console.error('[EventSub] onBotChat handler failed:', err?.message || err);
            }
        }
    }

    #emit(event) {
        for (const handler of this.#eventHandlers) {
            try {
                const result = handler(event);
                if (result && typeof result.catch === 'function') {
                    result.catch((err) => console.error('[EventSub] onEvent handler failed:', err?.message || err));
                }
            } catch (err) {
                console.error('[EventSub] onEvent handler failed:', err?.message || err);
            }
        }
    }
}

export default EventSubClient;
