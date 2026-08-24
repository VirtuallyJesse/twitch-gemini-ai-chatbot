import { useState } from 'react';
import type { BadgeKind } from '../lib/types';

/* Authentic Twitch badge assets from the shared static-cdn badge
   registry, with a flat colored-square fallback if the CDN fails. */

const BADGE_META: Record<BadgeKind, { uuid: string; label: string; fallback: string }> = {
  broadcaster: { uuid: '5527c58c-fb7d-422d-b71b-f309dcb85cc1', label: 'Broadcaster', fallback: '#e91916' },
  mod: { uuid: '3267646d-33f0-4b17-b3df-f923a41db1d0', label: 'Moderator', fallback: '#00ad03' },
  vip: { uuid: 'b817aba4-fad8-49e2-b88a-7cc744dfa6ec', label: 'VIP', fallback: '#e005b9' },
  sub: { uuid: '5d9f2208-5dd8-11e7-8513-2ff4adfae661', label: 'Subscriber', fallback: '#772ce8' },
  bits: { uuid: '09d93036-e7ce-431c-9a9e-7044297d4569', label: 'Cheerer', fallback: '#1baac7' },
  bot: { uuid: '3ffa9565-c35b-4cad-800b-041e60659cf2', label: 'Chat Bot', fallback: '#00ad9c' },
};

const badgeUrl = (uuid: string) => `https://static-cdn.jtvnw.net/badges/v1/${uuid}/1`;

function Badge({ kind, size }: { kind: BadgeKind; size: number }) {
  const meta = BADGE_META[kind];
  const [failed, setFailed] = useState(false);

  if (!meta) return null;

  if (failed) {
    return (
      <span
        title={meta.label}
        className="inline-block rounded-[3px] align-[-2px]"
        style={{ width: size, height: size, background: meta.fallback }}
      />
    );
  }

  return (
    <img
      src={badgeUrl(meta.uuid)}
      alt={meta.label}
      title={meta.label}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      className="inline-block rounded-[3px] align-[-2px]"
    />
  );
}

export function ChatBadge({ kind }: { kind: BadgeKind }) {
  return <Badge kind={kind} size={14} />;
}

export function AuthorBadge({ kind }: { kind: BadgeKind }) {
  return <Badge kind={kind} size={12} />;
}
