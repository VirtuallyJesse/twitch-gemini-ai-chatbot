import sharp from 'sharp';

const IMAGE_EXTS = /\.(jpg|jpeg|png|gif|bmp|webp|avif)(\?.*)?$/i;
const KNOWN_IMAGE_HOSTS = [
    'i.imgur.com',
    'cdn.discordapp.com',
    'i.nuuls.com',
    'i.redd.it',
    'pbs.twimg.com',
    'media.discordapp.net',
    'images.unsplash.com',
    'static.wikia.nocookie.net',
    'kappa.lol',
    'cdn.7tv.app'
];

export class ImageDownloader {
    constructor({
        fetchImpl = globalThis.fetch.bind(globalThis),
        sharpImpl = sharp,
        timeoutMs = 30_000,
        headTimeoutMs = 5_000,
        maxSize = 25 * 1024 * 1024
    } = {}) {
        this.fetchImpl = fetchImpl;
        this.sharpImpl = sharpImpl;
        this.timeoutMs = timeoutMs;
        this.headTimeoutMs = headTimeoutMs;
        this.maxSize = maxSize;
    }

    _isRecognizedImagePattern(url) {
        if (IMAGE_EXTS.test(url)) return true;
        try {
            const hostname = new URL(url).hostname;
            return KNOWN_IMAGE_HOSTS.some(h => hostname.includes(h));
        } catch {
            return false;
        }
    }

    async _headCheck(url) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.headTimeoutMs);

        try {
            const res = await this.fetchImpl(url, {
                method: 'HEAD',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                },
                signal: controller.signal,
                redirect: 'follow'
            });

            if (!res.ok) return false;

            const contentType = (res.headers.get('content-type') || '')
                .split(';')[0]
                .trim()
                .toLowerCase();

            return contentType.startsWith('image/');
        } catch {
            return false;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async isImageUrlAsync(url) {
        if (!url || typeof url !== 'string') return false;
        if (this._isRecognizedImagePattern(url)) return true;
        return this._headCheck(url);
    }

    async _download(url) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const res = await this.fetchImpl(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                },
                signal: controller.signal
            });

            if (!res.ok) {
                throw new Error(`HTTP ${res.status}: ${res.statusText || 'Error'}`);
            }

            const rawContentType = res.headers.get('content-type') || '';
            const contentType = rawContentType.split(';')[0].trim().toLowerCase();

            if (!contentType.startsWith('image/')) {
                throw new Error(`URL did not return an image. Content-Type: ${rawContentType}`);
            }

            const contentLength = res.headers.get('content-length');
            if (contentLength && parseInt(contentLength, 10) > this.maxSize) {
                throw new Error(`Image too large: exceeds ${this.maxSize / 1024 / 1024}MB limit`);
            }

            const arrayBuffer = await res.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            if (buffer.length > this.maxSize) {
                throw new Error(`Image too large: exceeds ${this.maxSize / 1024 / 1024}MB limit`);
            }

            return { buffer, mimeType: contentType };
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error('Image download timed out');
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async downloadImageAsBase64(url) {
        let { buffer, mimeType } = await this._download(url);

        const isAvif = mimeType === 'image/avif' || /\.avif(\?.*)?$/i.test(url);
        if (isAvif) {
            try {
                buffer = await this.sharpImpl(buffer).png().toBuffer();
                mimeType = 'image/png';
            } catch (err) {
                throw new Error(`Failed to convert AVIF: ${err.message}`);
            }
        }

        return {
            mimeType,
            data: buffer.toString('base64')
        };
    }
}

export default ImageDownloader;
