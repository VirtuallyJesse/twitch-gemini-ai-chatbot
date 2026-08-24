import type { LogEntry, RawChatEntry } from './types';
import { clockHM } from './time.ts';

export function formatRawChatEntry(e: RawChatEntry, fallbackIdx: number | string): LogEntry {
  if (e.event || e.kind === 'event') {
    return {
      kind: 'event',
      id: e.id || `e-${fallbackIdx}`,
      time: e.time || clockHM(new Date(e.timestamp || Date.now())),
      event: e.event || 'system',
      text: e.text || e.message || '',
    };
  }

  const color = typeof e.color === 'string' && e.color.trim() ? e.color.trim() : undefined;
  return {
    kind: 'msg',
    id: e.id || `m-${fallbackIdx}`,
    time: e.time || clockHM(new Date(e.timestamp || Date.now())),
    user: e.username || e.user || 'chatter',
    text: e.message || e.text || '',
    color,
    badges: Array.isArray(e.badges) ? e.badges : [],
    meta: e.meta || null,
  };
}
