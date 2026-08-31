import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquareText, LayoutGrid } from 'lucide-react';
import type {
  BadgeDictionaries,
  BotStatus,
  LogEntry,
  MediaItem,
  RawChatEntry,
  RawMediaEntry,
  ViewerInfo,
} from './lib/types';
import { api } from './lib/api';
import { wsClient } from './lib/ws';
import { registerChannelEmotes } from './lib/emotes';
import { registerChannelBadges } from './lib/badges';
import { hydrateBadgeCatalogs } from './lib/badgeHydration';
import { timeAgo } from './lib/time';
import { normChannel } from './lib/channel';
import { botAuthorization } from './lib/botStatusPresentation';
import { createGalleryAvatarHydrator } from './lib/avatars';
import { formatRawChatEntry } from './lib/chatLogs';
import {
  appendLiveChatEntry,
  beginChatHydration,
  beginOlderChatPage,
  chatLogs,
  createChatHistoryModel,
  failChatPage,
  revealOlderChatEntries,
  resetVisibleChatEntries,
  resolveChatPage,
  restartChatHydration,
  syncChatChannels,
  type ChatRequestMode,
} from './lib/chatHistory';
import { normalizeMediaEntry } from './lib/media';
import { applyMediaMutation, replayMediaMutations, type MediaMutation } from './lib/mediaMutations';
import Sidebar from './components/Sidebar';
import GalleryToolbar, { type Filter } from './components/GalleryToolbar';
import MediaGrid from './components/MediaGrid';
import SettingsModal from './components/SettingsModal';
import { GalleryActionsProvider } from './components/GalleryItemActions';
import DeleteMediaDialog, { type DeleteMediaDialogState } from './components/DeleteMediaDialog';

function haystack(m: MediaItem): string {
  return [
    m.prompt,
    m.author,
    `@${m.author}`,
    m.channel,
    `#${m.channel}`,
    m.type,
    m.audioKind ?? '',
    timeAgo(m.timestamp ?? m.minutesAgo),
  ]
    .join(' ')
    .toLowerCase();
}

