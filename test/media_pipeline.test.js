import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaPipeline } from '../src/media/media_pipeline.js';
import ErrorHandler from '../src/utils/error_handler.js';

function createDoubles(overrides = {}) {
    const errorHandler = overrides.errorHandler || new ErrorHandler();

    const provider = {
        generateImage: async (prompt) => ({
            buffer: Buffer.from(`img-${prompt}`),
            mimeType: 'image/png'
        }),
        generateVideo: async (prompt) => ({
            buffer: Buffer.from(`vid-${prompt}`),
            mimeType: 'video/mp4'
        }),
        generateAudio: async (prompt) => ({
            buffer: Buffer.from(`tts-${prompt}`),
            mimeType: 'audio/mpeg'
        }),
        generateMusic: async (prompt) => ({
            buffer: Buffer.from(`music-${prompt}`),
            mimeType: 'audio/mpeg'
        }),
        ...overrides.provider
    };

    const uploader = {
        uploadCalls: [],
        upload: async (buffer, opts) => {
            uploader.uploadCalls.push({ buffer, opts });
            return overrides.uploadedUrl || 'https://i.nuuls.com/generated-test.png';
        },
        ...overrides.uploader
    };

    const storage = {
        entries: [],
        addMediaEntry: async (entry) => {
            storage.entries.push(entry);
        },
        ...overrides.storage
    };

    const aiOperations = {
        calls: [],
        make_gemini_call: async (text, opts) => {
            aiOperations.calls.push({ text, opts });
            return overrides.aiResponse ?? 'Behold your creation! https://i.nuuls.com/generated-test.png Cool stuff.';
        },
        ...overrides.aiOperations
    };

    const emotes = {
        decorateReply: (_channel, text) => text,
        ...overrides.emotes
    };

    const savedEntries = [];
    const onMediaSaved = async (entry) => {
        savedEntries.push(entry);
        if (overrides.onMediaSaved) {
            await overrides.onMediaSaved(entry);
        }
    };

    const pipeline = new MediaPipeline({
        provider,
        uploader,
        storage,
        aiOperations,
        errorHandler,
        emotes,
        onMediaSaved,
        providerName: 'pollinations',
        maxLength: 499,
        now: () => 1700000000000,
        idFactory: () => 'fixed-id-123',
        ...overrides.pipelineOptions
    });

    return {
        pipeline,
        provider,
        uploader,
        storage,
        aiOperations,
        emotes,
        errorHandler,
        savedEntries
    };
}

test('empty or whitespace prompt returns MEDIA_PROMPT_REQUIRED without invoking provider', async () => {
    let providerCalled = false;
    const { pipeline } = createDoubles({
        provider: {
            generateImage: async () => {
                providerCalled = true;
                return { buffer: Buffer.from('data') };
            }
        }
    });

    const result = await pipeline.synthesize({
        channel: '#streamer',
        user: { username: 'testuser', 'display-name': 'TestUser' },
        prompt: '   ',
        mediaType: 'image',
        command: '!image'
    });

    assert.equal(result.success, false);
    assert.equal(result.mediaEntry, null);
    assert.match(result.replyText, /@TestUser Please provide a description for the image\./);
    assert.equal(providerCalled, false);
});

test('dispatches correctly to provider methods based on mediaType', async () => {
    const calls = [];
    const { pipeline } = createDoubles({
        provider: {
            generateImage: async (p) => { calls.push(['image', p]); return { buffer: Buffer.from('1') }; },
            generateVideo: async (p) => { calls.push(['video', p]); return { buffer: Buffer.from('2') }; },
            generateAudio: async (p) => { calls.push(['tts', p]); return { buffer: Buffer.from('3') }; },
            generateMusic: async (p) => { calls.push(['music', p]); return { buffer: Buffer.from('4') }; }
        }
    });

    await pipeline.synthesize({ channel: '#ch', user: 'bob', prompt: 'a cat', mediaType: 'image', command: '!image' });
    await pipeline.synthesize({ channel: '#ch', user: 'bob', prompt: 'a dog', mediaType: 'video', command: '!video' });
    await pipeline.synthesize({ channel: '#ch', user: 'bob', prompt: 'hello', mediaType: 'tts', command: '!tts' });
    await pipeline.synthesize({ channel: '#ch', user: 'bob', prompt: 'song', mediaType: 'music', command: '!song' });

    assert.deepEqual(calls, [
        ['image', 'a cat'],
        ['video', 'a dog'],
        ['tts', 'hello'],
        ['music', 'song']
    ]);
});

