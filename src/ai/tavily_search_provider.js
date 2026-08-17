export const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
export const TAVILY_USAGE_URL = 'https://api.tavily.com/usage';
export const TAVILY_BREAKER_KEY = 'tavily:breaker';
export const TAVILY_TIMEOUT_MS = 3500;
export const TAVILY_PROBE_INTERVAL_MS = 60 * 60 * 1000;
export const TAVILY_MAX_RESULTS = 5;

export const DEFAULT_TAVILY_DESCRIPTION =
    'Search the web for real-time facts, current events, live stats, and breaking news. Invoke only when the answer depends on current information that may have changed since training.';

export const DEFAULT_TAVILY_PARAMETERS = {
    type: 'object',
    properties: {
        query: { type: 'string', description: 'The search query' }
    },
    required: ['query']
};

export function startOfNextUtcMonth(nowMs = Date.now()) {
    const d = new Date(nowMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0);
}

export function remainingCreditsFromUsage(data) {
    if (!data || typeof data !== 'object') return null;
    if (typeof data.remaining === 'number' && Number.isFinite(data.remaining)) {
        return Math.max(0, data.remaining);
    }
    if (typeof data.credits_remaining === 'number' && Number.isFinite(data.credits_remaining)) {
        return Math.max(0, data.credits_remaining);
    }
    const pairs = [
        [data.key?.limit, data.key?.usage],
        [data.requests?.limit, data.requests?.usage],
        [data.account_plan?.plan_limit, data.account_plan?.usage ?? data.account_plan?.plan_usage],
        [data.usage?.limit, data.usage?.usage],
        [data.usage?.search?.limit, data.usage?.search?.usage]
    ];
    for (const [limit, usage] of pairs) {
        if (typeof limit === 'number' && typeof usage === 'number'
            && Number.isFinite(limit) && Number.isFinite(usage)) {
            return Math.max(0, limit - usage);
        }
    }
    return null;
}

export class TavilySearchProvider {
    name = 'search_web';
    description = DEFAULT_TAVILY_DESCRIPTION;
    parameters = DEFAULT_TAVILY_PARAMETERS;

    #apiKey;
    #searchDepth;
    #fetchImpl;
    #storage;
    #now;
    #probeIntervalMs;
    #probeTimer = null;
    #available = true;
    #disabledUntil = 0;

    constructor({
        apiKey,
        searchDepth = 'basic',
        fetchImpl = (...a) => globalThis.fetch(...a),
        storage = null,
        timeoutMs = TAVILY_TIMEOUT_MS,
        now = () => Date.now(),
        probeIntervalMs = TAVILY_PROBE_INTERVAL_MS
    } = {}) {
        this.#apiKey = String(apiKey || '');
        const depth = String(searchDepth || 'basic').toLowerCase();
        this.#searchDepth = depth === 'advanced' ? 'advanced' : 'basic';
        this.#fetchImpl = fetchImpl;
        this.#storage = storage && typeof storage.getJson === 'function' ? storage : null;
        this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : TAVILY_TIMEOUT_MS;
        this.#now = typeof now === 'function' ? now : () => Date.now();
        this.#probeIntervalMs = Number(probeIntervalMs) > 0
            ? Number(probeIntervalMs)
            : TAVILY_PROBE_INTERVAL_MS;
    }

    isAvailable() {
        if (this.#available) return true;
        return this.#disabledUntil > 0 && this.#now() >= this.#disabledUntil;
    }

    async search(query, context = {}) {
        const q = String(query ?? '').trim();
        if (!q) return { error: 'Missing search query' };
        if (!this.isAvailable()) {
            return { error: 'Web search is temporarily unavailable' };
        }

        const fetchImpl = context.fetchImpl || this.#fetchImpl;
        let signal = context.signal;
        let timer = null;
        if (!signal) {
            const controller = new AbortController();
            timer = setTimeout(() => controller.abort(), this.timeoutMs);
            signal = controller.signal;
        }

        try {
            const res = await fetchImpl(TAVILY_SEARCH_URL, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.#apiKey}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify({
                    query: q,
                    search_depth: this.#searchDepth,
                    max_results: TAVILY_MAX_RESULTS,
                    include_answer: false
                }),
                signal
            });

            if (res.status === 429 || res.status === 401 || res.status === 403) {
                await this.#trip(res.status === 429 ? 'quota_exhausted' : 'unauthorized', res.status);
                return { error: persistentMessage(res.status) };
            }
            if (!res.ok) {
                console.warn(`[Tavily] Transient error HTTP ${res.status}. Search unavailable for this turn.`);
                return { error: `Web search failed (HTTP ${res.status})` };
            }

