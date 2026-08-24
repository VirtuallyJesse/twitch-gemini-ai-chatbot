import { useEffect, useState, useSyncExternalStore } from 'react';
import type { BadgeDescriptor } from '../lib/types';
import {
  getBadgeRegistryRevision,
  resolveBadge,
  subscribeBadgeRegistry,
} from '../lib/badges';
import { stringToColor } from '../lib/color';

function Badge({ badge, channel, size }: { badge: BadgeDescriptor; channel: string; size: number }) {
  useSyncExternalStore(subscribeBadgeRegistry, getBadgeRegistryRevision, getBadgeRegistryRevision);
  const resolved = resolveBadge(channel, badge);
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [resolved.imageUrl]);

  if (!resolved.imageUrl || failed) {
    return (
      <span
        role="img"
        aria-label={resolved.title}
        title={resolved.title}
        className="inline-block shrink-0 rounded-[3px] align-[-2px]"
        style={{
          width: size,
          height: size,
          background: stringToColor(`${badge.kind}:${badge.version}`),
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.28)',
        }}
      />
    );
  }

  return (
    <img
      src={resolved.imageUrl}
      alt={resolved.title}
      title={resolved.title}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      className="inline-block shrink-0 rounded-[3px] object-contain align-[-2px]"
    />
  );
}

export function ChatBadge({ badge, channel }: { badge: BadgeDescriptor; channel: string }) {
  return <Badge badge={badge} channel={channel} size={14} />;
}

export function AuthorBadge({ badge, channel }: { badge: BadgeDescriptor; channel: string }) {
  return <Badge badge={badge} channel={channel} size={12} />;
}