test('missing or empty buffer returns MEDIA_NO_DATA', async () => {
    const { pipeline } = createDoubles({
        provider: {
            generateImage: async () => ({ buffer: Buffer.alloc(0) })
        }
    });

    const result = await pipeline.synthesize({
        channel: '#ch',
        user: 'alice',
        prompt: 'cat',
        mediaType: 'image',
        command: '!image'
    });

    assert.equal(result.success, false);
    assert.equal(result.mediaEntry, null);
    assert.match(result.replyText, /No image data returned/);
});

test('canonical media entry is persisted to storage and broadcast hook', async () => {
    const { pipeline, storage, savedEntries } = createDoubles({
        uploadedUrl: 'https://i.nuuls.com/cool-image.png'
    });

    const result = await pipeline.synthesize({
        channel: '#live',
        user: { 'display-name': 'Alice' },
        prompt: 'sunset over ocean',
        mediaType: 'image',
        command: '!image'
    });

    assert.equal(result.success, true);
    assert.ok(result.mediaEntry);
    assert.deepEqual(result.mediaEntry, {
        id: 'fixed-id-123',
        timestamp: 1700000000000,
        channel: '#live',
        username: 'Alice',
        command: '!image',
        prompt: 'sunset over ocean',
        mediaUrl: 'https://i.nuuls.com/cool-image.png',
        mediaType: 'image'
    });

    assert.equal(storage.entries.length, 1);
    assert.deepEqual(storage.entries[0], result.mediaEntry);
    assert.equal(savedEntries.length, 1);
    assert.deepEqual(savedEntries[0], result.mediaEntry);
});

test('storage or broadcast failure does not cause synthesis to fail', async () => {
    const { pipeline } = createDoubles({
        uploadedUrl: 'https://i.nuuls.com/cool-image.png',
        storage: {
            addMediaEntry: async () => {
                throw new Error('Redis connection lost');
            }
        },
        onMediaSaved: async () => {
            throw new Error('WS broken');
        }
    });

    const result = await pipeline.synthesize({
        channel: '#live',
        user: 'chatter',
        prompt: 'a dog',
        mediaType: 'image',
        command: '!image'
    });

    assert.equal(result.success, true);
    assert.equal(result.mediaEntry.mediaUrl, 'https://i.nuuls.com/cool-image.png');
    assert.ok(result.replyText.includes('https://i.nuuls.com/cool-image.png'));
});

test('appends URL automatically if omitted by AI presentation', async () => {
    const { pipeline } = createDoubles({
        uploadedUrl: 'https://i.nuuls.com/pic.png',
        aiResponse: 'Here is your marvelous artwork with lots of flair!'
    });

    const result = await pipeline.synthesize({
        channel: '#live',
        user: 'bob',
        prompt: 'art',
        mediaType: 'image',
        command: '!image'
    });

    assert.equal(result.success, true);
    assert.ok(result.replyText.includes('https://i.nuuls.com/pic.png'));
    assert.match(result.replyText, /Here is your marvelous artwork with lots of flair! https:\/\/i\.nuuls\.com\/pic\.png/);
});

test('AI exception falls back to MEDIA_FALLBACK_RESPONSE with valid URL', async () => {
    const { pipeline } = createDoubles({
        uploadedUrl: 'https://i.nuuls.com/audio.mp3',
        aiOperations: {
            make_gemini_call: async () => {
                throw new Error('Gemini quota reached');
            }
        }
    });

    const result = await pipeline.synthesize({
        channel: '#live',
        user: { 'display-name': 'Charlie' },
        prompt: 'read this text',
        mediaType: 'tts',
        command: '!tts'
    });

    assert.equal(result.success, true);
    assert.equal(result.mediaEntry.mediaUrl, 'https://i.nuuls.com/audio.mp3');
    assert.equal(result.replyText, "Here's your tts Charlie: https://i.nuuls.com/audio.mp3");
});

