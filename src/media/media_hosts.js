const REQUIRED_DESTINATIONS = ['primary', 'fallback'];

export function isHttpUrl(value) {
    if (typeof value !== 'string' || value.trim() !== value || !value || value.includes('*')) return false;

    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

function isExactHttpOrigin(value) {
    if (!isHttpUrl(value)) return false;

    const url = new URL(value);
    return url.origin === value;
}

function freezeHost({ uploadUrl, publicOrigins }) {
    return Object.freeze({
        uploadUrl,
        publicOrigins: Object.freeze([...publicOrigins])
    });
}

export const MEDIA_HOSTS = Object.freeze({
    primary: freezeHost({
        uploadUrl: 'https://i.nuuls.com/upload',
        publicOrigins: ['https://i.nuuls.com']
    }),
    fallback: freezeHost({
        uploadUrl: 'https://kappa.lol/api/upload',
        publicOrigins: ['https://kappa.lol']
    })
});

export function configureMediaHosts(hosts = MEDIA_HOSTS) {
    if (!hosts || typeof hosts !== 'object' || Array.isArray(hosts)) {
        throw new Error('Media hosts must be an object');
    }

    const names = Object.keys(hosts);
    const unexpected = names.filter((name) => !REQUIRED_DESTINATIONS.includes(name));
    if (unexpected.length > 0) {
        throw new Error(`Unsupported media host destination: ${unexpected.join(', ')}`);
    }

    const publicOrigins = [];
    for (const name of REQUIRED_DESTINATIONS) {
        const host = hosts[name];
        if (!host || typeof host !== 'object' || Array.isArray(host)) {
            throw new Error(`Media host ${name} must be an object`);
        }
        if (!isHttpUrl(host.uploadUrl)) {
            throw new Error(`Media host ${name} requires a valid upload URL`);
        }
        if (!Array.isArray(host.publicOrigins) || host.publicOrigins.length === 0) {
            throw new Error(`Media host ${name} requires at least one public media origin`);
        }

        for (const origin of host.publicOrigins) {
            if (!isExactHttpOrigin(origin)) {
                throw new Error(`Media host ${name} has invalid public media origin: ${String(origin)}`);
            }
            publicOrigins.push(origin);
        }
    }

    return Object.freeze({
        uploadUrls: Object.freeze({
            primary: hosts.primary.uploadUrl,
            fallback: hosts.fallback.uploadUrl
        }),
        publicOrigins: Object.freeze([...new Set(publicOrigins)])
    });
}