            const data = await res.json();
            if (!this.#available) {
                await this.#reset();
            }
            return transformResults(data);
        } catch (err) {
            if (err?.name === 'AbortError' || signal?.aborted) {
                return { error: 'Web search timed out' };
            }
            console.warn('[Tavily] Transient search error. Search unavailable for this turn.');
            return { error: 'Web search failed' };
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async checkUsage() {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const res = await this.#fetchImpl(TAVILY_USAGE_URL, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${this.#apiKey}`,
                    Accept: 'application/json'
                },
                signal: controller.signal
            });

            if (res.status === 429 || res.status === 401 || res.status === 403) {
                await this.#trip(res.status === 429 ? 'quota_exhausted' : 'unauthorized', res.status);
                return { ok: false, remaining: 0 };
            }
            if (!res.ok) return { ok: false, remaining: null };

            const remaining = remainingCreditsFromUsage(await res.json());
            if (remaining == null) return { ok: true, remaining: null };
            if (remaining > 0) {
                await this.#reset();
                console.log(`[Tavily] Usage probe: ${remaining} credits remaining. Search available.`);
            } else {
                await this.#trip('quota_exhausted', 429);
            }
            return { ok: true, remaining };
        } catch {
            return { ok: false, remaining: null };
        } finally {
            clearTimeout(timer);
        }
    }

    async loadBreakerState() {
        if (!this.#storage) return;
        try {
            const saved = await this.#storage.getJson(TAVILY_BREAKER_KEY);
            if (!saved || saved.available !== false) return;
            this.#available = false;
            this.#disabledUntil = Number(saved.disabledUntil) || 0;
            if (!this.isAvailable()) {
                const until = this.#disabledUntil
                    ? new Date(this.#disabledUntil).toISOString()
                    : 'unknown';
                console.warn(`[Tavily] Restored open circuit breaker. Web search disabled until ${until}.`);
            }
        } catch (error) {
            console.warn('[Tavily] Failed to restore breaker state:', error?.message || error);
        }
    }

    startBackgroundProbe() {
        this.stopBackgroundProbe();
        const boot = this.#boot();
        this.#probeTimer = setInterval(() => {
            if (!this.#available || !this.isAvailable()) void this.checkUsage();
        }, this.#probeIntervalMs);
        this.#probeTimer.unref?.();
        return boot;
    }

    stopBackgroundProbe() {
        if (this.#probeTimer) {
            clearInterval(this.#probeTimer);
            this.#probeTimer = null;
        }
    }

    async #boot() {
        await this.loadBreakerState();
        await this.checkUsage();
    }

    async #trip(reason, status) {
        this.#available = false;
        this.#disabledUntil = startOfNextUtcMonth(this.#now());
        const until = new Date(this.#disabledUntil).toISOString();
        if (reason === 'quota_exhausted') {
            console.warn(`[Tavily] Quota exhausted. Web search disabled until ${until}.`);
        } else {
            console.warn(`[Tavily] API key invalid or unauthorized (HTTP ${status}). Web search disabled until ${until}.`);
        }
        await this.#persist({ reason, status });
    }

    async #reset() {
        const wasOpen = !this.#available;
        this.#available = true;
        this.#disabledUntil = 0;
        if (wasOpen) console.log('[Tavily] Credits available. Web search restored.');
        await this.#persist({ reason: null, status: 0 });
    }

    async #persist({ reason, status }) {
        if (!this.#storage) return;
        try {
            await this.#storage.setJson(TAVILY_BREAKER_KEY, {
                available: this.#available,
                disabledUntil: this.#disabledUntil,
                reason: reason || null,
                status: status || 0,
                trippedAt: this.#now()
            });
        } catch (error) {
            console.warn('[Tavily] Failed to persist breaker state:', error?.message || error);
        }
    }
}

function transformResults(data) {
    const rows = Array.isArray(data?.results) ? data.results : [];
    return {
        results: rows.slice(0, TAVILY_MAX_RESULTS).map(row => ({
            title: String(row?.title || ''),
            url: String(row?.url || ''),
            content: String(row?.content || '')
        }))
    };
}

function persistentMessage(status) {
    if (status === 429) return 'Web search quota exhausted';
    return 'Web search is unauthorized';
}

export default TavilySearchProvider;
