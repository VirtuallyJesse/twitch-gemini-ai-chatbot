// src/twitch/twitch_transport.js
//
// Deep module owning the entire Twitch transport surface: IRC ingestion (tmi.js),
// Helix REST chat delivery (App Access Token -> official Chatbot badge), the OAuth
// 2.0 lifecycle with 401 recovery and refresh mutexing, Helix user-ID resolution,
// channel history buffers, and AI context collation.
// All config and I/O cross the constructor - this module reads zero environment variables directly.

import tmi from 'tmi.js';

const ID_BASE = 'https://id.twitch.tv/oauth2';
const HELIX_BASE = 'https://api.twitch.tv/helix';
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export const TWITCH_AUTH_SCOPES = ['chat:read', 'chat:edit', 'user:bot', 'user:read:chat', 'user:write:chat'];

export class AuthMismatchError extends Error {
    constructor(expected, actual) {
        super(`Authorization rejected: expected bot account "${expected}" but got "${actual}". Log into the correct Twitch account and try again.`);
        this.name = 'AuthMismatchError';
        this.expected = expected;
        this.actual = actual;
    }
}

const cleanName = (value) => String(value || '').replace('#', '').trim().toLowerCase();
const channelKey = (channel) => `#${cleanName(channel)}`;
const delay = (ms) => (ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve());

async function readBody(response) {
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
}

function buildHelixUrl(path, query = {}) {
    const url = new URL(`${HELIX_BASE}${path}`);
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
            for (const item of value) {
                if (item !== undefined && item !== null && item !== '') url.searchParams.append(key, item);
            }
        } else if (value !== '') {
            url.searchParams.append(key, value);
        }
    }
    return url;
}

/** Splits on word boundaries when possible; hard-cuts only when no space exists in range. */
function chunkMessage(text, maxLength) {
    if (text.length <= maxLength) return [text];
    const chunks = [];
    let rest = text;
    while (rest.length > maxLength) {
        const cut = rest.lastIndexOf(' ', maxLength);
        const at = cut > 0 ? cut : maxLength;
        chunks.push(rest.slice(0, at));
        rest = rest.slice(at).trimStart();
    }
    if (rest) chunks.push(rest);
    return chunks;
}

function normalizeIrcMessage(channel, tags, text, self) {
    tags = tags || {};
    return {
        channel: channelKey(channel),
        username: tags['display-name'] || tags.username || '',
        loginName: cleanName(tags.username || ''),
        text: String(text ?? ''),
        tags,
        isMod: tags.mod === true || tags.mod === '1',
        isBroadcaster: !!(tags.badges && tags.badges.broadcaster),
        self: !!self
    };
}

class TokenVault {
    #clientId; #clientSecret; #initialRefreshToken; #storage; #fetchImpl; #now;
    #accessToken = null;
    #refreshToken = null;
    #expiresAt = 0;
    #appToken = null;
    #appExpiresAt = 0;
    #refreshInFlight = null;

    constructor({ clientId, clientSecret, initialRefreshToken, storage, fetchImpl, now }) {
        this.#clientId = clientId;
        this.#clientSecret = clientSecret;
        this.#initialRefreshToken = initialRefreshToken || '';
        this.#storage = storage || null;
        this.#fetchImpl = fetchImpl;
        this.#now = now;
    }