export default function App() {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileView, setMobileView] = useState<'gallery' | 'chat'>('gallery');

  // Runtime state
  const [viewer, setViewer] = useState<ViewerInfo | null>(null);
  const [botStatus, setBotStatus] = useState<BotStatus | null>(null);
  const [channels, setChannels] = useState<string[]>([]);
  const [activeChannel, setActiveChannel] = useState<string>('');
  const [channelStatuses, setChannelStatuses] = useState<Record<string, { authorized?: boolean; linked?: boolean; needsRelink?: boolean }>>({});
  const [chatHistory, setChatHistory] = useState(createChatHistoryModel);
  const chatHistoryRef = useRef(chatHistory);
  const [mediaList, setMediaList] = useState<MediaItem[]>([]);
  const [deleteDialog, setDeleteDialog] = useState<DeleteMediaDialogState | null>(null);
  const deletePendingRef = useRef(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [avatarHydrator] = useState(() => createGalleryAvatarHydrator({
    lookup: (identities, signal) => api.getAvatars(identities, signal),
    commit: setMediaList,
  }));

  const commitChatHistory = useCallback((next: typeof chatHistory) => {
    chatHistoryRef.current = next;
    setChatHistory(next);
  }, []);

  const syncConfiguredChannels = useCallback((nextChannels: readonly string[]) => {
    commitChatHistory(syncChatChannels(chatHistoryRef.current, nextChannels));
  }, [commitChatHistory]);

  const requestChatPage = useCallback(async (channelValue: string, mode: ChatRequestMode) => {
    const channel = normChannel(channelValue);
    const started = mode === 'hydrate'
      ? beginChatHydration(chatHistoryRef.current, channel)
      : beginOlderChatPage(chatHistoryRef.current, channel);
    if (!started.request) return;
    commitChatHistory(started.model);
    try {
      const rawPage = await api.getChatPage(channel, started.request.cursor);
      const entries = rawPage.entries
        .map((entry) => formatRawChatEntry(entry))
        .filter((entry): entry is LogEntry => entry !== null);
      commitChatHistory(resolveChatPage(chatHistoryRef.current, started.request, {
        entries,
        nextCursor: rawPage.nextCursor,
        hasMore: rawPage.hasMore,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'CHAT_HISTORY_UNAVAILABLE';
      if (message === 'STALE_CURSOR' || message === 'INVALID_CURSOR') {
        commitChatHistory(restartChatHydration(chatHistoryRef.current, channel));
        queueMicrotask(() => void requestChatPage(channel, 'hydrate'));
        return;
      }
      commitChatHistory(failChatPage(chatHistoryRef.current, started.request, message));
    }
  }, [commitChatHistory]);

  const logs = useMemo(() => chatLogs(chatHistory), [chatHistory]);

  const handleRevealOlderChat = useCallback((channelValue: string) => {
    const channel = normChannel(channelValue);
    const current = chatHistoryRef.current;
    const revealed = revealOlderChatEntries(current, channel);
    if (revealed !== current) {
      commitChatHistory(revealed);
      return;
    }
    void requestChatPage(channel, 'older');
  }, [commitChatHistory, requestChatPage]);

  // Dynamic document title based on bot account
  useEffect(() => {
    const rawBotName = botStatus?.botUsername || '';
    const cleanName = rawBotName.replace(/^@/, '').trim();
    if (cleanName && cleanName.toLowerCase() !== 'your-bot-username') {
      document.title = `${cleanName} Dashboard`;
    } else {
      document.title = 'Dashboard';
    }
  }, [botStatus?.botUsername]);

  // Initial Data Hydration
  useEffect(() => {
    let disposed = false;
    let configuredChannelsReady = false;
    let mediaHydrated = false;
    const pendingChatEvents: Array<{ channel: string; entry: RawChatEntry }> = [];
    const pendingMediaMutations: MediaMutation[] = [];
    const acceptLiveChat = (data: { channel: string; entry: RawChatEntry }) => {
      const chan = normChannel(data.channel);
      const entry = formatRawChatEntry(data.entry);
      if (!entry) return;
      commitChatHistory(appendLiveChatEntry(chatHistoryRef.current, chan, entry));
    };
    const acceptMediaMutation = (mutation: MediaMutation) => {
      if (disposed) return;
      if (!mediaHydrated) {
        pendingMediaMutations.push(mutation);
        return;
      }
      setMediaList((previous) => applyMediaMutation(previous, mutation));
    };

    // Connect WebSocket
    wsClient.connect();
    const unsubStatus = wsClient.onStatus((s) => setWsConnected(s === 'connected'));

    // Fetch initial info
    Promise.allSettled([
      api.getViewer(),
      api.getStatus(),
      api.getChannels(),
      api.getChannelStatuses(),
      api.getMedia(),
    ]).then(([vRes, sRes, cRes, csRes, mRes]) => {
      if (disposed) return;
      if (vRes.status === 'fulfilled') setViewer(vRes.value);
      if (sRes.status === 'fulfilled') setBotStatus(sRes.value);

      if (cRes.status === 'fulfilled') {
        const chanList = cRes.value.map(normChannel);
        syncConfiguredChannels(chanList);
        setChannels(chanList);
        const first = chanList[0] || '';
        setActiveChannel(first);

        if (first) {
          api.getEmotes(first).then((emotes) => {
            if (emotes) registerChannelEmotes(first, emotes);
          });
        }

        void hydrateBadgeCatalogs(chanList, (channel) => api.getBadges(channel));
      }
      configuredChannelsReady = true;
      for (const pending of pendingChatEvents.splice(0)) acceptLiveChat(pending);

      if (csRes.status === 'fulfilled') setChannelStatuses(csRes.value);

      const snapshot = mRes.status === 'fulfilled' && Array.isArray(mRes.value)
        ? mRes.value.map(normalizeMediaEntry)
        : [];
      setMediaList(replayMediaMutations(snapshot, pendingMediaMutations));
      pendingMediaMutations.length = 0;
      mediaHydrated = true;
    });

    // Real-time WebSocket Listeners
    const unsubChat = wsClient.on<{ channel: string; entry: RawChatEntry }>('chat', (data) => {
      if (!data?.channel || !data?.entry) return;
      if (!configuredChannelsReady) {
        pendingChatEvents.push(data);
        if (pendingChatEvents.length > 200) pendingChatEvents.shift();
        return;
      }
      acceptLiveChat(data);
    });

    const unsubMedia = wsClient.on<{ entry: RawMediaEntry }>('media', (data) => {
      if (!data?.entry) return;
      acceptMediaMutation({ type: 'added', item: normalizeMediaEntry(data.entry) });
    });

    const unsubMediaDeleted = wsClient.on<{ id: string }>('media:deleted', (data) => {
      if (!data?.id) return;
      acceptMediaMutation({ type: 'deleted', id: data.id });
      setDeleteDialog((current) => current?.target.persistedId === data.id ? null : current);
    });

    const unsubEmotes = wsClient.on<{ channel: string; emotes: Record<string, string> }>('emotes:update', (data) => {
      if (data?.channel && data?.emotes) {
        registerChannelEmotes(data.channel, data.emotes);
      }
    });

    const unsubBadges = wsClient.on<{ channel: string; badges: BadgeDictionaries }>('badges:update', (data) => {
      if (data?.channel && data?.badges) registerChannelBadges(data.channel, data.badges);
    });

    const unsubBotStatus = wsClient.on<BotStatus>('bot:status', (data) => {
      if (data) {
        setBotStatus(data);
        if (data.channelStatuses) setChannelStatuses(data.channelStatuses);
      }
    });

    const unsubBroadcaster = wsClient.on<{ channel: string; authorized: boolean }>('auth:broadcaster', (data) => {
      if (data?.channel) {
        const c = normChannel(data.channel);
        setChannelStatuses((prev) => ({
          ...prev,
          [c]: { authorized: data.authorized },
          [`#${c}`]: { authorized: data.authorized },
        }));
      }
    });

    const unsubConfig = wsClient.on<{ key: string }>('config:updated', (data) => {
      if (!data?.key || data.key === 'bot_settings') {
        Promise.allSettled([api.getChannels(), api.getChannelStatuses(), api.getStatus()]).then(
          ([cRes, csRes, sRes]) => {
            if (cRes.status === 'fulfilled' && Array.isArray(cRes.value)) {
              const chanList = cRes.value.map(normChannel);
              syncConfiguredChannels(chanList);
              setChannels(chanList);
              setActiveChannel((prev) => (chanList.includes(prev) ? prev : chanList[0] || ''));
              void hydrateBadgeCatalogs(chanList, (channel) => api.getBadges(channel));
            }
            if (csRes.status === 'fulfilled') {
              setChannelStatuses(csRes.value);
            }
            if (sRes.status === 'fulfilled') {
              setBotStatus(sRes.value);
            }
          }
        );
      }
    });

    // Window message listener for OAuth popups
    const handleWindowMessage = (event: MessageEvent) => {
      if (event.data?.type === 'twitch:bot_authorized') {
        setBotStatus((prev) => (prev ? { ...prev, authorized: true } : null));
        api.getStatus().then((s) => s && setBotStatus(s));
      } else if (event.data?.type === 'twitch:broadcaster_authorized' && event.data?.channel) {
        const c = normChannel(String(event.data.channel));
        setChannelStatuses((prev) => ({
          ...prev,
          [c]: { authorized: true },
          [`#${c}`]: { authorized: true },
        }));
      }
    };
    window.addEventListener('message', handleWindowMessage);

    return () => {
      disposed = true;
      unsubStatus();
      unsubChat();
      unsubMedia();
      unsubMediaDeleted();
      unsubEmotes();
      unsubBadges();
      unsubBotStatus();
      unsubBroadcaster();
      unsubConfig();
      window.removeEventListener('message', handleWindowMessage);
    };
  }, [commitChatHistory, syncConfiguredChannels]);

  useEffect(() => {
    if (activeChannel && channels.includes(activeChannel)) {
      void requestChatPage(activeChannel, 'hydrate');
    }
  }, [activeChannel, channels, requestChatPage]);

  const hydrateExposedMedia = useCallback((exposed: readonly MediaItem[]) => {
    void avatarHydrator.hydrate(exposed);
  }, [avatarHydrator]);

  // Channel history hydrates in the effect above; presentation metadata can load independently.
  const handleSelectChannel = (chan: string) => {
    const norm = normChannel(chan);
    if (norm !== activeChannel) {
      commitChatHistory(resetVisibleChatEntries(chatHistoryRef.current, norm));
    }
    setActiveChannel(norm);
    if (!chatHistoryRef.current.channels[norm]?.hydrated) {
      api.getEmotes(norm).then((emotes) => {
        if (emotes) registerChannelEmotes(norm, emotes);
      });
    }
    api.getBadges(norm).then((catalog) => registerChannelBadges(catalog.channel || norm, catalog.badges));
  };

  const handleLogout = async () => {
    await api.logout();
    setViewer({ authenticated: false });
  };

  const requestMediaDelete = useCallback((item: MediaItem) => {
    if (!item.persistedId || deletePendingRef.current) return;
    setDeleteDialog({ target: item, pending: false, error: null });
  }, []);

  const cancelMediaDelete = useCallback(() => {
    if (deletePendingRef.current) return;
    setDeleteDialog(null);
  }, []);

  const confirmMediaDelete = useCallback(async () => {
    const id = deleteDialog?.target.persistedId;
    if (!id || deletePendingRef.current) return;
    deletePendingRef.current = true;
    setDeleteDialog((current) => current?.target.persistedId === id
      ? { ...current, pending: true, error: null }
      : current);
    try {
      await api.deleteMedia(id);
      setMediaList((previous) => applyMediaMutation(previous, { type: 'deleted', id }));
      setDeleteDialog((current) => current?.target.persistedId === id ? null : current);
    } catch {
      setDeleteDialog((current) => current?.target.persistedId === id
        ? { ...current, pending: false, error: 'Couldn’t delete this gallery item. Try again.' }
        : current);
    } finally {
      deletePendingRef.current = false;
    }
  }, [deleteDialog]);

  // Search & Filter
  const searched = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return mediaList;
    return mediaList.filter((m) => {
      const h = haystack(m);
      return terms.every((t) => h.includes(t));
    });
  }, [query, mediaList]);

  const counts = useMemo(
    () => ({
      all: searched.length,
      image: searched.filter((m) => m.type === 'image').length,
      video: searched.filter((m) => m.type === 'video').length,
      audio: searched.filter((m) => m.type === 'audio').length,
    }),
    [searched]
  );

  const items = useMemo(() => {
    const list = filter === 'all' ? searched : searched.filter((m) => m.type === filter);
    return [...list].sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));
  }, [searched, filter]);

  return (
    <div className="flex h-full bg-bg">
      {/* left rail — full viewport height */}
      <aside
        className={`h-full min-h-0 w-full shrink-0 border-r border-line lg:block lg:w-[390px] xl:w-[420px] ${
          mobileView === 'chat' ? 'block' : 'hidden'
        }`}
      >
        <Sidebar
          botUsername={botStatus?.botUsername || ''}
          botAuthorized={botAuthorization(botStatus)}
          botConnected={Boolean(botStatus?.connected)}
          wsConnected={wsConnected}
          channels={channels}
          joinedChannels={botStatus?.joinedChannels || []}
          activeChannel={activeChannel}
          onSelectChannel={handleSelectChannel}
          channelStatuses={channelStatuses}
          logs={logs}
          histories={chatHistory.channels}
          onLoadOlder={handleRevealOlderChat}
          viewer={viewer}
          onOpenSettings={() => setSettingsOpen(true)}
          onLogout={handleLogout}
        />
      </aside>

      {/* right panel — gallery toolbar + media canvas */}
      <section
        className={`h-full min-h-0 flex-1 flex-col lg:flex ${mobileView === 'gallery' ? 'flex' : 'hidden'}`}
      >
        <GalleryToolbar
          filter={filter}
          onFilter={setFilter}
          counts={counts}
          query={query}
          onQuery={setQuery}
        />
        <div className="min-h-0 flex-1">
          <GalleryActionsProvider
            canDelete={Boolean(viewer?.authenticated && viewer.isAdmin)}
            requestDelete={requestMediaDelete}
          >
            <MediaGrid
              items={items}
              resetKey={`${filter}:${query}`}
              onItemsExposed={hydrateExposedMedia}
            />
          </GalleryActionsProvider>
        </div>
      </section>

      {/* mobile zone switcher */}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center lg:hidden">
        <div className="pointer-events-auto flex gap-0.5 rounded-full border border-line bg-surface p-0.5 shadow-xl">
          <button
            onClick={() => setMobileView('gallery')}
            className={`flex cursor-pointer items-center gap-1.5 rounded-full px-4 py-2 text-[12px] font-medium transition-colors ${
              mobileView === 'gallery' ? 'bg-raised text-ink' : 'text-muted'
            }`}
          >
            <LayoutGrid size={13} className={mobileView === 'gallery' ? 'text-accent' : ''} />
            Gallery
          </button>
          <button
            onClick={() => setMobileView('chat')}
            className={`flex cursor-pointer items-center gap-1.5 rounded-full px-4 py-2 text-[12px] font-medium transition-colors ${
              mobileView === 'chat' ? 'bg-raised text-ink' : 'text-muted'
            }`}
          >
            <MessageSquareText size={13} className={mobileView === 'chat' ? 'text-accent' : ''} />
            Chat log
          </button>
        </div>
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        botUsername={botStatus?.botUsername || ''}
        botAuthorized={botAuthorization(botStatus)}
        activeChannel={activeChannel}
        channelStatuses={channelStatuses}
        onChannelsChange={(newChans) => {
          const cleaned = newChans.map(normChannel);
          syncConfiguredChannels(cleaned);
          setChannels(cleaned);
          setActiveChannel((prev) => (cleaned.includes(prev) ? prev : cleaned[0] || ''));
          api.getChannelStatuses().then((cs) => cs && setChannelStatuses(cs));
        }}
      />
      <DeleteMediaDialog
        state={deleteDialog}
        onCancel={cancelMediaDelete}
        onConfirm={() => void confirmMediaDelete()}
      />
    </div>
  );
}
