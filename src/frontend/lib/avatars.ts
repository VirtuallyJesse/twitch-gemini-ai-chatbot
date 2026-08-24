import type { MediaItem } from './types';

export function missingAvatarLogins(
  items: Array<{ author: string; avatarUrl?: string | null }>,
  known: Record<string, string>
): string[] {
  const missing = new Set<string>();
  for (const item of items) {
    if (item.avatarUrl) continue;
    const login = item.author.trim().toLowerCase();
    if (!login || known[login]) continue;
    missing.add(login);
  }
  return [...missing];
}

export function mergeAvatars(items: MediaItem[], known: Record<string, string>): MediaItem[] {
  return items.map((item) => {
    if (item.avatarUrl) return item;
    const url = known[item.author.trim().toLowerCase()];
    return url ? { ...item, avatarUrl: url } : item;
  });
}
