// src/twitch/twitch_transport.js
//
// Deep module owning the entire Twitch transport surface: the sole seam for
// observed chat. IRC (tmi.js) is authoritative for viewer-authored messages;
// a shared bot-token EventSub WebSocket session observes bot-authored messages
// and public alert sources; Helix REST (App Access Token -> official Chatbot badge) sends.
// One private observation path records every Twitch-observed message - exact
// identity, message ID, timestamp, local order - before any routing, ambient,
// or ignored-username policy runs.
// All config and I/O cross the constructor - this module reads zero environment variables directly.

import tmi from 'tmi.js';
import { EventSubClient } from './eventsub_client.js';
import { normalizeBadges } from '../utils/badges.js';
import { BadgeCatalog } from './badge_catalog.js';

const ID_BASE = 'https://id.twitch.tv/oauth2';
const HELIX_BASE = 'https://api.twitch.tv/helix';
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
export const TWITCH_AUTH_SCOPES = [
    'chat:read', 'chat:edit', 'user:bot', 'user:read:chat', 'user:write:chat',
    'clips:edit',
    'moderator:manage:banned_users',
    'moderator:manage:announcements',
    'moderator:manage:shoutouts',
    'moderator:manage:chat_settings',
    'channel:manage:broadcast'
];

export const TWITCH_BROADCASTER_SCOPES = [
    'channel:manage:broadcast',
    'bits:read',
    'channel:read:redemptions',
    'moderator:read:followers',
    'channel:manage:raids',
    'channel:manage:polls',
    'channel:manage:predictions'
];

function normalizedScopes(value) {
    if (Array.isArray(value)) return value.map((scope) => String(scope).trim()).filter(Boolean);
    if (typeof value === 'string') return value.trim().split(/\s+/).filter(Boolean);
    return null;
}

function hasScopeBundle(granted, required) {
    const scopes = normalizedScopes(granted);
    return Array.isArray(scopes) && required.every((scope) => scopes.includes(scope));
}

function firstMissingScope(granted, required) {
    const scopes = normalizedScopes(granted) || [];
    if (required.includes('user:read:chat') && !scopes.includes('user:read:chat')) return 'user:read:chat';
    return required.find((scope) => !scopes.includes(scope)) || null;
}

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

