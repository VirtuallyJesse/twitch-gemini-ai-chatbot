// src/utils/storage.js
//
// Deep Storage module with dual adapters: UpstashRedisAdapter (REST pipelining)
// and MemoryStorageAdapter (full-fidelity in-memory store).
// All configuration crosses the constructor; this module reads zero process.env variables.

import crypto from 'crypto';

const DEFAULT_MAX_CHAT_ENTRIES = 10000;
const DEFAULT_MAX_MEDIA_ENTRIES = 10000;
export const MAX_CHAT_PAGE_SIZE = 500;
const DEFAULT_CHAT_READ_LIMIT = MAX_CHAT_PAGE_SIZE;
const DEFAULT_CHAT_FLUSH_INTERVAL_MS = 10_000;
const TOKENS_KEY = 'twitch:tokens';
const MEDIA_KEY = 'media_log';
const defaultTimers = {
    setInterval: (...args) => setInterval(...args),
    clearInterval: (...args) => clearInterval(...args)
};

function normalizeChannel(channel) {
    return String(channel || '').replace(/^#/, '').toLowerCase();
}

function chatKey(channel) {
    return `chat:${normalizeChannel(channel)}`;
}

function chatEntriesKey(channel) {
    return `chat:v2:${normalizeChannel(channel)}:entries`;
}

function chatOrderKey(channel) {
    return `chat:v2:${normalizeChannel(channel)}:order`;
}

function chatMigrationKey(channel) {
    return `chat:v2:${normalizeChannel(channel)}:migrated`;
}

// TODO(after 2026-12): Delete the v1 repair branch below. It is intentional
// migration dead weight only until deployed channels have advanced to v2.
const MIGRATE_CHAT_LUA = `
local migrationVersion = redis.call('GET', KEYS[1])
if migrationVersion == '2' then return {'READY'} end

if migrationVersion then
  local indexed = redis.call('ZRANGE', KEYS[3], 0, -1, 'WITHSCORES')
  local repaired = 0
  for index = 1, #indexed, 2 do
    local raw = indexed[index]
    local score = tonumber(indexed[index + 1])
    local ok, entry = pcall(cjson.decode, raw)
    if not ok or type(entry) ~= 'table' or not score then
      return {'ERROR', 'INVALID_CHAT_ENTRY'}
    end
    if type(entry.order) ~= 'number' or entry.order ~= score then
      entry.order = score
      redis.call('ZREM', KEYS[3], raw)
      redis.call('ZADD', KEYS[3], score, cjson.encode(entry))
      repaired = repaired + 1
    end
  end
  redis.call('SET', KEYS[1], '2')
  return {'REPAIRED', tostring(repaired)}
end

local rows = redis.call('LRANGE', KEYS[2], 0, -1)
local last = 0
local upgraded = {}
for _, raw in ipairs(rows) do
  local ok, entry = pcall(cjson.decode, raw)
  if not ok or type(entry) ~= 'table' then
    return {'ERROR', 'INVALID_CHAT_ENTRY'}
  end
  local requested = tonumber(entry.order) or 0
  if requested <= last then requested = last + 1 end
  last = requested
  entry.order = last
  if type(entry.id) ~= 'string' or entry.id == '' then
    entry.id = ARGV[1] .. ':' .. tostring(last)
  end
  table.insert(upgraded, {last, cjson.encode(entry)})
end
for _, item in ipairs(upgraded) do
  redis.call('ZADD', KEYS[3], item[1], item[2])
end
redis.call('ZREMRANGEBYRANK', KEYS[3], 0, -tonumber(ARGV[2]) - 1)
redis.call('SET', KEYS[4], last)
redis.call('SET', KEYS[1], '2')
redis.call('DEL', KEYS[2])
return {'MIGRATED', tostring(last)}
`;

const ADD_CHAT_BATCH_LUA = `
local entries = cjson.decode(ARGV[1])
local last = tonumber(redis.call('GET', KEYS[2])) or 0
local stored = {}
for _, entry in ipairs(entries) do
  local requested = tonumber(entry.order) or 0
  if requested <= last then requested = last + 1 end
  last = requested
  entry.order = requested
  local encoded = cjson.encode(entry)
  redis.call('ZADD', KEYS[1], requested, encoded)
  table.insert(stored, encoded)
end
if #entries > 0 then redis.call('SET', KEYS[2], last) end
redis.call('ZREMRANGEBYRANK', KEYS[1], 0, -tonumber(ARGV[2]) - 1)
return cjson.encode(stored)
`;

function nextEntryOrder(list, now = Date.now()) {
    const previous = Number(list.at(-1)?.order) || 0;
    return Math.max(previous + 1, now * 1000);
}

function withChatMetadata(entry, fallbackOrder, minimumOrder = 0) {
    const requested = Number.isSafeInteger(entry?.order) && entry.order > 0
        ? entry.order
        : fallbackOrder;
    return {
        ...entry,
        id: typeof entry?.id === 'string' && entry.id ? entry.id : crypto.randomUUID(),
        order: requested > minimumOrder ? requested : Math.max(fallbackOrder, minimumOrder + 1)
    };
}

function timestampOrder(timestamp) {
    const numeric = Number(timestamp);
    if (Number.isFinite(numeric) && numeric > 0) return numeric * 1000;
    const parsed = Date.parse(String(timestamp || ''));
    return Number.isFinite(parsed) ? parsed * 1000 : 1;
}

function createCursorCodec(secret) {
    if (typeof secret !== 'string' || !secret.trim()) {
        throw new TypeError('cursorSecret is required');
    }
    const key = secret;
    return {
        encode(payload) {
            const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
            const signature = crypto.createHmac('sha256', key).update(body).digest('base64url');
            return `${body}.${signature}`;
        },
        decode(cursor) {
            if (typeof cursor !== 'string') return null;
            const [body, signature, extra] = cursor.split('.');
            if (!body || !signature || extra) return null;
            const expected = crypto.createHmac('sha256', key).update(body).digest();
            let actual;
            try {
                actual = Buffer.from(signature, 'base64url');
            } catch {
                return null;
            }
            if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
            try {
                return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
            } catch {
                return null;
            }
        }
    };
}

function validatePageLimit(limit) {
    return Number.isInteger(limit) && limit > 0 && limit <= MAX_CHAT_PAGE_SIZE;
}

function broadcasterKey(channel) {
    return `tokens:broadcaster:${normalizeChannel(channel)}`;
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
        maxMediaEntries = DEFAULT_MAX_MEDIA_ENTRIES,
        cursorSecret
    } = {}) {
        this.maxChatEntries = maxChatEntries;
        this.maxMediaEntries = maxMediaEntries;
        this.chat = new Map();
        this.migratedChat = new Set();
        this.cursorCodec = createCursorCodec(cursorSecret);
        this.media = [];
        this.tokens = null;
        this.kv = new Map();
        this.configured = false;
        this.isPersistent = false;
    }

    async setJson(key, value) {
        try {
            this.kv.set(String(key), JSON.stringify(value));
            return true;
        } catch (error) {
            console.error('[Storage] Memory write failed:', error.message);
            return false;
        }
    }

    async getJson(key) {
        try {
            if (!this.kv.has(String(key))) return null;
            return safeJsonParse(this.kv.get(String(key)));
        } catch (error) {
            console.error('[Storage] Memory read failed:', error.message);
            return null;
        }
    }

    async getValue(key) {
        try {
            return this.kv.has(String(key)) ? this.kv.get(String(key)) : null;
        } catch (error) {
            console.error('[Storage] Memory read failed:', error.message);
            return null;
        }
    }

    async getValues(keys) {
        try {
            return (keys || []).map((key) => this.kv.has(String(key)) ? this.kv.get(String(key)) : null);
        } catch (error) {
            console.error('[Storage] Memory read failed:', error.message);
            return (keys || []).map(() => null);
        }
    }

    async setValue(key, value) {
        try {
            this.kv.set(String(key), String(value));
            return true;
        } catch (error) {
            console.error('[Storage] Memory write failed:', error.message);
            return false;
        }
    }

    async deleteValue(key) {
        try {
            this.kv.delete(String(key));
            return true;
        } catch (error) {
            console.error('[Storage] Memory delete failed:', error.message);
            return false;
        }
    }

    async addChatMessage(channel, entry) {
        try {
            const key = normalizeChannel(channel);
            const list = this.chat.get(key) || [];
            const previous = Number(list.at(-1)?.order) || 0;
            const stored = withChatMetadata(entry, nextEntryOrder(list), previous);
            list.push(stored);
            if (list.length > this.maxChatEntries) list.shift();
            this.chat.set(key, list);
            this.migratedChat.add(key);
            return stored;
        } catch (error) {
            console.error('[Storage] Memory write failed:', error.message);
            return null;
        }
    }

    async flushChatMessages() {}

    async dispose() {}

    #upgradeChat(channel) {
        if (this.migratedChat.has(channel)) return this.chat.get(channel) || [];
        const source = this.chat.get(channel) || [];
        let lastOrder = 0;
        const upgraded = source.map((entry) => {
            const fallback = Math.max(lastOrder + 1, timestampOrder(entry?.timestamp));
            const stored = withChatMetadata(entry, fallback, lastOrder);
            lastOrder = stored.order;
            return stored;
        });
        this.chat.set(channel, upgraded);
        this.migratedChat.add(channel);
        return upgraded;
    }

    async getChatLogPage(channel, { limit = DEFAULT_CHAT_READ_LIMIT, cursor = null } = {}) {
        try {
            if (!validatePageLimit(limit)) return { ok: false, error: 'INVALID_LIMIT' };
            const key = normalizeChannel(channel);
            const list = this.#upgradeChat(key);
            let before = Number.POSITIVE_INFINITY;
            let floor = Number(list[0]?.order) || null;

            if (cursor != null) {
                const decoded = this.cursorCodec.decode(cursor);
                if (
                    !decoded || decoded.v !== 1 || decoded.channel !== key ||
                    !Number.isSafeInteger(decoded.before) || !Number.isSafeInteger(decoded.floor)
                ) {
                    return { ok: false, error: 'INVALID_CURSOR' };
                }
                if (floor == null) return { ok: false, error: 'STALE_CURSOR' };
                if (floor != null && floor > decoded.floor) return { ok: false, error: 'STALE_CURSOR' };
                before = decoded.before;
                floor = decoded.floor;
            }

            const eligible = list.filter((entry) => entry.order < before);
            const entries = eligible.slice(-limit);
            const hasMore = eligible.length > entries.length;
            const nextCursor = hasMore
                ? this.cursorCodec.encode({ v: 1, channel: key, before: entries[0].order, floor })
                : null;
            return { ok: true, entries, nextCursor, hasMore };
        } catch (error) {
            console.error('[Storage] Memory read failed:', error.message);
            return { ok: false, error: 'HISTORY_UNAVAILABLE' };
        }
    }

    async getChatLog(channel, limit = DEFAULT_CHAT_READ_LIMIT) {
        try {
            const list = this.#upgradeChat(normalizeChannel(channel));
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

    async getBroadcasterToken(channel) {
        try {
            return await this.getJson(broadcasterKey(channel));
        } catch (err) {
            console.error('[Storage] getBroadcasterToken failed:', err.message);
            return null;
        }
    }

    async setBroadcasterToken(channel, payload) {
        try {
            await this.setJson(broadcasterKey(channel), payload);
        } catch (err) {
            console.error('[Storage] setBroadcasterToken failed:', err.message);
        }
    }

    async deleteBroadcasterToken(channel) {
        try {
            this.kv.delete(broadcasterKey(channel));
        } catch (err) {
            console.error('[Storage] deleteBroadcasterToken failed:', err.message);
        }
    }
}

export class UpstashRedisAdapter {
    constructor({
        redisUrl,
        restUrl,
        restToken,
        fetchImpl,
        timerImpl = defaultTimers,
        chatFlushIntervalMs = DEFAULT_CHAT_FLUSH_INTERVAL_MS,
        maxChatEntries = DEFAULT_MAX_CHAT_ENTRIES,
        maxMediaEntries = DEFAULT_MAX_MEDIA_ENTRIES,
        cursorSecret
    } = {}) {
        const connection = resolveRedisConnection({ redisUrl, restUrl, restToken });
        this.restUrl = connection?.restUrl || restUrl || null;
        this.token = connection?.restToken || restToken || null;
        this.fetchImpl = fetchImpl || globalThis.fetch;
        this.timer = timerImpl;
        this.chatFlushIntervalMs = Math.max(1, Number(chatFlushIntervalMs) || DEFAULT_CHAT_FLUSH_INTERVAL_MS);
        this.maxChatEntries = maxChatEntries;
        this.maxMediaEntries = maxMediaEntries;
        this.cursorCodec = createCursorCodec(cursorSecret);
        this.migratedChat = new Set();
        this.chatQueues = new Map();
        this.chatFlushInFlight = null;
        this.disposed = false;
        this.configured = true;
        this.isPersistent = true;
        this.chatFlushTimer = this.timer.setInterval(
            () => this.flushChatMessages(),
            this.chatFlushIntervalMs
        );
        this.chatFlushTimer?.unref?.();
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
            if (this.disposed) return null;
            const normalized = normalizeChannel(channel);
            const candidate = withChatMetadata(entry, Date.now() * 1000);
            const queue = this.chatQueues.get(normalized) || [];
            queue.push(candidate);
            this.chatQueues.set(normalized, queue);
            return candidate;
        } catch (error) {
            console.error('[Storage] API Error:', error.message);
            return null;
        }
    }

    async flushChatMessages() {
        if (this.chatFlushInFlight) return this.chatFlushInFlight;
        const run = this.#flushChatQueues();
        this.chatFlushInFlight = run;
        try {
            await run;
        } finally {
            if (this.chatFlushInFlight === run) this.chatFlushInFlight = null;
        }
    }

    async #flushChatQueues() {
        const batches = [];
        for (const [channel, entries] of this.chatQueues) {
            if (entries.length === 0) continue;
            batches.push([channel, entries]);
            this.chatQueues.set(channel, []);
        }

        await Promise.all(batches.map(async ([channel, entries]) => {
            try {
                const migrated = await this.#ensureChatMigrated(channel);
                const data = migrated && await this.request('/', [
                    'EVAL', ADD_CHAT_BATCH_LUA, 2,
                    chatEntriesKey(channel), chatOrderKey(channel),
                    JSON.stringify(entries), this.maxChatEntries
                ]);
                if (data && data.result != null) {
                    if ((this.chatQueues.get(channel) || []).length === 0) this.chatQueues.delete(channel);
                    return;
                }
            } catch (error) {
                console.error(`[Storage] Chat batch serialization failed for #${channel}:`, error.message);
            }
            const pending = this.chatQueues.get(channel) || [];
            this.chatQueues.set(channel, [...entries, ...pending]);
            console.error(`[Storage] Chat batch flush failed for #${channel}; ${entries.length} entries retained.`);
        }));
    }

    async dispose() {
        if (this.disposed) return;
        this.disposed = true;
        if (this.chatFlushTimer) {
            this.timer.clearInterval(this.chatFlushTimer);
            this.chatFlushTimer = null;
        }
        if (this.chatFlushInFlight) await this.chatFlushInFlight;
        if ([...this.chatQueues.values()].some((entries) => entries.length > 0)) {
            await this.flushChatMessages();
        }
    }

    async #ensureChatMigrated(channel) {
        if (this.migratedChat.has(channel)) return true;
        const data = await this.request('/', [
            'EVAL', MIGRATE_CHAT_LUA, 4,
            chatMigrationKey(channel), chatKey(channel), chatEntriesKey(channel), chatOrderKey(channel),
            `legacy:${channel}`, this.maxChatEntries
        ]);
        if (!data || !Array.isArray(data.result) || data.result[0] === 'ERROR') return false;
        this.migratedChat.add(channel);
        return true;
    }

    async getChatLogPage(channel, { limit = DEFAULT_CHAT_READ_LIMIT, cursor = null } = {}) {
        try {
            if (!validatePageLimit(limit)) return { ok: false, error: 'INVALID_LIMIT' };
            const normalized = normalizeChannel(channel);
            if (!await this.#ensureChatMigrated(normalized)) {
                return { ok: false, error: 'HISTORY_UNAVAILABLE' };
            }

            let decoded = null;
            if (cursor != null) {
                decoded = this.cursorCodec.decode(cursor);
                if (
                    !decoded || decoded.v !== 1 || decoded.channel !== normalized ||
                    !Number.isSafeInteger(decoded.before) || !Number.isSafeInteger(decoded.floor)
                ) {
                    return { ok: false, error: 'INVALID_CURSOR' };
                }
            }

            const pageCommand = decoded
                ? ['ZREVRANGEBYSCORE', chatEntriesKey(normalized), `(${decoded.before}`, '-inf', 'LIMIT', 0, limit]
                : ['ZRANGE', chatEntriesKey(normalized), -limit, -1];
            const data = await this.request('/pipeline', [
                pageCommand,
                ['ZRANGE', chatEntriesKey(normalized), 0, 0]
            ]);
            if (!Array.isArray(data)) return { ok: false, error: 'HISTORY_UNAVAILABLE' };

            const pageResult = data[0]?.result;
            const oldestResult = data[1]?.result;
            if (!Array.isArray(pageResult) || !Array.isArray(oldestResult)) {
                return { ok: false, error: 'HISTORY_UNAVAILABLE' };
            }
            const entries = parseStoredList(pageResult);
            const oldestEntries = parseStoredList(oldestResult);
            if (entries.length !== pageResult.length || oldestEntries.length !== oldestResult.length) {
                return { ok: false, error: 'HISTORY_UNAVAILABLE' };
            }
            if (decoded) entries.reverse();
            const currentFloor = Number(oldestEntries[0]?.order) || null;
            if (decoded && currentFloor == null) return { ok: false, error: 'STALE_CURSOR' };
            if (decoded && currentFloor != null && currentFloor > decoded.floor) {
                return { ok: false, error: 'STALE_CURSOR' };
            }
            const floor = decoded?.floor ?? currentFloor;
            const hasMore = entries.length > 0 && floor != null && entries[0].order > floor;
            const nextCursor = hasMore
                ? this.cursorCodec.encode({
                    v: 1,
                    channel: normalized,
                    before: entries[0].order,
                    floor
                })
                : null;
            return { ok: true, entries, nextCursor, hasMore };
        } catch (error) {
            console.error('[Storage] API Error:', error.message);
            return { ok: false, error: 'HISTORY_UNAVAILABLE' };
        }
    }

    async getChatLog(channel, limit = DEFAULT_CHAT_READ_LIMIT) {
        const page = await this.getChatLogPage(channel, { limit: Math.min(limit, MAX_CHAT_PAGE_SIZE) });
        return page.ok ? page.entries : [];
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

    async setJson(key, value) {
        try {
            const data = await this.request('/', ['SET', String(key), JSON.stringify(value)]);
            return data !== null;
        } catch (error) {
            console.error('[Storage] API Error:', error.message);
            return false;
        }
    }

    async getJson(key) {
        try {
            const data = await this.request('/', ['GET', String(key)]);
            if (!data?.result) return null;
            return safeJsonParse(data.result);
        } catch (error) {
            console.error('[Storage] API Error:', error.message);
            return null;
        }
    }

    async getValue(key) {
        try {
            const data = await this.request('/', ['GET', String(key)]);
            if (!data || data.result == null) return null;
            return typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
        } catch (error) {
            console.error('[Storage] API Error:', error.message);
            return null;
        }
    }

    async getValues(keys) {
        const list = Array.isArray(keys) ? keys : [];
        if (list.length === 0) return [];
        try {
            const data = await this.request('/pipeline', list.map((key) => ['GET', String(key)]));
            if (!Array.isArray(data)) return list.map(() => null);
            return list.map((_, index) => {
                const result = data[index]?.result;
                if (result == null) return null;
                return typeof result === 'string' ? result : JSON.stringify(result);
            });
        } catch (error) {
            console.error('[Storage] API Error:', error.message);
            return list.map(() => null);
        }
    }

    async setValue(key, value) {
        try {
            const data = await this.request('/', ['SET', String(key), String(value)]);
            return data !== null;
        } catch (error) {
            console.error('[Storage] API Error:', error.message);
            return false;
        }
    }

    async deleteValue(key) {
        try {
            const data = await this.request('/', ['DEL', String(key)]);
            return data !== null;
        } catch (error) {
            console.error('[Storage] API Error:', error.message);
            return false;
        }
    }

    async getBroadcasterToken(channel) {
        try {
            return await this.getJson(broadcasterKey(channel));
        } catch (err) {
            console.error('[Storage] getBroadcasterToken failed:', err.message);
            return null;
        }
    }

    async setBroadcasterToken(channel, payload) {
        try {
            await this.setJson(broadcasterKey(channel), payload);
        } catch (err) {
            console.error('[Storage] setBroadcasterToken failed:', err.message);
        }
    }

    async deleteBroadcasterToken(channel) {
        try {
            await this.request('/', ['DEL', broadcasterKey(channel)]);
        } catch (err) {
            console.error('[Storage] deleteBroadcasterToken failed:', err.message);
        }
    }
}

