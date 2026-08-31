import type { ConfigIntent } from '../../config/ConfigEditor';
import type { StreamActionsSettings } from '../../lib/types';
import { FieldRow, inputCls, ResetTabButton, SectionTitle, Toggle } from './SettingsPrimitives';

interface Props {
  value: StreamActionsSettings;
  busy: boolean;
  dispatch: (intent: ConfigIntent) => void;
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
  busy,
  dispatch,
}: Props) {
  const change = <K extends keyof StreamActionsSettings>(field: K, next: StreamActionsSettings[K]) => {
    dispatch({ type: 'stream-action.changed', field, value: next });
  };

  return (
    <div className="space-y-4">
      <SectionTitle>Stream actions</SectionTitle>
      <FieldRow label="Stream actions" hint="Let chat trigger Twitch actions" noBorder={!value.enabled}>
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

          <ResetTabButton onReset={() => dispatch({ type: 'domain.reset', domain: 'stream_actions' })} disabled={busy} />
        </>
      )}
    </div>
  );
}
