import { normChannel } from './channel.ts';
import type { ChatHistoryPage, LogEntry } from './types.ts';

export const INITIAL_VISIBLE_CHAT_ENTRIES = 50;
export const CHAT_REVEAL_STEP = 50;
const MAX_RETAINED_CHAT_ENTRIES = 10_000;

export type ChatRequestMode = 'hydrate' | 'older';

export interface ChatPageRequest {
  channel: string;
  epoch: number;
  cursor: string | null;
  mode: ChatRequestMode;
}

export interface ChatChannelHistory {
  entries: LogEntry[];
  visibleCount: number;
  hydrated: boolean;
  cursor: string | null;
  hasMore: boolean;
  loading: ChatRequestMode | null;
  error: string | null;
  epoch: number;
  pending: ChatPageRequest | null;
}

export interface ChatHistoryModel {
  channels: Record<string, ChatChannelHistory>;
  nextEpoch: number;
}

export function createChatHistoryModel(): ChatHistoryModel {
  return { channels: {}, nextEpoch: 1 };
}

function newChannel(epoch: number): ChatChannelHistory {
  return {
    entries: [],
    visibleCount: 0,
    hydrated: false,
    cursor: null,
    hasMore: true,
    loading: null,
    error: null,
    epoch,
    pending: null,
  };
}

export function syncChatChannels(model: ChatHistoryModel, channels: readonly string[]): ChatHistoryModel {
  const normalized = [...new Set(channels.map(normChannel).filter(Boolean))];
  const nextChannels: Record<string, ChatChannelHistory> = {};
  let nextEpoch = model.nextEpoch;
  for (const channel of normalized) {
    const existing = model.channels[channel];
    if (existing) {
      nextChannels[channel] = existing;
    } else {
      nextChannels[channel] = newChannel(nextEpoch);
      nextEpoch += 1;
    }
  }
  return { channels: nextChannels, nextEpoch };
}

function beginRequest(
  model: ChatHistoryModel,
  channelValue: string,
  mode: ChatRequestMode
): { model: ChatHistoryModel; request: ChatPageRequest | null } {
  const channel = normChannel(channelValue);
  const state = model.channels[channel];
  if (
    !state || state.loading ||
    (mode === 'hydrate' && state.hydrated) ||
    (mode === 'older' && (
      !state.hydrated || !state.hasMore || state.visibleCount < state.entries.length
    ))
  ) {
    return { model, request: null };
  }
  const request: ChatPageRequest = {
    channel,
    epoch: state.epoch,
    cursor: mode === 'older' ? state.cursor : null,
    mode,
  };
  return {
    model: {
      ...model,
      channels: {
        ...model.channels,
        [channel]: { ...state, loading: mode, error: null, pending: request },
      },
    },
    request,
  };
}

export function beginChatHydration(model: ChatHistoryModel, channel: string) {
  return beginRequest(model, channel, 'hydrate');
}

export function beginOlderChatPage(model: ChatHistoryModel, channel: string) {
  return beginRequest(model, channel, 'older');
}

function isCurrentRequest(state: ChatChannelHistory | undefined, request: ChatPageRequest | null) {
  return Boolean(
    state && request && state.epoch === request.epoch &&
    state.pending?.epoch === request.epoch && state.pending.mode === request.mode &&
    state.pending.cursor === request.cursor
  );
}

function mergeEntries(existing: readonly LogEntry[], incoming: readonly LogEntry[]) {
  const byId = new Map<string, LogEntry>();
  for (const entry of existing) byId.set(entry.id, entry);
  for (const entry of incoming) byId.set(entry.id, entry);
  return [...byId.values()]
    .sort((a, b) => a.order - b.order)
    .slice(-MAX_RETAINED_CHAT_ENTRIES);
}

export function resolveChatPage(
  model: ChatHistoryModel,
  request: ChatPageRequest | null,
  page: ChatHistoryPage
): ChatHistoryModel {
  if (!request) return model;
  const state = model.channels[request.channel];
  if (!isCurrentRequest(state, request)) return model;
  const entries = mergeEntries(state.entries, page.entries);
  return {
    ...model,
    channels: {
      ...model.channels,
      [request.channel]: {
        ...state,
        entries,
        visibleCount: request.mode === 'hydrate'
          ? Math.min(entries.length, Math.max(INITIAL_VISIBLE_CHAT_ENTRIES, state.visibleCount))
          : Math.min(entries.length, state.visibleCount + CHAT_REVEAL_STEP),
        hydrated: true,
        cursor: page.nextCursor,
        hasMore: page.hasMore,
        loading: null,
        error: null,
        pending: null,
      },
    },
  };
}

export function failChatPage(
  model: ChatHistoryModel,
  request: ChatPageRequest | null,
  error: string
): ChatHistoryModel {
  if (!request) return model;
  const state = model.channels[request.channel];
  if (!isCurrentRequest(state, request)) return model;
  return {
    ...model,
    channels: {
      ...model.channels,
      [request.channel]: {
        ...state,
        loading: null,
        error,
        pending: null,
        hasMore: error === 'RATE_LIMITED' && request.mode === 'older' ? false : state.hasMore,
      },
    },
  };
}

export function appendLiveChatEntry(
  model: ChatHistoryModel,
  channelValue: string,
  entry: LogEntry
): ChatHistoryModel {
  const channel = normChannel(channelValue);
  const state = model.channels[channel];
  if (!state || !entry?.id) return model;
  const isNewEntry = !state.entries.some((existing) => existing.id === entry.id);
  const entries = mergeEntries(state.entries, [entry]);
  return {
    ...model,
    channels: {
      ...model.channels,
      [channel]: {
        ...state,
        entries,
        visibleCount: Math.min(entries.length, state.visibleCount + (isNewEntry ? 1 : 0)),
      },
    },
  };
}

export function revealOlderChatEntries(
  model: ChatHistoryModel,
  channelValue: string
): ChatHistoryModel {
  const channel = normChannel(channelValue);
  const state = model.channels[channel];
  if (!state || state.visibleCount >= state.entries.length) return model;
  return {
    ...model,
    channels: {
      ...model.channels,
      [channel]: {
        ...state,
        visibleCount: Math.min(state.entries.length, state.visibleCount + CHAT_REVEAL_STEP),
      },
    },
  };
}

export function resetVisibleChatEntries(
  model: ChatHistoryModel,
  channelValue: string
): ChatHistoryModel {
  const channel = normChannel(channelValue);
  const state = model.channels[channel];
  if (!state) return model;
  const visibleCount = Math.min(INITIAL_VISIBLE_CHAT_ENTRIES, state.entries.length);
  if (state.visibleCount === visibleCount) return model;
  return {
    ...model,
    channels: {
      ...model.channels,
      [channel]: { ...state, visibleCount },
    },
  };
}

export function restartChatHydration(model: ChatHistoryModel, channelValue: string): ChatHistoryModel {
  const channel = normChannel(channelValue);
  const state = model.channels[channel];
  if (!state) return model;
  return {
    channels: {
      ...model.channels,
      [channel]: {
        ...newChannel(model.nextEpoch),
        entries: state.entries,
        visibleCount: state.visibleCount,
      },
    },
    nextEpoch: model.nextEpoch + 1,
  };
}

export function chatLogs(model: ChatHistoryModel): Record<string, LogEntry[]> {
  return Object.fromEntries(
    Object.entries(model.channels).map(([channel, state]) => [
      channel,
      state.entries.slice(-state.visibleCount),
    ])
  );
}
