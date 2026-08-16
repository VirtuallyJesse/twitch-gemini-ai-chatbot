// public/web_emotes.js
// Pure client-side helpers for 1x scale emote asset resolution, payload parsing, and HTML rendering.

/**
 * Ensures protocol-relative URLs start with https:.
 */
export function ensureHttps(u) {
    if (!u || typeof u !== 'string') return '';
    const trimmed = u.trim();
    if (trimmed.startsWith('//')) return 'https:' + trimmed;
    return trimmed;
}

/**
 * Escapes characters for safe HTML injection.
 */
export function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/**
 * Checks if a string token is an HTTP/HTTPS URL.
 */
export function isUrlToken(token) {
    return /^https?:\/\/\S+$/i.test(String(token || ''));
}

/**
 * Constructs a Twitch native emote URL targeting dark theme and 1.0 scale (~28x28px).
 */
export function getTwitchEmoteUrlById(id) {
    if (!id || typeof id !== 'string' && typeof id !== 'number') return null;
    const cleanId = String(id).trim();
    if (!cleanId) return null;
    return `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(cleanId)}/default/dark/1.0`;
}

/**
 * Constructs a BetterTTV emote URL targeting 1x.webp (~28x28px).
 */
export function getBttvEmoteUrlById(id) {
    if (!id || typeof id !== 'string' && typeof id !== 'number') return null;
    const cleanId = String(id).trim();
    if (!cleanId) return null;
    return `https://cdn.betterttv.net/emote/${encodeURIComponent(cleanId)}/1x.webp`;
}

/**
 * Selects the best 7TV file object from a files array, prioritizing 1x scale
 * and format order WebP > AVIF > GIF > PNG, falling back to 2x, 3x, 4x if needed.
 */
export function pick7tvFile(files) {
    if (!Array.isArray(files) || files.length === 0) return null;

    const getScaleTier = (lower) => {
        if (lower.includes('1x')) return 4;
        if (lower.includes('2x')) return 3;
        if (lower.includes('3x')) return 2;
        if (lower.includes('4x')) return 1;
        return 0;
    };

    const getFormatScore = (lower) => {
        if (lower.endsWith('.webp') || lower.includes('webp')) return 4;
        if (lower.endsWith('.avif') || lower.includes('avif')) return 3;
        if (lower.endsWith('.gif') || lower.includes('gif')) return 2;
        if (lower.endsWith('.png') || lower.includes('png')) return 1;
        return 0;
    };

    const score = (f) => {
        if (!f) return -1;
        const lower = `${f.name || ''} ${f.format || ''}`.toLowerCase();
        return getScaleTier(lower) * 10 + getFormatScore(lower);
    };

    const sorted = [...files].filter(Boolean).sort((a, b) => score(b) - score(a));
    return sorted[0] || null;
}

/**
 * Extracts a map of { [name]: { url, provider: '7tv' } } from a 7TV emote set payload.
 */
export function extract7tvMapFromEmoteSetPayload(payload) {
    const emotes = Array.isArray(payload?.emotes) ? payload.emotes
                : Array.isArray(payload?.data?.emotes) ? payload.data.emotes
                : [];

    const map = {};
    for (const e of emotes) {
        const name = e?.name ?? e?.data?.name;
        const host = e?.data?.host ?? e?.host ?? null;
        const files = host?.files ?? e?.data?.host?.files ?? null;

        if (!name || !host?.url) continue;

        const file = pick7tvFile(files);
        if (!file?.name) continue;

        const base = host.url.startsWith('http') ? host.url : `https:${host.url}`;
        const url = `${base}/${file.name}`;

        map[name] = { url, provider: '7tv' };
    }
    return map;
}

function resolveFfzUrlDict(dict) {
    if (!dict || typeof dict !== 'object') return null;
    const keys = Object.keys(dict)
        .map(k => Number(k))
        .filter(n => Number.isFinite(n))
        .sort((a, b) => a - b); // Ascending: 1 -> 2 -> 4

    for (const k of keys) {
        const u = dict[String(k)];
        if (u && typeof u === 'string' && u.trim().length > 0) {
            return ensureHttps(u.trim());
        }
    }
    return null;
}

/**
 * Evaluates FrankerFaceZ emote URLs, prioritizing animated 1x assets before static 1x URLs,
 * sorting scale keys ascending (1 -> 2 -> 4).
 */
export function pickFfzUrl(target) {
    if (!target || typeof target !== 'object') return null;

    if ('animated' in target || 'urls' in target) {
        if (target.animated && typeof target.animated === 'object') {
            const animatedUrl = resolveFfzUrlDict(target.animated);
            if (animatedUrl) return animatedUrl;
        }
        if (target.urls && typeof target.urls === 'object') {
            const staticUrl = resolveFfzUrlDict(target.urls);
            if (staticUrl) return staticUrl;
        }
        return null;
    }

    return resolveFfzUrlDict(target);
}

