import { Bot, Settings2, LogIn, LogOut } from 'lucide-react';
import type { LogEntry, ViewerInfo } from '../lib/types';
import ChatPanel from './ChatPanel';
import Avatar from './Avatar';
import type { ChatChannelHistory } from '../lib/chatHistory';
import { connectionStatus } from '../lib/botStatusPresentation';

interface Props {
  botUsername?: string;
  botAuthorized?: boolean;
  botConnected: boolean;
  wsConnected: boolean;
  channels: string[];
  joinedChannels: string[];
  activeChannel: string;
  onSelectChannel: (c: string) => void;
  channelStatuses: Record<string, { authorized?: boolean }>;
  logs: Record<string, LogEntry[]>;
  histories: Record<string, ChatChannelHistory>;
  onLoadOlder: (channel: string) => void;
  viewer: ViewerInfo | null;
  onOpenSettings: () => void;
  onLogout: () => void;
}

export default function Sidebar({
  botUsername = 'Twitch Bot',
  botAuthorized = false,
  botConnected = false,
  wsConnected = false,
  channels,
  joinedChannels,
  activeChannel,
  onSelectChannel,
  channelStatuses,
  logs,
  histories,
  onLoadOlder,
  viewer,
  onOpenSettings,
  onLogout,
}: Props) {
  const cleanUsername = botUsername.replace(/^@/, '');
  const connection = connectionStatus({ wsConnected, botAuthorized, botConnected, channels, joinedChannels });
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {/* top — brand + live connection status */}
      <div className="flex shrink-0 items-center gap-2.5 border-b border-line px-3 py-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line bg-raised">
          <Bot size={16} className="text-accent" strokeWidth={2.2} />
        </div>
        <div className="min-w-0 leading-none">
          <div className="text-[14px] font-semibold text-ink truncate">{cleanUsername}</div>
          <div className="mt-1 flex items-center gap-1.5">
            {connection.tone === 'offline' ? (
              <>
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-rose-400" />
                <span className="text-[10.5px] text-muted">{connection.label}</span>
              </>
            ) : connection.tone === 'warning' ? (
              <>
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-400" />
                <span className="text-[10.5px] text-amber-400">{connection.label}</span>
              </>
            ) : connection.tone === 'connecting' ? (
              <>
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-400" />
                </span>
                <span className="text-[10.5px] text-muted">{connection.label}</span>
              </>
            ) : (
              <>
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                </span>
                <span className="text-[10.5px] text-muted">
                  {connection.label}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* middle — channel tabs + chat log */}
      <div className="min-h-0 flex-1">
        <ChatPanel
          channels={channels}
          joinedChannels={joinedChannels}
          activeChannel={activeChannel}
          onSelectChannel={onSelectChannel}
          channelStatuses={channelStatuses}
          logs={logs}
          histories={histories}
          onLoadOlder={onLoadOlder}
          botUsername={cleanUsername}
          botAuthorized={botAuthorized}
          onOpenSettings={onOpenSettings}
        />
      </div>

      {/* bottom — docked profile */}
      <div className="shrink-0 border-t border-line px-2 py-2">
        {viewer?.authenticated ? (
          <div className="flex items-center justify-between gap-1.5">
            <button
              onClick={viewer.isAdmin ? onOpenSettings : undefined}
              title={viewer.isAdmin ? 'Bot configuration' : `@${viewer.login}`}
              className={`flex flex-1 min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 transition-colors ${
                viewer.isAdmin ? 'cursor-pointer hover:bg-surface-2' : ''
              }`}
            >
              <Avatar name={viewer.displayName || viewer.login || 'Admin'} src={viewer.profileImageUrl} size={26} />
              <span className="min-w-0 truncate text-[12.5px] font-medium text-ink">
                {viewer.displayName || viewer.login}
              </span>
              {viewer.isAdmin && (
                <span className="rounded-full border border-accent/40 bg-accent/10 px-1.5 py-px text-[9px] font-semibold tracking-wider text-accent">
                  ADMIN
                </span>
              )}
            </button>
            <div className="flex items-center gap-0.5">
              {viewer.isAdmin && (
                <button
                  onClick={onOpenSettings}
                  title="Configure bot"
                  className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  <Settings2 size={14} />
                </button>
              )}
              <button
                onClick={onLogout}
                title="Sign out"
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <LogOut size={13} />
              </button>
            </div>
          </div>
        ) : (
          <a
            href="/auth/dashboard"
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[12px] font-medium text-ink transition-colors hover:bg-raised"
          >
            <LogIn size={13} className="text-accent" />
            Sign in with Twitch
          </a>
        )}
      </div>
    </div>
  );
}
