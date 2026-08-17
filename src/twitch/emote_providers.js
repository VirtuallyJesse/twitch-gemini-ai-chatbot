// emote_providers.js
export const DEFAULT_TIMEOUT_MS = 10_000;

export function normalizeEmoteToken(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  // Emotes must be a single token in Twitch chat (no spaces).
  if (/\s/.test(s)) return null;
  return s;
}

export async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }

    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function mapLimit(items, limit, fn) {
  const results = [];
  let i = 0;

  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/* ────────────────────────────────────────────────────────────────
 * Asset & URL Normalization Helpers
 * ──────────────────────────────────────────────────────────────── */

export function ensureHttps(u) {
  if (!u || typeof u !== 'string') return '';
  const trimmed = u.trim();
  return trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
}


export function pick7tvFile(files) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const scale = (l) => l.includes('1x') ? 4 : l.includes('2x') ? 3 : l.includes('3x') ? 2 : l.includes('4x') ? 1 : 0;
  const fmt = (l) => (
    l.includes('webp') ? 4 : l.includes('avif') ? 3 : l.includes('gif') ? 2 : l.includes('png') ? 1 : 0
  );
  const score = (f) => {
    const l = `${f?.name || ''} ${f?.format || ''}`.toLowerCase();
    return scale(l) * 10 + fmt(l);
  };
  return [...files].filter(Boolean).sort((a, b) => score(b) - score(a))[0] || null;
}

export function assetFrom7tvEmote(emote) {
  const name = normalizeEmoteToken(emote?.name ?? emote?.data?.name);
  if (!name) return null;
  const id = emote?.id ?? emote?.data?.id ?? null;
  const host = emote?.data?.host ?? emote?.host ?? null;
  const file = pick7tvFile(host?.files);
  let url = '';
  if (host?.url && file?.name) {
    const base = host.url.startsWith('http') ? host.url : `https:${host.url}`;
    url = `${base}/${file.name}`;
  }
  return { name, id: id ? String(id) : null, url, provider: '7tv' };
}

export function assetFromBttvEmote(emote) {
  const name = normalizeEmoteToken(emote?.code ?? emote?.name);
  const id = emote?.id;
  if (!name || !id) return null;
  return {
    name,
    id: String(id),
    url: `https://cdn.betterttv.net/emote/${encodeURIComponent(id)}/1x.webp`,
    provider: 'bttv'
  };
}

function resolveFfzUrlDict(dict) {
  if (!dict || typeof dict !== 'object') return null;
  const keys = Object.keys(dict).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  for (const k of keys) {
    const u = dict[String(k)];
    if (typeof u === 'string' && u.trim()) return ensureHttps(u.trim());
  }
  return null;
}

export function pickFfzUrl(target) {
  if (!target || typeof target !== 'object') return null;
  if (target.animated && typeof target.animated === 'object') {
    const u = resolveFfzUrlDict(target.animated);
    if (u) return u;
  }
  if (target.urls && typeof target.urls === 'object') {
    const u = resolveFfzUrlDict(target.urls);
    if (u) return u;
  }
  return resolveFfzUrlDict(target);
}

export function assetFromFfzEmote(emote) {
  const name = normalizeEmoteToken(emote?.name);
  if (!name) return null;
  return { name, id: emote?.id != null ? String(emote.id) : null, url: pickFfzUrl(emote) || '', provider: 'ffz' };
}

export function resolve7TvEmoteSetId(userData) {
  return userData?.emote_set?.id
    ?? userData?.connections?.find(c => c?.platform === 'TWITCH')?.emote_set?.id
    ?? userData?.emote_set_id
    ?? null;
}

/* ────────────────────────────────────────────────────────────────
 * 7TV
 * ──────────────────────────────────────────────────────────────── */

export async function fetchSevenTvGlobalEmotes({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch
} = {}) {
  const payload = await fetchJson('https://7tv.io/v3/emote-sets/global', { timeoutMs, fetchImpl });
  const emotes = Array.isArray(payload?.emotes) ? payload.emotes
    : Array.isArray(payload?.data?.emotes) ? payload.data.emotes
    : [];
  return emotes.map(assetFrom7tvEmote).filter(Boolean);
}

export async function fetchSevenTvChannelEmotesForTwitchIds(
  twitchIds,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    concurrency = 4,
    fetchImpl = globalThis.fetch
  } = {}
) {
  const results = new Map();
  const ids = [...new Set((twitchIds || []).map(String).filter(Boolean))];

  await mapLimit(ids, concurrency, async (id) => {
    try {
      const userData = await fetchJson(
        `https://7tv.io/v3/users/twitch/${encodeURIComponent(id)}`,
        { timeoutMs, fetchImpl }
      );
      const emoteSetId = resolve7TvEmoteSetId(userData);
      let payload = userData?.emote_set
        ?? userData?.connections?.find(c => c?.platform === 'TWITCH')?.emote_set
        ?? null;
      if (!Array.isArray(payload?.emotes) && emoteSetId) {
        payload = await fetchJson(
          `https://7tv.io/v3/emote-sets/${encodeURIComponent(emoteSetId)}`,
          { timeoutMs, fetchImpl }
        );
      }
      const emotes = (Array.isArray(payload?.emotes) ? payload.emotes : [])
        .map(assetFrom7tvEmote)
        .filter(Boolean);
      results.set(id, { emoteSetId: emoteSetId ? String(emoteSetId) : null, emotes });
    } catch (e) {
      console.error(`[7TV] Failed to fetch channel emotes for Twitch ID ${id}:`, e.message);
      results.set(id, { emoteSetId: null, emotes: [] });
    }
  });

  return results;
}

