import type {
  BadgeDescriptor,
  BadgeDictionaries,
  BadgeVersion,
} from './types.ts';

const registries = new Map<string, BadgeDictionaries>();
const listeners = new Set<() => void>();
let globalBadges: BadgeDictionaries['global'] = {};
let revision = 0;

const normChannel = (value: string): string => String(value || '').replace(/^#/, '').trim().toLowerCase();

export function registerChannelBadges(channel: string, badges: BadgeDictionaries): void {
  const name = normChannel(channel);
  const nextGlobal = badges?.global || {};
  if (Object.keys(nextGlobal).length > 0 || Object.keys(globalBadges).length === 0) {
    globalBadges = nextGlobal;
  }
  if (name) {
    registries.set(name, {
      channel: badges?.channel || {},
      global: {},
    });
  }
  revision++;
  for (const listener of listeners) listener();
}

export function subscribeBadgeRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getBadgeRegistryRevision(): number {
  return revision;
}

export interface ResolvedBadge {
  descriptor: BadgeDescriptor;
  scope: 'channel' | 'global' | null;
  version: BadgeVersion | null;
  imageUrl: string | null;
  title: string;
}

export function resolveBadge(channel: string, descriptor: BadgeDescriptor): ResolvedBadge {
  const registry = registries.get(normChannel(channel));
  const channelVersion = registry?.channel?.[descriptor.kind]?.versions?.[descriptor.version];
  const globalVersion = globalBadges[descriptor.kind]?.versions?.[descriptor.version];
  const version = channelVersion || globalVersion || null;
  const scope = channelVersion ? 'channel' : globalVersion ? 'global' : null;
  return {
    descriptor,
    scope,
    version,
    imageUrl: typeof version?.image_url_1x === 'string' && version.image_url_1x ? version.image_url_1x : null,
    title: typeof version?.title === 'string' && version.title ? version.title : `${descriptor.kind}/${descriptor.version}`,
  };
}

const EVENT_KIND = /(?:prediction|event|hype.?train|moment|clip.?champ)/i;
const GLOBAL_AUTHORITY_KIND = /^(?:staff|admin|global[-_]?mod|partner|verified)(?:[-_].*)?$/i;
const CHANNEL_AUTHORITY_KIND = /^(?:broadcaster|moderator|vip|artist(?:-badge)?)(?:[-_].*)?$/i;
const CHANNEL_SUPPORT_KIND = /^(?:subscriber|founder|bits|cheer|sub[-_]?gift(?:er|[-_]?leader)?|bits[-_]?leader)(?:[-_].*)?$/i;
const GLOBAL_VANITY_KIND = /^(?:bot[-_]?badge|prime|premium|turbo|ambassador|dj|listening|watching)(?:[-_].*)?$/i;

function displayPriority(channel: string, descriptor: BadgeDescriptor): number {
  const resolved = resolveBadge(channel, descriptor);
  const metadata = [resolved.version?.title, resolved.version?.description].filter(Boolean).join(' ');
  if (EVENT_KIND.test(descriptor.kind) || /\b(?:prediction|event|hype train|moment)\b/i.test(metadata)) return 0;
  if (GLOBAL_AUTHORITY_KIND.test(descriptor.kind) || /\b(?:twitch staff|administrator|global moderator|partner|verified)\b/i.test(metadata)) return 10;
  if (CHANNEL_AUTHORITY_KIND.test(descriptor.kind) || /\b(?:broadcaster|moderator|channel artist|vip)\b/i.test(metadata)) return 20;
  if (CHANNEL_SUPPORT_KIND.test(descriptor.kind) || /\b(?:subscriber|founder|bits|cheerer|sub gifter)\b/i.test(metadata)) return 30;
  if (GLOBAL_VANITY_KIND.test(descriptor.kind) || /\b(?:chat bot|prime gaming|turbo|ambassador)\b/i.test(metadata)) return 40;
  return 100;
}

/** Gallery-only Twitch slot policy; recording-time arrays remain untouched elsewhere. */
export function sortMediaBadges(channel: string, badges: readonly BadgeDescriptor[]): BadgeDescriptor[] {
  return badges
    .map((badge, index) => ({ badge, index, priority: displayPriority(channel, badge) }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map(({ badge }) => badge);
}
