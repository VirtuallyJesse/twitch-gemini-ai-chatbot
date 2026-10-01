import { retryDelay } from './retry_timing.js';

const staleStatuses = new Set([
    'disabled', 'authorization_revoked', 'user_removed', 'version_removed', 'notification_failures_exceeded',
    'websocket_disconnected', 'websocket_failed_ping_pong', 'websocket_received_inbound_traffic',
    'websocket_connection_unused', 'websocket_internal_error', 'websocket_network_timeout',
    'websocket_network_error', 'websocket_failed_to_reconnect'
]);

const keyOf = item => JSON.stringify([item.type, item.version, Object.entries(item.condition).sort()]);
export function matchesSubscription(sub, item) {
    return sub?.type === item.type
        && (sub.version === undefined || String(sub.version) === item.version)
        && Object.entries(item.condition).every(([key, value]) => String(sub.condition?.[key] || '') === String(value));
}

function terminalReason(status) {
    if (status === 401 || status === 403 || status === 'authorization_revoked') return 'authorization';
    if (status === 400 || status === 404 || status === 'version_removed') return 'unsupported_subscription';
    if (typeof status === 'string' || (status >= 400 && status < 500 && status !== 409 && status !== 429)) return 'revoked';
    return null;
}

/** Desired subscriptions, scoped requests, conflict recovery, and retries for one socket family. */
export class EventSubSubscriptions {
    #helix;
    #options;
    #entries = new Map();
    #sessionId = null;
    #stopped = false;

    constructor(helix, options) {
        this.#helix = helix;
        this.#options = options;
    }

    setDesired(items) {
        const desired = new Set(items.map(keyOf));
        for (const [key, entry] of this.#entries) {
            if (desired.has(key)) continue;
            this.#entries.delete(key);
            this.#cancel(entry);
        }
        for (const item of items) {
            const key = keyOf(item);
            const entry = this.#entries.get(key);
            if (entry) entry.item = item;
            else this.#entries.set(key, { key, item, appliedIn: null, terminal: null, attempt: 0, timer: null, flight: null });
        }
    }

    sessionChanged({ sessionId, previousSessionId, resumed }) {
        this.#sessionId = sessionId;
        for (const entry of this.#entries.values()) {
            this.#cancel(entry);
            entry.appliedIn = resumed && entry.appliedIn === previousSessionId ? sessionId : null;
            entry.attempt = 0;
        }
        void this.reconcile();
    }

