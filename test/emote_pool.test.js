import test from 'node:test';
import assert from 'node:assert/strict';
import { EmotePool } from '../src/twitch/emote_pool.js';

const CHANNELS = ['#virtuallyjesse'];
const IDS = { virtuallyjesse: '12345' };

const fixtureProviders = (overrides = {}) => ({
    '7tv': {
        name: '7TV',
        fetchChannel: async (ids) => new Map(ids.map(id => [id, ['peepoHappy', 'catJAM', 'PauseChamp']])),
        fetchGlobal: async () => ['catJAM', 'Prayge'],
        ...overrides['7tv']
    },
    bttv: {
        name: 'BTTV',
        fetchChannel: async (ids) => new Map(ids.map(id => [id, ['catJAM', 'monkaS']])),
        fetchGlobal: async () => ['SourPls'],
        ...overrides.bttv
    },
    ffz: {
        name: 'FFZ',
        fetchChannel: async (ids) => new Map(ids.map(id => [id, ['ZreknarF']])),
        fetchGlobal: async () => [],
        ...overrides.ffz
    }
});

const build = (options = {}) => new EmotePool({
    env: {},
    providers: fixtureProviders(options.providerOverrides),
    enable7tv: true, enableBttv: true, enableFfz: true,
    include7tvGlobals: true, includeBttvGlobals: true,
    ...options
});

/* ── seeding ─────────────────────────────────────────────── */

test('dedupes emotes shared across providers and merges globals', async () => {
    const pool = build();
    const stats = await pool.seed(CHANNELS, IDS);
    // 7TV: peepoHappy, catJAM, PauseChamp, Prayge | BTTV: monkaS, SourPls | FFZ: ZreknarF
    assert.equal(stats.channels['#virtuallyjesse'], 7);
});

test('a hanging provider does not block seeding', async () => {
    const pool = build({
        timeoutMs: 20,
        providerOverrides: { bttv: { fetchChannel: () => new Promise(() => {}) } }
    });
    const stats = await pool.seed(CHANNELS, IDS);
    assert.ok(stats.channels['#virtuallyjesse'] > 0);
    assert.ok(!pool.ingestMessage({ channel: CHANNELS[0], text: 'monkaS' }).isEmoteOnly);
});

test('a throwing provider is isolated', async () => {
    const pool = build({ providerOverrides: { ffz: { fetchChannel: async () => { throw new Error('502'); } } } });
    const stats = await pool.seed(CHANNELS, IDS);
    assert.ok(stats.channels['#virtuallyjesse'] >= 6);
});

test('emote matching is case sensitive', async () => {
    const pool = build();
    await pool.seed(CHANNELS, IDS);
    assert.equal(pool.ingestMessage({ channel: CHANNELS[0], text: 'catjam' }).textForLogs, 'catjam');
    assert.equal(pool.ingestMessage({ channel: CHANNELS[0], text: 'catJAM' }).textForLogs, 'emote:catJAM');
});

/* ── ingestion ───────────────────────────────────────────── */

test('flags native Twitch emotes from tmi range tags', async () => {
    const pool = build();
    await pool.seed(CHANNELS, IDS);
    const { textForLogs, emoteIdMap } = pool.ingestMessage({
        channel: CHANNELS[0],
        text: 'Kappa hello there',
        tags: { emotes: { 25: ['0-4'] } }
    });
    assert.equal(textForLogs, 'emote:Kappa hello there');
    assert.deepEqual(emoteIdMap, { Kappa: '25' });
});

test('flags third-party tokens mixed with prose', async () => {
    const pool = build();
    await pool.seed(CHANNELS, IDS);
    const { textForLogs } = pool.ingestMessage({ channel: CHANNELS[0], text: 'that clip was wild monkaS' });
    assert.equal(textForLogs, 'that clip was wild emote:monkaS');
});

test('does not flag emote names embedded in words', async () => {
    const pool = build();
    await pool.seed(CHANNELS, IDS);
    assert.equal(pool.ingestMessage({ channel: CHANNELS[0], text: 'supermonkaSx' }).textForLogs, 'supermonkaSx');
});

