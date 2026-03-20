import sharp from 'sharp';

const CONFIG = {
    image: {
        exts: /\.(jpg|jpeg|png|gif|bmp|webp|avif)(\?.*)?$/i,
        // Fast-path: recognize extensionless image URLs from these common CDNs without a HEAD request.
        // URLs with recognized file extensions are accepted from ANY host regardless of this list.
        // Unlisted hosts are resolved via HEAD request fallback in isImageUrlAsync().
        hosts: ['i.imgur.com', 'cdn.discordapp.com', 'i.nuuls.com', 'i.redd.it', 'pbs.twimg.com', 'media.discordapp.net', 'images.unsplash.com', 'static.wikia.nocookie.net', 'kappa.lol', 'cdn.7tv.app'],
        maxSize: 25 * 1024 * 1024,
        dlTimeout: 30000,
        ulTimeout: 60000
    },
    video: {
        exts: /\.(mp4|webm|mov|avi|mkv|m4v)(\?.*)?$/i,
        hosts: ['i.nuuls.com', 'cdn.discordapp.com', 'media.discordapp.net', 'kappa.lol'],
        maxSize: 100 * 1024 * 1024,
        dlTimeout: 180000,
        ulTimeout: 180000
    },
    audio: {
        exts: /\.(mp3|wav|ogg|flac|aac|m4a|opus)(\?.*)?$/i,
        hosts: ['i.nuuls.com', 'kappa.lol'],
        maxSize: 50 * 1024 * 1024,
        dlTimeout: 30000,
        ulTimeout: 60000
    }
};

class MediaProcessor {
    _isType(url, type) {
        const { exts, hosts } = CONFIG[type];
        if (exts.test(url)) return true;
        try {
            const hostname = new URL(url).hostname;
            return hosts.some(h => hostname.includes(h));
        } catch { return false; }
    }

    isImageUrl(url) { return this._isType(url, 'image'); }
    isAudioUrl(url) { return this._isType(url, 'audio'); }
    isVideoUrl(url) { return this._isType(url, 'video'); }

    /**
     * HEAD-request fallback for URLs that don't match known extensions or hosts.
     * Checks the Content-Type header to determine if the URL serves the expected media type.
     */
    async _headCheck(url, type) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            try {
                const res = await fetch(url, {
                    method: 'HEAD',
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' },
                    signal: controller.signal,
                    redirect: 'follow'
                });
                const contentType = res.headers.get('content-type') || '';
                return contentType.startsWith(`${type}/`);
            } finally {
                clearTimeout(timeoutId);
            }
        } catch {
            return false;
        }
    }

    /**
     * Async image detection with HEAD-request fallback.
     * First checks extension and known hosts (instant), then falls back to a HEAD request
     * for URLs from unlisted hosts without recognizable file extensions.
     */
    async isImageUrlAsync(url) {
        if (this._isType(url, 'image')) return true;
        return this._headCheck(url, 'image');
    }

    async _download(url, type) {
        const { maxSize, dlTimeout } = CONFIG[type];
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), dlTimeout);
        
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' },
                signal: controller.signal
            });
            
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            
            const contentType = res.headers.get('content-type');
            if (!contentType || !contentType.startsWith(`${type}/`)) {
                throw new Error(`URL did not return a ${type}. Content-Type: ${contentType}`);
            }
            
            const contentLength = res.headers.get('content-length');
            if (contentLength && parseInt(contentLength) > maxSize) {
                throw new Error(`${type} too large: exceeds ${maxSize / 1024 / 1024}MB limit`);
            }
            
            const arrayBuffer = await res.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            if (buffer.length > maxSize) throw new Error(`${type} too large: exceeds ${maxSize / 1024 / 1024}MB limit`);
            
            return { buffer, mimeType: contentType };
        } catch (error) {
            if (error.name === 'AbortError') throw new Error(`${type} download timed out`);
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async downloadImageAsBase64(url) {
        let { buffer, mimeType } = await this._download(url, 'image');
        
        const isAvif = mimeType === 'image/avif' || /\.avif(\?.*)?$/i.test(url);
        if (isAvif) {
            try {
                buffer = await sharp(buffer).png().toBuffer();
                mimeType = 'image/png';
            } catch (err) {
                throw new Error(`Failed to convert AVIF: ${err.message}`);
            }
        }
        
        return { mimeType, data: buffer.toString('base64') };
    }

    async downloadVideoAsBuffer(url) {
        return this._download(url, 'video');
    }

    async _upload(inputBuffer, mimeType, type) {
        if (!inputBuffer || inputBuffer.length === 0) throw new Error(`${type} upload failed: empty buffer`);
        
        let ext = mimeType.split('/')[1] || (type === 'video' ? 'mp4' : type === 'audio' ? 'mp3' : 'png');
        if (ext === 'mpeg') ext = 'mp3';
        const filename = `generated.${ext}`;
        const { ulTimeout } = CONFIG[type];

        const doFetch = async (url, form) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), ulTimeout);
            try {
                const res = await fetch(url, { method: 'POST', body: form, signal: controller.signal });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res;
            } catch (err) {
                if (err.name === 'AbortError') throw new Error('Timeout');
                throw err;
            } finally {
                clearTimeout(timeoutId);
            }
        };

        try {
            const form1 = new FormData();
            form1.append('file', new Blob([inputBuffer], { type: mimeType }), filename);
            const res = await doFetch('https://i.nuuls.com/upload', form1);
            const url = (await res.text()).trim();
            if (!url || url === '<none>') throw new Error('Response <none>');
            return url;
        } catch (err1) {
            try {
                const form2 = new FormData();
                form2.append('file', new Blob([inputBuffer], { type: mimeType }), filename);
                const res = await doFetch('https://kappa.lol/api/upload', form2);
                const data = await res.json();
                if (!data?.link) throw new Error('Invalid JSON');
                return data.link;
            } catch (err2) {
                throw new Error(`${type} upload failed: Primary (${err1.message}), Fallback (${err2.message})`);
            }
        }
    }

    uploadImage(buffer, mimeType) { return this._upload(buffer, mimeType, 'image'); }
    uploadVideo(buffer, mimeType) { return this._upload(buffer, mimeType, 'video'); }
    uploadAudio(buffer, mimeType) { return this._upload(buffer, mimeType, 'audio'); }
}

export default MediaProcessor;
