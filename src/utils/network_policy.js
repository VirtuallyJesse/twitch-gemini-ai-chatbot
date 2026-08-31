import dns from 'dns';
import net from 'net';

function parseIpv4(address) {
    const parts = String(address).split('.');
    if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
    const bytes = parts.map(Number);
    return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : null;
}

function mappedIpv4(address) {
    const lower = String(address).toLowerCase();
    const dotted = lower.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (dotted) return dotted;
    const hex = lower.match(/(?:^|:)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (!hex) return null;
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function isPublicIp(address) {
    const value = String(address || '').replace(/^\[|\]$/g, '').toLowerCase();
    const family = net.isIP(value);
    if (family === 4) {
        const bytes = parseIpv4(value);
        if (!bytes) return false;
        const [a, b, c] = bytes;
        if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
        if (a === 100 && b >= 64 && b <= 127) return false;
        if (a === 169 && b === 254) return false;
        if (a === 172 && b >= 16 && b <= 31) return false;
        if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false;
        if (a === 192 && b === 88 && c === 99) return false;
        if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
        if (a === 203 && b === 0 && c === 113) return false;
        return true;
    }
    if (family === 6) {
        const mapped = mappedIpv4(value);
        if (mapped) return isPublicIp(mapped);
        if (value === '::' || value === '::1') return false;
        const first = Number.parseInt(value.split(':')[0] || '0', 16);
        if ((first & 0xe000) !== 0x2000) return false; // only global-unicast 2000::/3
        if ((first & 0xfe00) === 0xfc00) return false;
        if ((first & 0xffc0) === 0xfe80) return false;
        if ((first & 0xff00) === 0xff00) return false;
        if (value.startsWith('2001:db8:') || value === '2001:db8::') return false;
        if (value.startsWith('2001:2:') || value === '2001:2::') return false;
        if (value.startsWith('2001:0:') || value.startsWith('2001:10:') || value.startsWith('2001:20:')) return false;
        if (value.startsWith('2002:') || value.startsWith('3fff:')) return false;
        return true;
    }
    return false;
}

export function isKnownHost(hostname, knownHosts) {
    const candidate = String(hostname || '').replace(/\.$/, '').toLowerCase();
    return (knownHosts || []).some((rawHost) => {
        const host = String(rawHost || '').replace(/\.$/, '').toLowerCase();
        return candidate === host || candidate.endsWith(`.${host}`);
    });
}

export async function resolvePublicDestination(rawUrl, { lookup = dns.promises.lookup } = {}) {
    let url;
    try {
        url = rawUrl instanceof URL ? new URL(rawUrl.href) : new URL(String(rawUrl));
    } catch {
        throw new Error('Remote image URL is invalid');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Remote image URL uses an unsupported protocol');
    }
    if (url.username || url.password) throw new Error('Remote image URL credentials are not allowed');
    const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
        throw new Error('Remote image destination is not public');
    }

    let addresses;
    const literalFamily = net.isIP(hostname);
    if (literalFamily) addresses = [{ address: hostname, family: literalFamily }];
    else addresses = await lookup(hostname, { all: true, verbatim: true });
    if (!Array.isArray(addresses) || addresses.length === 0) {
        throw new Error('Remote image destination could not be resolved');
    }
    const normalized = addresses.map((entry) => ({
        address: String(entry.address || ''),
        family: Number(entry.family) || net.isIP(entry.address)
    }));
    if (normalized.some((entry) => !isPublicIp(entry.address))) {
        throw new Error('Remote image destination is not public');
    }
    return { url, address: normalized[0], addresses: normalized };
}
