import { normChannel } from './channel.ts';

type ConnectionTone = 'offline' | 'warning' | 'connecting' | 'connected';

interface ConnectionStatusInput {
  wsConnected: boolean;
  botAuthorized: boolean;
  botConnected: boolean;
  channels: readonly string[];
  joinedChannels: readonly string[];
  showSetupDetails?: boolean;
}

export function channelJoinControls(botAuthorized: boolean): { disabled: boolean; helper: string | null } {
  return botAuthorized
    ? { disabled: false, helper: null }
    : { disabled: true, helper: 'Authorize the bot account before joining channels.' };
}

export function connectionStatus({
  wsConnected,
  botAuthorized,
  botConnected,
  channels,
  joinedChannels,
  showSetupDetails = true,
}: ConnectionStatusInput): { tone: ConnectionTone; label: string } {
  if (!wsConnected) return { tone: 'offline', label: 'Offline' };
  if (!showSetupDetails) {
    return botConnected
      ? { tone: 'connected', label: 'Connected' }
      : { tone: 'connecting', label: 'Available' };
  }
  if (!botAuthorized) return { tone: 'warning', label: 'Setup required' };
  if (!botConnected) return { tone: 'connecting', label: 'Connecting…' };

  const configured = new Set(channels.map(normChannel));
  const joinedCount = new Set(joinedChannels.map(normChannel).filter(channel => configured.has(channel))).size;
  const configuredCount = configured.size;
  if (joinedCount < configuredCount) {
    return { tone: 'warning', label: `Connected · ${joinedCount} of ${configuredCount} channels` };
  }
  return {
    tone: 'connected',
    label: `Connected · ${joinedCount} channel${joinedCount === 1 ? '' : 's'}`,
  };
}
