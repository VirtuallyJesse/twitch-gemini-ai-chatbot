import { BotError } from '../utils/error_handler.js';

const POLLINATIONS_BASE = 'https://gen.pollinations.ai';
const CATALOG_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = Object.freeze({ image: 120_000, video: 180_000, tts: 120_000, music: 180_000 });
const TTS_VOICES = Object.freeze(['charlotte', 'adam', 'bella', 'rachel', 'alloy', 'echo', 'nova', 'shimmer', 'onyx']);

export const POLLINATIONS_FALLBACK_CATALOG = Object.freeze({
    image: Object.freeze([{ provider: 'pollinations', id: 'flux' }]),
    video: Object.freeze([{ provider: 'pollinations', id: 'wan-fast', durations: Object.freeze([5, 10, 15]) }]),
    tts: Object.freeze([{ provider: 'pollinations', id: 'elevenlabs', voices: TTS_VOICES, defaultVoice: 'charlotte' }]),
    music: Object.freeze([{ provider: 'pollinations', id: 'elevenmusic', durations: Object.freeze([15, 30, 60]) }])
});

function cloneCatalog(catalog) {
    return Object.fromEntries(['image', 'video', 'tts', 'music'].map((type) => [
        type,
        (catalog[type] || []).map((model) => ({
            ...model,
            ...(model.voices ? { voices: [...model.voices] } : {}),
            ...(model.durations ? { durations: [...model.durations] } : {})
        }))
    ]));
}

function endpointType(type) {
    return type === 'tts' || type === 'music' ? 'audio' : type;
}

function requestParams(type, target) {
    if (type === 'image') return { model: target.model, nologo: true, enhance: true };
    if (type === 'video') return { model: target.model, ...(target.duration ? { duration: target.duration } : {}) };
    if (type === 'tts') return { model: target.model, ...(target.voice ? { voice: target.voice } : {}) };
    return { model: target.model, ...(target.duration ? { duration: target.duration } : {}) };
}

function modelId(item) {
    return String(item?.name || item?.id || item || '').trim();
}

function descriptorsFromDiscovery(imageModels, videoModels, audioModels) {
    const result = { image: null, video: null, tts: null, music: null };
    if (Array.isArray(imageModels)) {
        result.image = imageModels.map(modelId).filter(Boolean).map((id) => ({ provider: 'pollinations', id }));
    }
    if (Array.isArray(videoModels)) {
        result.video = videoModels.map(modelId).filter(Boolean).map((id) => ({ provider: 'pollinations', id, durations: [5, 10, 15] }));
    }
    if (Array.isArray(audioModels)) {
        const tts = [];
        const music = [];
        for (const item of audioModels) {
            const id = modelId(item);
            if (!id) continue;
            const lower = id.toLowerCase();
            const title = String(item?.title || '').toLowerCase();
            const description = String(item?.description || '').toLowerCase();
            if (Array.isArray(item?.output_modalities) && !item.output_modalities.includes('audio')) continue;
            if (['transcribe', 'whisper', 'scribe', 'isolator', 'changer', 'dialogue']
                .some((token) => lower.includes(token) || title.includes(token))) continue;
            if (Array.isArray(item?.voices) && item.voices.length > 0) {
                tts.push({ provider: 'pollinations', id, voices: [...item.voices], defaultVoice: item.voices[0] });
            } else if (lower.includes('music') || lower.includes('lyria') || lower.includes('sfx') || description.includes('music') || item?.category === 'music') {
                music.push({ provider: 'pollinations', id, durations: [15, 30, 60] });
            } else {
                tts.push({ provider: 'pollinations', id });
            }
        }
        result.tts = tts;
        result.music = music;
    }
    return result;
}

function responseError(status, type, body) {
    const params = { mediaType: type };
    if (status === 400) return new BotError('POLLINATIONS_BAD_REQUEST', { status, params });
    if (status === 401 || status === 403) return new BotError(`HTTP_${status}`, { status, params });
    if (status === 429) return new BotError('POLLINATIONS_RATE_LIMITED', { status, params });
    if (status === 502) return new BotError('POLLINATIONS_BAD_GATEWAY', { status, params });
    if (status === 503 || status === 521) return new BotError('POLLINATIONS_SERVER_DOWN', { status, params });
    if (status === 504) return new BotError('POLLINATIONS_GATEWAY_TIMEOUT', { status, params });
    if (status === 404 || /model.+(?:not found|unsupported)/i.test(body)) {
        return new BotError('MEDIA_MODEL_UNAVAILABLE', { status, params });
    }
    return new BotError('POLLINATIONS_GENERIC_ERROR', { status, params: { modelType: type } });
}

export class PollinationsProvider {
    #catalogState;
    #catalogRefresh = null;

