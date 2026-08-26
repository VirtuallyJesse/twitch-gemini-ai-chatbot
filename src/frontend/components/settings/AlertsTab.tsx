import { useRef, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import type { ConfigIntent } from '../../config/ConfigEditor';
import type { ChatEventKind, EventAlertConfig, EventAlertsConfig } from '../../lib/types';
import { api } from '../../lib/api';
import { createAlertPreviewMessage } from '../../lib/alertPreview';
import { EventRow, MsgRow } from '../ChatPanel';
import TokenInput from '../TokenInput';
import { FieldRow, inputCls, ResetTabButton, Toggle } from './SettingsPrimitives';

const EVENT_TOKENS: Record<string, string[]> = {
  subscription: ['{username}', '{tier}'],
  resub: ['{username}', '{tier}', '{months}', '{streak}', '{message}'],
  sub_gift: ['{username}', '{recipient}', '{tier}'],
  community_sub_gift: ['{username}', '{count}', '{tier}'],
  cheer: ['{username}', '{bits}', '{message}'],
  raid: ['{username}', '{viewers}'],
  follow: ['{username}'],
  channel_points: ['{username}', '{reward}', '{user_input}'],
};

const ALERT_LABELS: Record<string, string> = {
  subscription: 'Subs', resub: 'Resubs', sub_gift: 'Gifted subs', community_sub_gift: 'Community gifts',
  cheer: 'Cheers', raid: 'Raids', follow: 'Follows', channel_points: 'Channel points',
};

const SAMPLE_ALERT_DATA: Record<string, { event: ChatEventKind; eventText: string; vars: Record<string, string | number> }> = {
  subscription: { event: 'sub', eventText: 'CoolViewer subscribed at Tier 1', vars: { username: 'CoolViewer', tier: 'Tier 1' } },
  resub: { event: 'sub', eventText: 'DriftKing subscribed at Tier 1 · 7 month streak', vars: { username: 'DriftKing', tier: 'Tier 1', months: 7, streak: 7, message: 'fox supremacy' } },
  sub_gift: { event: 'gift', eventText: 'GenerousGiver gifted a Tier 1 sub to LuckyViewer', vars: { username: 'GenerousGiver', recipient: 'LuckyViewer', tier: 'Tier 1' } },
  community_sub_gift: { event: 'gift', eventText: 'QuantumQueen gifted 5 subs to the community', vars: { username: 'QuantumQueen', count: 5, tier: 'Tier 1' } },
  cheer: { event: 'cheer', eventText: 'HypeMaster cheered 500 bits: Keep up the great work!', vars: { username: 'HypeMaster', bits: 500, message: 'Keep up the great work!' } },
  raid: { event: 'raid', eventText: 'StreamerFriend raided with 42 viewers', vars: { username: 'StreamerFriend', viewers: 42 } },
  follow: { event: 'follow', eventText: 'NewFriend followed the channel', vars: { username: 'NewFriend' } },
  channel_points: { event: 'system', eventText: 'PointSpender redeemed Hydrate', vars: { username: 'PointSpender', reward: 'Hydrate', user_input: 'Drink some water!' } },
};

function interpolateTokens(template: string, vars: Record<string, string | number>): string {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => vars[key] != null ? String(vars[key]) : `{${key}}`);
}

interface Props {
  value: EventAlertsConfig;
  persona: string;
  botUsername: string;
  activeChannel: string;
  highlightBots: boolean;
  busy: boolean;
  dispatch: (intent: ConfigIntent) => void;
}

