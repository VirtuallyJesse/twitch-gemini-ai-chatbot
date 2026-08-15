import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaUploader } from '../src/media/media_uploader.js';

test('primary host success returns the primary URL', async () => {
    const fetchCalls = [];
    const fetchImpl = async (url, options) => {
        fetchCalls.push({ url, options });
        return {
            ok: true,
            status: 200,
            text: async () => 'https://i.nuuls.com/sample.png\n'
        };
    };

    const uploader = new MediaUploader({ fetchImpl });
    const buffer = Buffer.from('test-image-data');
    const result = await uploader.upload(buffer, { mediaType: 'image', mimeType: 'image/png' });

    assert.equal(result, 'https://i.nuuls.com/sample.png');
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'https://i.nuuls.com/upload');
});

test('primary empty response falls back to secondary host', async () => {
    const fetchCalls = [];
    const fetchImpl = async (url, options) => {
        fetchCalls.push({ url, options });
        if (url.includes('i.nuuls.com')) {
            return {
                ok: true,
                status: 200,
                text: async () => '<none>'
            };
        }
        return {
            ok: true,
            status: 200,
            json: async () => ({ link: 'https://kappa.lol/sample.png' })
        };
    };

    const uploader = new MediaUploader({ fetchImpl });
    const buffer = Buffer.from('test-image-data');
    const result = await uploader.upload(buffer, { mediaType: 'image' });

    assert.equal(result, 'https://kappa.lol/sample.png');
    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[0].url, 'https://i.nuuls.com/upload');
    assert.equal(fetchCalls[1].url, 'https://kappa.lol/api/upload');
});

test('primary HTTP 500 falls back to secondary host', async () => {
    const fetchCalls = [];
    const fetchImpl = async (url, options) => {
        fetchCalls.push({ url, options });
        if (url.includes('i.nuuls.com')) {
            return {
                ok: false,
                status: 500,
                text: async () => 'Server Error'
            };
        }
        return {
            ok: true,
            status: 200,
            json: async () => ({ link: 'https://kappa.lol/video.mp4' })
        };
    };

    const uploader = new MediaUploader({ fetchImpl });
    const buffer = Buffer.from('test-video-data');
    const result = await uploader.upload(buffer, { mediaType: 'video', mimeType: 'video/mp4' });

    assert.equal(result, 'https://kappa.lol/video.mp4');
    assert.equal(fetchCalls.length, 2);
});

test('primary timeout falls back to secondary host', async () => {
    const fetchCalls = [];
    const fetchImpl = async (url, options) => {
        fetchCalls.push({ url, options });
        if (url.includes('i.nuuls.com')) {
            const err = new Error('Abort');
            err.name = 'AbortError';
            throw err;
        }
        return {
            ok: true,
            status: 200,
            json: async () => ({ link: 'https://kappa.lol/audio.mp3' })
        };
    };

    const uploader = new MediaUploader({ fetchImpl });
    const buffer = Buffer.from('test-audio-data');
    const result = await uploader.upload(buffer, { mediaType: 'tts', mimeType: 'audio/mpeg' });

    assert.equal(result, 'https://kappa.lol/audio.mp3');
    assert.equal(fetchCalls.length, 2);
});

test('both hosts failing throws composite error', async () => {
    const fetchImpl = async (url) => {
        if (url.includes('i.nuuls.com')) {
            return {
                ok: false,
                status: 502,
                text: async () => 'Bad Gateway'
            };
        }
        return {
            ok: false,
            status: 503,
            text: async () => 'Service Unavailable'
        };
    };

    const uploader = new MediaUploader({ fetchImpl });
    const buffer = Buffer.from('test-music-data');

    await assert.rejects(
        async () => uploader.upload(buffer, { mediaType: 'music' }),
        /Audio upload failed: Primary \(HTTP 502\), Fallback \(HTTP 503\)/
    );
});

test('fallback invalid JSON throws composite error', async () => {
    const fetchImpl = async (url) => {
        if (url.includes('i.nuuls.com')) {
            return { ok: false, status: 500 };
        }
        return {
            ok: true,
            status: 200,
            json: async () => ({ error: 'no link' })
        };
    };

    const uploader = new MediaUploader({ fetchImpl });
    const buffer = Buffer.from('test-image-data');

    await assert.rejects(
        async () => uploader.upload(buffer, { mediaType: 'image' }),
        /Image upload failed: Primary \(HTTP 500\), Fallback \(invalid JSON response\)/
    );
});

test('empty buffer is rejected without network requests', async () => {
    let called = false;
    const fetchImpl = async () => {
        called = true;
        return { ok: true };
    };

    const uploader = new MediaUploader({ fetchImpl });

    await assert.rejects(
        async () => uploader.upload(Buffer.alloc(0), { mediaType: 'image' }),
        /Image upload failed: empty buffer/
    );
    assert.equal(called, false);

    await assert.rejects(
        async () => uploader.upload(null, { mediaType: 'video' }),
        /Video upload failed: empty buffer/
    );
    assert.equal(called, false);
});

test('unsupported media type throws error', async () => {
    const uploader = new MediaUploader();
    await assert.rejects(
        async () => uploader.upload(Buffer.from('data'), { mediaType: 'unsupported' }),
        /Unsupported media upload type: unsupported/
    );
});

test('correctly configures timeout overrides', () => {
    const uploader = new MediaUploader({
        timeoutMsByKind: { image: 5000 },
        timeoutMs: null
    });
    assert.equal(uploader.timeoutMs.image, 5000);
    assert.equal(uploader.timeoutMs.video, 180000);

    const uniform = new MediaUploader({ timeoutMs: 12000 });
    assert.equal(uniform.timeoutMs.image, 12000);
    assert.equal(uniform.timeoutMs.video, 12000);
    assert.equal(uniform.timeoutMs.audio, 12000);
});
