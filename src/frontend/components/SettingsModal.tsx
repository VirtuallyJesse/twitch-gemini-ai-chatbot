import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  X,
  Plus,
  Check,
  Sliders,
  Sparkles,
  Terminal,
  Bell,
  AlertTriangle,
  RotateCcw,
  Link,
  Trash2,
  Loader2,
  Lightbulb,
  Image as ImageIcon,
  Clapperboard,
  Mic,
  Music2,
} from 'lucide-react';
import type {
  AllConfig,
  BotSettings,
  ChatEventKind,
  CommandAccess,
  CommandsConfig,
  ConfigDomain,
  CustomCommand,
  EventAlertConfig,
  EventAlertsConfig,
  MediaCommandConfig,
  PollinationsCatalog,
} from '../lib/types';
import { api } from '../lib/api';
import { setBotHighlight, useBotHighlight } from '../lib/settings';
import { channelLabel, normChannel } from '../lib/channel';
import { EventRow, MsgRow } from './ChatPanel';
import TokenInput from './TokenInput';

interface Props {
  open: boolean;
  onClose: () => void;
  botUsername?: string;
  channelStatuses: Record<string, { authorized?: boolean }>;
  onChannelsChange?: (channels: string[]) => void;
}

type TabKey = 'config' | 'persona' | 'commands' | 'alerts' | 'errors';

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
  subscription: 'Subs',
  resub: 'Resubs',
  sub_gift: 'Gifted subs',
  community_sub_gift: 'Community gifts',
  cheer: 'Cheers',
  raid: 'Raids',
  follow: 'Follows',
  channel_points: 'Channel points',
};

const SAMPLE_ALERT_DATA: Record<
  string,
  { event: ChatEventKind; eventText: string; vars: Record<string, string | number> }
> = {
  subscription: {
    event: 'sub',
    eventText: 'CoolViewer subscribed at Tier 1',
    vars: { username: 'CoolViewer', tier: 'Tier 1' },
  },
  resub: {
    event: 'sub',
    eventText: 'DriftKing subscribed at Tier 1 · 7 month streak',
    vars: { username: 'DriftKing', tier: 'Tier 1', months: 7, streak: 7, message: 'fox supremacy' },
  },
  sub_gift: {
    event: 'gift',
    eventText: 'GenerousGiver gifted a Tier 1 sub to LuckyViewer',
    vars: { username: 'GenerousGiver', recipient: 'LuckyViewer', tier: 'Tier 1' },
  },
  community_sub_gift: {
    event: 'gift',
    eventText: 'QuantumQueen gifted 5 subs to the community',
    vars: { username: 'QuantumQueen', count: 5, tier: 'Tier 1' },
  },
  cheer: {
    event: 'cheer',
    eventText: 'HypeMaster cheered 500 bits: Keep up the great work!',
    vars: { username: 'HypeMaster', bits: 500, message: 'Keep up the great work!' },
  },
  raid: {
    event: 'raid',
    eventText: 'StreamerFriend raided with 42 viewers',
    vars: { username: 'StreamerFriend', viewers: 42 },
  },
  follow: {
    event: 'follow',
    eventText: 'NewFriend followed the channel',
    vars: { username: 'NewFriend' },
  },
  channel_points: {
    event: 'system',
    eventText: 'PointSpender redeemed Hydrate',
    vars: { username: 'PointSpender', reward: 'Hydrate', user_input: 'Drink some water!' },
  },
};

