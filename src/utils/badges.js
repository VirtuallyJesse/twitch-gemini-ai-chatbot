export const BADGE_KINDS = Object.freeze(['broadcaster', 'mod', 'vip', 'sub', 'bits', 'bot']);

const BADGE_ALIASES = Object.freeze({
    broadcaster: 'broadcaster',
    moderator: 'mod',
    mod: 'mod',
    vip: 'vip',
    subscriber: 'sub',
    sub: 'sub',
    bits: 'bits',
    bot: 'bot',
    verified_bot: 'bot'
});

function badgeSource(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return value.tags?.badges ?? value.badges ?? value;
}

/** Normalizes Twitch badge tags and stored badge arrays into display order. */
export function normalizeBadgeKinds(value) {
    const source = badgeSource(value);
    const found = new Set();

    if (Array.isArray(source)) {
        for (const badge of source) {
            const canonical = BADGE_ALIASES[String(badge || '').toLowerCase()];
            if (canonical) found.add(canonical);
        }
    } else if (source && typeof source === 'object') {
        for (const [rawKind, rawValue] of Object.entries(source)) {
            if (rawValue == null || rawValue === false) continue;
            const canonical = BADGE_ALIASES[rawKind.toLowerCase()];
            if (canonical) found.add(canonical);
        }
    }

    return BADGE_KINDS.filter((kind) => found.has(kind));
}
