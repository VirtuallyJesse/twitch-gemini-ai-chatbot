const DEFAULTS = {
    windowMs: 60_000,
    maxClients: 2_000,
    caches: {
        chat: { ttlMs: 5_000, maxEntries: 500 },
        media: { ttlMs: 5_000, maxEntries: 4 },
        badges: { ttlMs: 30_000, maxEntries: 100 }
    },
    families: {
        storage: {
            public: { perIp: 30, global: 240 },
            admin: { perIp: 120, global: 120 }
        },
        helix: {
            public: { perIp: 20, global: 120 },
            admin: { perIp: 100, global: 100 }
        }
    }
};

export class RateLimitError extends Error {
    constructor(retryAfterSeconds) {
        super('Too many requests');
        this.name = 'RateLimitError';
        this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
    }
}

class ExactRequestCache {
    #entries = new Map();
    #inflight = new Map();
    #now;
    #ttlMs;
    #maxEntries;
    #generation = 0;

    constructor({ now, ttlMs, maxEntries }) {
        this.#now = now;
        this.#ttlMs = ttlMs;
        this.#maxEntries = maxEntries;
    }

    cached(key) {
        const entry = this.#entries.get(key);
        if (!entry) return { hit: false };
        if (entry.expiresAt <= this.#now()) {
            this.#entries.delete(key);
            return { hit: false };
        }
        this.#entries.delete(key);
        this.#entries.set(key, entry);
        return { hit: true, value: entry.value };
    }

    pending(key) {
        return this.#inflight.get(key) || null;
    }

    load(key, loader) {
        const generation = this.#generation;
        const promise = Promise.resolve().then(loader).then((value) => {
            if (generation === this.#generation) {
                while (this.#entries.size >= this.#maxEntries) {
                    this.#entries.delete(this.#entries.keys().next().value);
                }
                this.#entries.set(key, { value, expiresAt: this.#now() + this.#ttlMs });
            }
            return value;
        }).finally(() => {
            if (this.#inflight.get(key) === promise) this.#inflight.delete(key);
        });
        this.#inflight.set(key, promise);
        return promise;
    }

    clear() {
        this.#generation += 1;
        this.#entries.clear();
    }

    get size() {
        return this.#entries.size + this.#inflight.size;
    }
}

class FixedWindowBudget {
    #now;
    #windowMs;
    #maxClients;
    #families;
    #clients = new Map();
    #globals = new Map();

    constructor({ now, windowMs, maxClients, families }) {
        this.#now = now;
        this.#windowMs = windowMs;
        this.#maxClients = maxClients;
        this.#families = families;
    }

    take(family, clientIp, isAdmin) {
        const tier = isAdmin ? 'admin' : 'public';
        const limits = this.#families[family]?.[tier];
        if (!limits) throw new Error(`Unknown upstream budget family: ${family}`);
        const now = this.#now();
        const windowStart = Math.floor(now / this.#windowMs) * this.#windowMs;
        const retryAfter = (windowStart + this.#windowMs - now) / 1000;
        this.#prune(windowStart);

        const globalKey = `${family}:${tier}`;
        const global = this.#globals.get(globalKey);
        const globalCount = global?.windowStart === windowStart ? global.count : 0;
        if (globalCount >= limits.global) return { ok: false, retryAfter };

        const clientKey = `${family}:${tier}:${String(clientIp || 'unknown')}`;
        const client = this.#clients.get(clientKey);
        const clientCount = client?.windowStart === windowStart ? client.count : 0;
        if (clientCount >= limits.perIp) return { ok: false, retryAfter };

        this.#globals.set(globalKey, { windowStart, count: globalCount + 1 });
        this.#clients.delete(clientKey);
        this.#clients.set(clientKey, { windowStart, count: clientCount + 1 });
        while (this.#clients.size > this.#maxClients) {
            this.#clients.delete(this.#clients.keys().next().value);
        }
        return { ok: true };
    }

    #prune(windowStart) {
        for (const [key, value] of this.#clients) {
            if (value.windowStart < windowStart) this.#clients.delete(key);
        }
        for (const [key, value] of this.#globals) {
            if (value.windowStart < windowStart) this.#globals.delete(key);
        }
    }

    get trackedClients() {
        return this.#clients.size;
    }
}

function mergePolicy(options) {
    return {
        ...DEFAULTS,
        ...options,
        caches: { ...DEFAULTS.caches, ...(options?.caches || {}) },
        families: {
            storage: {
                ...DEFAULTS.families.storage,
                ...(options?.families?.storage || {})
            },
            helix: {
                ...DEFAULTS.families.helix,
                ...(options?.families?.helix || {})
            }
        }
    };
}

export class AbuseProtection {
    #caches = new Map();
    #budget;

    constructor(options = {}) {
        const policy = mergePolicy(options);
        const now = options.now || Date.now;
        this.#budget = new FixedWindowBudget({
            now,
            windowMs: policy.windowMs,
            maxClients: policy.maxClients,
            families: policy.families
        });
        for (const [name, config] of Object.entries(policy.caches)) {
            this.#caches.set(name, new ExactRequestCache({ now, ...config }));
        }
    }

    async cached({ cache, key, family, clientIp, isAdmin = false, loader }) {
        const store = this.#caches.get(cache);
        if (!store) throw new Error(`Unknown request cache: ${cache}`);
        const hit = store.cached(key);
        if (hit.hit) return hit.value;
        const pending = store.pending(key);
        if (pending) return pending;
        const budget = this.#budget.take(family, clientIp, isAdmin);
        if (!budget.ok) throw new RateLimitError(budget.retryAfter);
        return store.load(key, loader);
    }

    spend({ family, clientIp, isAdmin = false }) {
        const budget = this.#budget.take(family, clientIp, isAdmin);
        if (!budget.ok) throw new RateLimitError(budget.retryAfter);
    }

    invalidate(cache) {
        this.#caches.get(cache)?.clear();
    }

    snapshot() {
        return {
            trackedClients: this.#budget.trackedClients,
            caches: Object.fromEntries([...this.#caches].map(([name, cache]) => [name, cache.size]))
        };
    }
}