test('detects emote-only messages across providers and Twitch natives', async () => {
    const pool = build();
    await pool.seed(CHANNELS, IDS);
    const mixed = pool.ingestMessage({
        channel: CHANNELS[0], text: 'Kappa catJAM monkaS', tags: { emotes: { 25: ['0-4'] } }
    });
    assert.equal(mixed.isEmoteOnly, true);
    assert.equal(pool.ingestMessage({ channel: CHANNELS[0], text: 'catJAM go on' }).isEmoteOnly, false);
    assert.equal(pool.ingestMessage({ channel: CHANNELS[0], text: '' }).isEmoteOnly, false);
});

test('strips the command prefix for textForAi while keeping full log text', async () => {
    const pool = build();
    await pool.seed(CHANNELS, IDS);
    const r = pool.ingestMessage({
        channel: CHANNELS[0], text: '!gemini Kappa what is this', prefix: '!gemini',
        tags: { emotes: { 25: ['8-12'] } } // range indexes the raw IRC text
    });
    assert.equal(r.textForAi, 'emote:Kappa what is this');
    assert.equal(r.textForLogs, '!gemini emote:Kappa what is this');
    assert.equal(r.isEmoteOnly, false);
});

test('command with only emotes is emote-only', async () => {
    const pool = build();
    await pool.seed(CHANNELS, IDS);
    const r = pool.ingestMessage({ channel: CHANNELS[0], text: '!gemini catJAM monkaS', prefix: '!gemini' });
    assert.equal(r.isEmoteOnly, true);
});

/* ── decoration ──────────────────────────────────────────── */

test('strips emote: markers and newlines without corrupting words containing emote:', async () => {
    const pool = build({ appendEnabled: false });
    await pool.seed(CHANNELS, IDS);
    assert.equal(pool.decorateReply(CHANNELS[0], 'hey\n\nemote:catJAM   there'), 'hey catJAM there');
    assert.equal(pool.decorateReply(CHANNELS[0], 'remote: server demote: user emote:catJAM'), 'remote: server demote: user catJAM');
});

test('spaces emotes away from punctuation and words', async () => {
    const pool = build({ appendEnabled: false });
    await pool.seed(CHANNELS, IDS);
    assert.equal(pool.decorateReply(CHANNELS[0], 'wow catJAM!'), 'wow catJAM !');
});

test('never rewrites URLs containing an emote name', async () => {
    const pool = build({ appendEnabled: false });
    await pool.seed(CHANNELS, IDS);
    const url = 'https://cdn.example.com/catJAM.png';
    assert.ok(pool.decorateReply(CHANNELS[0], `here you go ${url}`).includes(url));
});

test('appends a random channel emote', async () => {
    const pool = build({ random: () => 0 });
    await pool.seed(CHANNELS, IDS);
    const out = pool.decorateReply(CHANNELS[0], 'all done');
    assert.match(out, /^all done \S+$/);
});

test('skips appending for excluded prefixes', async () => {
    const pool = build({ random: () => 0, excludePrefixes: ['⚠️', 'error'] });
    await pool.seed(CHANNELS, IDS);
    assert.equal(pool.decorateReply(CHANNELS[0], 'Error: upstream is down'), 'Error: upstream is down');
    assert.notEqual(pool.decorateReply(CHANNELS[0], 'all good'), 'all good');
});

test('honours appendEmote:false and maxLength headroom', async () => {
    const pool = build({ random: () => 0 });
    await pool.seed(CHANNELS, IDS);
    assert.equal(pool.decorateReply(CHANNELS[0], 'quiet please', { appendEmote: false }), 'quiet please');
    const long = 'x'.repeat(498);
    assert.equal(pool.decorateReply(CHANNELS[0], long, { maxLength: 499 }), long);
});

test('unseeded / unknown channel degrades to a no-op', () => {
    const pool = build();
    const r = pool.ingestMessage({ channel: '#nobody', text: 'catJAM' });
    assert.equal(r.textForLogs, 'catJAM');
    assert.equal(pool.decorateReply('#nobody', 'hello'), 'hello');
});