    isAuthorized() { return !!this.#refreshToken; }

    /** Load from storage (falling back to the seed refresh token) and prove one works. */
    async bootstrap() {
        const seeds = [];
        if (this.#storage) {
            try {
                const stored = await this.#storage.getTokens();
                if (stored?.refreshToken) seeds.push(stored.refreshToken);
            } catch (err) {
                console.error('[TwitchTransport] Failed to read stored tokens:', err.message);
            }
        }
        if (this.#initialRefreshToken) seeds.push(this.#initialRefreshToken);

        for (const seed of seeds) {
            this.#refreshToken = seed;
            try {
                await this.#refreshUserToken();
                return true;
            } catch (err) {
                console.error('[TwitchTransport] Refresh token rejected:', err.message);
                this.#clearUserTokens();
            }
        }
        return false;
    }

    /** Exchange an OAuth code; revoke and throw AuthMismatchError on account mismatch. */
    async exchangeCode(code, redirectUri, expectedLogin) {
        const data = await this.#tokenGrant({
            grant_type: 'authorization_code',
            code: String(code),
            redirect_uri: redirectUri
        });
        if (expectedLogin) {
            const validation = await this.#validateToken(data.access_token);
            const authorizedLogin = cleanName(validation.login || '');
            const expected = cleanName(expectedLogin);
            if (authorizedLogin !== expected) {
                await this.#revokeToken(data.access_token).catch(() => {});
                throw new AuthMismatchError(expected, authorizedLogin);
            }
            console.log(`[TwitchTransport] Token verified for bot account: ${authorizedLogin}`);
        }
        this.#setUserTokens(data);
        await this.#persist();
        return data;
    }

    async getUserToken() {
        if (!this.#refreshToken) throw new Error('Not authorized. Connect the bot account via /auth/login.');
        if (this.#accessToken && this.#now() < this.#expiresAt - TOKEN_EXPIRY_BUFFER_MS) return this.#accessToken;
        return this.#refreshUserToken();
    }

    async getAppToken() {
        if (this.#appToken && this.#now() < this.#appExpiresAt - TOKEN_EXPIRY_BUFFER_MS) return this.#appToken;
        const data = await this.#tokenGrant({ grant_type: 'client_credentials' });
        this.#appToken = data.access_token;
        this.#appExpiresAt = this.#now() + Number(data.expires_in || 3600) * 1000;
        return this.#appToken;
    }

    invalidateAppToken() {
        this.#appToken = null;
        this.#appExpiresAt = 0;
    }

    async forceRefresh() {
        this.#expiresAt = 0;
        return this.#refreshUserToken();
    }

    /** Concurrent callers share one in-flight grant request (refresh mutex). */
    #refreshUserToken() {
        if (this.#refreshInFlight) return this.#refreshInFlight;
        this.#refreshInFlight = (async () => {
            try {
                const data = await this.#tokenGrant({
                    grant_type: 'refresh_token',
                    refresh_token: this.#refreshToken
                });
                this.#setUserTokens(data);
                await this.#persist();
                return this.#accessToken;
            } catch (err) {
                if (err.grantRejected) this.#clearUserTokens(); // Twitch refused -> standby; network errors keep state
                throw err;
            } finally {
                this.#refreshInFlight = null;
            }
        })();
        return this.#refreshInFlight;
    }

    async #tokenGrant(params) {
        if (!this.#clientId || !this.#clientSecret) {
            throw new Error('Twitch client credentials are required for token operations.');
        }
        const response = await this.#fetchImpl(`${ID_BASE}/token`, {
            method: 'POST',
            body: new URLSearchParams({ client_id: this.#clientId, client_secret: this.#clientSecret, ...params })
        });
        const data = await readBody(response);
        if (!response.ok) {
            const err = new Error(`Twitch token grant failed (${response.status}): ${typeof data === 'string' ? data : JSON.stringify(data)}`);
            err.grantRejected = true;
            throw err;
        }
        return data;
    }

    async #validateToken(token) {
        const response = await this.#fetchImpl(`${ID_BASE}/validate`, { headers: { Authorization: `OAuth ${token}` } });
        const data = await readBody(response);
        if (!response.ok) throw new Error(`Failed to validate Twitch access token (${response.status}).`);
        return data;
    }

    async #revokeToken(token) {
        await this.#fetchImpl(
            `${ID_BASE}/revoke?client_id=${encodeURIComponent(this.#clientId)}&token=${encodeURIComponent(token)}`,
            { method: 'POST' }
        );
    }

    #setUserTokens(data) {
        this.#accessToken = data.access_token;
        this.#refreshToken = data.refresh_token || this.#refreshToken; // Twitch rotates refresh tokens
        this.#expiresAt = this.#now() + Number(data.expires_in || 3600) * 1000;
    }

    #clearUserTokens() {
        this.#accessToken = null;
        this.#refreshToken = null;
        this.#expiresAt = 0;
    }

    async #persist() {
        if (!this.#storage) return;
        try {
            await this.#storage.setTokens(this.#accessToken, this.#refreshToken, this.#expiresAt);
        } catch (err) {
            console.error('[TwitchTransport] Failed to persist tokens:', err.message);
        }
    }
}

