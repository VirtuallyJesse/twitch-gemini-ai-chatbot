// src/twitch/eventsub_client.js
//
// Deep module owning Twitch EventSub WebSocket lifecycle, event normalization,
// message deduplication, and Helix subscription synchronization. Two session
// families share one private WebSocket engine: isolated per-broadcaster
// sessions for privileged alert events (broadcaster tokens) and one shared
// bot-token session for public/bot-authorized events across joined channels.
// Pure dependencies: reads zero process.env.

import { EventSubSubscriptions, matchesSubscription as matchesDesiredSubscription } from './eventsub_subscriptions.js';
import { EventSubSocket as WebSocketSession } from './eventsub_socket.js';
const cleanName = (value) => String(value || '').replace('#', '').trim().toLowerCase();
const channelKey = (channel) => `#${cleanName(channel)}`;
const CHAT_NOTIFICATION_TYPE = 'channel.chat.notification';

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
        case CHAT_NOTIFICATION_TYPE: {
            const noticeType = event.notice_type;
            const user = actorFrom(event, {
                anonymous: !!event.chatter_is_anonymous,
                prefix: 'chatter_user'
            });
            if (noticeType === 'sub') {
                return {
                    ...base,
                    kind: 'subscription',
                    user,
                    details: {
                        tier: mapTier(event.sub?.sub_tier),
                        message: event.message?.text || ''
                    }
                };
            }
            if (noticeType === 'resub') {
                return {
                    ...base,
                    kind: 'resub',
                    user,
                    details: {
                        tier: mapTier(event.resub?.sub_tier),
                        months: Number(event.resub?.cumulative_months) || 0,
                        streak: event.resub?.streak_months == null ? '' : Number(event.resub.streak_months),
                        message: event.message?.text || ''
                    }
                };
            }
            if (noticeType === 'sub_gift') {
                const gift = event.sub_gift || {};
                if (gift.community_gift_id != null && String(gift.community_gift_id).trim()) return null;
                const recipient = actorFrom(gift, { prefix: 'recipient_user' });
                return {
                    ...base,
                    kind: 'sub_gift',
                    user,
                    details: { tier: mapTier(gift.sub_tier), recipient }
                };
            }
            if (noticeType === 'community_sub_gift') {
                const gift = event.community_sub_gift || {};
                return {
                    ...base,
                    kind: 'community_sub_gift',
                    user,
                    details: { tier: mapTier(gift.sub_tier), count: Number(gift.total) || 1 }
                };
            }
            return null;
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

const BROADCASTER_SUBSCRIPTION_SPECS = [
    { type: 'channel.cheer', version: '1', condition: (id) => ({ broadcaster_user_id: id }) },
    {
        type: 'channel.channel_points_custom_reward_redemption.add',
        version: '1',
        condition: (id) => ({ broadcaster_user_id: id })
    },
    {
        type: 'channel.follow',
        version: '2',
        condition: (id, modId) => ({ broadcaster_user_id: id, moderator_user_id: modId || id })
    }
];

const BOT_CHAT_SUBSCRIPTION_TYPE = 'channel.chat.message';
const PUBLIC_SUBSCRIPTION_SPECS = [
    {
        type: BOT_CHAT_SUBSCRIPTION_TYPE,
        version: '1',
        condition: (broadcasterId, botUserId) => ({ broadcaster_user_id: broadcasterId, user_id: botUserId })
    },
    {
        type: CHAT_NOTIFICATION_TYPE,
        version: '1',
        condition: (broadcasterId, botUserId) => ({ broadcaster_user_id: broadcasterId, user_id: botUserId })
    },
    {
        type: 'channel.raid',
        version: '1',
        condition: (broadcasterId) => ({ to_broadcaster_user_id: broadcasterId })
    }
];

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

/** Normalizes only the Twitch-authored facts needed for transcript observation. */
function normalizeChatNotice(message, nowFn) {
    const metadata = message?.metadata || {};
    if (metadata.subscription_type !== CHAT_NOTIFICATION_TYPE) return null;
    const event = message?.payload?.event || {};
    const id = String(event.message_id || '');
    const systemMessage = typeof event.system_message === 'string' ? event.system_message : '';
    if (!id || !systemMessage.trim()) return null;

    return {
        id,
        channel: channelKey(event.broadcaster_user_login),
        occurredAt: Date.parse(metadata.message_timestamp) || nowFn(),
        noticeType: String(event.notice_type || ''),
        systemMessage,
        messageText: typeof event.message?.text === 'string' ? event.message.text : ''
    };
}

/** Owns a family's desired channels; socket mechanics and subscription policy remain separate. */
class EventSession {
    #helix;
    #specs;
    #userId;
    #getAccessToken;
    #desired = new Map();
    #lifecycle;
    #subscriptions;
    #label;

    constructor({ helix, specs, userId, getAccessToken, onNotification, lifecycle, label }) {
        this.#helix = helix;
        this.#specs = specs;
        this.#userId = userId;
        this.#getAccessToken = getAccessToken;
        this.#label = label;
        this.#subscriptions = new EventSubSubscriptions(helix, { ...lifecycle, label });
        this.#lifecycle = new WebSocketSession({
            ...lifecycle, label, onNotification,
            onResubscribe: () => this.#subscriptions.sessionChanged({ sessionId: this.sessionId, resumed: false }),
            onResumed: previousSessionId => this.#subscriptions.sessionChanged({ sessionId: this.sessionId, previousSessionId, resumed: true }),
            onDisconnected: () => this.#subscriptions.disconnected(),
            onRevocation: sub => this.#subscriptions.revoke(sub)
        });
    }

    get sessionId() { return this.#lifecycle.sessionId; }
    get connected() { return this.#lifecycle.connected; }
    get hasDesiredChannels() { return this.#desired.size > 0; }

    setDesired(item) {
        const id = String(item.broadcasterUserId);
        const previous = this.#desired.get(id);
        this.#desired.set(id, item);
        this.#syncDesired();
        if (previous && previous.accessToken !== item.accessToken) void this.reauthorize();
    }

    addChannel(broadcasterUserId, broadcasterChannel) {
        this.setDesired({ broadcasterUserId: String(broadcasterUserId), broadcasterChannel: cleanName(broadcasterChannel) });
    }

    #item(desired, spec) {
        return {
            type: spec.type,
            version: spec.version,
            condition: spec.condition(desired.broadcasterUserId, desired.moderatorUserId || this.#userId || desired.broadcasterUserId),
            broadcasterChannel: desired.broadcasterChannel,
            getAccessToken: desired.getAccessToken || this.#getAccessToken || (() => Promise.resolve(desired.accessToken))
        };
    }

    #syncDesired() {
        this.#subscriptions.setDesired([...this.#desired.values()].flatMap(desired => this.#specs.map(spec => this.#item(desired, spec))));
    }

    botChatHealth(broadcasterUserId) {
        const desired = this.#desired.get(String(broadcasterUserId));
        if (!this.connected || !desired) return { state: 'disconnected' };
        return this.#subscriptions.health(this.#item(desired, this.#specs.find(spec => spec.type === BOT_CHAT_SUBSCRIPTION_TYPE)));
    }

    ensureConnected() { return this.#lifecycle.ensureConnected(); }
    applySubscriptions() { return this.#subscriptions.reconcile(); }
    reauthorize() { return this.#subscriptions.reauthorize(); }
    stop() { this.#subscriptions.stop(); this.#lifecycle.stop(); }
    teardown() { this.#subscriptions.stop(); this.#lifecycle.teardown(); }

    async removeChannel(broadcasterUserId) {
        const id = String(broadcasterUserId);
        const desired = this.#desired.get(id);
        this.#desired.delete(id);
        this.#syncDesired();
        const sessionId = this.sessionId;
        if (!desired || !sessionId) return;
        const items = this.#specs.map(spec => this.#item(desired, spec));
        try {
            const accessToken = await items[0].getAccessToken();
            let after;
            do {
                const page = await this.#helix.request('/eventsub/subscriptions', {
                    accessToken, retry401: false, signal: AbortSignal.timeout(10_000),
                    query: { first: 100, ...(after ? { after } : {}) }
                });
                for (const sub of page?.data || []) {
                    if (!sub.id || sub.transport?.session_id !== sessionId || !items.some(item => matchesDesiredSubscription(sub, item))) continue;
                    await this.#helix.request('/eventsub/subscriptions', {
                        method: 'DELETE', query: { id: sub.id }, accessToken, retry401: false, signal: AbortSignal.timeout(10_000)
                    });
                }
                after = page?.pagination?.cursor;
            } while (after);
        } catch (error) {
            console.warn(`[EventSub:${this.#label}] Removing subscriptions for ${desired.broadcasterChannel} failed (HTTP ${error.status || 'unknown'})`);
        }
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
    #randomFn;

    #sessions = new Map(); // broadcasterUserId -> BroadcasterSession
    #eventHandlers = [];
    #dedupeMap = new Map();
    #stopped = false;

    #publicSession = null;
    #botUserId = null;
    #botTokenProvider = null;
    #botChatHandlers = [];
    #chatNoticeHandlers = [];

    constructor({
        helixClient,
        wsImpl = globalThis.WebSocket,
        nowFn = Date.now,
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout,
        randomFn = Math.random,
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
        this.#randomFn = randomFn;
        this.#wsUrl = wsUrl;
        this.#welcomeTimeoutMs = welcomeTimeoutMs;
        this.#keepaliveGraceMs = keepaliveGraceMs;
        this.#reconnectBaseMs = reconnectBaseMs;
        this.#reconnectMaxMs = reconnectMaxMs;
        this.#dedupeTtlMs = dedupeTtlMs;
        this.#dedupeMaxSize = dedupeMaxSize;
    }

    get connected() {
        if (this.publicSessionConnected) return true;
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

    /** Subscribes to normalized Twitch-authored chat-visible notice observations. */
    onChatNotice(handler) {
        this.#chatNoticeHandlers.push(handler);
        return () => {
            this.#chatNoticeHandlers = this.#chatNoticeHandlers.filter((h) => h !== handler);
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
        this.#publicSession?.teardown();
        this.#publicSession = null;
    }

    async subscribeChannel({ broadcasterUserId, broadcasterChannel, accessToken, getAccessToken, moderatorUserId }) {
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
            getAccessToken,
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
     * Configures the shared public/bot-authorized session. It owns
     * `channel.chat.message`, `channel.chat.notification`, and `channel.raid`
     * for every desired channel. Configuration alone opens no socket; the
     * first channel subscription connects lazily.
     */
    configurePublicSession({ userId, getAccessToken }) {
        this.#stopped = false;
        if (!userId) throw new Error('EventSubClient.configurePublicSession requires the bot user id');
        this.#botUserId = String(userId);
        this.#botTokenProvider = getAccessToken;
    }

    /** Adds one joined channel to the shared public session (connecting it lazily). */
    async subscribePublicChannel({ broadcasterUserId, broadcasterChannel }) {
        if (!this.#botUserId || !this.#botTokenProvider) return;
        this.#stopped = false;
        if (!this.#publicSession) this.#publicSession = this.#createPublicSession();
        const session = this.#publicSession;
        session.addChannel(broadcasterUserId, broadcasterChannel);
        await session.ensureConnected();
        if (this.#stopped || this.#publicSession !== session) return;
        await session.applySubscriptions();
    }

    /**
     * Removes one channel's subscription. Other channels keep the shared
     * socket alive; removing the final one stops the session terminally and
     * releases it, so a later addition starts from a fresh object.
     */
    async unsubscribePublicChannel(broadcasterUserId) {
        const session = this.#publicSession;
        if (!session) return;
        await session.removeChannel(broadcasterUserId);
        if (!session.hasDesiredChannels) {
            session.stop();
            this.#publicSession = null;
        }
    }

    get publicSessionConnected() {
        return Boolean(this.#publicSession?.connected);
    }

    getBotChatObservationHealth(broadcasterUserId) {
        return this.#publicSession?.botChatHealth(broadcasterUserId) || { state: 'disconnected' };
    }

    async reauthorizePublicSession() {
        await this.#publicSession?.reauthorize();
    }

    async reauthorizeBroadcasterSession(broadcasterUserId) {
        await this.#sessions.get(String(broadcasterUserId))?.reauthorize();
    }

    #createLifecycleOptions() {
        return {
            wsImpl: this.#wsImpl,
            nowFn: this.#nowFn,
            setTimeoutFn: this.#setTimeoutFn,
            clearTimeoutFn: this.#clearTimeoutFn,
            randomFn: this.#randomFn,
            wsUrl: this.#wsUrl,
            welcomeTimeoutMs: this.#welcomeTimeoutMs,
            keepaliveGraceMs: this.#keepaliveGraceMs,
            reconnectBaseMs: this.#reconnectBaseMs,
            reconnectMaxMs: this.#reconnectMaxMs,
            isStopped: () => this.#stopped
        };
    }

    #createSession(broadcasterUserId) {
        return new EventSession({
            helix: this.#helix,
            specs: BROADCASTER_SUBSCRIPTION_SPECS,
            label: `broadcaster:${broadcasterUserId}`,
            onNotification: (message) => this.#dispatchNotification(message),
            lifecycle: this.#createLifecycleOptions()
        });
    }

    #createPublicSession() {
        return new EventSession({
            helix: this.#helix,
            specs: PUBLIC_SUBSCRIPTION_SPECS,
            userId: this.#botUserId,
            label: 'public:bot',
            getAccessToken: () => this.#botTokenProvider(),
            onNotification: (message) => {
                if (message?.metadata?.subscription_type === BOT_CHAT_SUBSCRIPTION_TYPE) {
                    const messageId = message?.metadata?.message_id;
                    if (this.#isDuplicate(messageId)) return;
                    const observation = normalizeBotChatMessage(message, this.#nowFn);
                    if (observation) this.#dispatchObservers(this.#botChatHandlers, observation, 'onBotChat');
                    return;
                }
                this.#dispatchNotification(message);
            },
            lifecycle: this.#createLifecycleOptions()
        });
    }

    #dispatchNotification(message) {
        const messageId = message?.metadata?.message_id;
        if (this.#isDuplicate(messageId)) return;
        if (message?.metadata?.subscription_type === CHAT_NOTIFICATION_TYPE) {
            try {
                const notice = normalizeChatNotice(message, this.#nowFn);
                if (notice) this.#dispatchObservers(this.#chatNoticeHandlers, notice, 'onChatNotice');
            } catch (err) {
                console.error('[EventSub] Failed to normalize chat notice:', err?.message || err);
            }
        }
        try {
            const normalized = normalizeNotification(message, this.#nowFn);
            if (normalized) this.#dispatchObservers(this.#eventHandlers, normalized, 'onEvent');
        } catch (err) {
            console.error('[EventSub] Failed to normalize reaction event:', err?.message || err);
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

    #dispatchObservers(handlers, value, label) {
        for (const handler of handlers) {
            try {
                const result = handler(value);
                if (result && typeof result.catch === 'function') {
                    result.catch((err) => console.error(`[EventSub] ${label} handler failed:`, err?.message || err));
                }
            } catch (err) {
                console.error(`[EventSub] ${label} handler failed:`, err?.message || err);
            }
        }
    }
}

export default EventSubClient;
