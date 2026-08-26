import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { ConfigIntent } from '../../config/ConfigEditor';
import type { ErrorMessagesConfig } from '../../lib/types';
import { inputCls, ResetTabButton, SectionTitle } from './SettingsPrimitives';

let errorsGateUnlockedSession = false;

interface Props {
  value: ErrorMessagesConfig;
  busy: boolean;
  dispatch: (intent: ConfigIntent) => void;
}

export default function ErrorsTab({ value, busy, dispatch }: Props) {
  const [unlocked, setUnlocked] = useState(errorsGateUnlockedSession);
  const [filter, setFilter] = useState('');

  if (!unlocked) {
    return (
      <div className="flex h-full min-h-[380px] flex-col items-center justify-center py-12 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-amber-400/30 bg-amber-400/10 mb-3.5">
          <AlertTriangle size={24} className="text-amber-400" />
        </div>
        <h3 className="text-[15px] font-semibold text-ink">Custom error messages</h3>
        <p className="mt-1.5 max-w-[340px] text-[12px] leading-relaxed text-muted">
          These are sent to chat when something breaks. Editing them changes what viewers see.
        </p>
        <button
          onClick={() => {
            errorsGateUnlockedSession = true;
            setUnlocked(true);
          }}
          className="mt-5 inline-flex cursor-pointer items-center justify-center rounded-lg bg-accent px-6 py-2 text-[13px] font-semibold text-bg transition hover:brightness-110"
        >
          Edit anyway
        </button>
      </div>
    );
  }

  const entries = Object.entries(value).filter(([key]) => !filter || key.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <SectionTitle>Messages</SectionTitle>
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search error keys…" className={`w-48 ${inputCls}`} />
      </div>
      {entries.length === 0 ? (
        <div className="py-8 text-center text-[12px] text-muted">No error keys match "{filter}".</div>
      ) : (
        <div className="divide-y divide-line/20">
          {entries.map(([key, message]) => (
            <div key={key} className="py-2.5 space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] font-semibold text-accent">{key}</span>
              </div>
              <input
                value={message}
                onChange={(event) => dispatch({ type: 'error-message.changed', key, value: event.target.value })}
                placeholder="Message sent to chat…"
                className={`w-full ${inputCls}`}
              />
            </div>
          ))}
        </div>
      )}
      <ResetTabButton onReset={() => dispatch({ type: 'domain.reset', domain: 'error_messages' })} disabled={busy} />
    </div>
  );
}

