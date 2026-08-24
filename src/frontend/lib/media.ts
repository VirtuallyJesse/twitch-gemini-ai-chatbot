import { channelLabel } from './channel.ts';
import type { MediaItem, RawMediaEntry } from './types.ts';

export function normalizeMediaEntry(raw: RawMediaEntry): MediaItem {
  const isAudio = raw.mediaType === 'tts' || raw.mediaType === 'music' || raw.mediaType === 'audio';
  const type = isAudio ? 'audio' : raw.mediaType === 'video' ? 'video' : 'image';
  const audioKind = raw.mediaType === 'tts' ? 'Voice' : raw.mediaType === 'music' ? 'Music' : undefined;

  const ts = typeof raw.timestamp === 'number' ? raw.timestamp : Date.parse(String(raw.timestamp)) || Date.now();
  const minAgo = Math.max(0, Math.floor((Date.now() - ts) / 60000));

  return {
    id: raw.id || `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    src: raw.mediaUrl,
    prompt: raw.prompt || '',
    author: raw.username || 'someone',
    userId: raw.userId,
    channel: channelLabel(raw.channel || 'channel'),
    timestamp: ts,
    minutesAgo: minAgo,
    audioKind,
    avatarUrl: raw.avatarUrl,
    badges: Array.isArray(raw.badges) ? raw.badges : [],
  };
}
