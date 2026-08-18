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

function endpointType(type) {
    return type === 'tts' || type === 'music' ? 'audio' : type;
}

function defaultParams(type, models, ttsVoice, musicDuration, options = {}) {
    if (type === 'image') {
        return { model: options.model || models.image, nologo: true, enhance: true };
    }
    if (type === 'video') {
        return { model: options.model || models.video, duration: options.duration || 5 };
    }
    if (type === 'tts') {
        return { model: options.model || models.tts, voice: options.voice || ttsVoice };
    }
    return { model: options.model || models.music, duration: options.duration || musicDuration };
}

export class PollinationsProvider {
    constructor({
        apiKey = '',
        fetchImpl = globalThis.fetch.bind(globalThis),
        baseUrl = POLLINATIONS_BASE,
        imageModel = 'gptimage',
        videoModel = 'seedance',
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
