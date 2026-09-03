import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Hash,
  ArrowDown,
  Loader2,
  Zap,
  Star,
  Gift,
  Diamond,
  Heart,
  Radio,
  ShieldCheck,
  Ghost,
  Settings2,
  WifiOff,
} from 'lucide-react';
import type { ChatEventKind, LogEntry } from '../lib/types';
import { parseChat, type Token } from '../lib/parseChat';
import { useBotHighlight } from '../lib/settings';
import { normChannel } from '../lib/channel';
import { stringToColor } from '../lib/color';
import { ChatBadge } from './Badges';
import Emote from './Emote';
import type { ChatChannelHistory } from '../lib/chatHistory';
import {
  captureChatAnchor,
  chatViewportAtBottom,
  chatViewportNeedsFill,
  createChatAnchorRestorer,
  syncChatViewportAfterResize,
  type ChatScrollAnchor,
} from '../lib/chatScroll';

/* ------------------------------ tokens ------------------------------ */

function TokenView({ tok }: { tok: Token }) {
  switch (tok.t) {
    case 'text':
      return <>{tok.v}</>;
    case 'cmd':
      return (
        <code className="rounded bg-raised px-1 py-px font-mono text-[11px] font-medium text-accent">{tok.v}</code>
      );
    case 'mention':
      return <span className="font-semibold text-accent">{tok.v}</span>;
    case 'emote':
      return <Emote def={tok.e} />;
    case 'link':
      return (
        <a
          href={tok.href}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-accent underline decoration-accent/40 underline-offset-2 transition-colors hover:decoration-accent"
        >
          {tok.v}
        </a>
      );
  }
}

export function RichText({
  text,
  channel,
  meta,
}: {
  text: string;
  channel: string;
  meta?: { twitchEmotesByName?: Record<string, string>; [key: string]: unknown } | null;
}) {
  return (
    <>
      {parseChat(text, channel, meta).map((tok, i) => (
        <TokenView key={i} tok={tok} />
      ))}
    </>
  );
}

/* ------------------------------ rows ------------------------------ */