function interpolateTokens(template: string, vars: Record<string, string | number>): string {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => {
    const val = vars[key];
    return val != null ? String(val) : `{${key}}`;
  });
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      type="button"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors ${
        on ? 'bg-accent' : 'bg-raised'
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-ink transition-all ${
          on ? 'left-[18px]' : 'left-0.5'
        }`}
      />
    </button>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
      {children}
    </h3>
  );
}

function ResetTabButton({ onReset, disabled }: { onReset: () => void; disabled?: boolean }) {
  return (
    <div className="pt-6 pb-2 border-t border-line/20 flex justify-start">
      <button
        type="button"
        onClick={onReset}
        disabled={disabled}
        className="flex cursor-pointer items-center gap-1.5 text-[11.5px] font-medium text-faint hover:text-ink transition-colors disabled:opacity-50"
      >
        <RotateCcw size={11} />
        Reset tab to defaults
      </button>
    </div>
  );
}

function FieldRow({ label, hint, noBorder, children }: { label: string; hint?: string; noBorder?: boolean; children: React.ReactNode }) {
  return (
    <div className={`flex items-center justify-between gap-4 py-2 ${noBorder ? '' : 'border-b border-line/30'} last:border-0`}>
      <div className="min-w-0">
        <div className="text-[12.5px] font-medium text-ink">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] text-muted">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

const inputCls =
  'rounded-md border border-line bg-bg px-2.5 py-1.5 text-[12px] text-ink placeholder-faint outline-none focus:border-accent/60';
const selectCls =
  'cursor-pointer rounded-md border border-line bg-bg px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent/60';

/* Command + Aliases editors for a generative media card. Aliases keep a raw
   draft while focused so commas survive typing, then parse on blur. */
function CommandAliasFields({
  command,
  aliases,
  onCommandChange,
  onAliasesChange,
}: {
  command: string;
  aliases: string[];
  onCommandChange: (v: string) => void;
  onAliasesChange: (list: string[]) => void;
}) {
  const [aliasDraft, setAliasDraft] = useState<string | null>(null);
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-[11.5px] font-medium text-muted">Command</span>
        <input
          value={command}
          onChange={(e) => onCommandChange(e.target.value)}
          className={`w-24 font-mono ${inputCls}`}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[11.5px] font-medium text-muted">Aliases</span>
        <input
          value={aliasDraft ?? aliases.join(', ')}
          onFocus={() => setAliasDraft(aliases.join(', '))}
          onChange={(e) => setAliasDraft(e.target.value)}
          onBlur={() => {
            if (aliasDraft !== null) {
              onAliasesChange(
                aliasDraft.split(',').map((a) => a.trim().toLowerCase().slice(0, 32)).filter(Boolean)
              );
            }
            setAliasDraft(null);
          }}
          placeholder="!alias1, !alias2"
          className={`w-36 ${inputCls}`}
        />
      </div>
    </>
  );
}

function MediaCardTitle({ icon, noun }: { icon: React.ReactNode; noun: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
      {icon}
      {noun}
    </div>
  );
}

type MediaCommandKey = 'image' | 'video' | 'tts' | 'music';

const ACCESS_OPTIONS: { value: CommandAccess; label: string }[] = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'subs', label: 'Subs, VIPs & Mods' },
  { value: 'vipmod', label: 'VIPs & Mods' },
  { value: 'mod', label: 'Mods Only' },
];

function LabeledSelect({ label, value, onChange, children }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11.5px] font-medium text-muted">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={selectCls}>
        {children}
      </select>
    </div>
  );
}

/* One generative media command card. onPatch merges into that command's
   config; pass save=false for draft-only edits (command/aliases fields).
   modelPatch lets a card pair extra fields with a model switch (TTS voice). */
function MediaCommandCard({
  icon,
  noun,
  config,
  models,
  fallbackModel,
  onPatch,
  modelPatch,
  last = false,
  children,
}: {
  icon: React.ReactNode;
  noun: string;
  config: MediaCommandConfig;
  models?: string[];
  fallbackModel: string;
  onPatch: (patch: Partial<MediaCommandConfig>, save?: boolean) => void;
  modelPatch?: (model: string) => Partial<MediaCommandConfig>;
  last?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={`py-2.5 border-b border-line/30${last ? ' last:border-0' : ''}`}>
      <div className="flex items-center justify-between">
        <MediaCardTitle icon={icon} noun={noun} />
        <Toggle on={config.enabled} onChange={(v) => onPatch({ enabled: v })} />
      </div>
      {config.enabled && (
        <div className="mt-2.5 flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-3">
            <CommandAliasFields
              command={config.command}
              aliases={Array.isArray(config.aliases) ? config.aliases : []}
              onCommandChange={(v) => onPatch({ command: v }, false)}
              onAliasesChange={(list) => onPatch({ aliases: list }, false)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <LabeledSelect
              label="Model"
              value={config.model || fallbackModel}
              onChange={(m) => onPatch(modelPatch ? modelPatch(m) : { model: m })}
            >
              {(models || [fallbackModel]).map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </LabeledSelect>
            {children}
            <LabeledSelect
              label="Access"
              value={config.access || 'everyone'}
              onChange={(access) => onPatch({ access: access as CommandAccess })}
            >
              {ACCESS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </LabeledSelect>
          </div>
        </div>
      )}
    </div>
  );
}

let errorsGateUnlockedSession = false;

export default function SettingsModal({
  open,
  onClose,
  botUsername = 'Twitch Bot',
  channelStatuses,
  onChannelsChange,
}: Props) {
  const highlightBots = useBotHighlight();
  const [activeTab, setActiveTab] = useState<TabKey>('config');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [errorsUnlocked, setErrorsUnlockedState] = useState(errorsGateUnlockedSession);

  const handleUnlockErrors = () => {
    errorsGateUnlockedSession = true;
    setErrorsUnlockedState(true);
  };

  // 5-domain state
  const [serverConfig, setServerConfig] = useState<AllConfig | null>(null);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [botSettings, setBotSettings] = useState<BotSettings | null>(null);
  const [persona, setPersona] = useState<string>('');
  const [commands, setCommands] = useState<CommandsConfig | null>(null);
  const [alerts, setAlerts] = useState<EventAlertsConfig | null>(null);
  const [errorMessages, setErrorMessages] = useState<Record<string, string>>({});
  const [pollinations, setPollinations] = useState<PollinationsCatalog | null>(null);

  const [newChannelInput, setNewChannelInput] = useState('');
  const [newIgnoredUserInput, setNewIgnoredUserInput] = useState('');
  const [errorFilter, setErrorFilter] = useState('');
  const [selectedAlertKey, setSelectedAlertKey] = useState('subscription');

  const promptRef = useRef<HTMLTextAreaElement>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const [testingAiAlert, setTestingAiAlert] = useState(false);
  const [aiTestReplies, setAiTestReplies] = useState<Record<string, string>>({});
  const [aiTestErrors, setAiTestErrors] = useState<Record<string, string>>({});

  // Dirty state checks
  const isConfigDirty = useMemo(() => {
    if (!serverConfig || !botSettings) return false;
    return JSON.stringify(botSettings) !== JSON.stringify(serverConfig.bot_settings);
  }, [serverConfig, botSettings]);

  const isPersonaDirty = useMemo(() => {
    if (!serverConfig) return false;
    return persona !== (serverConfig.system_instructions || '');
  }, [serverConfig, persona]);

  const isCommandsDirty = useMemo(() => {
    if (!serverConfig || !commands) return false;
    return JSON.stringify(commands) !== JSON.stringify(serverConfig.commands);
  }, [serverConfig, commands]);

  const isAlertsDirty = useMemo(() => {
    if (!serverConfig || !alerts) return false;
    return JSON.stringify(alerts) !== JSON.stringify(serverConfig.event_alerts);
  }, [serverConfig, alerts]);

  const isErrorsDirty = useMemo(() => {
    if (!serverConfig || !errorMessages) return false;
    return JSON.stringify(errorMessages) !== JSON.stringify(serverConfig.error_messages || {});
  }, [serverConfig, errorMessages]);

  const isCurrentTabDirty = useMemo(() => {
    if (activeTab === 'config') return isConfigDirty;
    if (activeTab === 'persona') return isPersonaDirty;
    if (activeTab === 'commands') return isCommandsDirty;
    if (activeTab === 'alerts') return isAlertsDirty;
    if (activeTab === 'errors') return isErrorsDirty;
    return false;
  }, [activeTab, isConfigDirty, isPersonaDirty, isCommandsDirty, isAlertsDirty, isErrorsDirty]);

  const isAnyDirty = isConfigDirty || isPersonaDirty || isCommandsDirty || isAlertsDirty || isErrorsDirty;

  const insertTokenIntoField = (field: 'ai_prompt' | 'fallback_template', token: string) => {
    if (!alerts || !alerts[selectedAlertKey]) return;
    const inputEl = field === 'ai_prompt' ? promptRef.current : fallbackRef.current;
    const currentVal = alerts[selectedAlertKey][field] || '';
    let nextVal = '';
    let nextCursor = 0;

    if (inputEl) {
      const start = inputEl.selectionStart ?? currentVal.length;
      const end = inputEl.selectionEnd ?? currentVal.length;
      const before = currentVal.slice(0, start);
      const after = currentVal.slice(end);
      nextVal = `${before}${token}${after}`;
      nextCursor = start + token.length;
    } else {
      nextVal = currentVal ? `${currentVal} ${token}` : token;
      nextCursor = nextVal.length;
    }

    setAlerts({
      ...alerts,
      [selectedAlertKey]: {
        ...alerts[selectedAlertKey],
        [field]: nextVal,
      },
    });

    setTimeout(() => {
      if (inputEl) {
        inputEl.focus();
        inputEl.setSelectionRange(nextCursor, nextCursor);
      }
    }, 0);
  };

  const handleTestAiReply = async () => {
    if (!alerts || !alerts[selectedAlertKey]) return;
    const cfg = alerts[selectedAlertKey];
    const prompt = cfg.ai_prompt || '';
    if (!prompt.trim()) return;

    setTestingAiAlert(true);
    setAiTestErrors((prev) => ({ ...prev, [selectedAlertKey]: '' }));
    try {
      const res = await api.testAlertReply({
        eventKind: selectedAlertKey,
        prompt,
        personaOverride: persona || undefined,
      });
      if (res?.reply) {
        setAiTestReplies((prev) => ({ ...prev, [selectedAlertKey]: res.reply }));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'AI test reply failed';
      setAiTestErrors((prev) => ({ ...prev, [selectedAlertKey]: msg }));
    } finally {
      setTestingAiAlert(false);
    }
  };

  const handleRequestClose = () => {
    if (isAnyDirty) {
      setShowExitConfirm(true);
    } else {
      onClose();
    }
  };

  const handleConfirmExit = () => {
    setShowExitConfirm(false);
    if (serverConfig) {
      setBotSettings(structuredClone(serverConfig.bot_settings));
      setPersona(serverConfig.system_instructions || '');
      setCommands(structuredClone(serverConfig.commands));
      setAlerts(structuredClone(serverConfig.event_alerts));
      setErrorMessages(structuredClone(serverConfig.error_messages || {}));
    }
    onClose();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showExitConfirm) {
          setShowExitConfirm(false);
        } else {
          handleRequestClose();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, isAnyDirty, showExitConfirm]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setErrorMsg('');
    setShowExitConfirm(false);
    Promise.allSettled([
      api.getConfig(),
      api.getPollinationsModels(),
    ]).then(([configRes, polliRes]) => {
      if (configRes.status === 'fulfilled') {
        const c: AllConfig = configRes.value;
        let bs = c.bot_settings;
        if (bs && !Array.isArray(bs.channels)) {
          const fallbackChans = Object.keys(channelStatuses)
            .map(normChannel)
            .filter(Boolean);
          if (fallbackChans.length > 0) {
            bs = { ...bs, channels: fallbackChans };
          }
        }
        const initial: AllConfig = {
          ...c,
          bot_settings: bs,
          system_instructions: c.system_instructions || '',
          commands: c.commands,
          event_alerts: c.event_alerts,
          error_messages: c.error_messages || {},
        };
        setServerConfig(initial);
        setBotSettings(bs);
        setPersona(c.system_instructions || '');
        setCommands(c.commands);
        setAlerts(c.event_alerts);
        setErrorMessages(c.error_messages || {});
      } else {
        setErrorMsg('Failed to load bot configuration. Please make sure you are signed in as Admin.');
      }
      if (polliRes.status === 'fulfilled') {
        setPollinations(polliRes.value);
      }
      setLoading(false);
    });
  }, [open]);

  const autoSave = async <D extends ConfigDomain>(domain: D, updatedValue: unknown) => {
    if (domain === 'bot_settings') {
      const bs = updatedValue as BotSettings;
      setServerConfig((prev) => (prev ? { ...prev, bot_settings: bs } : prev));
      setBotHighlight(bs.highlight_bot_responses);
    } else if (domain === 'commands') {
      const cmds = updatedValue as CommandsConfig;
      setServerConfig((prev) => (prev ? { ...prev, commands: cmds } : prev));
    } else if (domain === 'event_alerts') {
      const al = updatedValue as EventAlertsConfig;
      setServerConfig((prev) => (prev ? { ...prev, event_alerts: al } : prev));
    }

    try {
      const res = await api.saveConfig(domain, updatedValue);
      if (domain === 'bot_settings') {
        const bs = res.value as BotSettings;
        setBotSettings(bs);
        setServerConfig((prev) => (prev ? { ...prev, bot_settings: bs } : prev));
      } else if (domain === 'commands') {
        const cmds = res.value as CommandsConfig;
        setCommands(cmds);
        setServerConfig((prev) => (prev ? { ...prev, commands: cmds } : prev));
      } else if (domain === 'event_alerts') {
        const al = res.value as EventAlertsConfig;
        setAlerts(al);
        setServerConfig((prev) => (prev ? { ...prev, event_alerts: al } : prev));
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Auto-save failed');
    }
  };

  const patchMedia = (type: MediaCommandKey, patch: Partial<MediaCommandConfig>, save = true) => {
    if (!commands) return;
    const next: CommandsConfig = {
      ...commands,
      media: { ...commands.media, [type]: { ...commands.media[type], ...patch } },
    };
    setCommands(next);
    if (save) autoSave('commands', next);
  };

  const addChannel = () => {
    if (!botSettings) return;
    const v = normChannel(newChannelInput.trim()).replace(/[^a-z0-9_]/g, '');
    if (v && !botSettings.channels.includes(v)) {
      const next = { ...botSettings, channels: [...botSettings.channels, v] };
      setBotSettings(next);
      autoSave('bot_settings', next);
      onChannelsChange?.(next.channels);
    }
    setNewChannelInput('');
  };

  const removeChannel = (name: string) => {
    if (!botSettings) return;
    const next = { ...botSettings, channels: botSettings.channels.filter((c) => c !== name) };
    setBotSettings(next);
    autoSave('bot_settings', next);
    onChannelsChange?.(next.channels);
  };

  const addIgnoredUser = () => {
    if (!botSettings) return;
    const entries = newIgnoredUserInput
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_]/g, ''))
      .filter(Boolean);
    if (entries.length === 0) return;
    const current = botSettings.ignored_usernames || [];
    const newItems = entries.filter((u) => !current.includes(u));
    if (newItems.length > 0) {
      const next = { ...botSettings, ignored_usernames: [...current, ...newItems] };
      setBotSettings(next);
      autoSave('bot_settings', next);
    }
    setNewIgnoredUserInput('');
  };

  const removeIgnoredUser = (username: string) => {
    if (!botSettings) return;
    const next = {
      ...botSettings,
      ignored_usernames: (botSettings.ignored_usernames || []).filter((u) => u !== username),
    };
    setBotSettings(next);
    autoSave('bot_settings', next);
  };

  const addCustomCommand = () => {
    if (!commands) return;
    const newCmd: CustomCommand = {
      command: '!newcmd',
      aliases: [],
      response: '',
      role: 'all',
    };
    setCommands({ ...commands, custom: [...commands.custom, newCmd] });
  };

  const updateCustomCommand = (index: number, patch: Partial<CustomCommand>) => {
    if (!commands) return;
    const next = [...commands.custom];
    next[index] = { ...next[index], ...patch };
    setCommands({ ...commands, custom: next });
  };

  const removeCustomCommand = (index: number) => {
    if (!commands) return;
    const nextCmds = { ...commands, custom: commands.custom.filter((_, i) => i !== index) };
    setCommands(nextCmds);
    autoSave('commands', nextCmds);
  };

  const cancelCurrentDomain = () => {
    if (!serverConfig) return;
    if (activeTab === 'config') setBotSettings(structuredClone(serverConfig.bot_settings));
    else if (activeTab === 'persona') setPersona(serverConfig.system_instructions || '');
    else if (activeTab === 'commands') setCommands(structuredClone(serverConfig.commands));
    else if (activeTab === 'alerts') setAlerts(structuredClone(serverConfig.event_alerts));
    else if (activeTab === 'errors') setErrorMessages(structuredClone(serverConfig.error_messages || {}));
    setErrorMsg('');
  };

  const saveCurrentDomain = async () => {
    setSaving(true);
    setErrorMsg('');
    try {
      if (activeTab === 'config' && botSettings) {
        const res = await api.saveConfig('bot_settings', botSettings);
        setBotHighlight(botSettings.highlight_bot_responses);
        setServerConfig((prev) => (prev ? { ...prev, bot_settings: res.value as BotSettings } : prev));
      } else if (activeTab === 'persona') {
        const res = await api.saveConfig('system_instructions', persona);
        setServerConfig((prev) => (prev ? { ...prev, system_instructions: res.value as string } : prev));
      } else if (activeTab === 'commands' && commands) {
        const cleanedCommands: CommandsConfig = {
          ...commands,
          custom: commands.custom.map((c) => ({
            ...c,
            aliases: (Array.isArray(c.aliases) ? c.aliases : String(c.aliases || '').split(','))
              .map((a) => a.trim().toLowerCase().slice(0, 32))
              .filter(Boolean),
          })),
        };
        const res = await api.saveConfig('commands', cleanedCommands);
        setCommands(cleanedCommands);
        setServerConfig((prev) => (prev ? { ...prev, commands: res.value as CommandsConfig } : prev));
      } else if (activeTab === 'alerts' && alerts) {
        const res = await api.saveConfig('event_alerts', alerts);
        setServerConfig((prev) => (prev ? { ...prev, event_alerts: res.value as EventAlertsConfig } : prev));
      } else if (activeTab === 'errors' && errorMessages) {
        const res = await api.saveConfig('error_messages', errorMessages);
        setServerConfig((prev) => (prev ? { ...prev, error_messages: res.value as Record<string, string> } : prev));
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const resetCurrentDomain = async () => {
    setErrorMsg('');
    try {
      const typeKey: ConfigDomain =
        activeTab === 'config'
          ? 'bot_settings'
          : activeTab === 'persona'
          ? 'system_instructions'
          : activeTab === 'commands'
          ? 'commands'
          : activeTab === 'alerts'
          ? 'event_alerts'
          : 'error_messages';

      const defaultRes = await api.getDefaults(typeKey);
      if (activeTab === 'config') {
        const bs = defaultRes.value as BotSettings;
        if (bs && (!bs.channels || bs.channels.length === 0) && botSettings?.channels?.length) {
          bs.channels = botSettings.channels;
        }
        setBotSettings(bs);
      } else if (activeTab === 'persona') {
        setPersona(defaultRes.value as string);
      } else if (activeTab === 'commands') {
        setCommands(defaultRes.value as CommandsConfig);
      } else if (activeTab === 'alerts') {
        setAlerts(defaultRes.value as EventAlertsConfig);
      } else if (activeTab === 'errors') {
        setErrorMessages(defaultRes.value as Record<string, string>);
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load defaults');
    }
  };

  const openBroadcasterLink = (channelName: string) => {
    const chan = channelLabel(channelName);
    const width = 600;
    const height = 700;
    const left = window.screen.width / 2 - width / 2;
    const top = window.screen.height / 2 - height / 2;
    window.open(
      `/auth/broadcaster?channel=${encodeURIComponent(chan)}`,
      'twitch_broadcaster_auth',
      `width=${width},height=${height},top=${top},left=${left}`
    );
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={handleRequestClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            onClick={(e) => e.stopPropagation()}
            className="relative flex h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
          >
            {/* header */}
            <div className="flex shrink-0 items-center justify-between border-b border-line px-5 py-3.5">
              <div>
                <h2 className="text-[14px] font-semibold text-ink">Bot Configuration</h2>
              </div>
              <button
                onClick={handleRequestClose}
                aria-label="Close"
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-ink"
              >
                <X size={15} />
              </button>
            </div>

            {/* main body with sidebar tabs */}
            <div className="flex min-h-0 flex-1">
              {/* left sidebar tabs */}
              <div className="w-36 sm:w-44 md:w-48 shrink-0 border-r border-line bg-surface-2/40 p-1.5 sm:p-2">
                <nav className="flex flex-col gap-1">
                  <button
                    onClick={() => setActiveTab('config')}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg px-2.5 sm:px-3 py-2 text-[12px] sm:text-[12.5px] font-medium transition-colors ${
                      activeTab === 'config' ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-surface-2 hover:text-ink'
                    }`}
                  >
                    <Sliders size={14} className="shrink-0" />
                    <span className="truncate">Configuration</span>
                  </button>
                  <button
                    onClick={() => setActiveTab('persona')}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg px-2.5 sm:px-3 py-2 text-[12px] sm:text-[12.5px] font-medium transition-colors ${
                      activeTab === 'persona' ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-surface-2 hover:text-ink'
                    }`}
                  >
                    <Sparkles size={14} className="shrink-0" />
                    <span className="truncate">Persona</span>
                  </button>
                  <button
                    onClick={() => setActiveTab('commands')}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg px-2.5 sm:px-3 py-2 text-[12px] sm:text-[12.5px] font-medium transition-colors ${
                      activeTab === 'commands' ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-surface-2 hover:text-ink'
                    }`}
                  >
                    <Terminal size={14} className="shrink-0" />
                    <span className="truncate">Commands</span>
                  </button>
                  <button
                    onClick={() => setActiveTab('alerts')}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg px-2.5 sm:px-3 py-2 text-[12px] sm:text-[12.5px] font-medium transition-colors ${
                      activeTab === 'alerts' ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-surface-2 hover:text-ink'
                    }`}
                  >
                    <Bell size={14} className="shrink-0" />
                    <span className="truncate">Alerts</span>
                  </button>
                  <button
                    onClick={() => setActiveTab('errors')}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg px-2.5 sm:px-3 py-2 text-[12px] sm:text-[12.5px] font-medium transition-colors ${
                      activeTab === 'errors' ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-surface-2 hover:text-ink'
                    }`}
                  >
                    <AlertTriangle size={14} className="shrink-0" />
                    <span className="truncate">Errors</span>
                  </button>
                </nav>
              </div>

              {/* right viewport */}
              <div className="relative flex min-h-0 flex-1 flex-col">
                <div className={`min-h-0 flex-1 p-4 sm:p-5 ${activeTab === 'persona' ? 'flex flex-col overflow-hidden pb-4' : 'scroll-slim overflow-y-auto pb-20'}`}>
                {loading ? (
                  <div className="flex h-full items-center justify-center gap-2 text-muted">
                    <Loader2 size={18} className="animate-spin text-accent" />
                    Loading configuration…
                  </div>
                ) : (
                  <>
                    {/* TAB 1: Configuration */}
                    {activeTab === 'config' && botSettings && (
                      <div className="space-y-4">
                        <SectionTitle>Connection & Channels</SectionTitle>
                        <FieldRow label="Bot account">
                          <span className="rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[11.5px] text-muted">
                            {botUsername ? botUsername.replace(/^@/, '') : 'Not configured'}
                          </span>
                        </FieldRow>

                        <div className="py-2 border-b border-line/30">
                          <div className="text-[12.5px] font-medium text-ink">Joined channels</div>
                          {botSettings.channels.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {botSettings.channels.map((c) => {
                                const isLinked = channelStatuses[c]?.authorized ?? channelStatuses[`#${c}`]?.authorized ?? false;
                                return (
                                  <span
                                    key={c}
                                    className="flex items-center gap-1.5 rounded-md border border-line bg-bg px-2 py-1 font-mono text-[11px] text-ink"
                                  >
                                    {channelLabel(c)}
                                    {isLinked ? (
                                      <span className="rounded bg-emerald-400/10 px-1 py-px text-[9px] font-semibold text-emerald-400">
                                        Linked
                                      </span>
                                    ) : (
                                      <button
                                        onClick={() => openBroadcasterLink(c)}
                                        title="Authorize broadcaster stream actions"
                                        className="flex cursor-pointer items-center gap-0.5 rounded bg-amber-400/10 px-1 py-px text-[9px] font-semibold text-amber-400 hover:bg-amber-400/20"
                                      >
                                        <Link size={9} />
                                        Link
                                      </button>
                                    )}
                                    <button
                                      onClick={() => removeChannel(c)}
                                      aria-label={`Remove ${c}`}
                                      className="ml-0.5 cursor-pointer text-faint transition-colors hover:text-ink"
                                    >
                                      <X size={11} />
                                    </button>
                                  </span>
                                );
                              })}
                            </div>
                          )}
                          <div className="mt-2 flex gap-1.5">
                            <input
                              value={newChannelInput}
                              onChange={(e) => setNewChannelInput(e.target.value)}
                              onKeyDown={(e) => e.key === 'Enter' && addChannel()}
                              placeholder="add channel name…"
                              className={`w-44 ${inputCls}`}
                            />
                            <button
                              onClick={addChannel}
                              className="flex cursor-pointer items-center gap-1 rounded-md border border-line bg-bg px-2.5 py-1.5 text-[11.5px] font-medium text-muted transition-colors hover:border-accent/50 hover:text-ink"
                            >
                              <Plus size={12} />
                              Join
                            </button>
                          </div>
                        </div>

                        <div className="py-2">
                          <div className="text-[12.5px] font-medium text-ink">Ignored users</div>
                          <div className="mt-0.5 text-[11px] text-muted">e.g. other bots</div>
                          {(botSettings.ignored_usernames || []).length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {(botSettings.ignored_usernames || []).map((u) => (
                                <span
                                  key={u}
                                  className="flex items-center gap-1.5 rounded-md border border-line bg-bg px-2 py-1 font-mono text-[11px] text-ink"
                                >
                                  {u}
                                  <button
                                    onClick={() => removeIgnoredUser(u)}
                                    aria-label={`Remove ${u}`}
                                    className="ml-0.5 cursor-pointer text-faint transition-colors hover:text-ink"
                                  >
                                    <X size={11} />
                                  </button>
                                </span>
                              ))}
                            </div>
                          )}
                          <div className="mt-2 flex gap-1.5">
                            <input
                              value={newIgnoredUserInput}
                              onChange={(e) => setNewIgnoredUserInput(e.target.value)}
                              onKeyDown={(e) => e.key === 'Enter' && addIgnoredUser()}
                              placeholder="add username…"
                              className={`w-44 ${inputCls}`}
                            />
                            <button
                              onClick={addIgnoredUser}
                              className="flex cursor-pointer items-center gap-1 rounded-md border border-line bg-bg px-2.5 py-1.5 text-[11.5px] font-medium text-muted transition-colors hover:border-accent/50 hover:text-ink"
                            >
                              <Plus size={12} />
                              Ignore
                            </button>
                          </div>
                        </div>

                        <SectionTitle>AI & search</SectionTitle>
                        <FieldRow label="Gemini Model">
                          <select
                            value={botSettings.model_name}
                            onChange={(e) => {
                              const next = { ...botSettings, model_name: e.target.value };
                              setBotSettings(next);
                              autoSave('bot_settings', next);
                            }}
                            className={selectCls}
                          >
                            <option value="gemini-3.7-flash">Gemini 3.7 Flash</option>
                            <option value="gemini-3.6-flash">Gemini 3.6 Flash</option>
                            <option value="gemini-3.5-flash">Gemini 3.5 Flash</option>
                          </select>
                        </FieldRow>

                        <FieldRow label="Thinking level">
                          <select
                            value={botSettings.thinking_level}
                            onChange={(e) => {
                              const next = { ...botSettings, thinking_level: e.target.value };
                              setBotSettings(next);
                              autoSave('bot_settings', next);
                            }}
                            className={selectCls}
                          >
                            <option value="low">Low</option>
                            <option value="medium">Medium</option>
                            <option value="high">High</option>
                          </select>
                        </FieldRow>

                        <FieldRow label="Bot Command Prefix" hint="Trigger word for AI responses in chat">
                          <input
                            value={botSettings.bot_command_name}
                            onChange={(e) => setBotSettings({ ...botSettings, bot_command_name: e.target.value })}
                            placeholder="!gemini,@yourbotusername"
                            className={`w-52 ${inputCls}`}
                          />
                        </FieldRow>

                        <FieldRow label="Response Cooldown (sec)">
                          <input
                            type="number"
                            min={0}
                            max={60}
                            value={botSettings.cooldown_duration}
                            onChange={(e) =>
                              setBotSettings({
                                ...botSettings,
                                cooldown_duration: Math.max(0, parseInt(e.target.value, 10) || 0),
                              })
                            }
                            className={`w-24 ${inputCls}`}
                          />
                        </FieldRow>

                        <FieldRow label="Conversation Memory" hint="Dialogue turns the bot remembers per channel">
                          <input
                            type="number"
                            min={0}
                            max={30}
                            value={botSettings.ai_history_length}
                            onChange={(e) =>
                              setBotSettings({
                                ...botSettings,
                                ai_history_length: Math.max(0, parseInt(e.target.value, 10) || 0),
                              })
                            }
                            className={`w-24 ${inputCls}`}
                          />
                        </FieldRow>

                        <FieldRow label="Chat Context Length" hint="Recent messages the bot can see">
                          <input
                            type="number"
                            min={1}
                            max={50}
                            value={botSettings.chat_context_length}
                            onChange={(e) =>
                              setBotSettings({
                                ...botSettings,
                                chat_context_length: Math.max(1, parseInt(e.target.value, 10) || 10),
                              })
                            }
                            className={`w-24 ${inputCls}`}
                          />
                        </FieldRow>

                        <FieldRow label="Web search" noBorder={botSettings.search_grounding !== 'tavily'}>
                          <select
                            value={botSettings.search_grounding}
                            onChange={(e) => {
                              const next = { ...botSettings, search_grounding: e.target.value };
                              setBotSettings(next);
                              autoSave('bot_settings', next);
                            }}
                            className={selectCls}
                          >
                            <option value="">Off</option>
                            <option value="tavily">Tavily</option>
                            <option value="google">Google</option>
                          </select>
                        </FieldRow>

                        {botSettings.search_grounding === 'tavily' && (
                          <FieldRow label="Search level" noBorder>
                            <select
                              value={botSettings.tavily_search_depth || 'basic'}
                              onChange={(e) => {
                                const next = { ...botSettings, tavily_search_depth: e.target.value };
                                setBotSettings(next);
                                autoSave('bot_settings', next);
                              }}
                              className={selectCls}
                            >
                              <option value="basic">Basic (1 credit)</option>
                              <option value="advanced">Advanced (2 credits)</option>
                            </select>
                          </FieldRow>
                        )}

                        <SectionTitle>Emotes & Stream Actions</SectionTitle>
                        <FieldRow label="Auto-Append Emotes" hint="Append channel emotes to bot responses">
                          <Toggle
                            on={botSettings.enable_emote_appending}
                            onChange={(v) => {
                              const next = { ...botSettings, enable_emote_appending: v };
                              setBotSettings(next);
                              autoSave('bot_settings', next);
                            }}
                          />
                        </FieldRow>
                        <FieldRow label="Stream actions" hint="Enables chat tools like title changes, clips and timeouts">
                          <Toggle
                            on={botSettings.enable_helix_actions}
                            onChange={(v) => {
                              const next = { ...botSettings, enable_helix_actions: v };
                              setBotSettings(next);
                              autoSave('bot_settings', next);
                            }}
                          />
                        </FieldRow>

                        {botSettings.enable_helix_actions && (
                          <>
                            <FieldRow label="Clip Cooldown (sec)">
                              <input
                                type="number"
                                min={0}
                                max={300}
                                value={botSettings.helix_clip_cooldown_seconds}
                                onChange={(e) =>
                                  setBotSettings({
                                    ...botSettings,
                                    helix_clip_cooldown_seconds: Math.max(0, parseInt(e.target.value, 10) || 0),
                                  })
                                }
                                className={`w-24 ${inputCls}`}
                              />
                            </FieldRow>
                            <FieldRow label="Timeout Duration (sec)">
                              <input
                                type="number"
                                min={1}
                                max={1209600}
                                value={botSettings.helix_default_timeout_seconds}
                                onChange={(e) =>
                                  setBotSettings({
                                    ...botSettings,
                                    helix_default_timeout_seconds: Math.max(1, parseInt(e.target.value, 10) || 600),
                                  })
                                }
                                className={`w-24 ${inputCls}`}
                              />
                            </FieldRow>
                          </>
                        )}
                        <FieldRow label="Highlight bot replies in dashboard" noBorder>
                          <Toggle
                            on={botSettings.highlight_bot_responses}
                            onChange={(v) => {
                              const next = { ...botSettings, highlight_bot_responses: v };
                              setBotSettings(next);
                              setBotHighlight(v);
                              autoSave('bot_settings', next);
                            }}
                          />
                        </FieldRow>
                        <ResetTabButton onReset={resetCurrentDomain} disabled={saving || loading} />
                      </div>
                    )}

                    {/* TAB 2: Persona */}
                    {activeTab === 'persona' && (
                      <div className="flex h-full min-h-0 flex-1 flex-col space-y-2.5">
                        <div className="flex items-center justify-between gap-3 shrink-0 mb-0.5">
                          <div className="flex items-center gap-1.5 text-[11.5px] text-muted min-w-0">
                            <Lightbulb size={12} className="shrink-0 text-amber-400" />
                            <span>
                              <strong className="font-medium text-ink">Tip:</strong> Wrap groups of rules in <code className="font-mono text-accent">&lt;tags&gt;</code> for best results.
                            </span>
                          </div>
                          <span className="shrink-0 font-mono text-[11px] text-faint">
                            {persona.length.toLocaleString()} / 16,000 chars
                          </span>
                        </div>

                        <textarea
                          value={persona}
                          onChange={(e) => setPersona(e.target.value.slice(0, 16000))}
                          placeholder="Describe who the bot is and how it talks…"
                          className="scroll-slim flex-1 w-full min-h-0 rounded-lg border border-line bg-bg p-3.5 font-mono text-[12px] leading-relaxed text-ink outline-none focus:border-accent/60 resize-none"
                        />
                        <div className="flex justify-start pt-1 shrink-0">
                          <button
                            type="button"
                            onClick={resetCurrentDomain}
                            disabled={saving || loading}
                            className="flex cursor-pointer items-center gap-1.5 text-[11.5px] font-medium text-faint hover:text-ink transition-colors disabled:opacity-50"
                          >
                            <RotateCcw size={11} />
                            Reset tab to defaults
                          </button>
                        </div>
                      </div>
                    )}

                    {/* TAB 3: Commands */}
                    {activeTab === 'commands' && commands && (
                      <div className="space-y-6">
                        <div>
                          <SectionTitle>Generative Media Commands</SectionTitle>

                          {/* Image Command */}
                          <MediaCommandCard
                            icon={<ImageIcon size={13} className="text-muted" strokeWidth={2.2} />}
                            noun="Image"
                            config={commands.media.image}
                            models={pollinations?.image?.models}
                            fallbackModel="flux"
                            onPatch={(patch, save) => patchMedia('image', patch, save)}
                          />

                          {/* Video Command */}
                          <MediaCommandCard
                            icon={<Clapperboard size={13} className="text-muted" strokeWidth={2.2} />}
                            noun="Video"
                            config={commands.media.video}
                            models={pollinations?.video?.models}
                            fallbackModel="wan-fast"
                            onPatch={(patch, save) => patchMedia('video', patch, save)}
                          >
                            <LabeledSelect
                              label="Duration"
                              value={String(commands.media.video.duration_cap || 10)}
                              onChange={(v) => patchMedia('video', { duration_cap: Number(v) })}
                            >
                              <option value="5">5s</option>
                              <option value="10">10s</option>
                              <option value="15">15s</option>
                            </LabeledSelect>
                          </MediaCommandCard>

                          {/* TTS Command */}
                          <MediaCommandCard
                            icon={<Mic size={13} className="text-muted" strokeWidth={2.2} />}
                            noun="Voice"
                            config={commands.media.tts}
                            models={pollinations?.tts?.models}
                            fallbackModel="elevenlabs"
                            onPatch={(patch, save) => patchMedia('tts', patch, save)}
                            modelPatch={(m) => ({
                              model: m,
                              voice: (pollinations?.tts?.voices?.[m] || [])[0] || '',
                            })}
                          >
                            {(() => {
                              const availableVoices = pollinations?.tts?.voices?.[commands.media.tts.model || 'elevenlabs'] || [];
                              if (availableVoices.length === 0) return null;
                              return (
                                <LabeledSelect
                                  label="Voice"
                                  value={commands.media.tts.voice || availableVoices[0]}
                                  onChange={(v) => patchMedia('tts', { voice: v })}
                                >
                                  {availableVoices.map((v) => (
                                    <option key={v} value={v}>{v}</option>
                                  ))}
                                </LabeledSelect>
                              );
                            })()}
                          </MediaCommandCard>

                          {/* Music Command */}
                          <MediaCommandCard
                            icon={<Music2 size={13} className="text-muted" strokeWidth={2.2} />}
                            noun="Music"
                            config={commands.media.music}
                            models={pollinations?.music?.models}
                            fallbackModel="elevenmusic"
                            onPatch={(patch, save) => patchMedia('music', patch, save)}
                            last
                          >
                            <LabeledSelect
                              label="Duration"
                              value={String(commands.media.music.duration_cap || 30)}
                              onChange={(v) => patchMedia('music', { duration_cap: Number(v) })}
                            >
                              <option value="15">15s</option>
                              <option value="30">30s</option>
                              <option value="60">60s</option>
                            </LabeledSelect>
                          </MediaCommandCard>
                        </div>

                        {/* Custom static commands */}
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <SectionTitle>Custom Static Commands</SectionTitle>
                            <button
                              onClick={addCustomCommand}
                              className="flex cursor-pointer items-center gap-1 rounded-md border border-line bg-bg px-2.5 py-1 text-[11.5px] font-medium text-muted transition hover:border-accent/50 hover:text-ink"
                            >
                              <Plus size={12} /> Add Command
                            </button>
                          </div>

                          {commands.custom.length === 0 ? (
                            <div className="py-6 text-center text-[12px] text-muted">
                              No custom commands yet.
                            </div>
                          ) : (
                            <div className="overflow-x-auto scroll-slim -mx-1 px-1 pb-1">
                              <div className="min-w-[540px]">
                                <div className="flex items-center gap-2 py-1.5 px-1 text-[10px] font-mono font-semibold uppercase tracking-[0.14em] text-faint">
                                  <span className="w-28 shrink-0">Command</span>
                                  <span className="w-36 shrink-0">Aliases</span>
                                  <span className="flex-1">Response</span>
                                  <span className="w-28 shrink-0">Permission</span>
                                  <span className="w-6 shrink-0"></span>
                                </div>
                                <div className="divide-y divide-line/20">
                                  {commands.custom.map((cmd, idx) => (
                                    <div key={idx} className="flex items-center gap-2 py-2">
                                      <input
                                        value={cmd.command}
                                        onChange={(e) => updateCustomCommand(idx, { command: e.target.value })}
                                        placeholder="!cmd"
                                        className={`w-28 shrink-0 font-mono ${inputCls}`}
                                      />
                                      <input
                                        value={Array.isArray(cmd.aliases) ? cmd.aliases.join(', ') : (cmd.aliases || '')}
                                        onChange={(e) => {
                                          const raw = e.target.value;
                                          const list = raw.split(',').map((s) => s.trim());
                                          updateCustomCommand(idx, { aliases: list });
                                        }}
                                        placeholder="!alias1, !alias2"
                                        className={`w-36 shrink-0 font-mono text-[11.5px] ${inputCls}`}
                                      />
                                      <input
                                        value={cmd.response}
                                        onChange={(e) => updateCustomCommand(idx, { response: e.target.value })}
                                        placeholder="Response text…"
                                        className={`flex-1 ${inputCls}`}
                                      />
                                      <select
                                        value={cmd.role}
                                        onChange={(e) => updateCustomCommand(idx, { role: e.target.value as 'all' | 'moderator' | 'broadcaster' })}
                                        className={`w-28 shrink-0 ${selectCls}`}
                                      >
                                        <option value="all">Everyone</option>
                                        <option value="moderator">Mods</option>
                                        <option value="broadcaster">Broadcaster</option>
                                      </select>
                                      <button
                                        onClick={() => removeCustomCommand(idx)}
                                        title="Delete command"
                                        className="cursor-pointer text-faint hover:text-red-400 transition-colors p-1 shrink-0"
                                      >
                                        <Trash2 size={13} />
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                        <ResetTabButton onReset={resetCurrentDomain} disabled={saving || loading} />
                      </div>
                    )}

                    {/* TAB 4: Alerts */}
                    {activeTab === 'alerts' && alerts && (
                      <div className="space-y-4">
                        <div className="flex flex-wrap items-center gap-1.5 pb-1">
                          {Object.keys(alerts).map((key) => {
                            const isSelected = selectedAlertKey === key;
                            const isEnabled = alerts[key]?.enabled;
                            const label = ALERT_LABELS[key] || key.replace(/_/g, ' ');
                            return (
                              <button
                                key={key}
                                type="button"
                                onClick={() => setSelectedAlertKey(key)}
                                className={`flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${
                                  isSelected
                                    ? 'border border-accent/40 bg-accent/15 text-accent shadow-xs'
                                    : 'border border-line bg-bg text-muted hover:border-line-soft hover:text-ink'
                                }`}
                              >
                                <span
                                  className={`h-1.5 w-1.5 rounded-full ${
                                    isEnabled ? 'bg-emerald-400' : 'bg-faint/60'
                                  }`}
                                />
                                <span>{label}</span>
                              </button>
                            );
                          })}
                        </div>

                        {alerts[selectedAlertKey] && (() => {
                          const activeAlert = alerts[selectedAlertKey];
                          const sample = SAMPLE_ALERT_DATA[selectedAlertKey] || SAMPLE_ALERT_DATA.subscription;
                          const fallbackText = interpolateTokens(activeAlert.fallback_template || '', sample.vars);
                          const testReply = aiTestReplies[selectedAlertKey];
                          const currentBotName = (botUsername || 'Twitch Bot').replace(/^@/, '');
                          const tokens = EVENT_TOKENS[selectedAlertKey] || ['{username}'];

                          return (
                            <div className="space-y-4 pt-1">
                              {/* Event Header */}
                              <div className={`flex items-center justify-between pb-3 ${activeAlert.enabled ? 'border-b border-line/30' : ''}`}>
                                <div>
                                  <div className="text-[13px] font-semibold text-ink">
                                    {ALERT_LABELS[selectedAlertKey] || selectedAlertKey.replace(/_/g, ' ')}
                                  </div>
                                </div>
                                <Toggle
                                  on={activeAlert.enabled}
                                  onChange={(v) => {
                                    const next = {
                                      ...alerts,
                                      [selectedAlertKey]: { ...activeAlert, enabled: v },
                                    };
                                    setAlerts(next);
                                    autoSave('event_alerts', next);
                                  }}
                                />
                              </div>

                              {activeAlert.enabled && (
                                <>
                                  {/* Live Chat Preview */}
                                  <div className="space-y-1.5 rounded-lg border border-line/60 bg-surface/60 p-3">
                                    <div className="flex items-center justify-between pb-1">
                                      <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.14em] text-faint">
                                        Live chat preview
                                      </span>
                                  {activeAlert.ai_enabled && testReply && (
                                    <span className="font-mono text-[9.5px] text-accent flex items-center gap-1">
                                      <Sparkles size={10} /> AI test reply
                                    </span>
                                  )}
                                </div>

                                <EventRow
                                  entry={{
                                    kind: 'event',
                                    id: `preview-event-${selectedAlertKey}`,
                                    event: sample.event,
                                    text: sample.eventText,
                                    time: '18:03',
                                  }}
                                />

                                {testingAiAlert ? (
                                  <div className="my-1 flex items-center gap-2 rounded-r-md border-l-2 border-accent bg-accent/[0.06] py-1.5 pl-2.5 pr-2 text-[12px] text-accent animate-pulse">
                                    <Loader2 size={13} className="animate-spin text-accent shrink-0" />
                                    <span>Generating reply…</span>
                                  </div>
                                ) : (
                                  <MsgRow
                                    entry={{
                                      kind: 'msg',
                                      id: `preview-msg-${selectedAlertKey}`,
                                      user: currentBotName,
                                      text: (activeAlert.ai_enabled && testReply) ? testReply : (fallbackText || '…'),
                                      time: '18:04',
                                    }}
                                    channel="demo"
                                    botUsername={currentBotName}
                                    highlightBots={highlightBots}
                                  />
                                )}

                                {aiTestErrors[selectedAlertKey] && (
                                  <div className="mt-1 text-[11px] text-red-400">
                                    {aiTestErrors[selectedAlertKey]}
                                  </div>
                                )}
                              </div>

                              {/* AI Persona Reaction */}
                              <FieldRow label="AI reply" hint="The bot writes each greeting itself">
                                <Toggle
                                  on={activeAlert.ai_enabled}
                                  onChange={(v) => {
                                    const next = {
                                      ...alerts,
                                      [selectedAlertKey]: { ...activeAlert, ai_enabled: v },
                                    };
                                    setAlerts(next);
                                    autoSave('event_alerts', next);
                                  }}
                                />
                              </FieldRow>

                              {/* AI Instruction Prompt */}
                              {activeAlert.ai_enabled && (
                                <div className="py-2.5 border-b border-line/30">
                                  <div className="flex items-center justify-between mb-1.5">
                                    <div>
                                      <div className="text-[12.5px] font-medium text-ink">AI prompt</div>
                                    </div>
                                    <span className="font-mono text-[10.5px] text-faint">
                                      {(activeAlert.ai_prompt || '').length} / 1,000 chars
                                    </span>
                                  </div>
                                  <TokenInput
                                    inputRef={promptRef}
                                    value={activeAlert.ai_prompt || ''}
                                    onChange={(val) =>
                                      setAlerts({
                                        ...alerts,
                                        [selectedAlertKey]: { ...activeAlert, ai_prompt: val.slice(0, 1000) },
                                      })
                                    }
                                    placeholder="How should the bot greet them?"
                                    maxLength={1000}
                                  />
                                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                                    <div className="flex flex-wrap items-center gap-1.5">
                                      {tokens.map((tok) => (
                                        <button
                                          key={tok}
                                          type="button"
                                          onClick={() => insertTokenIntoField('ai_prompt', tok)}
                                          className="cursor-pointer rounded border border-line bg-bg px-2 py-0.5 font-mono text-[11px] font-medium text-accent transition hover:border-accent/50 hover:bg-accent/10"
                                        >
                                          + {tok}
                                        </button>
                                      ))}
                                    </div>
                                    <button
                                      type="button"
                                      disabled={testingAiAlert || !(activeAlert.ai_prompt || '').trim()}
                                      onClick={handleTestAiReply}
                                      className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-accent/40 bg-accent/15 px-2.5 py-1 text-[11px] font-semibold text-accent transition hover:bg-accent/25 disabled:opacity-50"
                                    >
                                      {testingAiAlert ? (
                                        <>
                                          <Loader2 size={12} className="animate-spin" />
                                          Testing…
                                        </>
                                      ) : (
                                        <>
                                          <Sparkles size={12} />
                                          Test AI reply
                                        </>
                                      )}
                                    </button>
                                  </div>
                                </div>
                              )}

                              {/* Offline Fallback */}
                              <div className="py-2.5 border-b border-line/30">
                                <div className="flex items-center justify-between mb-1.5">
                                  <div>
                                    <div className="text-[12.5px] font-medium text-ink">Backup message</div>
                                    <div className="text-[11px] text-muted">Sent when AI replies are off or fail</div>
                                  </div>
                                  <span className="font-mono text-[10.5px] text-faint">
                                    {(activeAlert.fallback_template || '').length} / 450 chars
                                  </span>
                                </div>
                                <TokenInput
                                  inputRef={fallbackRef}
                                  value={activeAlert.fallback_template || ''}
                                  onChange={(val) =>
                                    setAlerts({
                                      ...alerts,
                                      [selectedAlertKey]: { ...activeAlert, fallback_template: val.slice(0, 450) },
                                    })
                                  }
                                  placeholder="Welcome, {username}!"
                                  maxLength={450}
                                />
                                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                    {tokens.map((tok) => (
                                    <button
                                      key={tok}
                                      type="button"
                                      onClick={() => insertTokenIntoField('fallback_template', tok)}
                                      className="cursor-pointer rounded border border-line bg-bg px-2 py-0.5 font-mono text-[11px] font-medium text-accent transition hover:border-accent/50 hover:bg-accent/10"
                                    >
                                      + {tok}
                                    </button>
                                  ))}
                                </div>
                              </div>

                              {/* Cooldown & Thresholds */}
                              <FieldRow label="Cooldown (sec)" noBorder={!['cheer', 'raid', 'sub_gift'].includes(selectedAlertKey)}>
                                <input
                                  type="number"
                                  min={0}
                                  max={3600}
                                  value={activeAlert.cooldown_seconds ?? 0}
                                  onChange={(e) =>
                                    setAlerts({
                                      ...alerts,
                                      [selectedAlertKey]: {
                                        ...activeAlert,
                                        cooldown_seconds: Math.max(0, parseInt(e.target.value, 10) || 0),
                                      },
                                    })
                                  }
                                  className={`w-24 ${inputCls}`}
                                />
                              </FieldRow>

                              {selectedAlertKey === 'cheer' && (
                                <FieldRow label="Minimum bits threshold" noBorder={selectedAlertKey === 'cheer'}>
                                  <input
                                    type="number"
                                    min={0}
                                    value={activeAlert.min_bits ?? 100}
                                    onChange={(e) =>
                                      setAlerts({
                                        ...alerts,
                                        [selectedAlertKey]: {
                                          ...activeAlert,
                                          min_bits: Math.max(0, parseInt(e.target.value, 10) || 0),
                                        },
                                      })
                                    }
                                    className={`w-24 ${inputCls}`}
                                  />
                                </FieldRow>
                              )}

                              {selectedAlertKey === 'raid' && (
                                <FieldRow label="Minimum viewers threshold" noBorder={selectedAlertKey === 'raid'}>
                                  <input
                                    type="number"
                                    min={1}
                                    value={activeAlert.min_viewers ?? 1}
                                    onChange={(e) =>
                                      setAlerts({
                                        ...alerts,
                                        [selectedAlertKey]: {
                                          ...activeAlert,
                                          min_viewers: Math.max(1, parseInt(e.target.value, 10) || 1),
                                        },
                                      })
                                    }
                                    className={`w-24 ${inputCls}`}
                                  />
                                </FieldRow>
                              )}

                              <ResetTabButton onReset={resetCurrentDomain} disabled={saving || loading} />
                            </>
                          )}
                          </div>
                        );
                        })()}
                      </div>
                    )}

                    {/* TAB 5: Errors */}
                    {activeTab === 'errors' && (
                      !errorsUnlocked ? (
                        <div className="flex h-full min-h-[380px] flex-col items-center justify-center py-12 text-center">
                          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-amber-400/30 bg-amber-400/10 mb-3.5">
                            <AlertTriangle size={24} className="text-amber-400" />
                          </div>
                          <h3 className="text-[15px] font-semibold text-ink">Custom error messages</h3>
                          <p className="mt-1.5 max-w-[340px] text-[12px] leading-relaxed text-muted">
                            These are sent to chat when something breaks. Editing them changes what viewers see.
                          </p>
                          <button
                            onClick={handleUnlockErrors}
                            className="mt-5 inline-flex cursor-pointer items-center justify-center rounded-lg bg-accent px-6 py-2 text-[13px] font-semibold text-bg transition hover:brightness-110"
                          >
                            Edit anyway
                          </button>
                        </div>
                      ) : (
                        <div className="space-y-4">
                          <div className="flex items-center justify-between gap-3">
                            <SectionTitle>Messages</SectionTitle>
                            <input
                              value={errorFilter}
                              onChange={(e) => setErrorFilter(e.target.value)}
                              placeholder="Search error keys…"
                              className={`w-48 ${inputCls}`}
                            />
                          </div>

                          {Object.entries(errorMessages).filter(
                            ([k]) => !errorFilter || k.toLowerCase().includes(errorFilter.toLowerCase())
                          ).length === 0 ? (
                            <div className="py-8 text-center text-[12px] text-muted">
                              No error keys match "{errorFilter}".
                            </div>
                          ) : (
                            <div className="divide-y divide-line/20">
                              {Object.entries(errorMessages)
                                .filter(([k]) => !errorFilter || k.toLowerCase().includes(errorFilter.toLowerCase()))
                                .map(([k, v]) => (
                                  <div key={k} className="py-2.5 space-y-1">
                                    <div className="flex items-center justify-between">
                                      <span className="font-mono text-[11px] font-semibold text-accent">{k}</span>
                                    </div>
                                    <input
                                      value={v}
                                      onChange={(e) =>
                                        setErrorMessages({
                                          ...errorMessages,
                                          [k]: e.target.value,
                                        })
                                      }
                                      placeholder="Message sent to chat…"
                                      className={`w-full ${inputCls}`}
                                    />
                                  </div>
                                ))}
                            </div>
                          )}
                          <ResetTabButton onReset={resetCurrentDomain} disabled={saving || loading} />
                        </div>
                      )
                    )}
                  </>
                )}
              </div>

              {/* Floating Save/Cancel Pill */}
              <AnimatePresence>
                {isCurrentTabDirty && (
                  <motion.div
                    initial={{ opacity: 0, y: 12, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.96 }}
                    transition={{ duration: 0.15, ease: 'easeOut' }}
                    className="absolute bottom-4 right-5 z-20 flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-2xl border border-line bg-surface/95 backdrop-blur-md px-2 py-1.5 shadow-2xl"
                  >
                    {errorMsg && (
                      <span className="max-w-[280px] break-words whitespace-normal px-2 text-[11px] font-medium leading-snug text-red-400">{errorMsg}</span>
                    )}
                    <button
                      type="button"
                      onClick={cancelCurrentDomain}
                      disabled={saving}
                      className="shrink-0 cursor-pointer rounded-full px-3.5 py-1.5 text-[12px] font-medium text-muted transition-colors hover:text-ink hover:bg-surface-2 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={saveCurrentDomain}
                      disabled={saving}
                      className={`flex shrink-0 items-center gap-1.5 rounded-full px-4 py-1.5 text-[12px] font-semibold ${
                        saving
                          ? 'cursor-not-allowed bg-raised text-muted border border-line'
                          : 'cursor-pointer bg-accent text-bg border border-transparent hover:brightness-110'
                      }`}
                    >
                      {saving ? (
                        <>
                          <Loader2 size={12} className="animate-spin text-muted" />
                          <span>Saving…</span>
                        </>
                      ) : (
                        'Save'
                      )}
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </motion.div>

        {/* Exit Confirmation Dialog */}
        <AnimatePresence>
          {showExitConfirm && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="fixed inset-0 z-60 flex items-center justify-center bg-black/70 p-4"
              onClick={() => setShowExitConfirm(false)}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 8 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-[340px] rounded-2xl border border-line bg-surface p-6 shadow-2xl text-center space-y-4"
              >
                <div className="space-y-1.5">
                  <h3 className="text-[16px] font-bold text-ink">Are you sure you want to exit?</h3>
                  <p className="text-[12.5px] text-muted">Your changes won't be saved.</p>
                </div>
                <div className="space-y-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowExitConfirm(false)}
                    className="w-full cursor-pointer rounded-full bg-accent py-2.5 text-[12.5px] font-semibold text-bg transition hover:brightness-110"
                  >
                    Back to editing
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmExit}
                    className="w-full cursor-pointer rounded-full border border-red-500/30 py-2.5 text-[12.5px] font-medium text-red-400 transition hover:bg-red-500/10 hover:border-red-500/50"
                  >
                    Exit
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    )}
  </AnimatePresence>
);
}
