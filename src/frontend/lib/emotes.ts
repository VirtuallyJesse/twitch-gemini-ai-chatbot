/* Multi-provider dynamic emote registry. 1x/low-res CDN assets only; every
   render path has a text fallback if the CDN load fails.
   Emote dictionaries are hydrated dynamically via backend REST (/api/emotes/:channel)
   and updated in real time via WebSockets (emotes:update). */

import { normChannel } from './channel';

export type EmoteProvider = 'twitch' | 'bttv' | '7tv' | 'ffz';

export interface EmoteDef {
  name: string;
  provider: EmoteProvider;
  url: string;
}

/**
 * Constructs a Twitch native emote URL targeting dark theme and 1.0 scale (~28x28px).
 */
export function getTwitchEmoteUrlById(id: string | number): string | null {
  if (!id && id !== 0) return null;
  const cleanId = String(id).trim();
  if (!cleanId) return null;
  return `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(cleanId)}/default/dark/1.0`;
}

// Dynamic per-channel registry
const channelEmoteStore: Record<string, Record<string, EmoteDef>> = {};

export function registerChannelEmotes(
  channel: string,
  emotes: Record<string, string | { url?: string; provider?: EmoteProvider }>
) {
  const normChan = normChannel(channel);
  const map: Record<string, EmoteDef> = {};
  for (const [code, item] of Object.entries(emotes)) {
    if (!item) continue;
    if (typeof item === 'string') {
      map[code] = { name: code, provider: 'twitch', url: item };
    } else if (item.url) {
      map[code] = {
        name: code,
        provider: item.provider || 'twitch',
        url: item.url,
      };
    }
  }
  channelEmoteStore[normChan] = map;
}

export function getEmote(
  name: string,
  channel?: string,
  meta?: { twitchEmotesByName?: Record<string, string> } | null
): EmoteDef | null {
  const clean = name.replace(/^emote:/, '');

  // 1) Per-message Twitch native emotes (exact IDs from IRC message tags)
  const twitchMap = meta?.twitchEmotesByName;
  if (twitchMap) {
    const id = twitchMap[clean] ?? twitchMap[name];
    if (id) {
      const url = getTwitchEmoteUrlById(id);
      if (url) return { name: clean, provider: 'twitch', url };
    }
  }

  // 2) Channel-specific third-party / registered emotes
  if (channel) {
    const chanMap = channelEmoteStore[normChannel(channel)];
    if (chanMap) {
      if (chanMap[clean]) return chanMap[clean];
      if (chanMap[name]) return chanMap[name];
    }
  }

  // 3) Any channel third-party / registered emotes
  for (const store of Object.values(channelEmoteStore)) {
    if (store[clean]) return store[clean];
    if (store[name]) return store[name];
  }

  return null;
}
