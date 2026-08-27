import sharp from 'sharp';

const IMAGE_EXTS = /\.(jpg|jpeg|png|gif|bmp|webp|avif)(\?.*)?$/i;
const KNOWN_IMAGE_HOSTS = [
    'i.imgur.com', 'cdn.discordapp.com', 'i.nuuls.com', 'i.redd.it',
    'pbs.twimg.com', 'media.discordapp.net', 'images.unsplash.com',
    'static.wikia.nocookie.net', 'kappa.lol', 'cdn.7tv.app'
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
            return KNOWN_IMAGE_HOSTS.some((host) => hostname.includes(host));
        } catch {
            return false;
        }
    }

    async _headCheck(url) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.headTimeoutMs);
        try {
            const response = await this.fetchImpl(url, {
                method: 'HEAD',
                headers: { 'User-Agent': 'Mozilla/5.0' },
                signal: controller.signal,
                redirect: 'follow'
            });
            if (!response.ok) return false;
            return String(response.headers.get('content-type') || '')
                .split(';')[0].trim().toLowerCase().startsWith('image/');
        } catch {
            return false;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async isImageUrlAsync(url) {
        if (!url || typeof url !== 'string') return false;
        return this._isRecognizedImagePattern(url) || this._headCheck(url);
    }

    async _download(url) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await this.fetchImpl(url, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                signal: controller.signal
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText || 'Error'}`);
            const rawContentType = response.headers.get('content-type') || '';
            const mimeType = rawContentType.split(';')[0].trim().toLowerCase();
            if (!mimeType.startsWith('image/')) throw new Error(`URL did not return an image. Content-Type: ${rawContentType}`);
            const contentLength = response.headers.get('content-length');
            if (contentLength && parseInt(contentLength, 10) > this.maxSize) {
                throw new Error(`Image too large: exceeds ${this.maxSize / 1024 / 1024}MB limit`);
            }
            const buffer = Buffer.from(await response.arrayBuffer());
            if (buffer.length > this.maxSize) throw new Error(`Image too large: exceeds ${this.maxSize / 1024 / 1024}MB limit`);
            return { buffer, mimeType };
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('Image download timed out');
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async downloadImageAsBase64(url) {
        let { buffer, mimeType } = await this._download(url);
        if (mimeType === 'image/avif' || /\.avif(\?.*)?$/i.test(url)) {
            try {
                buffer = await this.sharpImpl(buffer).png().toBuffer();
                mimeType = 'image/png';
            } catch (error) {
                throw new Error(`Failed to convert AVIF: ${error.message}`);
            }
        }
        return { mimeType, data: buffer.toString('base64') };
    }
}

export default ImageDownloader;
