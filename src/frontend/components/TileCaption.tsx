import type { MediaItem } from '../lib/types';
import { timeAgo } from '../lib/time';
import { channelLabel } from '../lib/channel';
import { sortMediaBadges } from '../lib/badges';
import { AuthorBadge } from './Badges';
import Avatar from './Avatar';

/* Shared bottom caption so every tile type reads identically:
   italic prompt quote · author avatar + profile badges · source channel
   (the gallery pools every channel the bot is joined to) · relative time */
export default function TileCaption({ item }: { item: MediaItem }) {
  const authorName = item.author || 'someone';
  const timeLabel = timeAgo(item.timestamp ?? item.minutesAgo);
  const channelName = channelLabel(item.channel || 'channel');
  const displayBadges = sortMediaBadges(channelName, item.badges || []).slice(0, 2);

  return (
    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-2.5 pb-2 pt-10 pointer-events-none">
      <p className="line-clamp-2 text-[11.5px] italic leading-snug text-ink/90">“{item.prompt}”</p>
      <div className="mt-1.5 flex items-center gap-1.5">
        <Avatar name={authorName} src={item.avatarUrl} size={16} />
        <span className="truncate text-[10.5px] font-medium text-muted">{authorName}</span>
        {displayBadges.map((b, idx) => (
          <AuthorBadge key={`${b.kind}/${b.version}-${idx}`} badge={b} channel={channelName} />
        ))}
        <span className="ml-auto shrink-0 truncate font-mono text-[9.5px] text-faint">
          #{channelName} · {timeLabel}
        </span>
      </div>
    </div>
  );
}
