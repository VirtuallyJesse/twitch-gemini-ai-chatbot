import { retryMetadata, retryDelay } from './retry_timing.js';

/** One independently managed EventSub socket, with a separate reconnect candidate. */
export class EventSubSocket {
    #options;
    #active = null;
    #attempt = null;
    #migration = null;
    #retryTimer = null;
    #retryAttempt = 0;
    #keepaliveTimer = null;
    #halted = false;

    constructor(options) { this.#options = options; }
    get sessionId() { return this.#active?.id || null; }
    get connected() { return Boolean(this.#active); }
    #stopped() { return this.#halted || this.#options.isStopped(); }

    ensureConnected() {
        if (this.#stopped()) return Promise.reject(new Error('EventSub disconnected'));
        if (this.connected || this.#retryTimer !== null) return Promise.resolve();
        if (this.#attempt) return this.#attempt.promise;
        return this.#open(false);
    }

    stop() { this.teardown(); }
    teardown() {
        this.#halted = true;
        this.#clearMigration();
        this.#clear(this.#retryTimer);
        this.#retryTimer = null;
        this.#clear(this.#keepaliveTimer);
        this.#keepaliveTimer = null;
        this.#cancelAttempt();
        const active = this.#active;
        this.#active = null;
        this.#options.onDisconnected?.();
        this.#close(active?.socket);
    }

    #open(resumed) {
        if (this.#stopped()) return Promise.reject(new Error('EventSub disconnected'));
        const attempt = { resumed, outcome: null, socket: null, timer: null };
        attempt.promise = new Promise((resolve, reject) => { attempt.resolve = resolve; attempt.reject = reject; });
        attempt.promise.catch(() => {});
        this.#attempt = attempt;
        const migration = this.#migration;
        if (resumed) {
            migration.attempt++;
            console.log(`[EventSub:${this.#options.label}] Resume attempt ${migration.attempt}, ${migration.deadline - this.#options.nowFn()}ms remaining`);
        }
        try {
            const socket = new this.#options.wsImpl(resumed ? migration.url : this.#options.wsUrl);
            attempt.socket = socket;
            const message = raw => this.#message(attempt, raw);
            const close = (code, reason) => this.#failure(attempt, { kind: 'close', code, reason: String(reason || '').slice(0, 256) });
            const error = () => this.#failure(attempt, { kind: 'error' });
            if (typeof socket.on === 'function') {
                socket.on('message', message);
                socket.on('close', close);
                socket.on('error', error);
                socket.on('unexpected-response', (_request, response) => {
                    const metadata = retryMetadata(response?.headers, response?.statusCode, this.#options.nowFn());
                    response?.resume?.();
                    this.#failure(attempt, { kind: 'upgrade', status: response?.statusCode, ...metadata });
                });
            } else {
                socket.onmessage = event => message(event.data);
                socket.onclose = event => close(event?.code, event?.reason);
                socket.onerror = error;
            }
            const remaining = resumed ? migration.deadline - this.#options.nowFn() : Infinity;
            attempt.timer = this.#timer(() => this.#failure(attempt, { kind: 'welcome_timeout' }), Math.min(this.#options.welcomeTimeoutMs, remaining));
        } catch {
            this.#failure(attempt, { kind: 'constructor' });
        }
        return attempt.promise;
    }

    #message(attempt, raw) {
        if (attempt.outcome === 'failed' || attempt.outcome === 'cancelled' || this.#stopped()) return;
        let message;
        try { message = JSON.parse(String(raw)); } catch {
            console.warn(`[EventSub:${this.#options.label}] Invalid message JSON`);
            return;
        }
        if (message?.metadata?.message_type === 'session_welcome') {
            if (attempt !== this.#attempt || attempt.outcome !== null) return;
            const session = message.payload?.session;
            if (typeof session?.id !== 'string' || !session.id.trim()) {
                this.#failure(attempt, { kind: 'invalid_welcome' });
                return;
            }
            attempt.outcome = 'welcomed';
            this.#clear(attempt.timer);
            this.#attempt = null;
            const oldActive = this.#active;
            const previousSessionId = this.#migration?.fromSessionId || oldActive?.id;
            this.#active = { socket: attempt.socket, id: session.id, keepaliveSec: Number(session.keepalive_timeout_seconds) || 10 };
            this.#clearMigration();
            this.#retryAttempt = 0;
            this.#armKeepalive();
            if (attempt.resumed) this.#options.onResumed?.(previousSessionId);
            else this.#options.onResubscribe();
            attempt.resolve();
            this.#close(oldActive?.socket);
            console.log(`[EventSub:${this.#options.label}] ${attempt.resumed ? 'Resume promoted' : 'Fresh welcome'}: ${session.id}`);
            return;
        }
        if (this.#active?.socket !== attempt.socket) return;
        switch (message?.metadata?.message_type) {
            case 'session_keepalive': this.#armKeepalive(); break;
            case 'notification':
                this.#armKeepalive();
                this.#options.onNotification(message);
                break;
            case 'revocation':
                this.#armKeepalive();
                console.warn(`[EventSub:${this.#options.label}] Revoked ${message.payload?.subscription?.type}: ${message.payload?.subscription?.status}`);
                this.#options.onRevocation?.(message.payload?.subscription || {});
                break;
            case 'session_reconnect':
                console.log(`[EventSub:${this.#options.label}] session_reconnect received for ${this.sessionId}`);
                if (message.payload?.session?.reconnect_url && !this.#migration) this.#migrate(message.payload.session.reconnect_url);
                break;
        }
    }

    #failure(attempt, detail) {
        if (attempt.outcome === 'welcomed') {
            if (this.#active?.socket !== attempt.socket) return;
            const active = this.#active;
            this.#active = null;
            this.#clear(this.#keepaliveTimer);
            this.#keepaliveTimer = null;
            this.#options.onDisconnected?.();
            this.#close(active.socket);
            const delay = this.#migration || this.#stopped() ? undefined : this.#scheduleClean(detail.retryAfterMs);
            console.warn(`[EventSub:${this.#options.label}] Active connection lost`, { ...detail, nextDelayMs: delay });
            return;
        }
        if (attempt.outcome !== null || this.#attempt !== attempt) return;
        attempt.outcome = 'failed';
        this.#attempt = null;
        this.#clear(attempt.timer);
        attempt.reject(new Error(`EventSub connection failed (${detail.kind}${detail.status ? ` HTTP ${detail.status}` : ''})`));
        this.#close(attempt.socket);
        let delay;
        const attemptNumber = attempt.resumed ? this.#migration?.attempt : this.#retryAttempt + 1;
        if (!this.#stopped()) {
            if (attempt.resumed && this.#migration) {
                delay = retryDelay(this.#migration.attempt - 1, 1000, 5000, this.#options.randomFn, detail.retryAfterMs);
                const remaining = this.#migration.deadline - this.#options.nowFn();
                if (delay + 1000 >= remaining || (detail.status >= 400 && detail.status < 500 && detail.status !== 429)) {
                    delay = this.#abandonMigration('resume budget or non-retryable rejection');
                } else {
                    this.#migration.timer = this.#timer(() => {
                        this.#migration.timer = null;
                        void this.#open(true);
                    }, delay);
                }
            } else delay = this.#scheduleClean(detail.retryAfterMs);
        }
        console.warn(`[EventSub:${this.#options.label}] ${attempt.resumed ? 'Resume' : 'Fresh'} attempt failed`, { ...detail, attempt: attemptNumber, nextDelayMs: delay });
    }

    #migrate(url) {
        this.#migration = { url, fromSessionId: this.sessionId, deadline: this.#options.nowFn() + 30_000, attempt: 0, timer: null, budgetTimer: null };
        this.#migration.budgetTimer = this.#timer(() => this.#abandonMigration('30-second migration budget expired'), 30_000);
        void this.#open(true);
    }

    #abandonMigration(reason) {
        if (!this.#migration) return;
        this.#clearMigration();
        this.#cancelAttempt();
        this.#clear(this.#keepaliveTimer);
        this.#keepaliveTimer = null;
        const active = this.#active;
        this.#active = null;
        this.#options.onDisconnected?.();
        this.#close(active?.socket);
        const delay = this.#stopped() ? undefined : this.#scheduleClean();
        console.warn(`[EventSub:${this.#options.label}] Resume -> clean reconnect: ${reason}`, { nextDelayMs: delay });
        return delay;
    }

    #clearMigration() {
        if (!this.#migration) return;
        this.#clear(this.#migration.timer);
        this.#clear(this.#migration.budgetTimer);
        this.#migration = null;
    }

    #cancelAttempt() {
        const attempt = this.#attempt;
        if (!attempt) return;
        this.#attempt = null;
        attempt.outcome = 'cancelled';
        this.#clear(attempt.timer);
        attempt.reject(new Error('EventSub disconnected'));
        this.#close(attempt.socket);
    }

    #scheduleClean(serverDelay) {
        if (this.#retryTimer !== null || this.#stopped()) return;
        const delay = retryDelay(this.#retryAttempt++, this.#options.reconnectBaseMs, this.#options.reconnectMaxMs, this.#options.randomFn, serverDelay);
        this.#retryTimer = this.#timer(() => {
            this.#retryTimer = null;
            if (!this.#stopped()) void this.#open(false);
        }, delay);
        return delay;
    }

    #armKeepalive() {
        this.#clear(this.#keepaliveTimer);
        this.#keepaliveTimer = this.#timer(() => {
            const active = this.#active;
            if (!active) return;
            this.#active = null;
            this.#keepaliveTimer = null;
            this.#options.onDisconnected?.();
            this.#close(active.socket);
            const delay = this.#migration ? undefined : this.#scheduleClean();
            console.warn(`[EventSub:${this.#options.label}] Keepalive timeout`, { nextDelayMs: delay });
        }, this.#active.keepaliveSec * 1000 + this.#options.keepaliveGraceMs);
    }

    #timer(callback, delay) {
        const timer = this.#options.setTimeoutFn(callback, delay);
        timer?.unref?.();
        return timer;
    }
    #clear(timer) { if (timer !== null) this.#options.clearTimeoutFn(timer); }
    #close(socket) {
        if (!socket) return;
        try {
            if (socket.readyState === 0 && typeof socket.terminate === 'function') socket.terminate();
            else socket.close();
        } catch { /* Socket state may already be terminal. */ }
    }
}
