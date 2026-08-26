import { useState, type ReactNode } from 'react';
import { Clapperboard, Image as ImageIcon, Mic, Music2, Plus, Trash2 } from 'lucide-react';
import type { ConfigIntent } from '../../config/ConfigEditor';
import type { CommandAccess, CommandsConfig, CustomCommand, MediaCommandConfig, PollinationsCatalog } from '../../lib/types';
import { inputCls, ResetTabButton, SectionTitle, selectCls, Toggle } from './SettingsPrimitives';

type MediaCommandKey = 'image' | 'video' | 'tts' | 'music';

const ACCESS_OPTIONS: { value: CommandAccess; label: string }[] = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'subs', label: 'Subs, VIPs & Mods' },
  { value: 'vipmod', label: 'VIPs & Mods' },
  { value: 'mod', label: 'Mods Only' },
];

function CommandAliasFields({ command, aliases, onCommandChange, onAliasesChange }: {
  command: string;
  aliases: string[];
  onCommandChange: (value: string) => void;
  onAliasesChange: (aliases: string[]) => void;
}) {
  const [aliasDraft, setAliasDraft] = useState<string | null>(null);
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-[11.5px] font-medium text-muted">Command</span>
        <input value={command} onChange={(event) => onCommandChange(event.target.value)} className={`w-24 font-mono ${inputCls}`} />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[11.5px] font-medium text-muted">Aliases</span>
        <input
          value={aliasDraft ?? aliases.join(', ')}
          onFocus={() => setAliasDraft(aliases.join(', '))}
          onChange={(event) => setAliasDraft(event.target.value)}
          onBlur={() => {
            if (aliasDraft !== null) {
              onAliasesChange(aliasDraft.split(',').map((alias) => alias.trim().toLowerCase().slice(0, 32)).filter(Boolean));
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

function LabeledSelect({ label, value, onChange, children }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11.5px] font-medium text-muted">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className={selectCls}>{children}</select>
    </div>
  );
}

function MediaCommandCard({ icon, noun, config, models, fallbackModel, onPatch, modelPatch, last = false, children }: {
  icon: ReactNode;
  noun: string;
  config: MediaCommandConfig;
  models?: string[];
  fallbackModel: string;
  onPatch: (patch: Partial<MediaCommandConfig>) => void;
  modelPatch?: (model: string) => Partial<MediaCommandConfig>;
  last?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`py-2.5 border-b border-line/30${last ? ' last:border-0' : ''}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">{icon}{noun}</div>
        <Toggle on={config.enabled} onChange={(enabled) => onPatch({ enabled })} />
      </div>
      {config.enabled && (
        <div className="mt-2.5 flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-3">
            <CommandAliasFields
              command={config.command}
              aliases={Array.isArray(config.aliases) ? config.aliases : []}
              onCommandChange={(command) => onPatch({ command })}
              onAliasesChange={(aliases) => onPatch({ aliases })}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <LabeledSelect label="Model" value={config.model || fallbackModel} onChange={(model) => onPatch(modelPatch ? modelPatch(model) : { model })}>
              {(models || [fallbackModel]).map((model) => <option key={model} value={model}>{model}</option>)}
            </LabeledSelect>
            {children}
            <LabeledSelect label="Access" value={config.access || 'everyone'} onChange={(access) => onPatch({ access: access as CommandAccess })}>
              {ACCESS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </LabeledSelect>
          </div>
        </div>
      )}
    </div>
  );
}

interface Props {
  value: CommandsConfig;
  catalog: PollinationsCatalog | null;
  busy: boolean;
  dispatch: (intent: ConfigIntent) => void;
}

export default function CommandsTab({ value, catalog, busy, dispatch }: Props) {
  const patchMedia = (command: MediaCommandKey, patch: Partial<MediaCommandConfig>) => {
    dispatch({ type: 'media-command.changed', command, patch });
  };
  const addCustom = () => dispatch({
    type: 'custom-command.added',
    value: { command: '!newcmd', aliases: [], response: '', role: 'all' },
  });
  const updateCustom = (index: number, patch: Partial<CustomCommand>) => dispatch({ type: 'custom-command.changed', index, patch });

  return (
    <div className="space-y-6">
      <div>
        <SectionTitle>Generative Media Commands</SectionTitle>
        <MediaCommandCard icon={<ImageIcon size={13} className="text-muted" strokeWidth={2.2} />} noun="Image" config={value.media.image} models={catalog?.image?.models} fallbackModel="flux" onPatch={(patch) => patchMedia('image', patch)} />
        <MediaCommandCard icon={<Clapperboard size={13} className="text-muted" strokeWidth={2.2} />} noun="Video" config={value.media.video} models={catalog?.video?.models} fallbackModel="wan-fast" onPatch={(patch) => patchMedia('video', patch)}>
          <LabeledSelect label="Duration" value={String(value.media.video.duration_cap || 10)} onChange={(duration) => patchMedia('video', { duration_cap: Number(duration) })}>
            <option value="5">5s</option><option value="10">10s</option><option value="15">15s</option>
          </LabeledSelect>
        </MediaCommandCard>
        <MediaCommandCard
          icon={<Mic size={13} className="text-muted" strokeWidth={2.2} />}
          noun="Voice"
          config={value.media.tts}
          models={catalog?.tts?.models}
          fallbackModel="elevenlabs"
          onPatch={(patch) => patchMedia('tts', patch)}
          modelPatch={(model) => ({ model, voice: (catalog?.tts?.voices?.[model] || [])[0] || '' })}
        >
          {(() => {
            const voices = catalog?.tts?.voices?.[value.media.tts.model || 'elevenlabs'] || [];
            return voices.length ? (
              <LabeledSelect label="Voice" value={value.media.tts.voice || voices[0]} onChange={(voice) => patchMedia('tts', { voice })}>
                {voices.map((voice) => <option key={voice} value={voice}>{voice}</option>)}
              </LabeledSelect>
            ) : null;
          })()}
        </MediaCommandCard>
        <MediaCommandCard icon={<Music2 size={13} className="text-muted" strokeWidth={2.2} />} noun="Music" config={value.media.music} models={catalog?.music?.models} fallbackModel="elevenmusic" onPatch={(patch) => patchMedia('music', patch)} last>
          <LabeledSelect label="Duration" value={String(value.media.music.duration_cap || 30)} onChange={(duration) => patchMedia('music', { duration_cap: Number(duration) })}>
            <option value="15">15s</option><option value="30">30s</option><option value="60">60s</option>
          </LabeledSelect>
        </MediaCommandCard>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <SectionTitle>Custom Static Commands</SectionTitle>
          <button onClick={addCustom} className="flex cursor-pointer items-center gap-1 rounded-md border border-line bg-bg px-2.5 py-1 text-[11.5px] font-medium text-muted transition hover:border-accent/50 hover:text-ink"><Plus size={12} /> Add Command</button>
        </div>
        {value.custom.length === 0 ? (
          <div className="py-6 text-center text-[12px] text-muted">No custom commands yet.</div>
        ) : (
          <div className="overflow-x-auto scroll-slim -mx-1 px-1 pb-1">
            <div className="min-w-[540px]">
              <div className="flex items-center gap-2 py-1.5 px-1 text-[10px] font-mono font-semibold uppercase tracking-[0.14em] text-faint">
                <span className="w-28 shrink-0">Command</span><span className="w-36 shrink-0">Aliases</span><span className="flex-1">Response</span><span className="w-28 shrink-0">Permission</span><span className="w-6 shrink-0" />
              </div>
              <div className="divide-y divide-line/20">
                {value.custom.map((command, index) => (
                  <div key={index} className="flex items-center gap-2 py-2">
                    <input value={command.command} onChange={(event) => updateCustom(index, { command: event.target.value })} placeholder="!cmd" className={`w-28 shrink-0 font-mono ${inputCls}`} />
                    <input value={Array.isArray(command.aliases) ? command.aliases.join(', ') : (command.aliases || '')} onChange={(event) => updateCustom(index, { aliases: event.target.value.split(',').map((alias) => alias.trim()) })} placeholder="!alias1, !alias2" className={`w-36 shrink-0 font-mono text-[11.5px] ${inputCls}`} />
                    <input value={command.response} onChange={(event) => updateCustom(index, { response: event.target.value })} placeholder="Response text…" className={`flex-1 ${inputCls}`} />
                    <select value={command.role} onChange={(event) => updateCustom(index, { role: event.target.value as CustomCommand['role'] })} className={`w-28 shrink-0 ${selectCls}`}>
                      <option value="all">Everyone</option><option value="moderator">Mods</option><option value="broadcaster">Broadcaster</option>
                    </select>
                    <button onClick={() => dispatch({ type: 'custom-command.removed', index })} title="Delete command" className="cursor-pointer text-faint hover:text-red-400 transition-colors p-1 shrink-0"><Trash2 size={13} /></button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      <ResetTabButton onReset={() => dispatch({ type: 'domain.reset', domain: 'commands' })} disabled={busy} />
    </div>
  );
}