class HelixClient {
    #clientId; #vault; #fetchImpl;

    constructor({ clientId, tokenVault, fetchImpl }) {
        this.#clientId = clientId;
        this.#vault = tokenVault;
        this.#fetchImpl = fetchImpl;
    }

    /** Bearer + Client-Id headers; exactly one 401 retry after refreshing the used token kind. */
    async request(path, { method = 'GET', query = {}, body = null, useAppToken = false, retry401 = true } = {}) {
        const token = useAppToken ? await this.#vault.getAppToken() : await this.#vault.getUserToken();
        const response = await this.#fetchImpl(buildHelixUrl(path, query), {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                'Client-Id': this.#clientId,
                ...(body ? { 'Content-Type': 'application/json' } : {})
            },
            ...(body ? { body: JSON.stringify(body) } : {})
        });
        const data = await readBody(response);

        if (response.status === 401 && retry401) {
            console.warn(`[TwitchTransport] 401 on ${method} ${path}; refreshing token and retrying once.`);
            if (useAppToken) this.#vault.invalidateAppToken();
            else await this.#vault.forceRefresh();
            return this.request(path, { method, query, body, useAppToken, retry401: false });
        }

        if (!response.ok) {
            throw new Error(`Twitch API ${method} ${path} failed (${response.status}): ${typeof data === 'string' ? data : JSON.stringify(data)}`);
        }
        return data;
    }

    /** Batch-resolve logins -> user IDs. */
    async resolveUserIds(usernames) {
        const logins = [...new Set((usernames || []).map(cleanName).filter(Boolean))];
        if (logins.length === 0) return {};
        const data = await this.request('/users', { query: { login: logins } });
        const idMap = {};
        for (const user of data?.data || []) idMap[cleanName(user.login)] = user.id;
        return idMap;
    }

    /** Channel title + live status for AI context. */
    async getChannelInfo(broadcasterId) {
        const channelData = await this.request('/channels', { query: { broadcaster_id: broadcasterId } });
        const channelInfo = channelData?.data?.[0];
        if (!channelInfo) return null;
        const streamData = await this.request('/streams', { query: { user_id: broadcasterId } });
        return {
            channelName: channelInfo.broadcaster_login,
            title: channelInfo.title,
            isLive: Array.isArray(streamData?.data) && streamData.data.length > 0
        };
    }

    /** Send chat via App Access Token - preserves the official Chatbot badge. */
    async sendChatMessage({ broadcasterId, senderId, message }) {
        const data = await this.request('/chat/messages', {
            method: 'POST',
            useAppToken: true,
            body: { broadcaster_id: broadcasterId, sender_id: senderId, message }
        });
        const result = data?.data?.[0];
        if (!result) throw new Error('Twitch chat API returned no result.');
        if (!result.is_sent) throw new Error(`Twitch rejected chat message: ${JSON.stringify(result.drop_reason || {})}`);
        return result;
    }
}

class IrcBridge {
    #client;
    #connected = false;