test('AI empty/blocked response falls back to MEDIA_FALLBACK_RESPONSE', async () => {
    const { pipeline } = createDoubles({
        uploadedUrl: 'https://i.nuuls.com/song.mp3',
        aiResponse: ''
    });

    const result = await pipeline.synthesize({
        channel: '#live',
        user: { 'display-name': 'Dave' },
        prompt: 'techno beat',
        mediaType: 'music',
        command: '!song'
    });

    assert.equal(result.success, true);
    assert.equal(result.replyText, "Here's your music Dave: https://i.nuuls.com/song.mp3");
});

test('provider error returns friendly message from ErrorHandler', async () => {
    const { pipeline } = createDoubles({
        provider: {
            generateImage: async () => {
                throw new Error('Pollinations Image HTTP 504: Gateway Timeout');
            }
        }
    });

    const result = await pipeline.synthesize({
        channel: '#live',
        user: 'user1',
        prompt: 'city skyline',
        mediaType: 'image',
        command: '!image'
    });

    assert.equal(result.success, false);
    assert.equal(result.mediaEntry, null);
    assert.match(result.replyText, /Gateway Timeout/);
});

test('upload failure returns friendly upload error message', async () => {
    const { pipeline } = createDoubles({
        uploader: {
            upload: async () => {
                throw new Error('Image upload failed: Primary (Timeout), Fallback (HTTP 502)');
            }
        }
    });

    const result = await pipeline.synthesize({
        channel: '#live',
        user: 'user1',
        prompt: 'city skyline',
        mediaType: 'image',
        command: '!image'
    });

    assert.equal(result.success, false);
    assert.equal(result.mediaEntry, null);
    assert.match(result.replyText, /Upload (Timeout|Error|Failed)/);
});

test('audio upload failure for TTS returns AUDIO_UPLOAD_* message', async () => {
    const { pipeline } = createDoubles({
        uploader: {
            upload: async () => {
                throw new Error('Audio upload failed: Primary (Timeout), Fallback (HTTP 500)');
            }
        }
    });

    const result = await pipeline.synthesize({
        channel: '#live',
        user: 'user1',
        prompt: 'hello world',
        mediaType: 'tts',
        command: '!tts'
    });

    assert.equal(result.success, false);
    assert.equal(result.mediaEntry, null);
    assert.match(result.replyText, /Audio Upload/);
});

test('never truncates the generated media URL even when exceeding maxLength', async () => {
    const longUrl = 'https://i.nuuls.com/' + 'a'.repeat(80) + '.png';
    const longAiCommentary = 'W' + 'o'.repeat(480) + 'w!';

    const { pipeline } = createDoubles({
        uploadedUrl: longUrl,
        aiResponse: `${longAiCommentary} ${longUrl}`,
        pipelineOptions: { maxLength: 200 }
    });

    const result = await pipeline.synthesize({
        channel: '#live',
        user: 'user',
        prompt: 'massive art',
        mediaType: 'image',
        command: '!image'
    });

    assert.equal(result.success, true);
    assert.ok(result.replyText.length <= 200);
    assert.ok(result.replyText.includes(longUrl));
});

test('preserves trailing punchline suffix when prefix commentary exceeds limit', async () => {
    const url = 'https://i.nuuls.com/cat.png';
    const longPrefix = 'A'.repeat(250);
    const punchline = 'Hope your speakers can handle it!';

    const { pipeline } = createDoubles({
        uploadedUrl: url,
        aiResponse: `${longPrefix} ${url} ${punchline}`,
        pipelineOptions: { maxLength: 100 }
    });

    const result = await pipeline.synthesize({
        channel: '#live',
        user: 'user',
        prompt: 'cat',
        mediaType: 'image',
        command: '!image'
    });

    assert.equal(result.success, true);
    assert.ok(result.replyText.length <= 100);
    assert.ok(result.replyText.includes(url));
    assert.ok(result.replyText.endsWith(punchline));
});

test('unknown errors return safe message from error_messages.json without leaking raw error string', async () => {
    const { pipeline } = createDoubles({
        provider: {
            generateImage: async () => {
                throw new Error('Raw internal system stack dump 12345');
            }
        }
    });

    const result = await pipeline.synthesize({
        channel: '#live',
        user: 'user',
        prompt: 'test',
        mediaType: 'image',
        command: '!image'
    });

    assert.equal(result.success, false);
    assert.equal(result.mediaEntry, null);
    assert.equal(result.replyText.includes('12345'), false);
    assert.match(result.replyText, /Unknown Error/);
});