/**
 * Extracts a map of { [name]: { url, provider: 'ffz' } } from an FFZ global or room payload.
 */
export function extractFfzMapFromPayload(payload) {
    const map = {};
    if (!payload || typeof payload !== 'object') return map;

    const sets = payload.sets && typeof payload.sets === 'object' ? payload.sets : {};
    const defaultSets = Array.isArray(payload.default_sets) ? payload.default_sets : null;

    const setList = defaultSets
        ? defaultSets.map(id => sets[String(id)]).filter(Boolean)
        : Object.values(sets);

    for (const set of setList) {
        const emoticons = Array.isArray(set?.emoticons) ? set.emoticons : [];
        for (const e of emoticons) {
            const url = pickFfzUrl(e);
            if (e?.name && url) {
                map[e.name] = { url, provider: 'ffz' };
            }
        }
    }

    return map;
}

/**
 * Extracts a map of { [code]: { url, provider: 'bttv' } } from a BetterTTV global array or room payload.
 */
export function extractBttvMapFromPayload(payload) {
    const map = {};
    if (!payload) return map;

    if (Array.isArray(payload)) {
        for (const e of payload) {
            if (!e || !e.code || !e.id) continue;
            const url = getBttvEmoteUrlById(e.id);
            if (url) map[e.code] = { url, provider: 'bttv' };
        }
        return map;
    }

    if (typeof payload === 'object') {
        const channelEmotes = Array.isArray(payload.channelEmotes) ? payload.channelEmotes : [];
        const sharedEmotes = Array.isArray(payload.sharedEmotes) ? payload.sharedEmotes : [];
        for (const e of [...channelEmotes, ...sharedEmotes]) {
            if (!e || !e.code || !e.id) continue;
            const url = getBttvEmoteUrlById(e.id);
            if (url) map[e.code] = { url, provider: 'bttv' };
        }
    }

    return map;
}

/**
 * Strips the internal 'emote:' prefix from a token string if present.
 */
export function stripEmotePrefix(token) {
    const s = String(token ?? '');
    return s.startsWith('emote:') ? s.slice('emote:'.length) : s;
}

/**
 * Looks up an emote token against Twitch-native metadata or cached third-party channel emote maps.
 */
export function getEmoteMatch(token, channel, msgMeta, emoteMapsByChannel = {}) {
    const name = stripEmotePrefix(token);

    // 1) Twitch-native emotes (per-message; includes real IDs)
    const twitchMap = msgMeta && msgMeta.twitchEmotesByName ? msgMeta.twitchEmotesByName : null;
    if (twitchMap && twitchMap[name]) {
        const url = getTwitchEmoteUrlById(twitchMap[name]);
        if (url) return { provider: 'twitch', url, alt: name };
    }

    // 2) Third-party emotes (cached per channel)
    const map = emoteMapsByChannel && channel ? emoteMapsByChannel[channel] : null;
    if (map && map[name]) {
        return { provider: map[name].provider, url: map[name].url, alt: name };
    }

    return null;
}

/**
 * Renders a single token into safe HTML (hyperlink, optimized 1x emote img, or escaped text).
 */
export function renderTokenHtml(token, channel, msgMeta, emoteMapsByChannel = {}) {
    if (!token) return '';

    // URLs
    if (isUrlToken(token)) {
        const safeUrl = escapeHtml(token);
        return `<a href="${safeUrl}" target="_blank" rel="noreferrer noopener">${safeUrl}</a>`;
    }

    // Emotes (either flagged as emote:NAME or raw NAME)
    const match = getEmoteMatch(token, channel, msgMeta, emoteMapsByChannel);
    if (match && match.url) {
        const safeUrl = escapeHtml(match.url);
        const safeAlt = escapeHtml(match.alt || '');
        const safeTitle = escapeHtml(`${match.alt} (${match.provider})`);
        return `<img class="emote-img" loading="lazy" decoding="async" referrerpolicy="no-referrer" src="${safeUrl}" alt="${safeAlt}" title="${safeTitle}">`;
    }

    // If token was flagged but we don't have a URL, strip the prefix for readability
    const cleaned = stripEmotePrefix(token);
    return escapeHtml(cleaned);
}

/**
 * Renders full chat message text into safe HTML preserving whitespace and substituting emotes/URLs.
 */
export function renderMessageHtml(text, channel, msgMeta, emoteMapsByChannel = {}) {
    const parts = String(text || '').split(/(\s+)/);

    return parts.map(part => {
        if (/^\s+$/.test(part)) return part;
        return renderTokenHtml(part, channel, msgMeta, emoteMapsByChannel);
    }).join('');
}
