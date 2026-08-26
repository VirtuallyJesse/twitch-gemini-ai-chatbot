import { Lightbulb, RotateCcw } from 'lucide-react';
import type { ConfigIntent } from '../../config/ConfigEditor';

interface Props {
  value: string;
  busy: boolean;
  dispatch: (intent: ConfigIntent) => void;
}

export default function PersonaTab({ value, busy, dispatch }: Props) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col space-y-2.5">
      <div className="flex items-center justify-between gap-3 shrink-0 mb-0.5">
        <div className="flex items-center gap-1.5 text-[11.5px] text-muted min-w-0">
          <Lightbulb size={12} className="shrink-0 text-amber-400" />
          <span>
            <strong className="font-medium text-ink">Tip:</strong> Wrap groups of rules in <code className="font-mono text-accent">&lt;tags&gt;</code> for best results.
          </span>
        </div>
        <span className="shrink-0 font-mono text-[11px] text-faint">
          {value.length.toLocaleString()} / 16,000 chars
        </span>
      </div>
      <textarea
        value={value}
        onChange={(event) => dispatch({ type: 'persona.changed', value: event.target.value.slice(0, 16000) })}
        placeholder="Describe who the bot is and how it talks…"
        className="scroll-slim flex-1 w-full min-h-0 rounded-lg border border-line bg-bg p-3.5 font-mono text-[12px] leading-relaxed text-ink outline-none focus:border-accent/60 resize-none"
      />
      <div className="flex justify-start pt-1 shrink-0">
        <button
          type="button"
          onClick={() => dispatch({ type: 'domain.reset', domain: 'system_instructions' })}
          disabled={busy}
          className="flex cursor-pointer items-center gap-1.5 text-[11.5px] font-medium text-faint hover:text-ink transition-colors disabled:opacity-50"
        >
          <RotateCcw size={11} />
          Reset tab to defaults
        </button>
      </div>
    </div>
  );
}