/* ────────────────────────────────────────────────────────────────
 * BTTV
 * ──────────────────────────────────────────────────────────────── */

export async function fetchBttvGlobalEmotes({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch
} = {}) {
  const data = await fetchJson('https://api.betterttv.net/3/cached/emotes/global', { timeoutMs, fetchImpl });
  const emotes = [];
  const seen = new Set();
  for (const emote of Array.isArray(data) ? data : []) {
    const asset = assetFromBttvEmote(emote);
    if (asset && !seen.has(asset.name)) {
      seen.add(asset.name);
      emotes.push(asset);
    }
  }
  return emotes.sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchBttvChannelEmotesForTwitchIds(
  twitchIds,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    concurrency = 4,
    fetchImpl = globalThis.fetch
  } = {}
) {
  const results = new Map();
  const ids = [...new Set((twitchIds || []).map(String).filter(Boolean))];

  await mapLimit(ids, concurrency, async (id) => {
    const emotes = [];
    try {
      const data = await fetchJson(
        `https://api.betterttv.net/3/cached/users/twitch/${encodeURIComponent(id)}`,
        { timeoutMs, fetchImpl }
      );

      const channel = Array.isArray(data?.channelEmotes) ? data.channelEmotes : [];
      const shared = Array.isArray(data?.sharedEmotes) ? data.sharedEmotes : [];

      for (const emote of channel) {
        const asset = assetFromBttvEmote(emote);
        if (asset) emotes.push(asset);
      }

      for (const emote of shared) {
        const asset = assetFromBttvEmote(emote);
        if (asset) emotes.push(asset);
      }
    } catch (e) {
      console.error(`[BTTV] Failed to fetch channel emotes for Twitch ID ${id}:`, e.message);
    }
    results.set(id, emotes);
  });

  return results;
}

/* ────────────────────────────────────────────────────────────────
 * FFZ
 * ──────────────────────────────────────────────────────────────── */

export async function fetchFfzGlobalEmotes({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch
} = {}) {
  const global = await fetchJson('https://api.frankerfacez.com/v1/set/global', { timeoutMs, fetchImpl });

  const defaultSets = Array.isArray(global?.default_sets) ? global.default_sets : [];
  const sets = global?.sets && typeof global.sets === 'object' ? global.sets : {};
  const emotes = [];
  const seen = new Set();

  for (const setId of defaultSets) {
    const set = sets[String(setId)];
    const emoticons = Array.isArray(set?.emoticons) ? set.emoticons : [];
    for (const emote of emoticons) {
      const asset = assetFromFfzEmote(emote);
      if (asset && !seen.has(asset.name)) {
        seen.add(asset.name);
        emotes.push(asset);
      }
    }
  }

  return emotes.sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchFfzRoomConditional(
  twitchId,
  {
    etag = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch
  } = {}
) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Accept: 'application/json' };
    if (etag) headers['If-None-Match'] = etag;
    const res = await fetchImpl(
      `https://api.frankerfacez.com/v1/room/id/${encodeURIComponent(twitchId)}`,
      { signal: controller.signal, headers }
    );
    if (res.status === 304) return { status: 304, etag, emotes: null };
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    const sets = data?.sets && typeof data.sets === 'object' ? data.sets : {};
    const emotes = [];
    for (const set of Object.values(sets)) {
      for (const emote of set?.emoticons || []) {
        const asset = assetFromFfzEmote(emote);
        if (asset) emotes.push(asset);
      }
    }
    return { status: 200, etag: res.headers.get('etag'), emotes };
  } finally {
    clearTimeout(t);
  }
}

export async function fetchFfzChannelEmotesForTwitchIds(
  twitchIds,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    concurrency = 4,
    fetchImpl = globalThis.fetch
  } = {}
) {
  const results = new Map();
  const ids = [...new Set((twitchIds || []).map(String).filter(Boolean))];

  await mapLimit(ids, concurrency, async (id) => {
    try {
      const res = await fetchFfzRoomConditional(id, { timeoutMs, fetchImpl });
      results.set(id, { etag: res.etag || null, emotes: res.emotes || [] });
    } catch (e) {
      console.error(`[FFZ] Failed to fetch channel emotes for Twitch ID ${id}:`, e.message);
      results.set(id, { etag: null, emotes: [] });
    }
  });

  return results;
}
