import type { MediaItem } from './types';

export type AvatarIdentity =
  | { key: `id:${string}`; userId: string }
  | { key: `login:${string}`; login: string };

export type AvatarLookupResult =
  | { key: string; status: 'resolved'; avatarUrl: string; userId?: string; login?: string }
  | { key: string; status: 'unavailable' | 'invalid' };

export type AvatarLookup = (
  identities: readonly AvatarIdentity[],
  signal: AbortSignal
) => Promise<{ results: AvatarLookupResult[] }>;

type GalleryCommit = (update: (current: MediaItem[]) => MediaItem[]) => void;

const USER_ID = /^\d+$/;
const LOGIN = /^[a-z0-9_]{1,25}$/;

function identityFor(item: MediaItem): AvatarIdentity | null {
  const userId = String(item.userId || '').trim();
  if (USER_ID.test(userId)) return { key: `id:${userId}`, userId };

  const login = item.author.trim().toLowerCase();
  return LOGIN.test(login) ? { key: `login:${login}`, login } : null;
}

function mergeResolved(items: MediaItem[], resolved: Map<string, string>): MediaItem[] {
  let changed = false;
  const merged = items.map((item) => {
    if (item.avatarUrl) return item;
    const identity = identityFor(item);
    const avatarUrl = identity ? resolved.get(identity.key) : undefined;
    if (!avatarUrl) return item;
    changed = true;
    return { ...item, avatarUrl };
  });
  return changed ? merged : items;
}

function isCompleteOutcome(
  outcome: { results: AvatarLookupResult[] } | null | undefined,
  batchKeys: Set<string>
): outcome is { results: AvatarLookupResult[] } {
  if (!Array.isArray(outcome?.results) || outcome.results.length !== batchKeys.size) return false;
  const seen = new Set<string>();
  for (const result of outcome.results) {
    if (!batchKeys.has(result?.key) || seen.has(result.key)) return false;
    if (result.status === 'resolved') {
      if (typeof result.avatarUrl !== 'string' || !result.avatarUrl) return false;
    } else if (result.status !== 'unavailable' && result.status !== 'invalid') {
      return false;
    }
    seen.add(result.key);
  }
  return seen.size === batchKeys.size;
}

export function createGalleryAvatarHydrator({
  lookup,
  commit,
  retryDelayMs = 2_000,
}: {
  lookup: AvatarLookup;
  commit: GalleryCommit;
  retryDelayMs?: number;
}) {
  const resolved = new Map<string, string>();
  const settled = new Set<string>();
  const exhausted = new Set<string>();
  const observedItemIds = new Set<string>();
  const retryWaiters = new Set<{ timer: ReturnType<typeof setTimeout>; resume: () => void }>();
  const activeControllers = new Set<AbortController>();
  let hydrationTail = Promise.resolve();
  let disposed = false;

  const waitForRetry = () => new Promise<void>((resolve) => {
    if (disposed || retryDelayMs <= 0) {
      resolve();
      return;
    }
    const waiter = {
      timer: setTimeout(() => {
        retryWaiters.delete(waiter);
        resolve();
      }, retryDelayMs),
      resume: resolve,
    };
    retryWaiters.add(waiter);
  });

  const runHydration = async (items: readonly MediaItem[]): Promise<void> => {
    if (disposed) return;

    let hasNewItem = false;
    for (const item of items) {
      if (!observedItemIds.has(item.id)) hasNewItem = true;
      observedItemIds.add(item.id);
    }
    commit((current) => mergeResolved(current, resolved));

    const pending = new Map<string, AvatarIdentity>();
    for (const item of items) {
      if (item.avatarUrl) continue;
      const identity = identityFor(item);
      if (!identity) continue;
      if (exhausted.has(identity.key) && !hasNewItem) continue;
      if (!resolved.has(identity.key) && !settled.has(identity.key)) {
        pending.set(identity.key, identity);
      }
    }
    if (pending.size === 0) return;

    const identities = [...pending.values()];
    for (let offset = 0; offset < identities.length; offset += 100) {
      const batch = identities.slice(offset, offset + 100);
      const batchKeys = new Set<string>(batch.map(({ key }) => key));
      let outcome: { results: AvatarLookupResult[] } | null = null;
      for (let attempt = 0; attempt < 2 && !disposed; attempt++) {
        const controller = new AbortController();
        activeControllers.add(controller);
        try {
          outcome = await lookup(batch, controller.signal);
          if (!isCompleteOutcome(outcome, batchKeys)) throw new Error('Malformed avatar lookup response');
          break;
        } catch {
          outcome = null;
          if (attempt === 0) await waitForRetry();
        } finally {
          activeControllers.delete(controller);
        }
      }
      if (disposed) continue;
      if (!outcome) {
        for (const key of batchKeys) exhausted.add(key);
        continue;
      }
      for (const key of batchKeys) exhausted.delete(key);
      for (const result of outcome.results) {
        if (!batchKeys.has(result.key)) continue;
        if (result.status === 'resolved' && result.avatarUrl) {
          const aliases = [result.key];
          if (result.userId && USER_ID.test(result.userId)) aliases.push(`id:${result.userId}`);
          const login = String(result.login || '').toLowerCase();
          if (LOGIN.test(login)) aliases.push(`login:${login}`);
          for (const key of aliases) {
            resolved.set(key, result.avatarUrl);
            settled.add(key);
          }
        } else if (result.status === 'unavailable' || result.status === 'invalid') {
          settled.add(result.key);
        }
      }
      commit((current) => mergeResolved(current, resolved));
    }
  };

  return {
    hydrate(items: readonly MediaItem[]): Promise<void> {
      const snapshot = [...items];
      const run = hydrationTail.then(() => runHydration(snapshot));
      hydrationTail = run.catch(() => {});
      return run;
    },

    dispose() {
      disposed = true;
      for (const controller of activeControllers) controller.abort();
      activeControllers.clear();
      for (const waiter of retryWaiters) {
        clearTimeout(waiter.timer);
        waiter.resume();
      }
      retryWaiters.clear();
    },
  };
}
