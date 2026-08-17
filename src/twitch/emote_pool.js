// src/twitch/emote_pool.js
//
// The emote pool owns the whole emote lifecycle: startup seeding from 7TV/BTTV/FFZ,
// incoming chat parsing (3rd-party tokens + Twitch native ranges), and outgoing
// reply decoration. Callers only ever need seed / ingestMessage / decorateReply.

import {
    fetchSevenTvChannelEmotesForTwitchIds,
    fetchSevenTvGlobalEmotes,
    fetchBttvChannelEmotesForTwitchIds,
    fetchBttvGlobalEmotes,
    fetchFfzChannelEmotesForTwitchIds,
    fetchFfzGlobalEmotes
} from './emote_providers.js';

const PLATFORMS = ['7tv', 'bttv', 'ffz'];
const EMOTE_ONLY = /^(?:\s*emote:\S+\s*)+$/;
const WORD = '\\p{L}\\p{N}_';
const URL_SPLIT = /(https?:\/\/\S+)/g;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bool = (v, fallback) => (v === undefined || v === null || v === '' ? fallback : String(v) === 'true');
const csv = (v) => String(v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const channelKey = (channel) => (channel ? `#${String(channel).replace('#', '').toLowerCase()}` : null);

const DEFAULT_PROVIDERS = {
    '7tv': { name: '7TV', fetchChannel: fetchSevenTvChannelEmotesForTwitchIds, fetchGlobal: fetchSevenTvGlobalEmotes },
    bttv: { name: 'BTTV', fetchChannel: fetchBttvChannelEmotesForTwitchIds, fetchGlobal: fetchBttvGlobalEmotes },
    ffz: { name: 'FFZ', fetchChannel: fetchFfzChannelEmotesForTwitchIds, fetchGlobal: fetchFfzGlobalEmotes }
};

const EMPTY_VIEW = { tokens: [], match: null, space: null, pool: [] };

export class EmotePool {
    #providers;
    #cfg;
    #channels = new Map();
    #any = EMPTY_VIEW; // union view used for channel-less callers (web endpoint, tests)

    /**
     * Reads env by default; every knob is overridable for tests.
     * `providers` is the injection seam — supply fixtures to avoid network.
     */
    constructor(options = {}) {
        const env = options.env || process.env;
        this.#providers = options.providers || DEFAULT_PROVIDERS;
        this.#cfg = {
            enabled: {
                '7tv': options.enable7tv ?? bool(env.ENABLE_7TV_EMOTES, true),
                bttv: options.enableBttv ?? bool(env.ENABLE_BTTV_EMOTES, true),
                ffz: options.enableFfz ?? bool(env.ENABLE_FFZ_EMOTES, false)
            },
            globals: {
                '7tv': options.include7tvGlobals ?? bool(env.INCLUDE_7TV_GLOBAL_EMOTES, false),
                bttv: options.includeBttvGlobals ?? bool(env.INCLUDE_BTTV_GLOBAL_EMOTES, false),
                ffz: options.includeFfzGlobals ?? bool(env.INCLUDE_FFZ_GLOBAL_EMOTES, false)
            },
            timeoutMs: Number(options.timeoutMs ?? env.EMOTE_FETCH_TIMEOUT_MS ?? 10_000),
            appendEnabled: options.appendEnabled ?? bool(env.ENABLE_EMOTE_APPENDING, true),
            excludePrefixes: options.excludePrefixes ?? csv(env.EMOTE_APPEND_EXCLUDE_PREFIXES),
            spacing: options.spacing ?? true,
            random: options.random || Math.random
        };
    }

    /* ── startup ─────────────────────────────────────────────── */

    /**
     * Fetches every enabled provider concurrently (channel sets + globals),
     * compiles separate ingestion sets (for chat recognition) and append pools
     * (gated by INCLUDE_*_GLOBAL_EMOTES for random sign-offs), and builds regexes.
     * Provider failures and hangs are isolated: a dead CDN yields an empty list.
     */
    async seed(channels = [], channelIdMap = {}) {
        const ids = [...new Set(Object.values(channelIdMap || {}).filter(Boolean).map(String))];
        const globals = Object.fromEntries(PLATFORMS.map(p => [p, []]));
        const byId = Object.fromEntries(PLATFORMS.map(p => [p, new Map()]));
        const opts = { timeoutMs: this.#cfg.timeoutMs };
        const jobs = [];

        for (const p of PLATFORMS) {
            const provider = this.#providers[p];
            if (!provider || !this.#cfg.enabled[p]) {
                console.log(`[Emotes] ${provider?.name || p} disabled.`);
                continue;
            }
            jobs.push(this.#guard(`${provider.name} channel`, () => provider.fetchChannel(ids, opts), new Map())
                .then(map => { byId[p] = map instanceof Map ? map : new Map(); }));

            jobs.push(this.#guard(`${provider.name} global`, () => provider.fetchGlobal(opts), [])
                .then(list => { globals[p] = Array.isArray(list) ? list : []; }));
        }

        await Promise.all(jobs);

        this.#channels.clear();
        const unionIngest = new Set();
        const unionPool = new Set();

        for (const ch of channels) {
            const key = channelKey(ch);
            if (!key) continue;
            const id = channelIdMap?.[key.slice(1)];
            const ingest = new Set();
            const pool = new Set();

            for (const p of PLATFORMS) {
                const channelTokens = id ? byId[p].get(String(id)) || [] : [];
                for (const t of channelTokens) {
                    this.#addToken(ingest, t);
                    this.#addToken(pool, t);
                }
                for (const t of globals[p]) {
                    this.#addToken(ingest, t);
                    if (this.#cfg.globals[p]) this.#addToken(pool, t);
                }
            }

            this.#channels.set(key, this.#compile(ingest, pool));
            for (const t of ingest) unionIngest.add(t);
            for (const t of pool) unionPool.add(t);
            console.log(`[Emotes] ${key}: ${ingest.size} recognized, ${pool.size} appendable`);
        }

        this.#any = this.#compile(unionIngest, unionPool);
        return this.stats();
    }

    stats() {
        return {
            channels: Object.fromEntries([...this.#channels].map(([k, v]) => [k, v.tokens.length])),
            total: this.#any.tokens.length
        };
    }

    /* ── incoming ────────────────────────────────────────────── */

    /**
     * Single-pass ingestion for a chat message.
     * `prefix` (optional) is the matched command token; when present, `textForAi`
     * is the prompt body with the command stripped. Twitch native emote ranges are
     * always resolved against the untouched IRC text so positions stay valid.
     */
    ingestMessage({ channel, text, tags = null, prefix = '' } = {}) {
        const raw = typeof text === 'string' ? text : '';
        const view = this.#view(channel);
        const emoteIdMap = this.#twitchEmoteIds(raw, tags);
        const twitchNames = new Set(Object.keys(emoteIdMap));

        const textForLogs = this.#flag(view, raw, twitchNames);
        const body = prefix ? raw.slice(prefix.length).replace(/^,\s*/, '').trim() : raw;
        const textForAi = prefix ? this.#flag(view, body, twitchNames) : textForLogs;

        const trimmed = textForAi.trim();
        return {
            textForAi,
            textForLogs,
            emoteIdMap,
            isEmoteOnly: trimmed.length > 0 && EMOTE_ONLY.test(trimmed)
        };
    }

    /* ── outgoing ────────────────────────────────────────────── */

    /**
     * Strips internal `emote:` markers, flattens whitespace/newlines, spaces emotes
     * away from adjacent words and punctuation, and appends a random channel emote
     * unless disabled or the reply starts with an excluded prefix.
     */
    decorateReply(channel, rawReply, { appendEmote = true, maxLength = null } = {}) {
        let out = String(rawReply ?? '').replace(/(?<!\S)emote:/g, '').replace(/\s+/g, ' ').trim();
        if (!out) return out;

        const view = this.#view(channel);
        out = this.#spaceEmotes(view, out);

        if (appendEmote && this.#cfg.appendEnabled && !this.#isExcluded(out)) {
            const emote = this.#randomEmote(view);
            if (emote && (!maxLength || out.length + emote.length + 1 <= maxLength)) {
                out = `${out} ${emote}`;
            }
        }
        return out;
    }

    /**
     * Builds dynamic harness instructions for emote IR token syntax and auto-appending.
     * @returns {string}
     */
    getHarnessInstructions() {
        const parts = [
            '<emotes>',
            'Users can type emotes into chat, which you will see formatted as emote:NAME for easy identification.',
            'Treat emote:NAME tokens as opaque unless contextually relevant to the user\'s prompt, for example if the user asks you to repeat an emote, or if an emote hints at the user\'s mood or intent.',
            'If you decide you must repeat an emote a user has written, echo it exactly as displayed with case-sensitivity.',
            'Do NOT invent new emotes or use emotes you haven\'t seen in the user\'s prompt or in your active Twitch chat logs.'
        ];

        if (this.#cfg.appendEnabled) {
            parts.push(
                'An emote is randomly appended to the end of every message you send. This function is automatic without your involvement and is performed by the system handler. You are not the system, do not attempt to perform this task.'
            );
        }

        parts.push('</emotes>');
        return parts.join('\n');
    }

    /* ── internals ───────────────────────────────────────────── */

    #addToken(set, value) {
        if (typeof value !== 'string') return;
        const t = value.trim();
        if (!t || /\s/.test(t)) return;
        set.add(t); // case-sensitive: Twitch emotes are, and LUL !== lul
    }

    #compile(ingestSet, poolSet = ingestSet) {
        const tokens = [...ingestSet].sort((a, b) => b.length - a.length || a.localeCompare(b));
        if (tokens.length === 0) return EMPTY_VIEW;
        const alt = tokens.map(escapeRe).join('|');
        return {
            tokens,
            // strict: only whole whitespace-delimited tokens get flagged as emotes
            match: new RegExp(`(?<!\\S)(${alt})(?!\\S)`, 'g'),
            // loose: catches "LUL!" / "wowLUL" boundaries so spacing can be repaired
            space: new RegExp(`(?<![${WORD}])(${alt})(?![${WORD}])`, 'gu'),
            pool: [...poolSet].sort((a, b) => a.localeCompare(b))
        };
    }

    #view(channel) {
        const key = channelKey(channel);
        return (key && this.#channels.get(key)) || this.#any;
    }

    async #guard(label, fn, fallback) {
        const { timeoutMs } = this.#cfg;
        let timer;
        try {
            return await Promise.race([
                Promise.resolve().then(fn),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
                    timer.unref?.();
                })
            ]);
        } catch (e) {
            console.error(`[Emotes] ${label} failed: ${e.message || e}`);
            return fallback;
        } finally {
            clearTimeout(timer);
        }
    }

    #twitchEmoteIds(message, tags) {
        const out = {};
        const emotes = tags && typeof tags === 'object' ? tags.emotes : null;
        if (!message || !emotes || typeof emotes !== 'object') return out;

        for (const [emoteId, ranges] of Object.entries(emotes)) {
            if (!Array.isArray(ranges) || ranges.length === 0 || typeof ranges[0] !== 'string') continue;
            const [s, e] = ranges[0].split('-').map(n => Number.parseInt(n, 10));
            if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e < s || e >= message.length) continue;
            const name = message.substring(s, e + 1).trim();
            if (name) out[name] = String(emoteId);
        }
        return out;
    }

    #flag(view, text, twitchNames) {
        if (!text) return text || '';
        let out = text;

        if (twitchNames.size > 0) {
            const alt = [...twitchNames].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
            out = out.replace(new RegExp(`(?<!\\S)(${alt})(?!\\S)`, 'g'), m => `emote:${m}`);
        }
        if (view.match) {
            view.match.lastIndex = 0;
            out = out.replace(view.match, m => `emote:${m}`);
        }
        return out;
    }

    #spaceEmotes(view, text) {
        if (!this.#cfg.spacing || !view.space) return text;
        // Never touch URLs — an emote name can legitimately appear inside a media link.
        const spaced = text.split(URL_SPLIT).map(segment => {
            if (/^https?:\/\//.test(segment)) return segment;
            view.space.lastIndex = 0;
            return segment.replace(view.space, (m, _g, offset, whole) => {
                const before = offset > 0 ? whole[offset - 1] : '';
                const after = whole[offset + m.length] || '';
                return `${before && !/\s/.test(before) ? ' ' : ''}${m}${after && !/\s/.test(after) ? ' ' : ''}`;
            });
        }).join('');
        return spaced.replace(/ {2,}/g, ' ').trim();
    }

    #isExcluded(reply) {
        if (this.#cfg.excludePrefixes.length === 0) return false;
        const lower = reply.toLowerCase();
        return this.#cfg.excludePrefixes.some(p => lower.startsWith(p));
    }

    #randomEmote(view) {
        if (view.pool.length === 0) return '';
        return view.pool[Math.floor(this.#cfg.random() * view.pool.length)] || '';
    }
}

export default EmotePool;