    disconnected() {
        this.#sessionId = null;
        for (const entry of this.#entries.values()) this.#cancel(entry);
    }

    stop() {
        this.#stopped = true;
        this.disconnected();
    }

    reauthorize() {
        for (const entry of this.#entries.values()) {
            this.#cancel(entry);
            if (entry.terminal === 'authorization') entry.terminal = null;
            entry.attempt = 0;
        }
        return this.reconcile();
    }

    revoke(subscription) {
        for (const entry of this.#entries.values()) {
            if (!matchesSubscription(subscription, entry.item)) continue;
            entry.appliedIn = null;
            entry.terminal = terminalReason(subscription.status) || 'revoked';
            this.#cancel(entry);
        }
    }

    health(item) {
        const entry = this.#entries.get(keyOf(item));
        if (entry?.terminal) return { state: 'unhealthy', reason: entry.terminal };
        if (!this.#sessionId) return { state: 'disconnected' };
        return { state: entry?.appliedIn === this.#sessionId ? 'ready' : 'pending' };
    }

    reconcile() {
        if (this.#stopped || !this.#sessionId) return Promise.resolve();
        return Promise.all([...this.#entries.values()].map(entry => this.#apply(entry)));
    }

    #current(entry, flight) {
        return !this.#stopped && !flight.cancelled && this.#entries.get(entry.key) === entry
            && this.#sessionId === flight.sessionId && entry.flight === flight;
    }

    #cancel(entry) {
        if (entry.timer !== null) this.#options.clearTimeoutFn(entry.timer);
        entry.timer = null;
        if (entry.flight) {
            entry.flight.cancelled = true;
            entry.flight.controller.abort();
            entry.flight.reject(new Error('Subscription work cancelled'));
        }
    }

    #apply(entry) {
        if (entry.flight) return entry.flight.promise;
        if (entry.terminal || entry.timer !== null || entry.appliedIn === this.#sessionId) return Promise.resolve();
        const flight = { sessionId: this.#sessionId, controller: new AbortController(), cancelled: false };
        entry.flight = flight;
        const cancelled = new Promise((_, reject) => { flight.reject = reject; });
        const timeout = this.#options.setTimeoutFn(() => {
            flight.controller.abort();
            flight.reject(new Error('EventSub subscription request timed out'));
        }, 10_000);
        timeout?.unref?.();
        flight.promise = Promise.race([Promise.resolve().then(() => this.#perform(entry, flight)), cancelled])
            .then(applied => {
                if (!applied || !this.#current(entry, flight)) return;
                entry.appliedIn = flight.sessionId;
                entry.attempt = 0;
            })
            .catch(error => {
                if (!this.#current(entry, flight)) return;
                entry.terminal = error.grantRejected || error.key === 'BOT_SCOPE_MISSING' ? 'authorization' : terminalReason(error.status);
                if (entry.terminal) {
                    console.warn(`[EventSub:${this.#options.label}] ${entry.item.type} for ${entry.item.broadcasterChannel} blocked: ${entry.terminal} (HTTP ${error.status})`);
                    return;
                }
                const delay = retryDelay(entry.attempt++, this.#options.reconnectBaseMs, this.#options.reconnectMaxMs, this.#options.randomFn, error.retryAfterMs);
                console.warn(`[EventSub:${this.#options.label}] ${entry.item.type} for ${entry.item.broadcasterChannel} retry ${entry.attempt} in ${delay}ms`, { status: error.status, ...error.retryHeaders });
                entry.timer = this.#options.setTimeoutFn(() => {
                    entry.timer = null;
                    void this.reconcile();
                }, delay);
                entry.timer?.unref?.();
            })
            .finally(() => {
                this.#options.clearTimeoutFn(timeout);
                if (entry.flight === flight) entry.flight = null;
                if (flight.cancelled && this.#entries.get(entry.key) === entry) void this.reconcile();
            });
        return flight.promise;
    }

    async #perform(entry, flight) {
        const item = entry.item;
        const token = await item.getAccessToken();
        if (!this.#current(entry, flight)) return false;
        if (!token) throw Object.assign(new Error('EventSub token unavailable'), { status: 401 });
        const options = { accessToken: token, broadcasterChannel: item.broadcasterChannel, retry401: false, signal: flight.controller.signal };
        const create = () => this.#helix.request('/eventsub/subscriptions', {
            ...options, method: 'POST', body: {
                type: item.type, version: item.version, condition: item.condition,
                transport: { method: 'websocket', session_id: flight.sessionId }
            }
        });
        try {
            await create();
            return true;
        } catch (error) {
            if (error.status !== 409 || !this.#current(entry, flight)) throw error;
            const matches = [];
            let after;
            do {
                if (!this.#current(entry, flight)) return false;
                const page = await this.#helix.request('/eventsub/subscriptions', { ...options, query: { first: 100, ...(after ? { after } : {}) } });
                matches.push(...(page?.data || []).filter(sub => matchesSubscription(sub, item)));
                after = page?.pagination?.cursor;
            } while (after);
            if (!this.#current(entry, flight)) return false;
            if (matches.some(sub => sub.status === 'enabled' && sub.transport?.session_id === flight.sessionId)) return true;
            if (!matches.length || matches.some(sub => !sub.id || !staleStatuses.has(sub.status))) throw error;
            for (const sub of matches) {
                if (!this.#current(entry, flight)) return false;
                try {
                    await this.#helix.request('/eventsub/subscriptions', { ...options, method: 'DELETE', query: { id: sub.id } });
                } catch (deletionError) {
                    if (deletionError.status !== 404) throw deletionError;
                }
            }
            if (!this.#current(entry, flight)) return false;
            await create();
            return true;
        }
    }
}