function Separator({ label }: { label: string }) {
  return (
    <div className="my-2.5 flex items-center gap-2.5 px-1">
      <span className="h-px flex-1 bg-line" />
      <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-faint">{label}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

export const EVENT_META: Record<ChatEventKind, { icon: React.ElementType; color: string }> = {
  raid: { icon: Zap, color: '#a273ff' },
  sub: { icon: Star, color: '#ffd166' },
  gift: { icon: Gift, color: '#4fd8b8' },
  cheer: { icon: Diamond, color: '#5fc9e8' },
  follow: { icon: Heart, color: '#ff6b8f' },
  online: { icon: Radio, color: '#7ed957' },
  offline: { icon: Radio, color: '#62676e' },
  system: { icon: ShieldCheck, color: '#a273ff' },
};

export function EventRow({ entry }: { entry: Extract<LogEntry, { kind: 'event' }> }) {
  const meta = EVENT_META[entry.event] || EVENT_META.system;
  const Icon = meta.icon;
  return (
    <div className="my-1 flex items-center gap-2 rounded-md border border-line-soft bg-surface-2/70 px-2.5 py-1.5">
      <Icon size={12} style={{ color: meta.color }} strokeWidth={2.4} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted">{entry.text}</span>
      <span className="shrink-0 font-mono text-[9.5px] text-faint">{entry.time}</span>
    </div>
  );
}

export function MsgRow({
  entry,
  channel,
  botUsername,
  highlightBots,
}: {
  entry: Extract<LogEntry, { kind: 'msg' }>;
  channel: string;
  botUsername?: string;
  highlightBots: boolean;
}) {
  const isBot = botUsername ? entry.user.toLowerCase() === botUsername.toLowerCase() : false;
  const badges = entry.badges || [];
  const userColor = entry.color || stringToColor(entry.user);

  const body = (
    <>
      <span className="mr-1.5 font-mono text-[10px] text-faint">{entry.time}</span>
      {badges.length > 0 && (
        <span className="mr-1 inline-flex gap-1 align-[-2px]">
          {badges.map((b, idx) => (
            <ChatBadge key={`${b.kind}/${b.version}-${idx}`} badge={b} channel={channel} />
          ))}
        </span>
      )}
      <span
        className="font-semibold"
        style={{ color: isBot && highlightBots ? '#a273ff' : userColor }}
      >
        {entry.user}
      </span>
      <span className={isBot && highlightBots ? 'text-ink/90' : 'text-ink/85'}>
        : <RichText text={entry.text} channel={channel} meta={entry.meta} />
      </span>
    </>
  );

  if (isBot && highlightBots) {
    return (
      <div className="my-1 rounded-r-md border-l-2 border-accent bg-accent/[0.06] py-1.5 pl-2.5 pr-2 text-[12.5px] leading-[1.5]">
        {body}
      </div>
    );
  }
  return <div className="rounded px-1 py-[3px] text-[12.5px] leading-[1.5] hover:bg-white/[0.03]">{body}</div>;
}

function NoChannels({ onOpenSettings }: { onOpenSettings?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <Hash size={22} className="text-faint" strokeWidth={1.8} />
      <div>
        <p className="text-[12.5px] font-medium text-muted">No channels yet</p>
        <p className="mt-1 text-[11.5px] leading-snug text-faint">
          Add your Twitch channel and the bot joins its chat.
        </p>
      </div>
      {onOpenSettings && (
        <button
          onClick={onOpenSettings}
          className="mt-1 flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-raised px-2.5 py-1.5 text-[11.5px] font-semibold text-ink transition hover:border-accent/50"
        >
          <Settings2 size={12} />
          Add a channel
        </button>
      )}
    </div>
  );
}

/* ------------------------------ panel ------------------------------ */

interface Props {
  channels: string[];
  joinedChannels: string[];
  activeChannel: string;
  onSelectChannel: (c: string) => void;
  logs: Record<string, LogEntry[]>;
  histories: Record<string, ChatChannelHistory>;
  onLoadOlder: (channel: string) => void;
  botUsername?: string;
  onOpenSettings?: () => void;
}

export default function ChatPanel({
  channels,
  joinedChannels,
  activeChannel,
  onSelectChannel,
  logs,
  histories,
  onLoadOlder,
  botUsername,
  onOpenSettings,
}: Props) {
  const [atBottom, setAtBottom] = useState(true);
  const [anchorRestorer] = useState(createChatAnchorRestorer);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevChannelRef = useRef(activeChannel);
  const pendingPrependRef = useRef<{
    channel: string;
    firstEntryId: string | null;
    anchor: ChatScrollAnchor;
  } | null>(null);
  const highlightBots = useBotHighlight();

  const activeNorm = normChannel(activeChannel);
  const entries: LogEntry[] = logs[activeNorm] || logs[`#${activeNorm}`] || [];
  const history = histories[activeNorm];
  const canRevealCached = Boolean(history && history.visibleCount < history.entries.length);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const channelChanged = prevChannelRef.current !== activeChannel;
    prevChannelRef.current = activeChannel;
    const pending = pendingPrependRef.current;

    if (channelChanged) {
      anchorRestorer.cancel();
      pendingPrependRef.current = null;
      el.scrollTop = el.scrollHeight;
      setAtBottom(true);
      return;
    }
    if (pending?.channel === activeNorm) {
      if ((entries[0]?.id || null) !== pending.firstEntryId) {
        anchorRestorer.restore(el, pending.anchor);
        pendingPrependRef.current = null;
        setAtBottom(chatViewportAtBottom(el));
        return;
      }
      if (el.scrollHeight !== pending.anchor.height) {
        pendingPrependRef.current = { ...pending, anchor: captureChatAnchor(el) };
      }
    }
    if (!pending && atBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [activeChannel, activeNorm, entries, atBottom, anchorRestorer]);

  useEffect(() => {
    const pending = pendingPrependRef.current;
    if (
      pending?.channel === activeNorm && history?.loading === null &&
      (entries[0]?.id || null) === pending.firstEntryId
    ) {
      pendingPrependRef.current = null;
    }
  }, [activeNorm, entries, history?.loading]);

  useEffect(() => () => anchorRestorer.cancel(), [anchorRestorer]);

  const loadOlder = useCallback(() => {
    const el = scrollRef.current;
    if (
      !el || !history?.hydrated || history.loading || pendingPrependRef.current ||
      anchorRestorer.isPending() ||
      (!canRevealCached && !history.hasMore)
    ) return;
    anchorRestorer.cancel();
    pendingPrependRef.current = {
      channel: activeNorm,
      firstEntryId: entries[0]?.id || null,
      anchor: captureChatAnchor(el),
    };
    onLoadOlder(activeNorm);
  }, [activeNorm, canRevealCached, entries, history, onLoadOlder, anchorRestorer]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && history?.hydrated && canRevealCached && chatViewportNeedsFill(el)) {
      loadOlder();
    }
  }, [activeNorm, canRevealCached, entries.length, history?.hydrated, loadOlder]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const needsFill = syncChatViewportAfterResize(el, atBottom);
      if (canRevealCached && needsFill) loadOlder();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [atBottom, canRevealCached, loadOlder]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(chatViewportAtBottom(el));
    if (el.scrollTop < 80) loadOlder();
  };

  const jumpToLatest = () => {
    anchorRestorer.cancel();
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-surface">
      {/* channel tabs */}
      {channels.length > 0 && (
        <div className="flex shrink-0 overflow-x-auto border-b border-line scroll-slim">
          {channels.map((chan) => {
          const chanNorm = normChannel(chan);
          const isActive = chanNorm === activeNorm;
          const joined = joinedChannels.map(normChannel).includes(chanNorm);
          return (
            <button
              key={chan}
              onClick={() => onSelectChannel(chanNorm)}
              className={`relative flex shrink-0 cursor-pointer items-center gap-1.5 px-3 py-2.5 text-[12px] font-medium transition-colors ${
                isActive ? 'text-ink' : 'text-muted hover:text-ink'
              }`}
            >
              {!joined ? (
                <WifiOff size={11} className="text-amber-400" strokeWidth={2.4} aria-label="Bot not joined" />
              ) : (
                <Hash size={11} className={isActive ? 'text-accent' : 'text-faint'} strokeWidth={2.4} />
              )}
              {chanNorm}
              {isActive && <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-t bg-accent" />}
            </button>
          );
        })}
        </div>
      )}

      {/* log */}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="scroll-slim h-full overflow-x-hidden overflow-y-auto px-2.5 py-2">
          {history?.loading === 'older' && (
            <div className="sticky top-1 z-10 flex h-0 justify-center" role="status">
              <span className="flex items-center gap-1.5 rounded-full border border-line bg-raised px-2.5 py-1 text-[10.5px] text-faint shadow-md">
                <Loader2 size={11} className="animate-spin" />
                Loading older messages…
              </span>
            </div>
          )}
          {history?.error && history.hydrated && (
            <div className="sticky top-1 z-10 flex h-0 justify-center">
              <span className="flex items-center gap-2 rounded-full border border-rose-400/30 bg-raised px-2.5 py-1 text-[10.5px] text-rose-300 shadow-md">
                History couldn’t load.
                <button onClick={loadOlder} className="cursor-pointer font-semibold text-accent hover:underline">
                  Retry
                </button>
              </span>
            </div>
          )}
          {history?.hydrated && !history.hasMore && !canRevealCached && entries.length > 0 && (
            <div className="py-2 text-center font-mono text-[9.5px] uppercase tracking-[0.12em] text-faint">
              Beginning of retained history
            </div>
          )}
          {channels.length === 0 ? (
            <NoChannels onOpenSettings={onOpenSettings} />
          ) : history?.loading === 'hydrate' && entries.length === 0 ? (
            <div className="flex items-center justify-center gap-2 px-6 py-14 text-[12px] text-muted" role="status">
              <Loader2 size={14} className="animate-spin" />
              Loading chat…
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center gap-2.5 px-6 py-14 text-center">
              <Ghost size={22} className="text-faint" />
              <p className="text-[12.5px] font-medium text-muted">No messages yet</p>
            </div>
          ) : (
            entries.map((e) => {
              if (e.kind === 'sep') return <Separator key={e.id} label={e.label} />;
              if (e.kind === 'event') return <EventRow key={e.id} entry={e} />;
              return (
                <MsgRow
                  key={e.id}
                  entry={e}
                  channel={activeNorm}
                  botUsername={botUsername}
                  highlightBots={highlightBots}
                />
              );
            })
          )}
        </div>
        {!atBottom && (
          <button
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 flex -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-raised px-3 py-1.5 text-[11px] font-medium text-ink shadow-lg transition-colors hover:border-accent/50"
          >
            <ArrowDown size={12} />
            Latest
          </button>
        )}
      </div>
    </section>
  );
}
