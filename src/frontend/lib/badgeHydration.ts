import type { ChannelBadgeCatalog } from './types.ts';
import { registerChannelBadges } from './badges.ts';

type BadgeCatalogLoader = (channel: string) => Promise<ChannelBadgeCatalog>;
const GLOBAL_CATALOG_KEY = '__global__';

export async function hydrateBadgeCatalogs(
  channels: readonly string[],
  loadCatalog: BadgeCatalogLoader,
): Promise<void> {
  const targets = channels.length > 0 ? channels : [GLOBAL_CATALOG_KEY];
  await Promise.allSettled(targets.map(async (channel) => {
    const catalog = await loadCatalog(channel);
    registerChannelBadges(catalog.channel || channel, catalog.badges);
  }));
}