    constructor({
        apiKey = '',
        fetchImpl = globalThis.fetch.bind(globalThis),
        baseUrl = POLLINATIONS_BASE,
        timeoutMsByType = {},
        now = () => Date.now(),
        catalogTtlMs = CATALOG_TTL_MS
    } = {}) {
        this.id = 'pollinations';
        this.name = this.id;
        this.apiKey = apiKey;
        this.fetchImpl = fetchImpl;
        this.baseUrl = baseUrl;
        this.timeoutMs = { ...DEFAULT_TIMEOUT_MS, ...timeoutMsByType };
        this.now = now;
        this.catalogTtlMs = catalogTtlMs;
        this.capabilities = { mediaTypes: new Set(['image', 'video', 'tts', 'music']) };
        this.#catalogState = { data: { image: null, video: null, tts: null, music: null }, successAt: 0, failedAt: 0 };
    }

    supports(type) {
        return this.capabilities.mediaTypes.has(type);
    }

    #degradedCatalog(discovered = null) {
        const result = {};
        for (const type of ['image', 'video', 'tts', 'music']) {
            if (Array.isArray(discovered?.[type])) this.#catalogState.data[type] = discovered[type];
            result[type] = this.#catalogState.data[type] ?? POLLINATIONS_FALLBACK_CATALOG[type];
        }
        return cloneCatalog(result);
    }

    async #discoverCatalog() {
        const requests = await Promise.allSettled([
            this.fetchImpl(`${this.baseUrl}/image/models`, { headers: { Accept: 'application/json' } }),
            this.fetchImpl(`${this.baseUrl}/video/models`, { headers: { Accept: 'application/json' } }),
            this.fetchImpl(`${this.baseUrl}/audio/models`, { headers: { Accept: 'application/json' } })
        ]);
        const values = [];
        let anySuccess = false;
        for (const request of requests) {
            if (request.status === 'fulfilled' && request.value.ok) {
                values.push(await request.value.json());
                anySuccess = true;
            } else values.push(null);
        }
        if (!anySuccess) throw new Error('Pollinations catalog discovery unavailable');
        return descriptorsFromDiscovery(...values);
    }

    async catalog() {
        const now = this.now();
        if (this.#catalogState.successAt && now - this.#catalogState.successAt < this.catalogTtlMs) return this.#degradedCatalog();
        if (this.#catalogState.failedAt && now - this.#catalogState.failedAt < this.catalogTtlMs) return this.#degradedCatalog();
        if (this.#catalogRefresh) return this.#catalogRefresh;
        this.#catalogRefresh = (async () => {
            try {
                const discovered = await this.#discoverCatalog();
                this.#catalogState.successAt = this.now();
                this.#catalogState.failedAt = 0;
                return this.#degradedCatalog(discovered);
            } catch (error) {
                this.#catalogState.failedAt = this.now();
                console.warn('[Pollinations] Model discovery failed:', error?.message || error);
                return this.#degradedCatalog();
            } finally {
                this.#catalogRefresh = null;
            }
        })();
        return this.#catalogRefresh;
    }

    async generate({ type, prompt, target = {}, signal } = {}) {
        if (!this.supports(type)) {
            throw new BotError('MEDIA_PROVIDER_UNAVAILABLE', { params: { provider: this.id, mediaType: type } });
        }
        if (!target.model) throw new BotError('MEDIA_MODEL_UNAVAILABLE', { params: { mediaType: type } });

        const params = requestParams(type, target);
        let cleanPrompt = String(prompt || '');
        const kind = endpointType(type);
        let mode = `text-to-${kind}`;
        const urlMatch = cleanPrompt.match(/(https?:\/\/[^\s]+)/);
        if (urlMatch) {
            params.image = urlMatch[0];
            cleanPrompt = cleanPrompt.replace(urlMatch[0], '').trim() || 'variation';
            mode = `image-to-${kind}`;
        }

        const url = `${this.baseUrl}/${kind}/${encodeURIComponent(cleanPrompt)}?${new URLSearchParams(params)}`;
        const controller = new AbortController();
        let timedOut = false;
        const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs[type]);
        const onExternalAbort = () => controller.abort();
        if (signal) {
            if (signal.aborted) { clearTimeout(timeoutId); throw new BotError('REQUEST_ABORTED'); }
            signal.addEventListener('abort', onExternalAbort, { once: true });
        }

        try {
            const response = await this.fetchImpl(url, {
                headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
                signal: controller.signal
            });
            if (!response.ok) throw responseError(response.status, type, await response.text().catch(() => ''));
            return {
                buffer: Buffer.from(await response.arrayBuffer()),
                mimeType: response.headers.get('content-type') || `${kind}/*`,
                sourceUrl: url,
                mode
            };
        } catch (error) {
            if (error instanceof BotError) throw error;
            if (error?.name === 'AbortError') throw new BotError(timedOut ? 'REQUEST_TIMEOUT' : 'REQUEST_ABORTED', { cause: error });
            throw error;
        } finally {
            clearTimeout(timeoutId);
            signal?.removeEventListener('abort', onExternalAbort);
        }
    }
}

export default PollinationsProvider;
