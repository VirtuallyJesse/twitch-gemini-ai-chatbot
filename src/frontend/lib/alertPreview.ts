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
  // Previews run before any channel is joined, so the only badge the bot can
  // guarantee is its global Chatbot badge - never an inferred Broadcaster one.
  return {
    channel: normChannel(channel.trim()),
    entry: {
      kind: 'msg',
      id: `preview-msg-${alertKey}`,
      order: 1,
      user: botUsername,
      text,
      time: '18:04',
      badges: [{ kind: 'bot-badge', version: '1' }],
    },
  };
}
