import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Activity, AlertTriangle, Bell, Loader2, Sliders, Sparkles, Terminal, X } from 'lucide-react';
import type { BotSettings, ConfigDomain, PollinationsCatalog } from '../lib/types';
import { api } from '../lib/api';
import { channelLabel } from '../lib/channel';
import { setBotHighlight, useBotHighlight } from '../lib/settings';
import { ConfigEditor } from '../config/ConfigEditor';
import { HttpConfigPersistence } from '../config/HttpConfigPersistence';
import { useConfigEditor } from '../config/useConfigEditor';
import AlertsTab from './settings/AlertsTab';
import CommandsTab from './settings/CommandsTab';
import ConfigurationTab from './settings/ConfigurationTab';
import ErrorsTab from './settings/ErrorsTab';
import PersonaTab from './settings/PersonaTab';
import StreamActionsTab from './settings/StreamActionsTab';

interface Props {
  open: boolean;
  onClose: () => void;
  botUsername?: string;
  activeChannel?: string;
  channelStatuses: Record<string, { authorized?: boolean; linked?: boolean; needsRelink?: boolean }>;
  onChannelsChange?: (channels: string[]) => void;
}

type TabKey = 'config' | 'persona' | 'stream-actions' | 'commands' | 'alerts' | 'errors';

const TAB_DOMAINS: Record<TabKey, ConfigDomain> = {
  config: 'bot_settings',
  persona: 'system_instructions',
  'stream-actions': 'stream_actions',
  commands: 'commands',
  alerts: 'event_alerts',
  errors: 'error_messages',
};

