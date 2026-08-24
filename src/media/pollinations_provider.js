const POLLINATIONS_BASE = 'https://gen.pollinations.ai';

const DEFAULT_TIMEOUT_MS = {
    image: 120_000,
    video: 180_000,
    tts: 120_000,
    music: 180_000
};

const ERROR_LABEL = {
    image: 'Image',
    video: 'Video',
    tts: 'Audio',
    music: 'Music'
};

/**
 * Offline-safe model/voice catalog served to the dashboard's Commands tab
 * whenever upstream discovery is unavailable. Defaults here are sanctioned
 * swaps (gptimage→flux, seedance→wan-fast) mirrored by factory config.
 */
export const POLLINATIONS_FALLBACK_MODELS = Object.freeze({
    image: {
        defaultModel: 'flux',
        models: ['flux']
    },
    video: {
        defaultModel: 'wan-fast',
        models: ['wan-fast']
    },
    tts: {
        defaultModel: 'elevenlabs',
        defaultVoice: 'charlotte',
        models: ['elevenlabs'],
        voices: {
            elevenlabs: ['charlotte', 'adam', 'bella', 'rachel', 'alloy', 'echo', 'nova', 'shimmer', 'onyx']
        }
    },
    music: {
        defaultModel: 'elevenmusic',
        models: ['elevenmusic']
    }
});

function endpointType(type) {
    return type === 'tts' || type === 'music' ? 'audio' : type;
}

function defaultParams(type, models, ttsVoice, musicDuration, options = {}) {
    if (type === 'image') {
        return { model: options.model || models.image, nologo: true, enhance: true };
    }
    if (type === 'video') {
        const duration = options.duration || options.duration_cap || 5;
        return { model: options.model || models.video, duration };
    }
    if (type === 'tts') {
        const params = { model: options.model || models.tts };
        // An explicit per-request voice wins; otherwise the trusted boot
        // default applies even when the model itself was overridden.
        const voice = options.voice || ttsVoice;
        if (voice) {
            params.voice = voice;
        }
        return params;
    }
    const duration = options.duration || options.duration_cap || musicDuration;
    const params = { model: options.model || models.music };
    if (duration) {
        params.duration = duration;
    }
    return params;
}

export class PollinationsProvider {
    #catalogCache;

    constructor({
        apiKey = '',
        fetchImpl = globalThis.fetch.bind(globalThis),
        baseUrl = POLLINATIONS_BASE,
        imageModel = 'flux',
        videoModel = 'wan-fast',
        ttsModel = 'elevenlabs',
        ttsVoice = 'charlotte',
        musicModel = 'elevenmusic',
        musicDuration = 30,
        timeoutMsByType = {}
    } = {}) {
        this.name = 'pollinations';
        this.apiKey = apiKey;
        this.fetchImpl = fetchImpl;
        this.baseUrl = baseUrl;
        this.ttsVoice = ttsVoice;
        this.musicDuration = musicDuration;
        this.models = {
            image: imageModel,
            video: videoModel,
            tts: ttsModel,
            music: musicModel
        };
        this.timeoutMs = { ...DEFAULT_TIMEOUT_MS, ...timeoutMsByType };
        this.capabilities = {
            mediaTypes: new Set(['image', 'video', 'tts', 'music'])
        };
        this.#catalogCache = { timestamp: 0, data: null };
    }