export default function AlertsTab({ value, persona, botUsername, activeChannel, highlightBots, busy, dispatch }: Props) {
  const [selectedAlert, setSelectedAlert] = useState('subscription');
  const [testing, setTesting] = useState(false);
  const [testReplies, setTestReplies] = useState<Record<string, string>>({});
  const [testErrors, setTestErrors] = useState<Record<string, string>>({});
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const active = value[selectedAlert];

  const patch = (next: Partial<EventAlertConfig>) => dispatch({ type: 'alert.changed', alert: selectedAlert, patch: next });
  const insertToken = (field: 'ai_prompt' | 'fallback_template', token: string) => {
    if (!active) return;
    const input = field === 'ai_prompt' ? promptRef.current : fallbackRef.current;
    const current = active[field] || '';
    const start = input?.selectionStart ?? current.length;
    const end = input?.selectionEnd ?? current.length;
    const next = `${current.slice(0, start)}${token}${current.slice(end)}`;
    patch({ [field]: next });
    setTimeout(() => {
      input?.focus();
      input?.setSelectionRange(start + token.length, start + token.length);
    }, 0);
  };
  const testAiReply = async () => {
    if (!active?.ai_prompt?.trim()) return;
    setTesting(true);
    setTestErrors((previous) => ({ ...previous, [selectedAlert]: '' }));
    try {
      const result = await api.testAlertReply({ eventKind: selectedAlert, prompt: active.ai_prompt, personaOverride: persona || undefined });
      if (result?.reply) setTestReplies((previous) => ({ ...previous, [selectedAlert]: result.reply }));
    } catch (error) {
      setTestErrors((previous) => ({ ...previous, [selectedAlert]: error instanceof Error ? error.message : 'AI test reply failed' }));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5 pb-1">
        {Object.keys(value).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setSelectedAlert(key)}
            className={`flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${selectedAlert === key ? 'border border-accent/40 bg-accent/15 text-accent shadow-xs' : 'border border-line bg-bg text-muted hover:border-line-soft hover:text-ink'}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${value[key]?.enabled ? 'bg-emerald-400' : 'bg-faint/60'}`} />
            <span>{ALERT_LABELS[key] || key.replace(/_/g, ' ')}</span>
          </button>
        ))}
      </div>

      {active && (() => {
        const sample = SAMPLE_ALERT_DATA[selectedAlert] || SAMPLE_ALERT_DATA.subscription;
        const fallbackText = interpolateTokens(active.fallback_template || '', sample.vars);
        const testReply = testReplies[selectedAlert];
        const currentBotName = (botUsername || 'Twitch Bot').replace(/^@/, '');
        const tokens = EVENT_TOKENS[selectedAlert] || ['{username}'];
        const preview = createAlertPreviewMessage({
          alertKey: selectedAlert,
          botUsername: currentBotName,
          channel: activeChannel,
          text: active.ai_enabled && testReply ? testReply : fallbackText || '…',
        });
        return (
          <div className="space-y-4 pt-1">
            <div className={`flex items-center justify-between pb-3 ${active.enabled ? 'border-b border-line/30' : ''}`}>
              <div className="text-[13px] font-semibold text-ink">{ALERT_LABELS[selectedAlert] || selectedAlert.replace(/_/g, ' ')}</div>
              <Toggle on={active.enabled} onChange={(enabled) => patch({ enabled })} />
            </div>
            {active.enabled && (
              <>
                <div className="space-y-1.5 rounded-lg border border-line/60 bg-surface/60 p-3">
                  <div className="flex items-center justify-between pb-1">
                    <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.14em] text-faint">Live chat preview</span>
                    {active.ai_enabled && testReply && <span className="font-mono text-[9.5px] text-accent flex items-center gap-1"><Sparkles size={10} /> AI test reply</span>}
                  </div>
                  <EventRow entry={{ kind: 'event', id: `preview-event-${selectedAlert}`, order: 1, event: sample.event, text: sample.eventText, time: '18:03' }} />
                  {testing ? (
                    <div className="my-1 flex items-center gap-2 rounded-r-md border-l-2 border-accent bg-accent/[0.06] py-1.5 pl-2.5 pr-2 text-[12px] text-accent animate-pulse"><Loader2 size={13} className="animate-spin text-accent shrink-0" /><span>Generating reply…</span></div>
                  ) : (
                    <MsgRow entry={preview.entry} channel={preview.channel} botUsername={currentBotName} highlightBots={highlightBots} />
                  )}
                  {testErrors[selectedAlert] && <div className="mt-1 text-[11px] text-red-400">{testErrors[selectedAlert]}</div>}
                </div>

                <FieldRow label="AI reply" hint="The bot writes each greeting itself"><Toggle on={active.ai_enabled} onChange={(ai_enabled) => patch({ ai_enabled })} /></FieldRow>
                {active.ai_enabled && (
                  <div className="py-2.5 border-b border-line/30">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="text-[12.5px] font-medium text-ink">AI prompt</div>
                      <span className="font-mono text-[10.5px] text-faint">{(active.ai_prompt || '').length} / 1,000 chars</span>
                    </div>
                    <TokenInput inputRef={promptRef} value={active.ai_prompt || ''} onChange={(next) => patch({ ai_prompt: next.slice(0, 1000) })} placeholder="How should the bot greet them?" maxLength={1000} />
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {tokens.map((token) => <button key={token} type="button" onClick={() => insertToken('ai_prompt', token)} className="cursor-pointer rounded border border-line bg-bg px-2 py-0.5 font-mono text-[11px] font-medium text-accent transition hover:border-accent/50 hover:bg-accent/10">+ {token}</button>)}
                      </div>
                      <button type="button" disabled={testing || !active.ai_prompt.trim()} onClick={testAiReply} className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-accent/40 bg-accent/15 px-2.5 py-1 text-[11px] font-semibold text-accent transition hover:bg-accent/25 disabled:opacity-50">
                        {testing ? <><Loader2 size={12} className="animate-spin" />Testing…</> : <><Sparkles size={12} />Test AI reply</>}
                      </button>
                    </div>
                  </div>
                )}

                <div className="py-2.5 border-b border-line/30">
                  <div className="flex items-center justify-between mb-1.5">
                    <div><div className="text-[12.5px] font-medium text-ink">Backup message</div><div className="text-[11px] text-muted">Sent when AI replies are off or fail</div></div>
                    <span className="font-mono text-[10.5px] text-faint">{(active.fallback_template || '').length} / 450 chars</span>
                  </div>
                  <TokenInput inputRef={fallbackRef} value={active.fallback_template || ''} onChange={(next) => patch({ fallback_template: next.slice(0, 450) })} placeholder="Welcome, {username}!" maxLength={450} />
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {tokens.map((token) => <button key={token} type="button" onClick={() => insertToken('fallback_template', token)} className="cursor-pointer rounded border border-line bg-bg px-2 py-0.5 font-mono text-[11px] font-medium text-accent transition hover:border-accent/50 hover:bg-accent/10">+ {token}</button>)}
                  </div>
                </div>

                <FieldRow label="Cooldown (sec)" noBorder={!['cheer', 'raid', 'sub_gift'].includes(selectedAlert)}>
                  <input type="number" min={0} max={3600} value={active.cooldown_seconds ?? 0} onChange={(event) => patch({ cooldown_seconds: Math.max(0, parseInt(event.target.value, 10) || 0) })} className={`w-24 ${inputCls}`} />
                </FieldRow>
                {selectedAlert === 'cheer' && <FieldRow label="Minimum bits threshold" noBorder><input type="number" min={0} value={active.min_bits ?? 100} onChange={(event) => patch({ min_bits: Math.max(0, parseInt(event.target.value, 10) || 0) })} className={`w-24 ${inputCls}`} /></FieldRow>}
                {selectedAlert === 'raid' && <FieldRow label="Minimum viewers threshold" noBorder><input type="number" min={1} value={active.min_viewers ?? 1} onChange={(event) => patch({ min_viewers: Math.max(1, parseInt(event.target.value, 10) || 1) })} className={`w-24 ${inputCls}`} /></FieldRow>}
                <ResetTabButton onReset={() => dispatch({ type: 'domain.reset', domain: 'event_alerts' })} disabled={busy} />
              </>
            )}
          </div>
        );
      })()}
    </div>
  );
}

