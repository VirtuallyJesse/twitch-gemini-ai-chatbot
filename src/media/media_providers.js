// media_providers.js
const POLLINATIONS_BASE = 'https://gen.pollinations.ai';

function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
}

export class PollinationsClient {
    constructor(options = {}) {
        this.apiKey = options.apiKey || process.env.POLLINATIONS_API_KEY;
    }

    async _requestMedia(type, prompt, params, timeoutMs, errorType = type) {
        const baseUrl = `${POLLINATIONS_BASE}/${type}`;
        
        let mode = `text-to-${type}`;
        const urlMatch = prompt.match(/(https?:\/\/[^\s]+)/);
        if (urlMatch) {
            params.image = urlMatch[0];
            prompt = prompt.replace(urlMatch[0], '').trim();
            mode = `image-to-${type}`;
            if (!prompt) prompt = 'variation';
        }

        const url = `${baseUrl}/${encodeURIComponent(prompt)}?${new URLSearchParams(params)}`;
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeoutMs);

        try {
            console.log(`[Pollinations] Requesting ${type}...`);
            const res = await fetch(url, {
                headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
                signal: controller.signal
            });
            if (!res.ok) {
                throw new Error(`Pollinations ${capitalize(errorType)} HTTP ${res.status}: ${await res.text()}`);
            }
            const buffer = Buffer.from(await res.arrayBuffer());
            return { buffer, mimeType: res.headers.get('content-type') || `${type}/*`, generatedUrl: url, mode };
        } finally {
            clearTimeout(id);
        }
    }

    generateImage(prompt, opts = {}) { return this._requestMedia('image', prompt, { model: opts.model || process.env.POLLINATIONS_IMAGE_MODEL || 'gptimage', nologo: true, enhance: true }, 120000, 'Image'); }
    generateVideo(prompt, opts = {}) { return this._requestMedia('video', prompt, { model: opts.model || process.env.POLLINATIONS_VIDEO_MODEL || 'seedance', duration: 5 }, 180000, 'Video'); }
    generateAudio(prompt, opts = {}) { return this._requestMedia('audio', prompt, { model: opts.model || process.env.POLLINATIONS_TTS_MODEL || 'elevenlabs', voice: process.env.POLLINATIONS_TTS_VOICE || 'charlotte' }, 120000, 'Audio'); }
    generateMusic(prompt, opts = {}) { return this._requestMedia('audio', prompt, { model: opts.model || process.env.POLLINATIONS_MUSIC_MODEL || 'elevenmusic', duration: opts.duration || 30 }, 180000, 'Music'); }
}

export default PollinationsClient;
