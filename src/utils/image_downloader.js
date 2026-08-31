import http from 'http';
import https from 'https';
import sharp from 'sharp';
import { isKnownHost, resolvePublicDestination } from './network_policy.js';

const IMAGE_EXTS = /\.(jpg|jpeg|png|gif|bmp|webp|avif)$/i;
const KNOWN_IMAGE_HOSTS = [
    'i.imgur.com', 'cdn.discordapp.com', 'i.nuuls.com', 'i.redd.it',
    'pbs.twimg.com', 'media.discordapp.net', 'images.unsplash.com',
    'static.wikia.nocookie.net', 'kappa.lol', 'cdn.7tv.app'
];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function headerBag(headers) {
    return {
        get(name) {
            const value = headers[String(name).toLowerCase()];
            return Array.isArray(value) ? value.join(', ') : value == null ? null : String(value);
        }
    };
}

function pinnedNodeRequest(destination, { method, headers, signal, maxSize }) {
    const client = destination.url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        let settled = false;
        const finishReject = (error) => {
            if (settled) return;
            settled = true;
            reject(error);
        };
        const request = client.request(destination.url, {
            method,
            headers,
            signal,
            lookup: (_hostname, options, callback) => {
                const selected = destination.address;
                if (options?.all) callback(null, [selected]);
                else callback(null, selected.address, selected.family);
            }
        }, (response) => {
            const chunks = [];
            let size = 0;
            response.on('data', (chunk) => {
                size += chunk.length;
                if (size > maxSize) {
                    response.destroy(new Error(`Image too large: exceeds ${maxSize / 1024 / 1024}MB limit`));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('error', finishReject);
            response.on('end', () => {
                if (settled) return;
                settled = true;
                const buffer = Buffer.concat(chunks);
                resolve({
                    ok: response.statusCode >= 200 && response.statusCode < 300,
                    status: response.statusCode,
                    statusText: response.statusMessage || '',
                    headers: headerBag(response.headers),
                    arrayBuffer: async () => buffer
                });
            });
        });
        request.on('error', finishReject);
        request.end();
    });
}

export class ImageDownloader {
    constructor({
        fetchImpl = null,
        requestImpl = null,
        lookup,
        sharpImpl = sharp,
        timeoutMs = 30_000,
        headTimeoutMs = 5_000,
        maxSize = 25 * 1024 * 1024,
        maxRedirects = 3
    } = {}) {
        this.fetchImpl = fetchImpl;
        this.requestImpl = requestImpl;
        this.lookup = lookup;
        this.sharpImpl = sharpImpl;
        this.timeoutMs = timeoutMs;
        this.headTimeoutMs = headTimeoutMs;
        this.maxSize = maxSize;
        this.maxRedirects = maxRedirects;
    }

    _isRecognizedImagePattern(rawUrl) {
        try {
            const url = new URL(rawUrl);
            return IMAGE_EXTS.test(url.pathname) || isKnownHost(url.hostname, KNOWN_IMAGE_HOSTS);
        } catch {
            return false;
        }
    }

    async _request(rawUrl, { method = 'GET', timeoutMs = this.timeoutMs } = {}) {
        let current = new URL(String(rawUrl));
        for (let redirects = 0; redirects <= this.maxRedirects; redirects++) {
            const destination = await resolvePublicDestination(current, { lookup: this.lookup });
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const options = {
                    method,
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                    signal: controller.signal,
                    redirect: 'manual'
                };
                const response = this.requestImpl
                    ? await this.requestImpl(destination, { ...options, maxSize: this.maxSize })
                    : this.fetchImpl
                        ? await this.fetchImpl(destination.url.href, options)
                        : await pinnedNodeRequest(destination, { ...options, maxSize: this.maxSize });
                if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: current.href };
                const location = response.headers.get('location');
                if (!location || redirects === this.maxRedirects) throw new Error('Remote image redirect limit exceeded');
                current = new URL(location, current);
            } catch (error) {
                if (error?.name === 'AbortError') throw new Error('Image download timed out');
                throw error;
            } finally {
                clearTimeout(timeoutId);
            }
        }
        throw new Error('Remote image redirect limit exceeded');
    }

    async _headCheck(url) {
        try {
            const { response } = await this._request(url, { method: 'HEAD', timeoutMs: this.headTimeoutMs });
            if (!response.ok) return false;
            return String(response.headers.get('content-type') || '')
                .split(';')[0].trim().toLowerCase().startsWith('image/');
        } catch {
            return false;
        }
    }

    async isImageUrlAsync(url) {
        if (!url || typeof url !== 'string') return false;
        try {
            await resolvePublicDestination(url, { lookup: this.lookup });
        } catch {
            return false;
        }
        return this._isRecognizedImagePattern(url) || this._headCheck(url);
    }

    async _download(url) {
        const { response, finalUrl } = await this._request(url);
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
        return { buffer, mimeType, finalUrl };
    }

    async downloadImageAsBase64(url) {
        let { buffer, mimeType, finalUrl } = await this._download(url);
        if (mimeType === 'image/avif' || /\.avif$/i.test(new URL(finalUrl).pathname)) {
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
