// src/utils/storage.js
//
// Deep Storage module with dual adapters: UpstashRedisAdapter (REST pipelining)
// and MemoryStorageAdapter (full-fidelity in-memory store).
// All configuration crosses the constructor; this module reads zero process.env variables.

const DEFAULT_MAX_CHAT_ENTRIES = 1000;
const DEFAULT_MAX_MEDIA_ENTRIES = 500;
const DEFAULT_CHAT_READ_LIMIT = 200;
const TOKENS_KEY = 'twitch:tokens';
const MEDIA_KEY = 'media_log';

function normalizeChannel(channel) {
    return String(channel || '').replace(/^#/, '').toLowerCase();
}

function chatKey(channel) {
    return `chat:${normalizeChannel(channel)}`;
}

function safeJsonParse(value) {
    if (value == null) return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function parseStoredList(items) {
    if (!Array.isArray(items)) return [];
    return items.map(safeJsonParse).filter(Boolean);
}

function normalizeTokenPayload(accessTokenOrPayload, refreshToken, expiration) {
    if (accessTokenOrPayload && typeof accessTokenOrPayload === 'object') {
        return {
            accessToken: accessTokenOrPayload.accessToken,
            refreshToken: accessTokenOrPayload.refreshToken,
            expiration: accessTokenOrPayload.expiration
        };
    }
    return {
        accessToken: accessTokenOrPayload,
        refreshToken,
        expiration
    };
}

function resolveRedisConnection({ redisUrl, restUrl, restToken } = {}) {
    let resolvedUrl = null;
    let resolvedToken = null;

    if (redisUrl) {
        try {
            const parsed = new URL(redisUrl);
            resolvedUrl = `https://${parsed.hostname}`;
            resolvedToken = parsed.password || null;
        } catch (error) {
            console.error('[Storage] Failed to parse redisUrl:', error.message);
        }
    }

    if (restUrl && restToken) {
        resolvedUrl = restUrl;
        resolvedToken = restToken;
    }

    if (resolvedUrl && resolvedToken) {
        return { restUrl: resolvedUrl, restToken: resolvedToken };
    }
    return null;
}

export class MemoryStorageAdapter {
    constructor({
        maxChatEntries = DEFAULT_MAX_CHAT_ENTRIES,
        maxMediaEntries = DEFAULT_MAX_MEDIA_ENTRIES
    } = {}) {
        this.maxChatEntries = maxChatEntries;
        this.maxMediaEntries = maxMediaEntries;
        this.chat = new Map();
        this.media = [];
        this.tokens = null;
        this.configured = false;
        this.isPersistent = false;
    }

    async addChatMessage(channel, entry) {
        try {
            const key = normalizeChannel(channel);
            const list = this.chat.get(key) || [];
            list.push(entry);
            if (list.length > this.maxChatEntries) list.shift();
            this.chat.set(key, list);
        } catch (error) {
            console.error('[Storage] Memory write failed:', error.message);
        }
    }

    async getChatLog(channel, limit = DEFAULT_CHAT_READ_LIMIT) {
        try {
            const list = this.chat.get(normalizeChannel(channel)) || [];
            return list.slice(-limit);
        } catch (error) {
            console.error('[Storage] Memory read failed:', error.message);
            return [];
        }
    }

    async addMediaEntry(entry) {
        try {
            this.media.push(entry);
            if (this.media.length > this.maxMediaEntries) this.media.shift();
        } catch (error) {
            console.error('[Storage] Memory write failed:', error.message);
        }
    }

    async getMediaLog(limit = DEFAULT_MAX_MEDIA_ENTRIES) {
        try {
            return [...this.media].reverse().slice(0, limit);
        } catch (error) {
            console.error('[Storage] Memory read failed:', error.message);
            return [];
        }
    }

    async setTokens(accessTokenOrPayload, refreshToken, expiration) {
        try {
            this.tokens = normalizeTokenPayload(accessTokenOrPayload, refreshToken, expiration);
        } catch (error) {
            console.error('[Storage] Memory write failed:', error.message);
        }
    }

    async getTokens() {
        try {
            return this.tokens ? { ...this.tokens } : null;
        } catch (error) {
            console.error('[Storage] Memory read failed:', error.message);
            return null;
        }
    }
}

export class UpstashRedisAdapter {
    constructor({
        redisUrl,
        restUrl,
        restToken,
        fetchImpl,
        maxChatEntries = DEFAULT_MAX_CHAT_ENTRIES,
        maxMediaEntries = DEFAULT_MAX_MEDIA_ENTRIES
    } = {}) {
        const connection = resolveRedisConnection({ redisUrl, restUrl, restToken });
        this.restUrl = connection?.restUrl || restUrl || null;
        this.token = connection?.restToken || restToken || null;
        this.fetchImpl = fetchImpl || globalThis.fetch;
        this.maxChatEntries = maxChatEntries;
        this.maxMediaEntries = maxMediaEntries;
        this.configured = true;
        this.isPersistent = true;
    }

    async request(endpoint, payload) {
        try {
            const res = await this.fetchImpl(`${this.restUrl}${endpoint}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                const txt = await res.text();
                throw new Error(`Upstash ${res.status}: ${txt}`);
            }
            return await res.json();
        } catch (error) {
            console.error('[Storage] API Error:', error.message);
            return null;
        }
    }

    async addChatMessage(channel, entry) {
        try {
            const key = chatKey(channel);
            await this.request('/pipeline', [
                ['RPUSH', key, JSON.stringify(entry)],
                ['LTRIM', key, -this.maxChatEntries, -1]
            ]);
        } catch (error) {
            console.error('[Storage] API Error:', error.message);
        }
    }

    async getChatLog(channel, limit = DEFAULT_CHAT_READ_LIMIT) {
        try {
            const data = await this.request('/', ['LRANGE', chatKey(channel), -limit, -1]);
            return parseStoredList(data?.result);
        } catch (error) {
            console.error('[Storage] API Error:', error.message);
            return [];
        }
    }

    async addMediaEntry(entry) {
        try {
            await this.request('/pipeline', [
                ['RPUSH', MEDIA_KEY, JSON.stringify(entry)],
                ['LTRIM', MEDIA_KEY, -this.maxMediaEntries, -1]
            ]);
        } catch (error) {
            console.error('[Storage] API Error:', error.message);
        }
    }

    async getMediaLog(limit = DEFAULT_MAX_MEDIA_ENTRIES) {
        try {
            const data = await this.request('/', ['LRANGE', MEDIA_KEY, -limit, -1]);
            return parseStoredList(data?.result).reverse();
        } catch (error) {
            console.error('[Storage] API Error:', error.message);
            return [];
        }
    }

    async setTokens(accessTokenOrPayload, refreshToken, expiration) {
        try {
            const value = JSON.stringify(
                normalizeTokenPayload(accessTokenOrPayload, refreshToken, expiration)
            );
            await this.request('/', ['SET', TOKENS_KEY, value]);
        } catch (error) {
            console.error('[Storage] API Error:', error.message);
        }
    }

    async getTokens() {
        try {
            const data = await this.request('/', ['GET', TOKENS_KEY]);
            if (!data?.result) return null;
            return safeJsonParse(data.result);
        } catch (error) {
            console.error('[Storage] API Error:', error.message);
            return null;
        }
    }
}

export class Storage {
    constructor(config = {}) {
        const connection = resolveRedisConnection(config);
        const shared = {
            fetchImpl: config.fetchImpl,
            maxChatEntries: config.maxChatEntries,
            maxMediaEntries: config.maxMediaEntries
        };

        if (connection) {
            this.adapter = new UpstashRedisAdapter({ ...connection, ...shared });
            console.log(`[Storage] Connected to ${connection.restUrl}`);
        } else {
            this.adapter = new MemoryStorageAdapter(shared);
            console.warn('[Storage] No Redis credentials found. Persistence disabled (Memory only).');
        }
    }

    get configured() {
        return this.adapter.configured;
    }

    get isPersistent() {
        return this.adapter.isPersistent;
    }

    addChatMessage(channel, entry) {
        return this.adapter.addChatMessage(channel, entry);
    }

    getChatLog(channel, limit) {
        return this.adapter.getChatLog(channel, limit);
    }

    addMediaEntry(entry) {
        return this.adapter.addMediaEntry(entry);
    }

    getMediaLog(limit) {
        return this.adapter.getMediaLog(limit);
    }

    setTokens(accessTokenOrPayload, refreshToken, expiration) {
        return this.adapter.setTokens(accessTokenOrPayload, refreshToken, expiration);
    }

    getTokens() {
        return this.adapter.getTokens();
    }
}