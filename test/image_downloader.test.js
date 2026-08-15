import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageDownloader } from '../src/ai/image_downloader.js';

test('recognized image extension returns true without HEAD request', async () => {
    let headCalled = false;
    const fetchImpl = async () => {
        headCalled = true;
        return { ok: true };
    };

    const downloader = new ImageDownloader({ fetchImpl });
    const isImage = await downloader.isImageUrlAsync('https://example.com/photo.png');
    assert.equal(isImage, true);
    assert.equal(headCalled, false);
});

test('known image host is recognized without HEAD request', async () => {
    let headCalled = false;
    const fetchImpl = async () => {
        headCalled = true;
        return { ok: true };
    };

    const downloader = new ImageDownloader({ fetchImpl });
    const isImage = await downloader.isImageUrlAsync('https://cdn.discordapp.com/attachments/123/456');
    assert.equal(isImage, true);
    assert.equal(headCalled, false);
});

test('unknown extension falls back to HEAD request', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'image/jpeg; charset=utf-8' })
        };
    };

    const downloader = new ImageDownloader({ fetchImpl });
    const isImage = await downloader.isImageUrlAsync('https://example.com/media/random-id');
    assert.equal(isImage, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.method, 'HEAD');
});

test('non-image HEAD response returns false', async () => {
    const fetchImpl = async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' })
    });

    const downloader = new ImageDownloader({ fetchImpl });
    const isImage = await downloader.isImageUrlAsync('https://example.com/article');
    assert.equal(isImage, false);
});

test('HEAD request failure returns false instead of throwing', async () => {
    const fetchImpl = async () => {
        throw new Error('Network error');
    };

    const downloader = new ImageDownloader({ fetchImpl });
    const isImage = await downloader.isImageUrlAsync('https://example.com/unreachable');
    assert.equal(isImage, false);
});

test('downloadImageAsBase64 downloads and encodes image data', async () => {
    const fakeData = Buffer.from('hello-image-bytes');
    const fetchImpl = async () => ({
        ok: true,
        status: 200,
        headers: new Headers({
            'content-type': 'image/png',
            'content-length': String(fakeData.length)
        }),
        arrayBuffer: async () => fakeData.buffer.slice(fakeData.byteOffset, fakeData.byteOffset + fakeData.byteLength)
    });

    const downloader = new ImageDownloader({ fetchImpl });
    const result = await downloader.downloadImageAsBase64('https://example.com/photo.png');

    assert.equal(result.mimeType, 'image/png');
    assert.equal(result.data, fakeData.toString('base64'));
});

test('downloadImageAsBase64 rejects non-2xx response', async () => {
    const fetchImpl = async () => ({
        ok: false,
        status: 404,
        statusText: 'Not Found'
    });

    const downloader = new ImageDownloader({ fetchImpl });
    await assert.rejects(
        async () => downloader.downloadImageAsBase64('https://example.com/not-found.png'),
        /HTTP 404: Not Found/
    );
});

test('downloadImageAsBase64 rejects non-image content type', async () => {
    const fetchImpl = async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' })
    });

    const downloader = new ImageDownloader({ fetchImpl });
    await assert.rejects(
        async () => downloader.downloadImageAsBase64('https://example.com/data.json'),
        /URL did not return an image/
    );
});

test('downloadImageAsBase64 rejects oversized images via content-length', async () => {
    const fetchImpl = async () => ({
        ok: true,
        status: 200,
        headers: new Headers({
            'content-type': 'image/png',
            'content-length': String(30 * 1024 * 1024)
        })
    });

    const downloader = new ImageDownloader({ fetchImpl });
    await assert.rejects(
        async () => downloader.downloadImageAsBase64('https://example.com/huge.png'),
        /Image too large: exceeds 25MB limit/
    );
});

test('downloadImageAsBase64 rejects oversized images via buffer length', async () => {
    const hugeBuf = Buffer.alloc(26 * 1024 * 1024);
    const fetchImpl = async () => ({
        ok: true,
        status: 200,
        headers: new Headers({
            'content-type': 'image/png'
        }),
        arrayBuffer: async () => hugeBuf.buffer.slice(hugeBuf.byteOffset, hugeBuf.byteOffset + hugeBuf.byteLength)
    });

    const downloader = new ImageDownloader({ fetchImpl });
    await assert.rejects(
        async () => downloader.downloadImageAsBase64('https://example.com/huge.png'),
        /Image too large: exceeds 25MB limit/
    );
});

test('downloadImageAsBase64 converts AVIF to PNG using sharp', async () => {
    const rawAvif = Buffer.from('avif-binary-data');
    const convertedPng = Buffer.from('png-converted-data');
    let sharpCalled = false;

    const sharpImpl = (buf) => {
        sharpCalled = true;
        assert.deepEqual(buf, rawAvif);
        return {
            png() {
                return {
                    async toBuffer() {
                        return convertedPng;
                    }
                };
            }
        };
    };

    const fetchImpl = async () => ({
        ok: true,
        status: 200,
        headers: new Headers({
            'content-type': 'image/avif; charset=binary',
            'content-length': String(rawAvif.length)
        }),
        arrayBuffer: async () => rawAvif.buffer.slice(rawAvif.byteOffset, rawAvif.byteOffset + rawAvif.byteLength)
    });

    const downloader = new ImageDownloader({ fetchImpl, sharpImpl });
    const result = await downloader.downloadImageAsBase64('https://example.com/pic.avif');

    assert.equal(sharpCalled, true);
    assert.equal(result.mimeType, 'image/png');
    assert.equal(result.data, convertedPng.toString('base64'));
});

test('downloadImageAsBase64 handles timeout', async () => {
    const fetchImpl = async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
    };

    const downloader = new ImageDownloader({ fetchImpl });
    await assert.rejects(
        async () => downloader.downloadImageAsBase64('https://example.com/timeout.png'),
        /Image download timed out/
    );
});
