import type { LogEntry } from './types';
import { normChannel } from './channel.ts';

interface AlertPreviewInput {
  alertKey: string;
  botUsername: string;
  channel: string;
  text: string;
}

interface AlertPreviewMessage {
  channel: string;
  entry: Extract<LogEntry, { kind: 'msg' }>;
}

export function createAlertPreviewMessage({
  alertKey,
  botUsername,
  channel,
  text,
}: AlertPreviewInput): AlertPreviewMessage {
  const previewChannel = normChannel(channel.trim());
  const badgeKind = previewChannel === normChannel(botUsername.trim()) ? 'broadcaster' : 'bot-badge';

  return {
    channel: previewChannel,
    entry: {
      kind: 'msg',
      id: `preview-msg-${alertKey}`,
      order: 1,
      user: botUsername,
      text,
      time: '18:04',
      badges: [{ kind: badgeKind, version: '1' }],
    },
  };
}
