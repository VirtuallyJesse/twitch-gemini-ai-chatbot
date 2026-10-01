/** Reads only retry/rate-limit headers shared by Helix and WebSocket upgrades. */
export function retryMetadata(headers, status, now = Date.now()) {
    const retryHeaders = {};
    for (const [header, key] of [
        ['retry-after', 'retryAfter'], ['ratelimit-reset', 'ratelimitReset'],
        ['ratelimit-limit', 'ratelimitLimit'], ['ratelimit-remaining', 'ratelimitRemaining']
    ]) {
        const value = headers?.get?.(header) ?? headers?.[header];
        if (typeof value === 'string') retryHeaders[key] = value.slice(0, 128);
    }
    const raw = retryHeaders.retryAfter?.trim();
    let retryAfterMs;
    if (raw && /^\d+$/.test(raw)) retryAfterMs = Number(raw) * 1000;
    else if (raw && /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw) && Number.isFinite(Date.parse(raw))) {
        retryAfterMs = Math.max(0, Date.parse(raw) - now);
    }
    const reset = retryHeaders.ratelimitReset?.trim();
    if (status === 429 && reset && /^\d+$/.test(reset)) {
        const resetMs = Math.max(0, Number(reset) * 1000 - now);
        retryAfterMs = Math.max(retryAfterMs ?? 0, resetMs);
    }
    if (!Number.isFinite(retryAfterMs)) retryAfterMs = undefined;
    return { retryAfterMs, retryHeaders };
}

export function retryDelay(attempt, base, ceiling, randomFn, serverDelay) {
    if (Number.isFinite(serverDelay) && serverDelay >= 0) return serverDelay;
    return Math.round(Math.min(ceiling, base * 2 ** Math.min(attempt, 16) * (0.5 + randomFn())));
}
