export type MediaType = 'image' | 'video' | 'audio';
export type BadgeKind = 'broadcaster' | 'mod' | 'vip' | 'sub' | 'bits' | 'bot';
export type ChatEventKind = 'online' | 'offline' | 'raid' | 'sub' | 'gift' | 'cheer' | 'follow' | 'system';

export type LogEntry =
  | {
      kind: 'msg';
      id: string;
      time: string;
      user: string;
      text: string;
      color?: string;
      badges?: BadgeKind[];
      meta?: {
        twitchEmotesByName?: Record<string, string>;
        [key: string]: unknown;
      } | null;
    }
  | { kind: 'event'; id: string; time: string; event: ChatEventKind; text: string }
  | { kind: 'sep'; id: string; label: string };

export interface MediaItem {
  id: string;
  type: MediaType;
  src?: string;
  prompt: string;
  author: string;
  userId?: string | null;
  channel: string;
  timestamp?: number | string;
  minutesAgo: number;
  duration?: string;
  audioKind?: 'Music' | 'Voice' | 'SFX';
  avatarUrl?: string | null;
  badges?: BadgeKind[];
}

export interface RawMediaEntry {
  id: string;
  timestamp: number | string;
  channel: string;
  username: string;
  userId?: string | null;
  avatarUrl?: string | null;
  badges?: BadgeKind[];
  command?: string;
  prompt: string;
  mediaUrl: string;
  mediaType: 'image' | 'video' | 'tts' | 'music' | 'audio';
}

export interface RawChatEntry {
  id?: string;
  kind?: string;
  event?: ChatEventKind;
  text?: string;
  message?: string;
  time?: string;
  timestamp?: number | string;
  username?: string;
  user?: string;
  color?: string;
  badges?: BadgeKind[];
  meta?: {
    twitchEmotesByName?: Record<string, string>;
    [key: string]: unknown;
  } | null;
}

export interface ChannelInfo {
  id: string;
  name: string;
  msgs: string | number;
  linked: boolean;
  broadcaster?: string;
}

export interface ViewerInfo {
  authenticated: boolean;
  login?: string;
  displayName?: string;
  profileImageUrl?: string;
  isAdmin?: boolean;
}

export interface BotStatus {
  botUsername?: string;
  authorized?: boolean;
  connected?: boolean;
  channelStatuses?: Record<string, { authorized?: boolean }>;
  storageConfigured?: boolean;
}

export interface BotSettings {
  channels: string[];
  model_name: string;
  thinking_level: string;
  search_grounding: string;
  tavily_search_depth: string;
  cooldown_duration: number;
  ignored_usernames: string[];
  ai_history_length: number;
  chat_context_length: number;
  enable_helix_actions: boolean;
  helix_clip_cooldown_seconds: number;
  helix_default_timeout_seconds: number;
  enable_emote_appending: boolean;
  bot_command_name: string;
  highlight_bot_responses: boolean;
}

export type ConfigDomain = 'bot_settings' | 'system_instructions' | 'commands' | 'event_alerts' | 'error_messages';
export type CommandAccess = 'everyone' | 'subs' | 'vipmod' | 'mod';

export interface MediaCommandConfig {
  enabled: boolean;
  command: string;
  aliases: string[];
  model?: string;
  voice?: string;
  duration_cap?: number;
  access?: CommandAccess;
}

export interface CustomCommand {
  command: string;
  aliases: string[];
  response: string;
  role: 'all' | 'moderator' | 'broadcaster';
}

export interface CommandsConfig {
  media: {
    image: MediaCommandConfig;
    video: MediaCommandConfig;
    tts: MediaCommandConfig;
    music: MediaCommandConfig;
    access: CommandAccess;
  };
  custom: CustomCommand[];
}

export interface EventAlertConfig {
  enabled: boolean;
  ai_enabled: boolean;
  cooldown_seconds: number;
  fallback_template: string;
  ai_prompt: string;
  min_bits?: number;
  min_viewers?: number;
  rewards?: Record<string, { ai_enabled: boolean; fallback_template: string; ai_prompt?: string }>;
}

export type EventAlertsConfig = Record<string, EventAlertConfig>;
export type ErrorMessagesConfig = Record<string, string>;

export interface AllConfig {
  bot_settings: BotSettings;
  system_instructions: string;
  commands: CommandsConfig;
  event_alerts: EventAlertsConfig;
  error_messages: ErrorMessagesConfig;
  overrides?: Record<string, boolean>;
}

export interface PollinationsCatalog {
  image: { defaultModel: string; models: string[] };
  video: { defaultModel: string; models: string[] };
  tts: { defaultModel: string; defaultVoice: string; models: string[]; voices: Record<string, string[]> };
  music: { defaultModel: string; models: string[] };
}