export class InvalidReplyParentError extends Error {
    constructor(dropReason) {
        super(`Twitch rejected native reply parent: ${JSON.stringify(dropReason || {})}`);
        this.name = 'InvalidReplyParentError';
        this.code = 'INVALID_REPLY_PARENT';
        this.dropReason = dropReason || null;
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

export class MissingScopeError extends Error {
    constructor(scope) {
        super(`Twitch grant lacks ${scope}; reauthorization required.`);
        this.name = 'MissingScopeError';
        this.scope = scope;
        // User-facing copy renders from the catalog via ErrorHandler (BOT_SCOPE_MISSING).
        this.key = 'BOT_SCOPE_MISSING';
    }
}

export function renderAuthMismatchHtml({ expected, actual, retryUrl, isBroadcaster = false }) {
    const cleanExpected = String(expected || '').replace(/^[#@]/, '');
    const cleanActual = String(actual || '').replace(/^[#@]/, '');
    const title = isBroadcaster ? 'Broadcaster Authorization Mismatch' : 'Account Authorization Mismatch';
    const explanation = isBroadcaster
        ? `You attempted to link stream management for channel <strong>#${cleanExpected}</strong>, but you authorized with Twitch account <strong>${cleanActual}</strong>.`
        : `This bot is configured to run as <strong>${cleanExpected}</strong>, but you authorized with Twitch account <strong>${cleanActual}</strong>.`;
    const actionText = isBroadcaster
        ? `Log into Twitch as <strong>${cleanExpected}</strong> in your browser (or switch accounts) and try again.`
        : `Log into Twitch as <strong>${cleanExpected}</strong> (or open the authorization link in an <strong>Incognito / Private window</strong>) and try again.`;
    const buttonText = isBroadcaster
        ? `Retry Authorization for #${cleanExpected}`
        : `Retry Authorization with ${cleanExpected}`;

    return `<!doctype html>
<html>
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background: #101113;
            color: #9da2ab;
            line-height: 1.55;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
        }
        .card {
            background: #18191c;
            border: 1px solid #2d3039;
            border-radius: 12px;
            padding: 28px;
            max-width: 520px;
            width: 100%;
        }
        .header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 16px;
        }
        .icon-wrap {
            width: 36px;
            height: 36px;
            border-radius: 8px;
            background: rgba(251, 191, 36, 0.1);
            border: 1px solid rgba(251, 191, 36, 0.25);
            display: flex;
            align-items: center;
            justify-content: center;
            color: #fbbf24;
            flex-shrink: 0;
        }
        h1 {
            color: #e8eaed;
            font-size: 16px;
            font-weight: 600;
            line-height: 1.3;
        }
        p {
            font-size: 13px;
            margin-bottom: 12px;
            color: #9da2ab;
        }
        strong {
            color: #a273ff;
            background: #222429;
            padding: 1px 5px;
            border-radius: 4px;
            border: 1px solid #2d3039;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 12px;
            font-weight: 600;
        }
        .actions {
            margin-top: 20px;
            display: flex;
            gap: 10px;
            align-items: center;
        }
        .button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: #a273ff;
            color: #101113;
            text-decoration: none;
            padding: 9px 18px;
            border-radius: 6px;
            font-weight: 600;
            font-size: 13px;
            transition: filter 0.15s ease;
        }
        .button:hover {
            filter: brightness(1.15);
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="header">
            <div class="icon-wrap">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="8" x2="12" y2="12"></line>
                    <line x1="12" y1="16" x2="12.01" y2="16"></line>
                </svg>
            </div>
            <h1>${title}</h1>
        </div>
        <p>${explanation}</p>
        <p>${actionText}</p>
        <div class="actions">
            <a class="button" href="${retryUrl}">${buttonText}</a>
        </div>
    </div>
</body>
</html>`;
}

const cleanName = (value) => String(value || '').replace('#', '').trim().toLowerCase();
export const channelKey = (channel) => `#${cleanName(channel)}`;
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
    const replyParentMessageId = String(tags['reply-parent-msg-id'] || '');
    const isReply = [
        'reply-parent-msg-id',
        'reply-parent-user-id',
        'reply-parent-user-login',
        'reply-parent-display-name'
    ].some((key) => Object.hasOwn(tags, key));
    return {
        channel: channelKey(channel),
        messageId: String(tags.id || ''),
        username: tags['display-name'] || tags.username || '',
        loginName: cleanName(tags.username || ''),
        text: String(text ?? ''),
        tags,
        isReply,
        replyParentMessageId,
        replyParentUserId: String(tags['reply-parent-user-id'] || ''),
        replyParentLogin: cleanName(tags['reply-parent-user-login'] || ''),
        replyParentDisplayName: String(tags['reply-parent-display-name'] || ''),
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
    #appRefreshInFlight = null;
    #refreshInFlight = null;
    #broadcasterTokens = new Map();
    #broadcasterRefreshInFlight = new Map();
    #grantedScopes = null;

    constructor({ clientId, clientSecret, initialRefreshToken, storage, fetchImpl, now }) {
        this.#clientId = clientId;
        this.#clientSecret = clientSecret;
        this.#initialRefreshToken = initialRefreshToken || '';
        this.#storage = storage || null;
        this.#fetchImpl = fetchImpl;
        this.#now = now;
    }

    isAuthorized() { return !!this.#refreshToken; }

    /** True only when the grant satisfies the current fixed bot bundle. */
    hasRequiredScope() {
        return hasScopeBundle(this.#grantedScopes, TWITCH_AUTH_SCOPES);
    }

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
                if (!this.hasRequiredScope()) {
                    console.error('[TwitchTransport] Stored bot grant lacks required Twitch permissions; reauthorization required.');
                    this.#clearUserTokens();
                    continue;
                }
                return true;
            } catch (err) {
                console.error('[TwitchTransport] Refresh token rejected:', err.message);
                this.#clearUserTokens();
            }
        }
        return false;
    }

    /** Exchange an OAuth code; revoke and throw on account or scope mismatch. */
    async exchangeCode(code, redirectUri, expectedLogin) {
        const data = await this.#tokenGrant({
            grant_type: 'authorization_code',
            code: String(code),
            redirect_uri: redirectUri
        });
        let grantedScopes = null;
        if (expectedLogin) {
            const validation = await this.#validateToken(data.access_token);
            const authorizedLogin = cleanName(validation.login || '');
            const expected = cleanName(expectedLogin);
            if (authorizedLogin !== expected) {
                await this.#revokeToken(data.access_token).catch(() => {});
                throw new AuthMismatchError(expected, authorizedLogin);
            }
            grantedScopes = normalizedScopes(validation.scopes);
            if (!hasScopeBundle(grantedScopes, TWITCH_AUTH_SCOPES)) {
                await this.#revokeToken(data.access_token).catch(() => {});
                throw new MissingScopeError(firstMissingScope(grantedScopes, TWITCH_AUTH_SCOPES) || 'required Twitch permissions');
            }
            console.log(`[TwitchTransport] Token verified for bot account: ${authorizedLogin}`);
        }
        this.#setUserTokens(data, grantedScopes);
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
        if (this.#appRefreshInFlight) return this.#appRefreshInFlight;
        this.#appRefreshInFlight = (async () => {
            try {
                const data = await this.#tokenGrant({ grant_type: 'client_credentials' });
                this.#appToken = data.access_token;
                this.#appExpiresAt = this.#now() + Number(data.expires_in || 3600) * 1000;
                return this.#appToken;
            } finally {
                this.#appRefreshInFlight = null;
            }
        })();
        return this.#appRefreshInFlight;
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

    #setUserTokens(data, validatedScopes = null) {
        this.#accessToken = data.access_token;
        this.#refreshToken = data.refresh_token || this.#refreshToken; // Twitch rotates refresh tokens
        this.#expiresAt = this.#now() + Number(data.expires_in || 3600) * 1000;
        const scopes = normalizedScopes(data.scope ?? data.scopes ?? validatedScopes);
        if (scopes) this.#grantedScopes = scopes;
        // Unparseable scope leaves the current state untouched; authorization
        // checks fail closed when no explicit scope set is available.
    }

    #clearUserTokens() {
        this.#accessToken = null;
        this.#refreshToken = null;
        this.#expiresAt = 0;
        this.#grantedScopes = null;
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
        const grantedScopes = normalizedScopes(validation.scopes ?? data.scope ?? data.scopes);
        if (!hasScopeBundle(grantedScopes, TWITCH_BROADCASTER_SCOPES)) {
            await this.#revokeToken(data.access_token).catch(() => {});
            throw new MissingScopeError(firstMissingScope(grantedScopes, TWITCH_BROADCASTER_SCOPES) || 'required broadcaster permissions');
        }
        await this.#setBroadcasterTokens(expected, data, grantedScopes);
        return data;
    }

    async hasBroadcasterToken(channel) {
        const key = cleanName(channel);
        const entry = await this.#loadBroadcasterEntry(key);
        return Boolean(entry?.refreshToken);
    }

    async getBroadcasterStatus(channel) {
        const entry = await this.#loadBroadcasterEntry(cleanName(channel));
        const linked = Boolean(entry?.refreshToken);
        const authorized = linked && hasScopeBundle(entry?.scopes, TWITCH_BROADCASTER_SCOPES);
        return { linked, authorized, needsRelink: linked && !authorized };
    }

    /**
     * Valid broadcaster access token for `channel`, or null.
     * Requires an explicit broadcaster OAuth grant. Never falls back to the bot user token.
     */
    async getBroadcasterAccessToken(channel) {
        const key = cleanName(channel);
        const entry = await this.#loadBroadcasterEntry(key);
        if (!entry?.refreshToken) return null;
        if (!hasScopeBundle(entry.scopes, TWITCH_BROADCASTER_SCOPES)) return null;
        if (entry.accessToken && this.#now() < (entry.expiresAt || 0) - TOKEN_EXPIRY_BUFFER_MS) {
            return entry.accessToken;
        }
        return this.refreshBroadcasterToken(key);
    }

    refreshBroadcasterToken(channel) {
        const key = cleanName(channel);
        if (this.#broadcasterRefreshInFlight.has(key)) {
            return this.#broadcasterRefreshInFlight.get(key);
        }
        const pending = (async () => {
            try {
                const entry = await this.#loadBroadcasterEntry(key);
                if (!entry?.refreshToken) {
                    throw new Error(`No broadcaster refresh token for ${key}`);
                }
                const data = await this.#tokenGrant({
                    grant_type: 'refresh_token',
                    refresh_token: entry.refreshToken
                });
                await this.#setBroadcasterTokens(key, data, normalizedScopes(data.scope ?? data.scopes) ?? entry.scopes);
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

    async #setBroadcasterTokens(channel, data, validatedScopes = null) {
        const current = this.#broadcasterTokens.get(channel);
        const entry = {
            accessToken: data.access_token,
            refreshToken: data.refresh_token || current?.refreshToken,
            expiresAt: this.#now() + Number(data.expires_in || 3600) * 1000,
            scopes: normalizedScopes(data.scope ?? data.scopes ?? validatedScopes) ?? current?.scopes ?? null
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

    constructor({ clientId = '', tokenVault, fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
        this.#clientId = clientId;
        this.#vault = tokenVault;
        this.#fetchImpl = fetchImpl;
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
        let token = accessToken;
        if (!token && broadcasterChannel && this.#vault?.getBroadcasterAccessToken) {
            token = await this.#vault.getBroadcasterAccessToken(broadcasterChannel);
            if (!token) {
                throw new Error(`No broadcaster token for ${cleanName(broadcasterChannel)}`);
            }
        }
        if (!token) {
            token = useAppToken ? await this.#vault.getAppToken() : await this.#vault.getUserToken();
        }

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
                nextAccess = await this.#vault.refreshBroadcasterToken(broadcasterChannel);
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
    async sendChatMessage({ broadcasterId, senderId, message, replyParentMessageId = '' }) {
        const body = { broadcaster_id: broadcasterId, sender_id: senderId, message };
        if (replyParentMessageId) body.reply_parent_message_id = replyParentMessageId;
        let data;
        try {
            data = await this.request('/chat/messages', {
                method: 'POST',
                useAppToken: true,
                body
            });
        } catch (error) {
            const messageText = String(error?.data?.message || '');
            if (error instanceof HelixApiError
                && error.status === 400
                && /reply_parent_message_id/i.test(messageText)
                && /(?:not valid|invalid)/i.test(messageText)) {
                throw new InvalidReplyParentError(error.data);
            }
            throw error;
        }
        const result = data?.data?.[0];
        if (!result) throw new Error('Twitch chat API returned no result.');
        if (!result.is_sent) {
            if (result.drop_reason?.code === 'invalid_reply_parent') {
                throw new InvalidReplyParentError(result.drop_reason);
            }
            throw new Error(`Twitch rejected chat message: ${JSON.stringify(result.drop_reason || {})}`);
        }
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

    async banUser(broadcasterId, moderatorId, { targetUserId, reason }, { signal } = {}) {
        return this.request('/moderation/bans', {
            method: 'POST',
            query: { broadcaster_id: broadcasterId, moderator_id: moderatorId },
            body: { data: { user_id: targetUserId, reason: reason || '' } },
            signal
        });
    }

    async unbanUser(broadcasterId, moderatorId, targetUserId, { signal } = {}) {
        return this.request('/moderation/bans', {
            method: 'DELETE',
            query: { broadcaster_id: broadcasterId, moderator_id: moderatorId, user_id: targetUserId },
            signal
        });
    }

    async updateChatSettings(broadcasterId, moderatorId, settings, { signal } = {}) {
        const body = {};
        if (settings.emoteMode !== undefined) body.emote_mode = settings.emoteMode;
        if (settings.subscriberMode !== undefined) body.subscriber_mode = settings.subscriberMode;
        if (settings.followerMode !== undefined) body.follower_mode = settings.followerMode;
        if (settings.followerModeDuration !== undefined) body.follower_mode_duration = settings.followerModeDuration;
        return this.request('/chat/settings', {
            method: 'PATCH',
            query: { broadcaster_id: broadcasterId, moderator_id: moderatorId },
            body,
            signal
        });
    }

    async createStreamMarker(broadcasterId, description, { accessToken, channel, signal } = {}) {
        const body = { user_id: broadcasterId };
        if (description) body.description = description;
        const data = await this.request('/streams/markers', {
            method: 'POST',
            body,
            accessToken,
            broadcasterChannel: channel ? cleanName(channel) : null,
            signal
        });
        return data?.data?.[0] || null;
    }

    async startRaid(fromBroadcasterId, toBroadcasterId, { accessToken, channel, signal } = {}) {
        return this.request('/raids', {
            method: 'POST',
            query: { from_broadcaster_id: fromBroadcasterId, to_broadcaster_id: toBroadcasterId },
            accessToken,
            broadcasterChannel: channel ? cleanName(channel) : null,
            signal
        });
    }

    async cancelRaid(broadcasterId, { accessToken, channel, signal } = {}) {
        return this.request('/raids', {
            method: 'DELETE',
            query: { broadcaster_id: broadcasterId },
            accessToken,
            broadcasterChannel: channel ? cleanName(channel) : null,
            signal
        });
    }

    async createPoll(broadcasterId, { title, choices, duration }, { accessToken, channel, signal } = {}) {
        const data = await this.request('/polls', {
            method: 'POST',
            body: {
                broadcaster_id: broadcasterId,
                title,
                choices: choices.map((choice) => ({ title: choice })),
                duration
            },
            accessToken,
            broadcasterChannel: channel ? cleanName(channel) : null,
            signal
        });
        return data?.data?.[0] || null;
    }

    async createPrediction(broadcasterId, { title, outcomes, duration }, { accessToken, channel, signal } = {}) {
        const data = await this.request('/predictions', {
            method: 'POST',
            body: {
                broadcaster_id: broadcasterId,
                title,
                outcomes: outcomes.map((outcome) => ({ title: outcome })),
                prediction_window: duration
            },
            accessToken,
            broadcasterChannel: channel ? cleanName(channel) : null,
            signal
        });
        return data?.data?.[0] || null;
    }

    async getPredictions(broadcasterId, { accessToken, channel, signal } = {}) {
        const data = await this.request('/predictions', {
            query: { broadcaster_id: broadcasterId, first: 20 },
            accessToken,
            broadcasterChannel: channel ? cleanName(channel) : null,
            signal
        });
        return data?.data || [];
    }

    async endPrediction(broadcasterId, { id, status, winningOutcomeId }, { accessToken, channel, signal } = {}) {
        const body = { broadcaster_id: broadcasterId, id, status };
        if (winningOutcomeId) body.winning_outcome_id = winningOutcomeId;
        const data = await this.request('/predictions', {
            method: 'PATCH',
            body,
            accessToken,
            broadcasterChannel: channel ? cleanName(channel) : null,
            signal
        });
        return data?.data?.[0] || null;
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
    #desiredChannels = [];
    #joinedChannels = new Set();
    #reconcilePromise = null;
    #reconcileRequested = false;
    #connectReconcilePromise = null;
    #onStatus;

    constructor({ botUsername, channels, tokenVault, ircClientFactory, onMessage, onStatus }) {
        this.#desiredChannels = this.#normalizeChannels(channels);
        this.#onStatus = onStatus;
        this.#client = ircClientFactory({
            connection: { reconnect: true, secure: true },
            identity: {
                username: botUsername,
                // Dynamic provider: every (re)connect resolves the freshest user token.
                password: async () => `oauth:${await tokenVault.getUserToken()}`
            },
            channels: []
        });
        this.#client.on('message', (channel, tags, text, self) => onMessage(normalizeIrcMessage(channel, tags, text, self)));
        this.#client.on('connected', (address, port) => {
            this.#connected = true;
            onStatus({ type: 'connected', address, port });
            this.#connectReconcilePromise = this.#queueReconcile();
        });
        this.#client.on('disconnected', reason => {
            this.#connected = false;
            this.#joinedChannels.clear();
            this.#connectReconcilePromise = null;
            onStatus({ type: 'disconnected', reason });
        });
        this.#client.on('join', (channel, _username, self) => {
            if (!self) return;
            const key = channelKey(channel);
            if (!key || key === '#' || this.#joinedChannels.has(key)) return;
            this.#joinedChannels.add(key);
            onStatus({ type: 'joined', channel: key });
            if (!this.#desiredChannels.includes(key)) void this.#queueReconcile();
        });
        this.#client.on('part', (channel, _username, self) => {
            if (!self) return;
            const key = channelKey(channel);
            if (!this.#joinedChannels.delete(key)) return;
            onStatus({ type: 'parted', channel: key });
            if (this.#desiredChannels.includes(key)) void this.#queueReconcile();
        });
    }

    get connected() {
        return this.#connected || this.#client?.readyState?.() === 'OPEN';
    }

    get joinedChannels() {
        return [...this.#joinedChannels];
    }

    async connect() {
        await this.#client.connect(); // identity password provider resolves the user token during auth
        if (!this.#connected) {
            this.#connected = true;
            this.#onStatus({ type: 'connected' });
            this.#connectReconcilePromise = this.#queueReconcile();
        }
        await this.#connectReconcilePromise;
    }

    async syncChannels(channels) {
        const next = this.#normalizeChannels(channels);
        const changed = next.length !== this.#desiredChannels.length
            || next.some((channel, index) => channel !== this.#desiredChannels[index]);
        this.#desiredChannels = next;
        if (!this.connected) return;
        if (this.#reconcilePromise && changed) this.#reconcileRequested = true;
        await this.#queueReconcile();
    }

    #normalizeChannels(channels) {
        return [...new Set((channels || []).map(channelKey).filter(key => key && key !== '#'))];
    }

    #queueReconcile() {
        if (!this.connected) return Promise.resolve();
        if (this.#reconcilePromise) return this.#reconcilePromise;
        this.#reconcilePromise = (async () => {
            try {
                do {
                    this.#reconcileRequested = false;
                    await this.#reconcileOnce();
                } while (this.#reconcileRequested && this.connected);
            } finally {
                this.#reconcilePromise = null;
            }
        })();
        return this.#reconcilePromise;
    }

    async #reconcileOnce() {
        const desired = new Set(this.#desiredChannels);
        const toJoin = this.#desiredChannels.filter(channel => !this.#joinedChannels.has(channel));
        const toPart = [...this.#joinedChannels].filter(channel => !desired.has(channel));
        await Promise.all([
            ...toJoin.map(channel => this.#requestJoin(channel)),
            ...toPart.map(channel => this.#requestPart(channel))
        ]);
    }

    async #requestJoin(channel) {
        if (typeof this.#client?.join !== 'function') return;
        try {
            console.log(`[TwitchTransport] Joining IRC channel: ${channel}`);
            await this.#client.join(channel);
        } catch (err) {
            console.error(`[TwitchTransport] IRC join failed for ${channel}:`, err.message || err);
        }
    }

    async #requestPart(channel) {
        if (typeof this.#client?.part !== 'function') return;
        try {
            console.log(`[TwitchTransport] Parting IRC channel: ${channel}`);
            await this.#client.part(channel);
        } catch (err) {
            console.error(`[TwitchTransport] IRC part failed for ${channel}:`, err.message || err);
        }
    }

    async disconnect() {
        try {
            await this.#client.disconnect();
        } catch (err) {
            console.error('[TwitchTransport] IRC disconnect failed:', err.message);
        }
        if (this.#connected || this.#joinedChannels.size > 0) {
            this.#connected = false;
            this.#joinedChannels.clear();
            this.#onStatus({ type: 'disconnected', reason: 'client disconnected' });
        }
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

    /** Ambient logs hold only policy-eligible observations; entries arrive prebuilt. */
    append(channel, entry) {
        const key = channelKey(channel);
        if (!this.#buffers.has(key)) this.#buffers.set(key, []);
        const buffer = this.#buffers.get(key);
        const stored = {
            username: entry.username,
            message: entry.message,
            timestamp: Number(entry.timestamp) || this.#now(),
            meta: entry.meta && typeof entry.meta === 'object' ? entry.meta : null
        };
        if (Array.isArray(entry.badges) && entry.badges.length > 0) stored.badges = entry.badges;
        if (entry.color) stored.color = entry.color;
        buffer.push(stored);
        if (buffer.length > this.#maxBufferSize) buffer.shift();
        return stored;
    }

    /** AI-facing logs: newest `count` entries, minus excluded logins. */
    recentLogs(channel, { count = 10, excludeLogins = [] } = {}) {
        const buffer = this.#buffers.get(channelKey(channel)) || [];
        return buffer
            .slice(-count)
            .filter(entry => {
                const login = cleanName(entry.username || '');
                return !excludeLogins.includes(login);
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
    #nowFn;
    #vault;
    #helix;
    #irc;
    #buffers;
    #badges = null;
    #eventsub = null;
    #emotePool = null;
    #botId = null;
    #channelIdMap = {};
    #running = false;
    #bootPromise = null;
    #messageHandlers = [];
    #logHandlers = [];
    #statusHandlers = [];
    #eventHandlers = [];
    #messageClassifier = () => ({ kind: 'none' });
    #orders = new Map(); // channelKey -> last assigned local order

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
            emotePool = null,
            fetchImpl = globalThis.fetch.bind(globalThis),
            ircClientFactory = (tmiOptions) => new tmi.client(tmiOptions),
            nowFn = Date.now,
            wsImpl = globalThis.WebSocket,
            eventsubClient = null,
            enableEventSub = true
        } = options;

        this.#clientId = clientId;
        this.#botUsername = cleanName(botUsername);
        this.#channels = [...new Set((channels || []).map(channelKey).filter(key => key !== '#'))];
        this.#ignored = new Set((ignoredUsernames || []).map(cleanName).filter(Boolean));
        this.#maxMessageLength = maxMessageLength;
        this.#chunkDelayMs = chunkDelayMs;
        this.#nowFn = nowFn;

        this.#vault = new TokenVault({ clientId, clientSecret, initialRefreshToken, storage, fetchImpl, now: nowFn });
        this.#helix = new HelixClient({ clientId, tokenVault: this.#vault, fetchImpl });
        if (storage?.getJson && storage?.setJson) {
            this.#badges = new BadgeCatalog({
                helixClient: this.#helix,
                storage,
                nowFn,
                ttlMs: options.badgeCacheTtlMs,
                missCooldownMs: options.badgeMissCooldownMs
            });
        }
        this.#buffers = new MessageBufferStore({ maxBufferSize, now: nowFn });
        this.#emotePool = emotePool;
        this.#irc = new IrcBridge({
            botUsername: this.#botUsername,
            channels: this.#channels,
            tokenVault: this.#vault,
            ircClientFactory,
            onMessage: msg => this.#ingestIrc(msg),
            onStatus: status => this.#emitStatus(status)
        });

        this.#eventHandlers = [];
        this.#eventsub = eventsubClient
            || (enableEventSub === false
                ? null
                : new EventSubClient({
                    helixClient: this.#helix,
                    wsImpl: wsImpl || globalThis.WebSocket,
                    nowFn
                }));

        if (this.#eventsub?.onEvent) {
            this.#eventsub.onEvent((event) => this.#emitEvent(event));
        }
        // Bot-token EventSub session: authoritative observation of bot chat.
        if (this.#eventsub?.onBotChat) {
            this.#eventsub.onBotChat(obs => this.#ingestBotChat(obs));
        }

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
        if (handlers.onEvent) this.onEvent(handlers.onEvent);

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
        try {
            await this.#eventsub?.disconnect?.();
        } catch (err) {
            console.error('[TwitchTransport] EventSub disconnect failed:', err.message);
        }
        await this.#irc.disconnect();
    }

    /* ── outbound delivery ─────────────────────────────────── */

    /**
     * Delivers chat via Helix with the App Access Token (official Chatbot badge).
     * Flattens newlines, chunks >maxMessageLength on word boundaries paced
     * chunkDelayMs apart, retries 401s transparently. Delivery is a separate
     * fact from observation: the transcript row arrives only when the
     * bot-token EventSub session reports Twitch's own record of the message.
     */
    async send(channel, message, { replyParentMessageId = '' } = {}) {
        const flat = String(message ?? '').replace(/\s+/g, ' ').trim();
        if (!flat) return { sent: 0 };
        const chunks = chunkMessage(flat, this.#maxMessageLength);
        let sent = 0;
        for (const chunk of chunks) {
            if (sent > 0) await delay(this.#chunkDelayMs);
            await this.#sendChunk(channel, chunk, { replyParentMessageId });
            sent++;
        }
        return { sent };
    }

    /* ── AI context ────────────────────────────────────────── */

    /** Stream metadata + recent logs in one call for AIEngine. */
    async getContext(channel, { logCount = 10 } = {}) {
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
            ? this.#buffers.recentLogs(channel, { count: logCount, excludeLogins: [this.#botUsername] })
            : [];
        return { channelContext, recentLogs };
    }

    /* ── ingestion & history ───────────────────────────────── */

    onMessage(handler) {
        this.#messageHandlers.push(handler);
        return () => {
            this.#messageHandlers = this.#messageHandlers.filter(h => h !== handler);
        };
    }
    onLogEntry(handler) {
        this.#logHandlers.push(handler);
        return () => {
            this.#logHandlers = this.#logHandlers.filter(h => h !== handler);
        };
    }
    onStatus(handler) {
        this.#statusHandlers.push(handler);
        return () => {
            this.#statusHandlers = this.#statusHandlers.filter(h => h !== handler);
        };
    }
    onEvent(handler) {
        this.#eventHandlers.push(handler);
        return () => {
            this.#eventHandlers = this.#eventHandlers.filter(h => h !== handler);
        };
    }

    #emitEvent(event) {
        for (const handler of this.#eventHandlers) {
            try {
                const result = handler(event);
                if (result && typeof result.catch === 'function') {
                    result.catch((err) => console.error('[TwitchTransport] Event handler failed:', err.message));
                }
            } catch (err) {
                console.error('[TwitchTransport] Event handler failed:', err.message);
            }
        }
    }

    /* ── getters & dynamic setters ──────────────────────────── */

    setIgnoredUsernames(usernames) {
        this.#ignored = new Set((usernames || []).map(cleanName).filter(Boolean));
    }

    /** ChatRouter-owned synchronous invocation policy for ambient projection. */
    setMessageClassifier(classifier) {
        this.#messageClassifier = typeof classifier === 'function'
            ? classifier
            : () => ({ kind: 'none' });
    }

    get botUserId() { return this.#botId; }

    /**
     * Hot-reloads the active channel list: diffs additions/removals, resolves Helix IDs,
     * joins/parts IRC chat, and updates both EventSub session families.
     * @param {string[]} channels
     */
    async syncChannels(channels) {
        const nextKeys = [...new Set((channels || []).map(channelKey).filter(k => k && k !== '#'))];
        const oldKeys = new Set(this.#channels);
        const toAdd = nextKeys.filter(k => !oldKeys.has(k));
        const toRemove = this.#channels.filter(k => !nextKeys.includes(k));
        const configuredChanged = toAdd.length > 0 || toRemove.length > 0;

        this.#channels = nextKeys;
        await this.#irc.syncChannels(nextKeys);
        if (!configuredChanged) return this.channels;

        if (toAdd.length > 0) {
            const logins = toAdd.map(cleanName);
            try {
                const newIds = await this.#helix.resolveUserIds(logins);
                Object.assign(this.#channelIdMap, newIds);
            } catch (err) {
                console.warn('[TwitchTransport] Failed to resolve IDs for added channels:', err.message);
            }
        }

        for (const ch of toAdd) {
            if (this.#running) {
                await this.#subscribeEventSubChannel(ch);
                await this.#subscribePublicEventSubChannel(ch);
            }
        }

        for (const ch of toRemove) {
            await this.#unsubscribePublicEventSubChannel(ch);
            this.#unsubscribeEventSubChannel(ch);
        }

        if (this.#badges) {
            const activeIds = {};
            for (const channel of this.#channels) {
                const login = cleanName(channel);
                if (this.#channelIdMap[login]) activeIds[login] = this.#channelIdMap[login];
            }
            await this.#badges.syncChannels(activeIds);
        }

        this.#emitStatus({ type: 'channels_synced' });
        return this.channels;
    }

    get channels() { return [...this.#channels]; }
    get joinedChannels() { return this.#irc.joinedChannels; }
    get connected() { return this.#irc.connected; }
    get botId() { return this.#botId; }
    get channelIdMap() { return { ...this.#channelIdMap }; }
    get helix() { return this.#helix; }
    get badges() { return this.#badges; }

    async getBroadcasterToken(channel) {
        return this.#vault.getBroadcasterAccessToken(channel);
    }

    async getChannelAuthStatuses() {
        const statuses = {};
        for (const channel of this.#channels) {
            const key = cleanName(channel);
            const grant = await this.#vault.getBroadcasterStatus(key);
            statuses[channel] = {
                channel,
                authorized: grant.authorized,
                linked: grant.linked,
                needsRelink: grant.needsRelink,
                isBot: Boolean(this.#botUsername && key === cleanName(this.#botUsername))
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
        if (this.#running) {
            try {
                await this.#subscribeEventSubChannel(channel);
            } catch (err) {
                console.error('[TwitchTransport] EventSub subscribe after broadcaster link failed:', err.message);
            }
        }
        return { authorized: true, channel: cleanName(channel) };
    }

    #getStatus() {
        return {
            authorized: this.#vault.isAuthorized(),
            connected: this.#irc.connected,
            botUsername: this.#botUsername,
            botId: this.#botId,
            channels: this.channels,
            joinedChannels: this.joinedChannels,
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
            await this.#badges?.initialize(this.#channelIdMap);
            await this.#irc.connect();
            await this.#startEventSub();
            this.#running = true;
            return { authorized: true, connected: true };
        })();
        try {
            return await this.#bootPromise;
        } finally {
            this.#bootPromise = null;
        }
    }

    async #startEventSub() {
        if (!this.#eventsub) return;
        try {
            await this.#eventsub.connect();
        } catch (err) {
            console.error('[TwitchTransport] EventSub failed to start:', err.message);
        }
        await this.#subscribeEventSubChannels();
        await this.#startPublicEventSubSession();
    }

    /** Opens the shared public/bot-authorized session for every joined channel. */
    async #startPublicEventSubSession() {
        if (!this.#eventsub?.configurePublicSession || !this.#botId) return;
        try {
            this.#eventsub.configurePublicSession({
                userId: this.#botId,
                getAccessToken: () => this.#vault.getUserToken()
            });
        } catch (err) {
            console.error('[TwitchTransport] Public EventSub session failed to start:', err.message);
            return;
        }
        for (const channel of this.#channels) {
            await this.#subscribePublicEventSubChannel(channel);
        }
    }

    async #subscribePublicEventSubChannel(channel) {
        if (!this.#eventsub?.subscribePublicChannel || !this.#botId) return;
        const login = cleanName(channel);
        const broadcasterId = this.#channelIdMap[login];
        if (!broadcasterId) return;
        try {
            // Bot user identity only: no broadcaster token or moderator status required.
            await this.#eventsub.subscribePublicChannel({
                broadcasterUserId: broadcasterId,
                broadcasterChannel: login
            });
        } catch (err) {
            console.error(`[TwitchTransport] Public EventSub subscribe failed for ${channel}:`, err.message);
        }
    }

    async #unsubscribePublicEventSubChannel(channel) {
        if (!this.#eventsub?.unsubscribePublicChannel) return;
        const login = cleanName(channel);
        const broadcasterId = this.#channelIdMap[login];
        if (!broadcasterId) return;
        try {
            await this.#eventsub.unsubscribePublicChannel(broadcasterId);
        } catch (err) {
            console.error(`[TwitchTransport] Public EventSub unsubscribe failed for ${channel}:`, err.message);
        }
    }

    async #subscribeEventSubChannels() {
        for (const channel of this.#channels) {
            await this.#subscribeEventSubChannel(channel);
        }
    }

    /** Drops a removed channel's EventSub session and its cached Helix ID. */
    #unsubscribeEventSubChannel(channel) {
        if (!this.#eventsub?.unsubscribeChannel) return;
        const login = cleanName(channel);
        const broadcasterId = this.#channelIdMap[login];
        if (!broadcasterId) return;
        try {
            this.#eventsub.unsubscribeChannel(broadcasterId);
            delete this.#channelIdMap[login];
        } catch (err) {
            console.error(`[TwitchTransport] EventSub unsubscribe failed for ${channel}:`, err.message);
        }
    }

    async #subscribeEventSubChannel(channel) {
        if (!this.#eventsub) return;
        const login = cleanName(channel);
        const broadcasterId = this.#channelIdMap[login];
        if (!broadcasterId) return;

        if (!(await this.#vault.hasBroadcasterToken(login))) {
            console.warn(`[TwitchTransport] No broadcaster token for ${channel}; skipping EventSub subscriptions.`);
            return;
        }

        let token = null;
        try {
            token = await this.#vault.getBroadcasterAccessToken(login);
        } catch (err) {
            console.warn(`[TwitchTransport] Broadcaster token lookup failed for ${channel}:`, err.message);
            return;
        }
        if (!token) {
            console.warn(`[TwitchTransport] No broadcaster token for ${channel}; skipping EventSub subscriptions.`);
            return;
        }

        try {
            await this.#eventsub.subscribeChannel({
                broadcasterUserId: broadcasterId,
                broadcasterChannel: login,
                accessToken: token,
                moderatorUserId: broadcasterId
            });
        } catch (err) {
            console.error(`[TwitchTransport] EventSub subscribe failed for ${channel}:`, err.message);
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

    async #sendChunk(channel, chunk, { replyParentMessageId = '' } = {}) {
        const broadcasterId = this.#channelIdMap[cleanName(channel)];
        if (!broadcasterId) throw new Error(`No broadcaster ID resolved for channel "${channel}".`);
        if (!this.#botId) throw new Error('Bot user ID is not resolved; call start() before send().');
        await this.#helix.sendChatMessage({
            broadcasterId,
            senderId: this.#botId,
            message: chunk,
            replyParentMessageId
        });
    }

    /* ── observation path ──────────────────────────────────── */

    /**
     * IRC ingestion: authoritative for viewer-authored messages. The message
     * is recorded before routing eligibility, ignored-username rules, or
     * ambient-log policy run. Twitch does not echo the bot's own PRIVMSG back,
     * and any bot-authored IRC line would double-count against the EventSub
     * record, so those are discarded outright.
     */
    #ingestIrc(msg) {
        if (msg.self || !msg.loginName || msg.loginName === this.#botUsername) return;
        this.#observe({
            channel: msg.channel,
            loginName: msg.loginName,
            username: msg.username,
            text: msg.text,
            tags: msg.tags || {},
            id: msg.messageId,
            timestamp: Number(msg.tags?.['tmi-sent-ts']) || this.#nowFn(),
            authoredByBot: false,
            isReply: msg.isReply,
            replyParentMessageId: msg.replyParentMessageId,
            replyParentUserId: msg.replyParentUserId,
            replyParentLogin: msg.replyParentLogin,
            replyParentDisplayName: msg.replyParentDisplayName,
            isMod: msg.isMod,
            isBroadcaster: msg.isBroadcaster
        });
    }

    /**
     * Bot-token EventSub ingestion: authoritative for bot-authored messages.
     * Viewer-authored notifications are discarded because IRC owns viewers.
     */
    #ingestBotChat(observation) {
        const channel = channelKey(observation.channel);
        if (
            String(this.#botId || '') === ''
            || observation.chatterUserId !== String(this.#botId)
            || !this.#channels.includes(channel)
        ) return;
        this.#observe({
            channel,
            loginName: observation.loginName,
            username: observation.username,
            text: observation.text,
            tags: observation.tags || {},
            id: observation.id || '',
            timestamp: Number(observation.timestamp) || this.#nowFn(),
            authoredByBot: true
        });
    }

    /**
     * The one private observation path. Records the canonical transcript
     * entry - exact Twitch ID, identity, emote metadata, source timestamp,
     * and monotonic local order assigned before any listener runs - then
     * applies the projection policy: bot-authored observations are transcript-
     * only; ignored usernames are transcript-only; viewer commands are kept
     * out of ambient logs; ordinary viewer messages flow everywhere eligible.
     */
    #observe(obs) {
        const key = channelKey(obs.channel);

        // Exact Twitch identity only: a live observation without its canonical
        // message id is discarded rather than given synthetic identity.
        const id = String(obs.id || '');
        if (!id) {
            console.warn(`[TwitchTransport] Discarding ${key} message without a canonical Twitch message id`);
            return;
        }

        const routable = !obs.authoredByBot && !this.#ignored.has(obs.loginName);

        const { text, emotes } = this.#normalizeTranscriptText(key, obs.text, obs.tags);
        const badges = normalizeBadges(obs.tags);
        const color = typeof obs.tags?.color === 'string' && obs.tags.color.trim() ? obs.tags.color.trim() : '';

        const entry = {
            id,
            username: obs.username,
            message: text,
            timestamp: Number(obs.timestamp) || this.#nowFn(),
            meta: Object.keys(emotes).length > 0 ? { twitchEmotesByName: emotes } : {},
            order: this.#nextLocalOrder(key)
        };
        if (badges.length > 0) entry.badges = badges;
        if (color) entry.color = color;

        // Transcript emission: complete rows only; consumers never repair them.
        if (entry.badges) void this.#badges?.noteDescriptors(key, entry.badges);
        for (const handler of this.#logHandlers) {
            try {
                handler(key, entry);
            } catch (err) {
                console.error('[TwitchTransport] onLogEntry handler failed:', err.message);
            }
        }

        if (obs.authoredByBot) return; // transcript evidence only: no ambient, no routing, no memory turn

        if (!routable) {
            console.log(`[TwitchTransport] Ignoring message from ${obs.username}`);
            return;
        }

        const viewerMessage = {
            channel: key,
            messageId: id,
            username: obs.username,
            loginName: obs.loginName,
            text: obs.text,
            tags: obs.tags,
            isReply: !!obs.isReply,
            replyParentMessageId: String(obs.replyParentMessageId || ''),
            replyParentUserId: String(obs.replyParentUserId || ''),
            replyParentLogin: cleanName(obs.replyParentLogin || ''),
            replyParentDisplayName: String(obs.replyParentDisplayName || ''),
            isMod: !!obs.isMod,
            isBroadcaster: !!obs.isBroadcaster,
            self: false
        };
        let invocation = { kind: 'none' };
        try {
            invocation = this.#messageClassifier(viewerMessage) || invocation;
        } catch (err) {
            console.error('[TwitchTransport] Message classification failed:', err.message);
        }

        if (invocation.kind === 'none') {
            this.#buffers.append(key, entry);
        }

        for (const handler of this.#messageHandlers) {
            try {
                const result = handler({ ...viewerMessage, invocation });
                if (result && typeof result.catch === 'function') {
                    result.catch(err => console.error('[TwitchTransport] Message handler failed:', err.message));
                }
            } catch (err) {
                console.error('[TwitchTransport] Message handler failed:', err.message);
            }
        }
    }

    /** Transcript pass: flags channel + native emotes via the injected pool. */
    #normalizeTranscriptText(channelKey, text, tags) {
        if (this.#emotePool?.ingestMessage) {
            const { textForLogs, emoteIdMap } = this.#emotePool.ingestMessage({ channel: channelKey, text, tags });
            return { text: textForLogs, emotes: emoteIdMap };
        }
        return { text: String(text ?? ''), emotes: {} };
    }

    #nextLocalOrder(key) {
        const previous = this.#orders.get(key) || 0;
        const now = Number(this.#nowFn());
        const clockOrder = Number.isFinite(now) && now > 0 ? Math.floor(now * 1000) : 1;
        const next = Math.max(previous + 1, clockOrder);
        this.#orders.set(key, next);
        return next;
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
