// src/twitch/eventsub_client.js
//
// Deep module owning Twitch EventSub WebSocket lifecycle, event normalization,
// message deduplication, and Helix subscription synchronization.
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

    #socket = null;
    #sessionId = null;
    #eventHandlers = [];
    #desiredChannels = new Map();
    #dedupeMap = new Map();
    #connectPromise = null;
    #connectResolve = null;
    #connectReject = null;
    #welcomeTimer = null;
    #keepaliveTimer = null;
    #keepaliveSec = 10;
    #reconnectTimer = null;
    #reconnectAttempt = 0;
    #stopped = false;

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

    get sessionId() {
        return this.#sessionId;
    }

    get connected() {
        return Boolean(this.#socket);
    }

    onEvent(handler) {
        this.#eventHandlers.push(handler);
        return () => {
            this.#eventHandlers = this.#eventHandlers.filter((h) => h !== handler);
        };
    }

    async connect() {
        this.#stopped = false;
        if (this.#connectPromise) return this.#connectPromise;
        return this.#openSocket(this.#wsUrl, { isResume: false });
    }

    async disconnect() {
        this.#stopped = true;
        this.#clearTimers();
        if (this.#connectReject) {
            this.#connectReject(new Error('EventSub disconnected'));
            this.#connectReject = null;
            this.#connectResolve = null;
        }
        this.#cleanupSocket(this.#socket);
        this.#socket = null;
        this.#sessionId = null;
    }

    async subscribeChannel({ broadcasterUserId, broadcasterChannel, accessToken, moderatorUserId }) {
        if (!broadcasterUserId) return;
        const cleanChan = cleanName(broadcasterChannel);
        const item = {
            broadcasterUserId,
            broadcasterChannel: cleanChan,
            accessToken,
            moderatorUserId: moderatorUserId || broadcasterUserId
        };
        this.#desiredChannels.set(broadcasterUserId, item);
        if (!this.#sessionId) return;
        await this.#applySubscriptions(item);
    }

    async #openSocket(url, { isResume = false }) {
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
            this.#cleanupSocket(ws);
            if (!this.#stopped) this.#scheduleReconnect();
        }, this.#welcomeTimeoutMs);
        this.#welcomeTimer?.unref?.();

        bindSocket(ws, {
            onOpen: () => {},
            onMessage: (data) => this.#handleRawMessage(data, ws, isResume),
            onClose: () => this.#handleSocketClose(ws, isResume),
            onError: (err) => this.#handleSocketError(err, ws)
        });

        return this.#connectPromise;
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

                if (!isResume) {
                    for (const desired of this.#desiredChannels.values()) {
                        this.#applySubscriptions(desired).catch((err) => {
                            console.warn('[EventSub] Failed to subscribe channel on welcome:', err?.message || err);
                        });
                    }
                }
                break;
            }
            case 'session_keepalive': {
                this.#resetKeepalive();
                break;
            }
            case 'notification': {
                this.#resetKeepalive();
                const messageId = metadata.message_id;
                if (this.#isDuplicate(messageId)) return;
                const normalized = normalizeNotification(message, this.#nowFn);
                if (normalized) {
                    this.#emit(normalized);
                }
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
            await this.#openSocket(reconnectUrl, { isResume: true });
            this.#cleanupSocket(oldSocket);
        } catch (err) {
            console.warn('[EventSub] Reconnect URL resume failed, falling back to clean reconnect:', err.message);
            this.#cleanupSocket(oldSocket);
            if (!this.#stopped) this.#scheduleReconnect(0, false);
        }
    }

    #handleSocketClose(ws, isResume) {
        if (ws !== this.#socket && this.#socket) return;
        this.#cleanupSocket(ws);
        if (this.#socket === ws) {
            this.#socket = null;
            this.#sessionId = null;
        }
        if (!this.#stopped) {
            this.#scheduleReconnect(undefined, false);
        }
    }

    #handleSocketError(err, ws) {
        console.warn('[EventSub] WebSocket error:', err?.message || err);
        // Error is typically followed by close; let close handle reconnection.
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
            if (!this.#stopped) this.#scheduleReconnect(0, false);
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
        if (this.#stopped) return;

        let waitMs = delayMs;
        if (waitMs === undefined) {
            waitMs = Math.min(this.#reconnectBaseMs * Math.pow(2, this.#reconnectAttempt), this.#reconnectMaxMs);
            this.#reconnectAttempt++;
        }

        this.#reconnectTimer = this.#setTimeoutFn(async () => {
            this.#reconnectTimer = null;
            if (this.#stopped) return;
            try {
                await this.#openSocket(this.#wsUrl, { isResume });
            } catch (err) {
                console.error('[EventSub] Reconnection attempt failed:', err?.message || err);
            }
        }, waitMs);
        this.#reconnectTimer?.unref?.();
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

    async #applySubscriptions({ broadcasterUserId, broadcasterChannel, accessToken, moderatorUserId }) {
        for (const spec of SUBSCRIPTION_SPECS) {
            try {
                await this.#helix.request('/eventsub/subscriptions', {
                    method: 'POST',
                    accessToken,
                    broadcasterChannel,
                    body: {
                        type: spec.type,
                        version: spec.version,
                        condition: spec.condition(broadcasterUserId, moderatorUserId),
                        transport: { method: 'websocket', session_id: this.#sessionId }
                    }
                });
            } catch (err) {
                const status = err?.status;
                if (status === 409) continue; // already exists
                if (status === 401 || status === 403) {
                    console.warn(`[EventSub] Skipping ${spec.type} for ${broadcasterChannel}: missing scope (${status})`);
                    continue;
                }
                console.warn(`[EventSub] Failed to subscribe ${spec.type} for ${broadcasterChannel}:`, err?.message || err);
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

export default EventSubClient;
