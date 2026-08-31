import crypto from 'crypto';

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_PENDING = 256;

export class OAuthStateStore {
    #pending = new Map();
    #now;
    #ttlMs;
    #maxPending;
    #randomBytes;

    constructor({
        now = Date.now,
        ttlMs = DEFAULT_TTL_MS,
        maxPending = DEFAULT_MAX_PENDING,
        randomBytes = crypto.randomBytes
    } = {}) {
        this.#now = now;
        this.#ttlMs = ttlMs;
        this.#maxPending = maxPending;
        this.#randomBytes = randomBytes;
    }

    create(metadata) {
        this.#prune();
        while (this.#pending.size >= this.#maxPending) {
            this.#pending.delete(this.#pending.keys().next().value);
        }
        let state;
        do {
            state = this.#randomBytes(24).toString('base64url');
        } while (this.#pending.has(state));
        this.#pending.set(state, {
            ...metadata,
            expiresAt: this.#now() + this.#ttlMs
        });
        return state;
    }

    consume(state, bindings = {}) {
        this.#prune();
        const key = String(state || '');
        const pending = this.#pending.get(key);
        if (!pending) return null;
        this.#pending.delete(key);
        for (const [name, expected] of Object.entries(bindings)) {
            if (expected !== undefined && pending[name] !== expected) return null;
        }
        return pending;
    }

    #prune() {
        const now = this.#now();
        for (const [state, pending] of this.#pending) {
            if (pending.expiresAt <= now) this.#pending.delete(state);
        }
    }

    get size() {
        this.#prune();
        return this.#pending.size;
    }
}
