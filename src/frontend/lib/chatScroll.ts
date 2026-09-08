import type { LogEntry } from './types';

// The newest end is zero; scrolling toward older messages makes scrollTop negative.
export function chatIsAtLatest(viewport: { scrollTop: number }): boolean {
  return viewport.scrollTop >= 0;
}

export function chatIsNearOldest(viewport: { scrollHeight: number; clientHeight: number; scrollTop: number }): boolean {
  return viewport.scrollHeight - viewport.clientHeight + viewport.scrollTop < 80;
}

export function chatViewportNeedsFill(viewport: { scrollHeight: number; clientHeight: number }): boolean {
  return viewport.clientHeight > 0 && viewport.scrollHeight - viewport.clientHeight < 24;
}

/** Keep live arrivals in history but outside the viewport while reading older messages. */
export function selectChatViewportEntries(entries: LogEntry[], newestOrder: number | null): LogEntry[] {
  return newestOrder === null ? entries : entries.filter(entry => entry.order <= newestOrder);
}