    /**
     * Model/voice catalog for the dashboard's Commands tab. Queries the public
     * category endpoints with a 1h TTL cache and degrades to the fallback
     * catalog on any upstream failure, so the route never throws.
     */
    async catalog() {
        const now = Date.now();
        if (this.#catalogCache.data && (now - this.#catalogCache.timestamp < 3600000)) {
            return this.#catalogCache.data;
        }

        try {
            const [imgRes, vidRes, audRes] = await Promise.allSettled([
                this.fetchImpl(`${this.baseUrl}/image/models`, { headers: { Accept: 'application/json' } }),
                this.fetchImpl(`${this.baseUrl}/video/models`, { headers: { Accept: 'application/json' } }),
                this.fetchImpl(`${this.baseUrl}/audio/models`, { headers: { Accept: 'application/json' } })
            ]);

            const imageModels = imgRes.status === 'fulfilled' && imgRes.value.ok ? await imgRes.value.json() : null;
            const videoModels = vidRes.status === 'fulfilled' && vidRes.value.ok ? await vidRes.value.json() : null;
            const audioModels = audRes.status === 'fulfilled' && audRes.value.ok ? await audRes.value.json() : null;

            const result = {
                image: {
                    defaultModel: POLLINATIONS_FALLBACK_MODELS.image.defaultModel,
                    models: Array.isArray(imageModels) ? imageModels.map(m => m.name || m.id || m) : POLLINATIONS_FALLBACK_MODELS.image.models
                },
                video: {
                    defaultModel: POLLINATIONS_FALLBACK_MODELS.video.defaultModel,
                    models: Array.isArray(videoModels) ? videoModels.map(m => m.name || m.id || m) : POLLINATIONS_FALLBACK_MODELS.video.models
                },
                tts: {
                    defaultModel: POLLINATIONS_FALLBACK_MODELS.tts.defaultModel,
                    defaultVoice: POLLINATIONS_FALLBACK_MODELS.tts.defaultVoice,
                    models: [],
                    voices: {}
                },
                music: {
                    defaultModel: POLLINATIONS_FALLBACK_MODELS.music.defaultModel,
                    models: POLLINATIONS_FALLBACK_MODELS.music.models
                }
            };

            if (Array.isArray(audioModels)) {
                const ttsList = [];
                const musicList = [];
                const voicesMap = {};

                // Filter out models that output text (e.g. STT models)
                const isTextOutput = (item) =>
                    Array.isArray(item.output_modalities) && !item.output_modalities.includes('audio');

                // Filter out non-generative utilities (transcription, voice isolator/changer)
                const isUtility = (nameLower, titleLower) =>
                    ['transcribe', 'whisper', 'scribe', 'isolator', 'changer', 'dialogue']
                        .some((p) => nameLower.includes(p) || titleLower.includes(p));

                for (const item of audioModels) {
                    if (isTextOutput(item)) continue;
                    const name = item.name || item.id || item;
                    const nameLower = String(name).toLowerCase();
                    const titleLower = String(item.title || '').toLowerCase();
                    const descLower = String(item.description || '').toLowerCase();
                    if (isUtility(nameLower, titleLower)) continue;

                    if (item.voices && Array.isArray(item.voices) && item.voices.length > 0) {
                        ttsList.push(name);
                        voicesMap[name] = item.voices;
                    } else if (
                        nameLower.includes('music') ||
                        nameLower.includes('audio') ||
                        nameLower.includes('lyria') ||
                        nameLower.includes('sfx') ||
                        descLower.includes('music') ||
                        item.category === 'music'
                    ) {
                        musicList.push(name);
                    } else {
                        ttsList.push(name);
                    }
                }

                result.tts.models = ttsList.length ? ttsList : POLLINATIONS_FALLBACK_MODELS.tts.models;
                result.tts.voices = Object.keys(voicesMap).length ? voicesMap : POLLINATIONS_FALLBACK_MODELS.tts.voices;
                if (musicList.length) result.music.models = musicList;
            } else {
                result.tts.models = POLLINATIONS_FALLBACK_MODELS.tts.models;
                result.tts.voices = POLLINATIONS_FALLBACK_MODELS.tts.voices;
            }

            this.#catalogCache = { timestamp: now, data: result };
            return result;
        } catch (err) {
            console.warn('[Pollinations] Model discovery failed, using fallback:', err.message);
            return POLLINATIONS_FALLBACK_MODELS;
        }
    }

    async generate({ type, prompt, options = {}, signal } = {}) {
        if (!this.capabilities.mediaTypes.has(type)) {
            throw new Error(`Pollinations does not support media type: ${type}`);
        }

        const params = defaultParams(
            type,
            this.models,
            this.ttsVoice,
            this.musicDuration,
            options
        );

        let cleanPrompt = String(prompt || '');
        const kind = endpointType(type);
        let mode = `text-to-${kind}`;
        const urlMatch = cleanPrompt.match(/(https?:\/\/[^\s]+)/);
        if (urlMatch) {
            params.image = urlMatch[0];
            cleanPrompt = cleanPrompt.replace(urlMatch[0], '').trim();
            mode = `image-to-${kind}`;
            if (!cleanPrompt) cleanPrompt = 'variation';
        }

        const url = `${this.baseUrl}/${kind}/${encodeURIComponent(cleanPrompt)}?${new URLSearchParams(params)}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs[type]);
        const onExternalAbort = () => controller.abort();

        if (signal) {
            if (signal.aborted) {
                clearTimeout(timeoutId);
                const err = new Error('Aborted');
                err.name = 'AbortError';
                throw err;
            }
            signal.addEventListener('abort', onExternalAbort, { once: true });
        }

        try {
            console.log(`[Pollinations] Requesting ${type}...`);
            const res = await this.fetchImpl(url, {
                headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
                signal: controller.signal
            });
            if (!res.ok) {
                throw new Error(
                    `Pollinations ${ERROR_LABEL[type]} HTTP ${res.status}: ${await res.text()}`
                );
            }
            const buffer = Buffer.from(await res.arrayBuffer());
            return {
                buffer,
                mimeType: res.headers.get('content-type') || `${kind}/*`,
                sourceUrl: url,
                mode
            };
        } finally {
            clearTimeout(timeoutId);
            signal?.removeEventListener('abort', onExternalAbort);
        }
    }
}

export default PollinationsProvider;
