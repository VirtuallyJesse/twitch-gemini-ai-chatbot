import type {
  AllConfig,
  BotStatus,
  ChannelBadgeCatalog,
  ConfigDomain,
  PollinationsCatalog,
  RawChatHistoryPage,
  RawMediaEntry,
  ViewerInfo,
} from './types';
import { normChannel } from './channel';
import type { EmoteProvider } from './emotes';
import type { AvatarIdentity, AvatarLookupResult } from './avatars';

class ApiClient {
  private async request<T>(url: string, options?: RequestInit): Promise<T> {
    const res = await fetch(url, {
      ...options,
      headers: {
        'Accept': 'application/json',
        ...options?.headers,
      },
    });

    if (!res.ok) {
      let errMessage = `HTTP error ${res.status}`;
      try {
        const body = await res.json();
        if (body?.message) errMessage = body.message;
        else if (body?.error) errMessage = body.error;
      } catch {
        // use default error message
      }
      throw new Error(errMessage);
    }

    return res.json();
  }

  async getViewer(): Promise<ViewerInfo> {
    return this.request<ViewerInfo>('/api/me');
  }

  async getStatus(): Promise<BotStatus> {
    return this.request<BotStatus>('/api/status');
  }

  async getChannels(): Promise<string[]> {
    return this.request<string[]>('/api/channels');
  }

  async getChannelStatuses(): Promise<Record<string, { authorized?: boolean; linked?: boolean; needsRelink?: boolean }>> {
    return this.request<Record<string, { authorized?: boolean; linked?: boolean; needsRelink?: boolean }>>('/api/channel-status');
  }

  async getChatPage(channel: string, cursor: string | null = null): Promise<RawChatHistoryPage> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.request<RawChatHistoryPage>(`/api/chat/${normChannel(channel)}${query}`);
  }

  async getMedia(): Promise<RawMediaEntry[]> {
    return this.request<RawMediaEntry[]>('/api/media');
  }

  async getEmotes(channel: string): Promise<Record<string, string | { url?: string; provider?: EmoteProvider }>> {
    return this.request<Record<string, string | { url?: string; provider?: EmoteProvider }>>(`/api/emotes/${normChannel(channel)}`);
  }

  async getBadges(channel: string): Promise<ChannelBadgeCatalog> {
    return this.request<ChannelBadgeCatalog>(`/api/badges/${normChannel(channel)}`);
  }

  async getConfig(): Promise<AllConfig> {
    return this.request<AllConfig>('/api/config');
  }

  async saveConfig<T = unknown>(type: ConfigDomain, value: T): Promise<{ type: ConfigDomain; value: T; override: boolean }> {
    return this.request<{ type: ConfigDomain; value: T; override: boolean }>(`/api/config/${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
  }

  async resetConfig<T = unknown>(type: ConfigDomain): Promise<{ type: ConfigDomain; value: T; override: boolean }> {
    return this.request<{ type: ConfigDomain; value: T; override: boolean }>(`/api/config/${type}/reset`, {
      method: 'POST',
    });
  }

  async getDefaults<T = unknown>(type: ConfigDomain): Promise<{ type: ConfigDomain; value: T }> {
    return this.request<{ type: ConfigDomain; value: T }>(`/api/config/defaults/${type}`);
  }

  async getPollinationsModels(): Promise<PollinationsCatalog> {
    return this.request<PollinationsCatalog>('/api/models/pollinations');
  }

  async getAvatars(
    identities: readonly AvatarIdentity[],
    signal?: AbortSignal
  ): Promise<{ results: AvatarLookupResult[] }> {
    if (identities.length === 0) return { results: [] };
    if (identities.length > 100) throw new Error('AVATAR_LOOKUP_LIMIT_EXCEEDED');
    return this.request<{ results: AvatarLookupResult[] }>('/api/users/avatars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identities }),
      signal,
    });
  }

  async testAlertReply(params: {
    eventKind: string;
    prompt: string;
    personaOverride?: string;
  }): Promise<{ ok: boolean; reply: string }> {
    return this.request<{ ok: boolean; reply: string }>('/api/alerts/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  }

  async logout(): Promise<void> {
    await fetch('/auth/logout', { method: 'POST' });
  }
}

export const api = new ApiClient();
