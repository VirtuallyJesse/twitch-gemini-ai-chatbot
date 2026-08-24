import { useSyncExternalStore } from 'react';

/* Tiny live settings store so the config modal and the chat feed stay
   in sync without prop drilling. */

let botHighlight = true;
const listeners = new Set<() => void>();

export function setBotHighlight(v: boolean) {
  botHighlight = v;
  listeners.forEach((l) => l());
}

export function useBotHighlight(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => botHighlight
  );
}
