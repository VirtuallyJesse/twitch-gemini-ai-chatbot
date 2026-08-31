import type { MediaItem } from './types';

export type MediaMutation =
  | { type: 'added'; item: MediaItem }
  | { type: 'deleted'; id: string };

export function applyMediaMutation(items: readonly MediaItem[], mutation: MediaMutation): MediaItem[] {
  if (mutation.type === 'deleted') {
    return items.filter((item) => item.persistedId !== mutation.id);
  }

  const identity = mutation.item.persistedId || mutation.item.id;
  return [
    mutation.item,
    ...items.filter((item) => (item.persistedId || item.id) !== identity),
  ];
}

export function replayMediaMutations(
  snapshot: readonly MediaItem[],
  mutations: readonly MediaMutation[]
): MediaItem[] {
  return mutations.reduce(applyMediaMutation, [...snapshot]);
}
