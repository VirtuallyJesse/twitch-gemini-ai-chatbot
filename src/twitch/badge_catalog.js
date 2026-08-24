import crypto from 'node:crypto';

export const BADGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const BADGE_MISS_COOLDOWN_MS = 5 * 60 * 1000;

const cleanChannel = (value) => String(value || '').replace(/^#/, '').trim().toLowerCase();
const channelStorageKey = (broadcasterId) => `badges:channel:${broadcasterId}`;
const GLOBAL_STORAGE_KEY = 'badges:global';

export function indexBadgeSets(sets) {
    const indexed = {};
    for (const rawSet of Array.isArray(sets) ? sets : []) {
        const setId = String(rawSet?.set_id ?? '').trim();
        if (!setId) continue;
        const versions = {};
        for (const rawVersion of Array.isArray(rawSet.versions) ? rawSet.versions : []) {
            const id = String(rawVersion?.id ?? '').trim();
            if (!id) continue;
            versions[id] = { ...rawVersion, id };
        }
        indexed[setId] = { ...rawSet, set_id: setId, versions };
    }
    return indexed;
}

function fingerprint(badges) {
    return crypto.createHash('sha256').update(JSON.stringify(badges)).digest('hex');
}

function emptyEntry() {
    return { fetchedAt: 0, fingerprint: '', badges: {} };
}

function hydrateEntry(payload) {
    if (!payload || typeof payload !== 'object' || !payload.badges || typeof payload.badges !== 'object') {
        return null;
    }
    return {
        fetchedAt: Number(payload.fetched_at) || 0,
        fingerprint: String(payload.fingerprint || ''),
        badges: payload.badges
    };
}

export class BadgeCatalog {
    #helix;
    #storage;
    #now;
    #ttlMs;
    #missCooldownMs;
    #global = emptyEntry();
    #channels = new Map();
    #channelIds = new Map();
    #listeners = new Set();
    #inFlight = new Map();
    #lastMissRefresh = new Map();

    constructor({
        helixClient,
        storage,
        nowFn = Date.now,
        ttlMs = BADGE_CACHE_TTL_MS,
        missCooldownMs = BADGE_MISS_COOLDOWN_MS
    } = {}) {
        if (!helixClient?.request) throw new Error('BadgeCatalog requires a Helix client');
        if (!storage?.getJson || !storage?.setJson) throw new Error('BadgeCatalog requires storage');
        this.#helix = helixClient;
        this.#storage = storage;
        this.#now = nowFn;
        this.#ttlMs = Math.max(0, Number(ttlMs) || 0);
        this.#missCooldownMs = Math.max(0, Number(missCooldownMs) || 0);
    }

    async initialize(channelIdMap = {}, { refresh = true } = {}) {
        await this.#hydrateGlobal();
        await this.syncChannels(channelIdMap, { refresh: false });
        if (refresh) void this.refreshAll();
        return this;
    }

    async syncChannels(channelIdMap = {}, { refresh = true } = {}) {
        const next = new Map();
        for (const [rawChannel, rawId] of Object.entries(channelIdMap || {})) {
            const channel = cleanChannel(rawChannel);
            const broadcasterId = String(rawId || '').trim();
            if (channel && broadcasterId) next.set(channel, broadcasterId);
        }
        this.#channelIds = next;
        await Promise.all([...next.entries()].map(([channel, broadcasterId]) =>
            this.#hydrateChannel(channel, broadcasterId)
        ));
        if (refresh) void this.refreshAll();
    }

    onUpdate(listener) {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    getForChannel(channel) {
        const name = cleanChannel(channel);
        return {
            channel: name,
            badges: {
                channel: this.#channels.get(name)?.badges || {},
                global: this.#global.badges
            }
        };
    }

    async refreshAll({ force = false } = {}) {
        await Promise.all([
            this.refreshGlobal({ force }),
            ...[...this.#channelIds.entries()].map(([channel, broadcasterId]) =>
                this.refreshChannel(channel, broadcasterId, { force })
            )
        ]);
    }

    refreshGlobal({ force = false } = {}) {
        return this.#once('global', async () => {
            if (!force && this.#isFresh(this.#global)) return false;
            try {
                const response = await this.#helix.request('/chat/badges/global', { useAppToken: true });
                const changed = await this.#storeGlobal(indexBadgeSets(response?.data));
                if (changed) {
                    for (const channel of this.#channelIds.keys()) this.#emit(channel);
                }
                return changed;
            } catch (error) {
                console.warn('[Badges] Global refresh failed; keeping cached badges:', error.message);
                return false;
            }
        });
    }

    refreshChannel(channel, broadcasterId, { force = false } = {}) {
        const name = cleanChannel(channel);
        const id = String(broadcasterId || this.#channelIds.get(name) || '').trim();
        if (!name || !id) return Promise.resolve(false);
        return this.#once(`channel:${id}`, async () => {
            const current = this.#channels.get(name) || emptyEntry();
            if (!force && this.#isFresh(current)) return false;
            try {
                const response = await this.#helix.request('/chat/badges', {
                    query: { broadcaster_id: id },
                    useAppToken: true
                });
                const changed = await this.#storeChannel(name, id, indexBadgeSets(response?.data));
                if (changed) this.#emit(name);
                return changed;
            } catch (error) {
                console.warn(`[Badges] Refresh failed for #${name}; keeping cached badges:`, error.message);
                return false;
            }
        });
    }

    noteDescriptors(channel, descriptors) {
        const name = cleanChannel(channel);
        const broadcasterId = this.#channelIds.get(name);
        if (!broadcasterId || !this.#hasUnknown(name, descriptors)) return Promise.resolve(false);
        const last = this.#lastMissRefresh.get(name);
        const now = this.#now();
        if (last !== undefined && now - last < this.#missCooldownMs) return Promise.resolve(false);
        this.#lastMissRefresh.set(name, now);
        return Promise.all([
            this.refreshGlobal({ force: true }),
            this.refreshChannel(name, broadcasterId, { force: true })
        ]).then(() => true);
    }

    #hasUnknown(channel, descriptors) {
        const channelBadges = this.#channels.get(channel)?.badges || {};
        const globalBadges = this.#global.badges;
        for (const badge of Array.isArray(descriptors) ? descriptors : []) {
            const kind = String(badge?.kind || '');
            const version = String(badge?.version || '');
            if (!kind || !version) continue;
            if (channelBadges[kind]?.versions?.[version] || globalBadges[kind]?.versions?.[version]) continue;
            return true;
        }
        return false;
    }

    #isFresh(entry) {
        return entry.fetchedAt > 0 && this.#now() - entry.fetchedAt < this.#ttlMs;
    }

    #once(key, task) {
        if (this.#inFlight.has(key)) return this.#inFlight.get(key);
        const pending = task().finally(() => this.#inFlight.delete(key));
        this.#inFlight.set(key, pending);
        return pending;
    }

    async #hydrateGlobal() {
        try {
            const stored = hydrateEntry(await this.#storage.getJson(GLOBAL_STORAGE_KEY));
            if (stored) this.#global = stored;
        } catch (error) {
            console.warn('[Badges] Failed to hydrate global cache:', error.message);
        }
    }

    async #hydrateChannel(channel, broadcasterId) {
        if (this.#channels.has(channel)) return;
        try {
            const stored = hydrateEntry(await this.#storage.getJson(channelStorageKey(broadcasterId)));
            if (stored) this.#channels.set(channel, stored);
        } catch (error) {
            console.warn(`[Badges] Failed to hydrate #${channel} cache:`, error.message);
        }
    }

    async #storeGlobal(badges) {
        const nextFingerprint = fingerprint(badges);
        const changed = nextFingerprint !== this.#global.fingerprint;
        this.#global = { fetchedAt: this.#now(), fingerprint: nextFingerprint, badges };
        await this.#persist(GLOBAL_STORAGE_KEY, this.#global);
        return changed;
    }

    async #storeChannel(channel, broadcasterId, badges) {
        const nextFingerprint = fingerprint(badges);
        const current = this.#channels.get(channel) || emptyEntry();
        const changed = nextFingerprint !== current.fingerprint;
        const entry = { fetchedAt: this.#now(), fingerprint: nextFingerprint, badges };
        this.#channels.set(channel, entry);
        await this.#persist(channelStorageKey(broadcasterId), entry);
        return changed;
    }

    async #persist(key, entry) {
        try {
            await this.#storage.setJson(key, {
                fetched_at: entry.fetchedAt,
                fingerprint: entry.fingerprint,
                badges: entry.badges
            });
        } catch (error) {
            console.warn(`[Badges] Failed to persist ${key}:`, error.message);
        }
    }

    #emit(channel) {
        const event = this.getForChannel(channel);
        for (const listener of this.#listeners) {
            try { listener(event); } catch (error) {
                console.warn('[Badges] Update listener failed:', error.message);
            }
        }
    }
}

export default BadgeCatalog;