function SettingsSession({ onClose, botUsername = 'Twitch Bot', activeChannel = '', channelStatuses, onChannelsChange }: Omit<Props, 'open'>) {
  const highlightBots = useBotHighlight();
  const canonicalChannels = useRef<string[] | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('config');
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [catalog, setCatalog] = useState<PollinationsCatalog | null>(null);
  const [editor] = useState(() => new ConfigEditor({
    persistence: new HttpConfigPersistence(),
    onCommitted: ({ domain, value }) => {
      if (domain !== 'bot_settings') return;
      const settings = value as BotSettings;
      setBotHighlight(settings.highlight_bot_responses);
      if (JSON.stringify(settings.channels) !== JSON.stringify(canonicalChannels.current)) {
        canonicalChannels.current = settings.channels;
        onChannelsChange?.(settings.channels);
      }
    },
  }));
  const snapshot = useConfigEditor(editor);
  const domain = TAB_DOMAINS[activeTab];
  const current = snapshot.domains[domain];
  const dispatch = editor.dispatch.bind(editor);

  useEffect(() => {
    if (canonicalChannels.current || snapshot.status !== 'ready') return;
    canonicalChannels.current = snapshot.domains.bot_settings.value?.channels || [];
  }, [snapshot.status, snapshot.domains.bot_settings.value]);

  useEffect(() => {
    void editor.start();
    let currentSession = true;
    api.getPollinationsModels().then((value) => {
      if (currentSession) setCatalog(value);
    }).catch(() => {});
    return () => {
      currentSession = false;
      editor.terminate();
    };
  }, [editor]);

  useEffect(() => {
    if (snapshot.closeDisposition === 'close') onClose();
    else if (snapshot.closeDisposition === 'confirm') setShowExitConfirm(true);
  }, [snapshot.closeDisposition, onClose]);

  const continueEditing = () => {
    setShowExitConfirm(false);
    editor.dispatch({ type: 'session.continue' });
  };
  const requestClose = () => editor.requestClose();
  const confirmExit = () => {
    setShowExitConfirm(false);
    editor.dispatch({ type: 'session.discard-all' });
  };
  const openBroadcasterLink = (channelName: string) => {
    const width = 600;
    const height = 700;
    window.open(
      `/auth/broadcaster?channel=${encodeURIComponent(channelLabel(channelName))}`,
      'twitch_broadcaster_auth',
      `width=${width},height=${height},top=${window.screen.height / 2 - height / 2},left=${window.screen.width / 2 - width / 2}`
    );
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (showExitConfirm) continueEditing();
      else requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showExitConfirm]);

  const busy = current.pending || current.resetting || snapshot.status === 'loading';
  const renderTab = () => {
    if (snapshot.status !== 'ready') return null;
    switch (activeTab) {
      case 'config': {
        const value = snapshot.domains.bot_settings.value;
        return value && <ConfigurationTab value={value} busy={busy} botUsername={botUsername} dispatch={dispatch} />;
      }
      case 'persona': {
        const value = snapshot.domains.system_instructions.value;
        return value !== null && <PersonaTab value={value} busy={busy} dispatch={dispatch} />;
      }
      case 'stream-actions': {
        const value = snapshot.domains.stream_actions.value;
        return value && <StreamActionsTab value={value} channels={snapshot.domains.bot_settings.value?.channels || []} channelStatuses={channelStatuses} busy={busy} dispatch={dispatch} onAuthorizeBroadcaster={openBroadcasterLink} onOpenConfiguration={() => setActiveTab('config')} />;
      }
      case 'commands': {
        const value = snapshot.domains.commands.value;
        return value && <CommandsTab value={value} catalog={catalog} busy={busy} dispatch={dispatch} />;
      }
      case 'alerts': {
        const value = snapshot.domains.event_alerts.value;
        return value && <AlertsTab value={value} persona={snapshot.domains.system_instructions.value || ''} botUsername={botUsername} activeChannel={activeChannel} highlightBots={highlightBots} busy={busy} dispatch={dispatch} />;
      }
      case 'errors': {
        const value = snapshot.domains.error_messages.value;
        return value && <ErrorsTab value={value} busy={busy} dispatch={dispatch} />;
      }
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={requestClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.98 }} transition={{ duration: 0.18, ease: 'easeOut' }}
        onClick={(event) => event.stopPropagation()}
        className="relative flex h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[14px] font-semibold text-ink">Bot Configuration</h2>
          <button onClick={requestClose} aria-label="Close" className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-ink"><X size={15} /></button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="w-36 sm:w-44 md:w-48 shrink-0 border-r border-line bg-surface-2/40 p-1.5 sm:p-2">
            <nav className="flex flex-col gap-1">
              {([
                ['config', 'Configuration', Sliders], ['persona', 'Persona', Sparkles], ['stream-actions', 'Stream Actions', Activity], ['commands', 'Commands', Terminal],
                ['alerts', 'Alerts', Bell], ['errors', 'Errors', AlertTriangle],
              ] as const).map(([key, label, Icon]) => (
                <button key={key} onClick={() => setActiveTab(key)} className={`flex cursor-pointer items-center gap-2 rounded-lg px-2.5 sm:px-3 py-2 text-[12px] sm:text-[12.5px] font-medium transition-colors ${activeTab === key ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-surface-2 hover:text-ink'}`}>
                  <Icon size={14} className="shrink-0" /><span className="truncate">{label}</span>
                </button>
              ))}
            </nav>
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col">
            <div className={`min-h-0 flex-1 p-4 sm:p-5 ${activeTab === 'persona' ? 'flex flex-col overflow-hidden pb-4' : 'scroll-slim overflow-y-auto pb-20'}`}>
              {snapshot.status === 'loading' ? (
                <div className="flex h-full items-center justify-center gap-2 text-muted"><Loader2 size={18} className="animate-spin text-accent" />Loading configuration…</div>
              ) : (
                <>
                  {snapshot.failure && <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11.5px] text-red-400" role="alert">{snapshot.failure.message}</div>}
                  {renderTab()}
                </>
              )}
            </div>

            <AnimatePresence>
              {current.saveRequired && (
                <motion.div initial={{ opacity: 0, y: 12, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: 0.96 }} transition={{ duration: 0.15, ease: 'easeOut' }} className="absolute bottom-4 right-5 z-20 flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-2xl border border-line bg-surface/95 backdrop-blur-md px-2 py-1.5 shadow-2xl">
                  {current.failure && <span className="max-w-[280px] break-words whitespace-normal px-2 text-[11px] font-medium leading-snug text-red-400">{current.failure.message}</span>}
                  <button type="button" onClick={() => editor.dispatch({ type: 'domain.cancel', domain })} className="shrink-0 cursor-pointer rounded-full px-3.5 py-1.5 text-[12px] font-medium text-muted transition-colors hover:text-ink hover:bg-surface-2">Cancel</button>
                  <button type="button" onClick={() => editor.dispatch({ type: 'domain.save', domain })} disabled={current.pending} className={`flex shrink-0 items-center gap-1.5 rounded-full px-4 py-1.5 text-[12px] font-semibold ${current.pending ? 'cursor-not-allowed bg-raised text-muted border border-line' : 'cursor-pointer bg-accent text-bg border border-transparent hover:brightness-110'}`}>
                    {current.pending ? <><Loader2 size={12} className="animate-spin text-muted" /><span>Saving…</span></> : 'Save'}
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </motion.div>

      <AnimatePresence>
        {showExitConfirm && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} className="fixed inset-0 z-60 flex items-center justify-center bg-black/70 p-4" onClick={continueEditing}>
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 8 }} transition={{ duration: 0.15, ease: 'easeOut' }} onClick={(event) => event.stopPropagation()} className="w-full max-w-[340px] rounded-2xl border border-line bg-surface p-6 shadow-2xl text-center space-y-4">
              <div className="space-y-1.5"><h3 className="text-[16px] font-bold text-ink">Are you sure you want to exit?</h3><p className="text-[12.5px] text-muted">Your changes won't be saved.</p></div>
              <div className="space-y-2 pt-2">
                <button type="button" onClick={continueEditing} className="w-full cursor-pointer rounded-full bg-accent py-2.5 text-[12.5px] font-semibold text-bg transition hover:brightness-110">Back to editing</button>
                <button type="button" onClick={confirmExit} className="w-full cursor-pointer rounded-full border border-red-500/30 py-2.5 text-[12.5px] font-medium text-red-400 transition hover:bg-red-500/10 hover:border-red-500/50">Exit</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export default function SettingsModal({ open, ...props }: Props) {
  return <AnimatePresence>{open && <SettingsSession {...props} />}</AnimatePresence>;
}