    constructor({ botUsername, channels, tokenVault, ircClientFactory, onMessage, onStatus }) {
        this.#client = ircClientFactory({
            connection: { reconnect: true, secure: true },
            identity: {
                username: botUsername,
                // Dynamic provider: every (re)connect resolves the freshest user token.
                password: async () => `oauth:${await tokenVault.getUserToken()}`
            },
            channels
        });
        this.#client.on('message', (channel, tags, text, self) => onMessage(normalizeIrcMessage(channel, tags, text, self)));
        this.#client.on('connected', (address, port) => {
            this.#connected = true;
            onStatus({ type: 'connected', address, port });
        });
        this.#client.on('disconnected', reason => {
            this.#connected = false;
            onStatus({ type: 'disconnected', reason });
        });
    }

    get connected() { return this.#connected; }

    async connect() {
        await this.#client.connect(); // identity password provider resolves the user token during auth
    }

    async disconnect() {
        try {
            await this.#client.disconnect();
        } catch (err) {
            console.error('[TwitchTransport] IRC disconnect failed:', err.message);
        }
        this.#connected = false;
    }
}

class MessageBufferStore {
    #buffers = new Map();
    #maxBufferSize;
    #now;

    constructor({ maxBufferSize = 1000, now = Date.now } = {}) {
        this.#maxBufferSize = maxBufferSize;
        this.#now = now;
    }

