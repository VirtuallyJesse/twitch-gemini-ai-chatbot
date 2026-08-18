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

export const TWITCH_AUTH_SCOPES = [
    'chat:read', 'chat:edit', 'user:bot', 'user:read:chat', 'user:write:chat',
    'clips:edit',
    'moderator:manage:banned_users',
    'moderator:manage:announcements',
    'moderator:manage:shoutouts',
    'channel:manage:broadcast'
];

export const TWITCH_BROADCASTER_SCOPES = ['channel:manage:broadcast'];

export class HelixApiError extends Error {
    constructor(method, path, status, data) {
        const body = typeof data === 'string' ? data : JSON.stringify(data);
        super(`Twitch API ${method} ${path} failed (${status}): ${body}`);
        this.name = 'HelixApiError';
        this.status = status;
        this.path = path;
        this.data = data;
    }
}

export class AuthMismatchError extends Error {
    constructor(expected, actual) {
        super(`Authorization rejected: expected account "${expected}" but got "${actual}". Log into the correct Twitch account and try again.`);
        this.name = 'AuthMismatchError';
        this.expected = expected;
        this.actual = actual;
    }
}

export function renderAuthMismatchHtml({ expected, actual, retryUrl, isBroadcaster = false }) {
    const title = isBroadcaster ? 'Broadcaster Authorization Mismatch' : 'Account Authorization Mismatch';
    const explanation = isBroadcaster
        ? `You attempted to link stream management for channel <strong>#${expected}</strong>, but you authorized with Twitch account <strong>@${actual}</strong>.`
        : `This bot is configured to run as <strong>@${expected}</strong>, but you authorized with Twitch account <strong>@${actual}</strong>.`;
    const actionText = isBroadcaster
        ? `To fix this, log into Twitch as <strong>@${expected}</strong> in your browser (or switch accounts) and try again.`
        : `To fix this, log into Twitch as <strong>@${expected}</strong> (or open the authorization link in an <strong>Incognito / Private window</strong>) and try again.`;
    const buttonText = isBroadcaster
        ? `Retry Authorization for #${expected}`
        : `Retry Authorization with @${expected}`;

    return `<!doctype html>
<html>
<head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
        body { font-family: sans-serif; max-width: 640px; margin: 60px auto; padding: 0 20px; line-height: 1.6; }
        .error-card { border: 1px solid #f87171; background: #fef2f2; border-radius: 8px; padding: 24px; color: #991b1b; }
        h1 { color: #b91c1c; margin-top: 0; font-size: 20px; display: flex; align-items: center; gap: 8px; }
        .button { display: inline-block; background: #9147ff; color: white; text-decoration: none; padding: 10px 18px; border-radius: 6px; font-weight: 600; margin-top: 14px; }
        .button:hover { background: #772ce8; }
        code { background: #fee2e2; padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 14px; }
    </style>
</head>
<body>
    <div class="error-card">
        <h1>⚠️ ${title}</h1>
        <p>${explanation}</p>
        <p>${actionText}</p>
        <a class="button" href="${retryUrl}">${buttonText}</a>
    </div>
</body>
</html>`;
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
    #broadcasterTokens = new Map();
    #broadcasterRefreshInFlight = new Map();

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

    async exchangeBroadcasterCode(channel, code, redirectUri) {
        const expected = cleanName(channel);
        const data = await this.#tokenGrant({
            grant_type: 'authorization_code',
            code: String(code),
            redirect_uri: redirectUri
        });
        const validation = await this.#validateToken(data.access_token);
        const authorizedLogin = cleanName(validation.login || '');
        if (authorizedLogin !== expected) {
            await this.#revokeToken(data.access_token).catch(() => {});
            throw new AuthMismatchError(expected, authorizedLogin);
        }
        await this.#setBroadcasterTokens(expected, data);
        return data;
    }

    async hasBroadcasterToken(channel, botUsername) {
        const key = cleanName(channel);
        if (botUsername && key === cleanName(botUsername) && this.#refreshToken) {
            return true;
        }
        const entry = await this.#loadBroadcasterEntry(key);
        return Boolean(entry?.refreshToken);
    }

    /**
     * Valid broadcaster access token for `channel`, or null.
     * Single-streamer fallback: if the bot login IS the channel, reuse the bot user token.
     */
    async getBroadcasterAccessToken(channel, botUsername) {
        const key = cleanName(channel);
        const entry = await this.#loadBroadcasterEntry(key);
        if (entry?.refreshToken) {
            if (entry.accessToken && this.#now() < (entry.expiresAt || 0) - TOKEN_EXPIRY_BUFFER_MS) {
                return entry.accessToken;
            }
            return this.refreshBroadcasterToken(key, botUsername);
        }
        if (botUsername && key === cleanName(botUsername) && this.#refreshToken) {
            return this.getUserToken();
        }
        return null;
    }

    refreshBroadcasterToken(channel, botUsername = null) {
        const key = cleanName(channel);
        if (this.#broadcasterRefreshInFlight.has(key)) {
            return this.#broadcasterRefreshInFlight.get(key);
        }
        const pending = (async () => {
            try {
                const entry = await this.#loadBroadcasterEntry(key);
                if (!entry?.refreshToken) {
                    if (botUsername && key === cleanName(botUsername) && this.#refreshToken) {
                        await this.forceRefresh();
                        return this.getUserToken();
                    }
                    throw new Error(`No broadcaster refresh token for ${key}`);
                }
                const data = await this.#tokenGrant({
                    grant_type: 'refresh_token',
                    refresh_token: entry.refreshToken
                });
                await this.#setBroadcasterTokens(key, data);
                return this.#broadcasterTokens.get(key).accessToken;
            } catch (err) {
                if (err.grantRejected) {
                    this.#broadcasterTokens.delete(key);
                    await this.#storage?.deleteBroadcasterToken?.(key);
                }
                throw err;
            } finally {
                this.#broadcasterRefreshInFlight.delete(key);
            }
        })();
        this.#broadcasterRefreshInFlight.set(key, pending);
        return pending;
    }

    async #setBroadcasterTokens(channel, data) {
        const entry = {
            accessToken: data.access_token,
            refreshToken: data.refresh_token || this.#broadcasterTokens.get(channel)?.refreshToken,
            expiresAt: this.#now() + Number(data.expires_in || 3600) * 1000
        };
        this.#broadcasterTokens.set(channel, entry);
        if (this.#storage) {
            try {
                await this.#storage.setBroadcasterToken(channel, entry);
            } catch (err) {
                console.error('[TwitchTransport] Failed to persist broadcaster token:', err.message);
            }
        }
    }

    async #loadBroadcasterEntry(key) {
        let entry = this.#broadcasterTokens.get(key);
        if (!entry?.refreshToken && this.#storage) {
            try { entry = await this.#storage.getBroadcasterToken(key); } catch { entry = null; }
            if (entry?.refreshToken) this.#broadcasterTokens.set(key, entry);
        }
        return entry;
    }
}

