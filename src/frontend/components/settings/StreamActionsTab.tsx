import { Link } from 'lucide-react';
import type { ConfigIntent } from '../../config/ConfigEditor';
import type { StreamActionsSettings } from '../../lib/types';
import { channelLabel } from '../../lib/channel';
import { FieldRow, inputCls, ResetTabButton, SectionTitle, Toggle } from './SettingsPrimitives';

interface ChannelStatus {
  authorized?: boolean;
  linked?: boolean;
  needsRelink?: boolean;
}

interface Props {
  value: StreamActionsSettings;
  channels: string[];
  channelStatuses: Record<string, ChannelStatus>;
  busy: boolean;
  dispatch: (intent: ConfigIntent) => void;
  onAuthorizeBroadcaster: (channel: string) => void;
  onOpenConfiguration: () => void;
}

const FAMILY_ROWS: Array<{ field: keyof StreamActionsSettings; label: string; hint: string }> = [
  { field: 'stream_setup_enabled', label: 'Stream setup', hint: 'Update title or category, or add a stream marker.' },
  { field: 'moderation_enabled', label: 'Moderation', hint: 'Timeout, ban, or unban chatters.' },
  { field: 'chat_access_enabled', label: 'Chat access', hint: 'Emote-only, sub-only, or followers-only chat.' },
  { field: 'community_enabled', label: 'Community', hint: 'Announcements, shoutouts, and raids.' },
  { field: 'polls_predictions_enabled', label: 'Polls & predictions', hint: 'Polls and Channel Points predictions.' },
];

export default function StreamActionsTab({
  value,
  channels,
  channelStatuses,
  busy,
  dispatch,
  onAuthorizeBroadcaster,
  onOpenConfiguration,
}: Props) {
  const change = <K extends keyof StreamActionsSettings>(field: K, next: StreamActionsSettings[K]) => {
    dispatch({ type: 'stream-action.changed', field, value: next });
  };

  return (
    <div className="space-y-4">
      <SectionTitle>Stream Actions</SectionTitle>
      <FieldRow label="Stream Actions" hint="Let chat trigger Twitch actions" noBorder={!value.enabled}>
        <Toggle on={value.enabled} onChange={(next) => change('enabled', next)} />
      </FieldRow>

      {value.enabled && (
        <>
          <SectionTitle>Broadcaster & moderators</SectionTitle>
          {FAMILY_ROWS.map(({ field, label, hint }) => (
            <FieldRow key={field} label={label} hint={hint}>
              <Toggle on={Boolean(value[field])} onChange={(next) => change(field, next)} />
            </FieldRow>
          ))}

          <SectionTitle>Everyone</SectionTitle>
          <FieldRow label="Viewer clips" hint="Anyone can ask for a clip" noBorder={!value.viewer_clips_enabled}>
            <Toggle on={value.viewer_clips_enabled} onChange={(next) => change('viewer_clips_enabled', next)} />
          </FieldRow>
          {value.viewer_clips_enabled && (
            <div className="pl-4">
              <FieldRow label="Clip cooldown (sec)" hint="Shares the last clip again within this time" noBorder>
                <input
                  type="number"
                  min={0}
                  max={300}
                  value={value.clip_cooldown_seconds}
                  onChange={(event) => change('clip_cooldown_seconds', Math.min(300, Math.max(0, Number.parseInt(event.target.value, 10) || 0)))}
                  className={`w-24 ${inputCls}`}
                />
              </FieldRow>
            </div>
          )}

          <SectionTitle>Channel access</SectionTitle>
          {channels.length === 0 ? (
            <p className="py-2 text-[11.5px] text-muted">
              No channels joined.{' '}
              <button type="button" onClick={onOpenConfiguration} className="cursor-pointer font-medium text-accent hover:underline">
                Add a channel in Configuration first.
              </button>
            </p>
          ) : channels.map((channel) => {
            const status = channelStatuses[channel] ?? channelStatuses[`#${channel}`] ?? {};
            const label = status.needsRelink ? 'Relink' : status.authorized ? 'Linked' : 'Link';
            return (
              <FieldRow key={channel} label={channelLabel(channel)}>
                {status.authorized ? (
                  <span className="rounded bg-emerald-400/10 px-2 py-1 text-[10px] font-semibold text-emerald-400">Linked</span>
                ) : (
                  <button type="button" onClick={() => onAuthorizeBroadcaster(channel)} className="flex cursor-pointer items-center gap-1 rounded bg-amber-400/10 px-2 py-1 text-[10px] font-semibold text-amber-400 hover:bg-amber-400/20">
                    <Link size={10} /> {label}
                  </button>
                )}
              </FieldRow>
            );
          })}

          <ResetTabButton onReset={() => dispatch({ type: 'domain.reset', domain: 'stream_actions' })} disabled={busy} />
        </>
      )}
    </div>
  );
}
