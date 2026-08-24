import type { LogEntry, RawChatEntry } from './types';
import { clockHM } from './time.ts';

export function formatRawChatEntry(
  e: RawChatEntry,
  fallbackIdx?: number | string
): LogEntry | null {
  const fallbackOrder = typeof fallbackIdx === 'number' ? fallbackIdx + 1 : Number(fallbackIdx);
  const id = e.id || (fallbackIdx === undefined ? '' : `chat-${fallbackIdx}`);
  const order = Number.isSafeInteger(e.order) && Number(e.order) > 0
    ? Number(e.order)
    : (Number.isSafeInteger(fallbackOrder) && fallbackOrder > 0 ? fallbackOrder : 0);
  if (!id || !order) return null;
  if (e.event || e.kind === 'event') {
    return {
      kind: 'event',
      id,
      order,
      time: e.time || clockHM(new Date(e.timestamp || Date.now())),
      event: e.event || 'system',
      text: e.text || e.message || '',
    };
  }

  const color = typeof e.color === 'string' && e.color.trim() ? e.color.trim() : undefined;
  return {
    kind: 'msg',
    id,
    order,
    time: e.time || clockHM(new Date(e.timestamp || Date.now())),
    user: e.username || e.user || 'chatter',
    text: e.message || e.text || '',
    color,
    badges: Array.isArray(e.badges) ? e.badges : [],
    meta: e.meta || null,
  };
}