class HelixClient {
    #clientId;
    #vault;
    #fetchImpl;
    #botUsername;

    constructor({ clientId = '', tokenVault, fetchImpl = globalThis.fetch.bind(globalThis), botUsername = '' } = {}) {
        this.#clientId = clientId;
        this.#vault = tokenVault;
        this.#fetchImpl = fetchImpl;
        this.#botUsername = cleanName(botUsername);
    }

    /** Bearer + Client-Id headers; exactly one 401 retry after refreshing the used token kind. */
    async request(path, {
        method = 'GET',
        query = {},
        body = null,
        useAppToken = false,
        accessToken = null,
        broadcasterChannel = null,
        retry401 = true,
        signal
    } = {}) {
        const token = accessToken
            || (useAppToken ? await this.#vault.getAppToken() : await this.#vault.getUserToken());

        const response = await this.#fetchImpl(buildHelixUrl(path, query), {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                'Client-Id': this.#clientId,
                ...(body ? { 'Content-Type': 'application/json' } : {})
            },
            signal,
            ...(body ? { body: JSON.stringify(body) } : {})
        });
        const data = await readBody(response);

        if (response.status === 401 && retry401) {
            console.warn(`[TwitchTransport] 401 on ${method} ${path}; refreshing token and retrying once.`);
            let nextAccess = null;
            if (broadcasterChannel) {
                nextAccess = await this.#vault.refreshBroadcasterToken(broadcasterChannel, this.#botUsername);
            } else if (useAppToken) {
                this.#vault.invalidateAppToken();
            } else {
                await this.#vault.forceRefresh();
            }
            return this.request(path, {
                method,
                query,
                body,
                useAppToken,
                accessToken: nextAccess,
                broadcasterChannel,
                retry401: false,
                signal
            });
        }

        if (!response.ok) {
            throw new HelixApiError(method, path, response.status, data);
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

    /** Channel title, game category + live status for AI context. */
    async getChannelInfo(broadcasterId) {
        const channelData = await this.request('/channels', { query: { broadcaster_id: broadcasterId } });
        const channelInfo = channelData?.data?.[0];
        if (!channelInfo) return null;
        const streamData = await this.request('/streams', { query: { user_id: broadcasterId } });
        return {
            channelName: channelInfo.broadcaster_login,
            title: channelInfo.title,
            gameName: channelInfo.game_name || '',
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

    async searchCategories(query, { signal } = {}) {
        const data = await this.request('/search/categories', {
            query: { query: String(query || ''), first: 5 },
            useAppToken: true,
            signal
        });
        return (data?.data || []).map((c) => ({
            id: c.id,
            name: c.name,
            box_art_url: c.box_art_url
        }));
    }

    async createClip(broadcasterId, { signal } = {}) {
        const data = await this.request('/clips', {
            method: 'POST',
            query: { broadcaster_id: broadcasterId },
            signal
        });
        const clip = data?.data?.[0];
        if (!clip?.id) throw new Error('Twitch clip API returned no clip id.');
        return { id: clip.id, url: `https://clips.twitch.tv/${clip.id}` };
    }

    async updateChannelInfo(broadcasterId, info, { accessToken, signal, channel } = {}) {
        const body = {};
        if (info.gameId !== undefined) body.game_id = info.gameId;
        if (info.title !== undefined) body.title = info.title;
        if (info.tags !== undefined) body.tags = info.tags;
        if (info.language !== undefined) body.broadcaster_language = info.language;

        await this.request('/channels', {
            method: 'PATCH',
            query: { broadcaster_id: broadcasterId },
            body,
            accessToken,
            broadcasterChannel: channel ? cleanName(channel) : null,
            signal
        });
        return { success: true, updated: info };
    }

    async timeoutUser(broadcasterId, moderatorId, { targetUserId, duration, reason }, { signal } = {}) {
        return this.request('/moderation/bans', {
            method: 'POST',
            query: { broadcaster_id: broadcasterId, moderator_id: moderatorId },
            body: {
                data: {
                    user_id: targetUserId,
                    duration,
                    reason: reason || ''
                }
            },
            signal
        });
    }

    async sendAnnouncement(broadcasterId, moderatorId, { message, color }, { signal } = {}) {
        const allowed = new Set(['primary', 'blue', 'green', 'orange', 'purple']);
        return this.request('/chat/announcements', {
            method: 'POST',
            query: { broadcaster_id: broadcasterId, moderator_id: moderatorId },
            body: {
                message: String(message || '').slice(0, 500),
                color: allowed.has(color) ? color : 'primary'
            },
            signal
        });
    }

    async sendShoutout(broadcasterId, moderatorId, targetBroadcasterId, { signal } = {}) {
        return this.request('/chat/shoutouts', {
            method: 'POST',
            query: {
                from_broadcaster_id: broadcasterId,
                to_broadcaster_id: targetBroadcasterId,
                moderator_id: moderatorId
            },
            signal
        });
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
        this.#helix = new HelixClient({ clientId, tokenVault: this.#vault, fetchImpl, botUsername: this.#botUsername });
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
            getBroadcasterLoginUrl: (redirectUri, channel) => this.#buildBroadcasterLoginUrl(redirectUri, channel),
            handleBroadcasterCallback: (channel, code, redirectUri) =>
                this.#handleBroadcasterCallback(channel, code, redirectUri),
            getStatus: () => this.#getStatus(),
            getChannelAuthStatuses: () => this.getChannelAuthStatuses(),
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
    get helix() { return this.#helix; }

    async getBroadcasterToken(channel) {
        return this.#vault.getBroadcasterAccessToken(channel, this.#botUsername);
    }

    async getChannelAuthStatuses() {
        const statuses = {};
        for (const channel of this.#channels) {
            const key = cleanName(channel);
            const isBot = Boolean(this.#botUsername && key === cleanName(this.#botUsername));
            const authorized = await this.#vault.hasBroadcasterToken(key, this.#botUsername);
            statuses[channel] = {
                channel,
                authorized,
                isBot
            };
        }
        return statuses;
    }

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

    #buildBroadcasterLoginUrl(redirectUri, channel) {
        if (!this.#clientId) throw new Error('Twitch client ID is required to build the authorization URL.');
        const name = cleanName(channel);
        if (!name) throw new Error('channel is required for broadcaster authorization.');
        const url = new URL(`${ID_BASE}/authorize`);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', this.#clientId);
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('scope', TWITCH_BROADCASTER_SCOPES.join(' '));
        url.searchParams.set('state', `broadcaster:${name}`);
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

    async #handleBroadcasterCallback(channel, code, redirectUri) {
        if (!code) throw new Error('Missing authorization code.');
        if (!channel) throw new Error('Missing channel.');
        await this.#vault.exchangeBroadcasterCode(cleanName(channel), String(code), redirectUri);
        return { authorized: true, channel: cleanName(channel) };
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

export { TokenVault, HelixClient };
export default TwitchTransport;
