// public/js/utils/web_emotes.js
// Client-side helpers for HTML rendering of Twitch chat messages, links, and cached emote assets.

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
    if (!id || (typeof id !== 'string' && typeof id !== 'number')) return null;
    const cleanId = String(id).trim();
    if (!cleanId) return null;
    return `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(cleanId)}/default/dark/1.0`;
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
 * Handles error events on emote <img> elements by non-destructively scheduling a retry with backoff.
 * Leaves the <img> in the DOM intact without degrading to text so subsequent renders or retries can succeed.
 */
export function handleEmoteError(img, options = {}) {
    if (!img || typeof img !== 'object') return false;

    if (!img.dataset) img.dataset = {};
    const dataset = img.dataset;
    const originalSrc = dataset.srcOriginal || dataset.src || img.src || '';
    if (!dataset.srcOriginal && originalSrc) {
        dataset.srcOriginal = originalSrc;
    }

    const maxRetries = options.maxRetries ?? 2;
    const currentRetry = parseInt(dataset.retryCount || '0', 10);
    if (currentRetry < maxRetries && dataset.srcOriginal) {
        dataset.retryCount = String(currentRetry + 1);
        const scheduleTimer = options.scheduleTimer || ((fn, ms) => setTimeout(fn, ms));
        const delayMs = options.delayMs ?? (currentRetry === 0 ? 1500 : 3500);

        scheduleTimer(() => {
            const sep = dataset.srcOriginal.includes('?') ? '&' : '?';
            img.src = `${dataset.srcOriginal}${sep}retry=${currentRetry + 1}`;
        }, delayMs);
        return true;
    }

    return false;
}

/**
 * Renders a single token into safe HTML (hyperlink, lazy-loaded emote img, or escaped text).
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
        return `<img class="emote-img" loading="lazy" decoding="async" referrerpolicy="no-referrer" src="${safeUrl}" data-src-original="${safeUrl}" alt="${safeAlt}" title="${safeTitle}">`;
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
