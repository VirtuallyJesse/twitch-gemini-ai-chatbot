function parsePairs(value) {
    if (typeof value !== 'string') return null;
    const pairs = [];
    for (const item of value.split(',')) {
        const separator = item.indexOf('/');
        if (separator < 1) continue;
        const kind = item.slice(0, separator).trim();
        const version = item.slice(separator + 1).trim();
        if (kind && version) pairs.push([kind, version]);
    }
    return pairs;
}

function descriptor(kind, version, info, hasInfo = false) {
    const cleanKind = String(kind ?? '').trim();
    const cleanVersion = String(version ?? '').trim();
    if (!cleanKind || !cleanVersion) return null;
    return {
        kind: cleanKind,
        version: cleanVersion,
        ...(hasInfo ? { info: String(info ?? '') } : {})
    };
}

function unwrap(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { badges: value, badgeInfo: undefined };
    }
    const tags = value.tags && typeof value.tags === 'object' ? value.tags : value;
    return {
        badges: tags.badges ?? value.badges,
        badgeInfo: tags['badge-info'] ?? tags.badge_info ?? value['badge-info'] ?? value.badge_info
    };
}

function infoMap(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string') return {};
    const info = {};
    for (const item of value.split(',')) {
        const separator = item.indexOf('/');
        if (separator < 1) continue;
        const kind = item.slice(0, separator).trim();
        if (kind) info[kind] = item.slice(separator + 1).trim();
    }
    return info;
}

/** Preserves Twitch recording-time badge set/version descriptors and upstream order. */
export function normalizeBadges(value) {
    const { badges, badgeInfo } = unwrap(value);
    const info = infoMap(badgeInfo);

    if (Array.isArray(badges)) {
        const result = [];
        for (const badge of badges) {
            if (typeof badge === 'string') {
                const pair = parsePairs(badge)?.[0];
                if (!pair) continue;
                const hasInfo = Object.hasOwn(info, pair[0]);
                const normalized = descriptor(pair[0], pair[1], info[pair[0]], hasInfo);
                if (normalized) result.push(normalized);
                continue;
            }
            if (!badge || typeof badge !== 'object') continue;
            const hasOwnInfo = Object.hasOwn(badge, 'info');
            const normalized = descriptor(
                badge.kind ?? badge.set_id,
                badge.version ?? badge.id,
                badge.info,
                hasOwnInfo
            );
            if (normalized) result.push(normalized);
        }
        return result;
    }

    const pairs = parsePairs(badges);
    if (pairs) {
        return pairs.flatMap(([kind, version]) => {
            const hasInfo = Object.hasOwn(info, kind);
            const normalized = descriptor(kind, version, info[kind], hasInfo);
            return normalized ? [normalized] : [];
        });
    }

    if (badges && typeof badges === 'object') {
        const result = [];
        for (const [kind, version] of Object.entries(badges)) {
            if (version == null || version === false) continue;
            const hasInfo = Object.hasOwn(info, kind);
            const normalized = descriptor(kind, version, info[kind], hasInfo);
            if (normalized) result.push(normalized);
        }
        return result;
    }

    return [];
}