export class Storage {
    constructor(config = {}) {
        const connection = resolveRedisConnection(config);
        const shared = {
            fetchImpl: config.fetchImpl,
            timerImpl: config.timerImpl,
            chatFlushIntervalMs: config.chatFlushIntervalMs,
            maxChatEntries: config.maxChatEntries,
            maxMediaEntries: config.maxMediaEntries,
            cursorSecret: config.cursorSecret
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

    flushChatMessages() {
        return this.adapter.flushChatMessages();
    }

    dispose() {
        return this.adapter.dispose();
    }

    getChatLog(channel, limit) {
        return this.adapter.getChatLog(channel, limit);
    }

    getChatLogPage(channel, options) {
        return this.adapter.getChatLogPage(channel, options);
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

    getBroadcasterToken(channel) {
        return this.adapter.getBroadcasterToken(channel);
    }

    setBroadcasterToken(channel, payload) {
        return this.adapter.setBroadcasterToken(channel, payload);
    }

    deleteBroadcasterToken(channel) {
        return this.adapter.deleteBroadcasterToken(channel);
    }

    setJson(key, value) {
        return this.adapter.setJson(key, value);
    }

    getJson(key) {
        return this.adapter.getJson(key);
    }

    getValue(key) {
        return this.adapter.getValue(key);
    }

    getValues(keys) {
        return this.adapter.getValues(keys);
    }

    setValue(key, value) {
        return this.adapter.setValue(key, value);
    }

    deleteValue(key) {
        return this.adapter.deleteValue(key);
    }
}
