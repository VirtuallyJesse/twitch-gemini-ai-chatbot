// src/web/session.js
//
// Stateless HMAC-signed session tokens and cookie serialization for dashboard authentication.

import crypto from 'crypto';

export const COOKIE_NAME = 'tg_session';
export const STATE_COOKIE = 'tg_oauth_state';
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

const PLACEHOLDER_SECRETS = new Set([
    'dev-insecure',
    'change-me',
    'changeme',
    'your-client-secret',
    'your-twitch-client-secret',
    'twitch-client-secret'
]);

export function deriveSessionSecret(clientSecret) {
    const material = String(clientSecret || '').trim();
    if (!material || PLACEHOLDER_SECRETS.has(material.toLowerCase())) {
        throw new Error('TWITCH_CLIENT_SECRET must be configured with non-placeholder signing material.');
    }
    return crypto.createHmac('sha256', material)
        .update('twitch-dashboard-session-v1')
        .digest();
}

export function createSessionToken({ login, userId, displayName, profileImageUrl }, secret, { now = Date.now, ttlMs = SESSION_TTL_MS } = {}) {
    const payload = {
        login: String(login || '').toLowerCase(),
        userId: String(userId || ''),
        displayName: String(displayName || login || ''),
        profileImageUrl: String(profileImageUrl || ''),
        iat: now(),
        exp: now() + ttlMs
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${sig}`;
}

export function verifySessionToken(token, secret, { now = Date.now } = {}) {
    if (!token || !secret) return null;
    const dot = String(token).lastIndexOf('.');
    if (dot < 1) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (!payload?.login || typeof payload.exp !== 'number' || payload.exp <= now()) return null;
        return payload;
    } catch {
        return null;
    }
}

export function parseCookies(header) {
    const out = {};
    if (!header || typeof header !== 'string') return out;
    const pairs = header.split(';');
    for (const pair of pairs) {
        const eq = pair.indexOf('=');
        if (eq === -1) continue;
        const key = pair.slice(0, eq).trim();
        const val = pair.slice(eq + 1).trim();
        if (key) {
            try {
                out[key] = decodeURIComponent(val);
            } catch {
                out[key] = val;
            }
        }
    }
    return out;
}

export function serializeCookie(name, value, { maxAge, httpOnly = true, sameSite = 'Lax', path = '/', secure = false } = {}) {
    let cookie = `${name}=${encodeURIComponent(String(value ?? ''))}`;
    if (path) cookie += `; Path=${path}`;
    if (typeof maxAge === 'number') cookie += `; Max-Age=${Math.floor(maxAge)}`;
    if (httpOnly) cookie += '; HttpOnly';
    if (sameSite) cookie += `; SameSite=${sameSite}`;
    if (secure) cookie += '; Secure';
    return cookie;
}

export function clearCookieHeader(name, { secure = false, path = '/' } = {}) {
    return serializeCookie(name, '', { maxAge: 0, path, secure, httpOnly: true });
}
