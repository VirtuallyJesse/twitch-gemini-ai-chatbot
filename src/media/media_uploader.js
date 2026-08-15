const HOSTS = {
    primary: 'https://i.nuuls.com/upload',
    fallback: 'https://kappa.lol/api/upload'
};

const UPLOAD_KIND = {
    image: 'image',
    video: 'video',
    tts: 'audio',
    music: 'audio'
};

const DEFAULT_MIME = {
    image: 'image/png',
    video: 'video/mp4',
    audio: 'audio/mpeg'
};

function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function normalizeMimeType(mimeType, kind) {
    const value = String(mimeType || '').split(';')[0].toLowerCase().trim();

    if (!value || value.endsWith('/*') || !value.includes('/')) {
        return DEFAULT_MIME[kind];
    }

    return value;
}

function extensionFor(mimeType, kind) {
    let extension = (mimeType || '').split('/')[1] || '';

    if (extension === 'mpeg') extension = 'mp3';
    if (!/^[a-z0-9]+$/i.test(extension)) {
        return kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : 'png';
    }

    return extension;
}

export class MediaUploader {
    constructor({
        fetchImpl = globalThis.fetch.bind(globalThis),
        timeoutMs = null,
        timeoutMsByKind = {},
        primaryUrl = HOSTS.primary,
        fallbackUrl = HOSTS.fallback,
        FormDataImpl = FormData,
        BlobImpl = Blob
    } = {}) {
        this.fetchImpl = fetchImpl;
        this.primaryUrl = primaryUrl;
        this.fallbackUrl = fallbackUrl;
        this.FormDataImpl = FormDataImpl;
        this.BlobImpl = BlobImpl;

        this.timeoutMs = {
            image: 60_000,
            video: 180_000,
            audio: 60_000,
            ...timeoutMsByKind
        };

        if (timeoutMs !== null) {
            this.timeoutMs.image = timeoutMs;
            this.timeoutMs.video = timeoutMs;
            this.timeoutMs.audio = timeoutMs;
        }
    }

    #createForm(buffer, mimeType, filename) {
        const form = new this.FormDataImpl();
        form.append('file', new this.BlobImpl([buffer], { type: mimeType }), filename);
        return form;
    }

    async #requestWithTimeout(url, form, timeoutMs) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = await this.fetchImpl(url, {
                method: 'POST',
                body: form,
                signal: controller.signal
            });

            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }

            return res;
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new Error('Timeout');
            }
            throw err;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async #uploadPrimary(buffer, mimeType, filename, kind) {
        const form = this.#createForm(buffer, mimeType, filename);
        const res = await this.#requestWithTimeout(this.primaryUrl, form, this.timeoutMs[kind]);
        const url = (await res.text()).trim();

        if (!url || url === '<none>') {
            throw new Error('empty response');
        }

        return url;
    }

    async #uploadFallback(buffer, mimeType, filename, kind) {
        const form = this.#createForm(buffer, mimeType, filename);
        const res = await this.#requestWithTimeout(this.fallbackUrl, form, this.timeoutMs[kind]);

        let data;
        if (typeof res.json === 'function') {
            try {
                data = await res.json();
            } catch {
                data = null;
            }
        } else {
            try {
                data = JSON.parse(await res.text());
            } catch {
                data = null;
            }
        }

        if (!data?.link || typeof data.link !== 'string') {
            throw new Error('invalid JSON response');
        }

        return data.link.trim();
    }

    async upload(buffer, { mediaType, mimeType } = {}) {
        const kind = UPLOAD_KIND[mediaType];

        if (!kind) {
            throw new Error(`Unsupported media upload type: ${mediaType}`);
        }

        const length = buffer?.byteLength ?? buffer?.length ?? 0;
        if (!buffer || length === 0) {
            throw new Error(`${capitalize(kind)} upload failed: empty buffer`);
        }

        const normalizedMime = normalizeMimeType(mimeType, kind);
        const filename = `generated.${extensionFor(normalizedMime, kind)}`;

        try {
            return await this.#uploadPrimary(buffer, normalizedMime, filename, kind);
        } catch (primaryError) {
            try {
                return await this.#uploadFallback(buffer, normalizedMime, filename, kind);
            } catch (fallbackError) {
                throw new Error(
                    `${capitalize(kind)} upload failed: ` +
                    `Primary (${primaryError.message}), ` +
                    `Fallback (${fallbackError.message})`
                );
            }
        }
    }
}

export default MediaUploader;