    append(channel, username, message, meta = null) {
        const key = channelKey(channel);
        if (!this.#buffers.has(key)) this.#buffers.set(key, []);
        const buffer = this.#buffers.get(key);
        const entry = { username, message, timestamp: this.#now(), meta: meta && typeof meta === 'object' ? meta : null };
        buffer.push(entry);
        if (buffer.length > this.#maxBufferSize) buffer.shift();
        return entry;
    }

    /** AI-facing logs: newest `count`, minus excluded logins and command-prefixed lines. */
    recentLogs(channel, { count = 10, excludeLogins = [], excludePrefixes = [] } = {}) {
        const buffer = this.#buffers.get(channelKey(channel)) || [];
        return buffer
            .slice(-count)
            .filter(entry => {
                const login = cleanName(entry.username || '');
                if (excludeLogins.includes(login)) return false;
                const message = String(entry.message || '').toLowerCase().trim();
                return !excludePrefixes.some(prefix => message.startsWith(prefix));
            })
            .map(entry => `${entry.username}: ${entry.message}`);
    }
}

export class TwitchTransport {
    #clientId;
    #botUsername;
    #channels;
    #ignored;
    #maxMessageLength;
    #chunkDelayMs;
    #vault;
    #helix;
    #irc;
    #buffers;
    #botId = null;
    #channelIdMap = {};
    #running = false;
    #bootPromise = null;
    #messageHandlers = [];
    #logHandlers = [];
    #statusHandlers = [];

    constructor(options = {}) {
        const {
            clientId = '',
            clientSecret = '',
            botUsername = '',
            channels = [],
            initialRefreshToken = '',
            storage = null,
            maxBufferSize = 1000,
            maxMessageLength = 499,
            chunkDelayMs = 1000,
            ignoredUsernames = [],
            fetchImpl = globalThis.fetch.bind(globalThis),
            ircClientFactory = (tmiOptions) => new tmi.client(tmiOptions),
            nowFn = Date.now
        } = options;

        this.#clientId = clientId;
        this.#botUsername = cleanName(botUsername);
        this.#channels = (channels || []).map(channelKey).filter(key => key !== '#');
        this.#ignored = new Set((ignoredUsernames || []).map(cleanName).filter(Boolean));
        this.#maxMessageLength = maxMessageLength;
        this.#chunkDelayMs = chunkDelayMs;

        this.#vault = new TokenVault({ clientId, clientSecret, initialRefreshToken, storage, fetchImpl, now: nowFn });
        this.#helix = new HelixClient({ clientId, tokenVault: this.#vault, fetchImpl });
        this.#buffers = new MessageBufferStore({ maxBufferSize, now: nowFn });
        this.#irc = new IrcBridge({
            botUsername: this.#botUsername,
            channels: this.#channels,
            tokenVault: this.#vault,
            ircClientFactory,
            onMessage: msg => this.#ingest(msg),
            onStatus: status => this.#emitStatus(status)
        });

        this.auth = {
            getLoginUrl: (redirectUri, state) => this.#buildLoginUrl(redirectUri, state),
            handleCallback: (code, redirectUri) => this.#handleCallback(code, redirectUri),
            getStatus: () => this.#getStatus(),
            isAuthorized: () => this.#vault.isAuthorized()
        };
    }

    /* ── runtime lifecycle ─────────────────────────────────── */

    /** Boots from stored/seed tokens, resolves Helix IDs, connects IRC - or stands by. */
    async start(handlers = {}) {
        if (handlers.onMessage) this.onMessage(handlers.onMessage);
        if (handlers.onLogEntry) this.onLogEntry(handlers.onLogEntry);
        if (handlers.onStatus) this.onStatus(handlers.onStatus);

        if (!this.#vault.isAuthorized()) {
            const bootstrapped = await this.#vault.bootstrap();
            if (!bootstrapped) {
                console.log('[TwitchTransport] Not authorized. Standing by for /auth/login.');
                this.#emitStatus({ type: 'auth_required' });
                return { authorized: false, connected: false };
            }
        }
        try {
            return await this.#bootRuntime();
        } catch (err) {
            console.error('[TwitchTransport] Runtime failed to start:', err.message);
            return { authorized: true, connected: false, error: err.message };
        }
    }

    async stop() {
        this.#running = false;
        await this.#irc.disconnect();
    }

    /* ── outbound delivery ─────────────────────────────────── */

    /**
     * Delivers chat via Helix with the App Access Token (official Chatbot badge).
     * Flattens newlines, chunks >maxMessageLength on word boundaries paced
     * chunkDelayMs apart, retries 401s transparently, logs each delivered chunk.
     */
    async send(channel, message) {
        const flat = String(message ?? '').replace(/\s+/g, ' ').trim();
        if (!flat) return { sent: 0 };
        const chunks = chunkMessage(flat, this.#maxMessageLength);
        let sent = 0;
        for (const chunk of chunks) {
            if (sent > 0) await delay(this.#chunkDelayMs);
            await this.#sendChunk(channel, chunk);
            this.logMessage(channel, this.#botUsername, chunk);
            sent++;
        }
        return { sent };
    }

    /* ── AI context ────────────────────────────────────────── */

    /** Stream metadata + command-filtered recent logs in one call for AIEngine. */
    async getContext(channel, { logCount = 10, commandPrefixes = [] } = {}) {
        const broadcasterId = this.#channelIdMap[cleanName(channel)];
        let channelContext = null;
        if (broadcasterId) {
            try {
                channelContext = await this.#helix.getChannelInfo(broadcasterId);
            } catch (err) {
                console.error('[TwitchTransport] Failed to fetch channel info:', err.message);
            }
        }
        const recentLogs = logCount > 0
            ? this.#buffers.recentLogs(channel, { count: logCount, excludeLogins: [this.#botUsername], excludePrefixes: commandPrefixes })
            : [];
        return { channelContext, recentLogs };
    }

    /* ── ingestion & history ───────────────────────────────── */

    onMessage(handler) { this.#messageHandlers.push(handler); }
    onLogEntry(handler) { this.#logHandlers.push(handler); }
    onStatus(handler) { this.#statusHandlers.push(handler); }

    /** Appends to the channel history buffer (post-emote-processing text) and emits onLogEntry. */
    logMessage(channel, username, message, meta = null) {
        const entry = this.#buffers.append(channel, username, message, meta);
        for (const handler of this.#logHandlers) {
            try {
                handler(channelKey(channel), entry);
            } catch (err) {
                console.error('[TwitchTransport] onLogEntry handler failed:', err.message);
            }
        }
        return entry;
    }

    /* ── getters ───────────────────────────────────────────── */

    get channels() { return [...this.#channels]; }
    get connected() { return this.#irc.connected; }
    get botId() { return this.#botId; }
    get channelIdMap() { return { ...this.#channelIdMap }; }
    /** Config-shaped map (channel -> resolved ID or null) for the dashboard. */
    get channelIds() {
        const out = {};
        for (const channel of this.#channels) out[channel] = this.#channelIdMap[cleanName(channel)] || null;
        return out;
    }

    /* ── auth facade internals ─────────────────────────────── */

    #buildLoginUrl(redirectUri, state = '') {
        if (!this.#clientId) throw new Error('Twitch client ID is required to build the authorization URL.');
        const url = new URL(`${ID_BASE}/authorize`);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', this.#clientId);
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('scope', TWITCH_AUTH_SCOPES.join(' '));
        if (state) url.searchParams.set('state', state);
        return url.toString();
    }

    async #handleCallback(code, redirectUri) {
        if (!code) throw new Error('Missing authorization code.');
        await this.#vault.exchangeCode(String(code), redirectUri, this.#botUsername);
        try {
            await this.#bootRuntime();
        } catch (err) {
            // Auth succeeded; a transient runtime failure must not fail the OAuth callback.
            console.error('[TwitchTransport] Runtime failed to start after authorization:', err.message);
        }
        return this.#getStatus();
    }

    #getStatus() {
        return {
            authorized: this.#vault.isAuthorized(),
            connected: this.#irc.connected,
            botUsername: this.#botUsername,
            botId: this.#botId,
            channels: this.channels,
            channelIdMap: this.channelIdMap
        };
    }

    /* ── internals ─────────────────────────────────────────── */

    async #bootRuntime() {
        if (this.#running) return { authorized: true, connected: this.#irc.connected };
        if (this.#bootPromise) return this.#bootPromise;
        this.#bootPromise = (async () => {
            await this.#vault.getUserToken();
            await this.#resolveIds();
            await this.#irc.connect();
            this.#running = true;
            return { authorized: true, connected: true };
        })();
        try {
            return await this.#bootPromise;
        } finally {
            this.#bootPromise = null;
        }
    }

    async #resolveIds() {
        if (!this.#botUsername) throw new Error('botUsername is required to resolve Twitch user IDs.');
        const logins = [...new Set([this.#botUsername, ...this.#channels.map(cleanName)])];
        const idMap = await this.#helix.resolveUserIds(logins);
        this.#botId = idMap[this.#botUsername] || null;
        if (!this.#botId) throw new Error(`Could not resolve Twitch user ID for bot account "${this.#botUsername}".`);
        this.#channelIdMap = {};
        for (const channel of this.#channels) {
            const login = cleanName(channel);
            const id = idMap[login];
            if (id) this.#channelIdMap[login] = id;
            else console.error(`[TwitchTransport] Could not resolve ID for channel: ${channel}`);
        }
    }

    async #sendChunk(channel, chunk) {
        const broadcasterId = this.#channelIdMap[cleanName(channel)];
        if (!broadcasterId) throw new Error(`No broadcaster ID resolved for channel "${channel}".`);
        if (!this.#botId) throw new Error('Bot user ID is not resolved; call start() before send().');
        await this.#helix.sendChatMessage({ broadcasterId, senderId: this.#botId, message: chunk });
    }

    #ingest(msg) {
        if (msg.self || !msg.loginName || msg.loginName === this.#botUsername) return;
        if (this.#ignored.has(msg.loginName)) {
            console.log(`[TwitchTransport] Ignoring message from ${msg.username}`);
            return;
        }
        for (const handler of this.#messageHandlers) {
            try {
                const result = handler(msg);
                if (result && typeof result.catch === 'function') {
                    result.catch(err => console.error('[TwitchTransport] Message handler failed:', err.message));
                }
            } catch (err) {
                console.error('[TwitchTransport] Message handler failed:', err.message);
            }
        }
    }

    #emitStatus(status) {
        for (const handler of this.#statusHandlers) {
            try {
                handler(status);
            } catch (err) {
                console.error('[TwitchTransport] onStatus handler failed:', err.message);
            }
        }
    }
}

export default TwitchTransport;
