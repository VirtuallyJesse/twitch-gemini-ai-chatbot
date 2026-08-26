import type { ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';

export const inputCls =
  'rounded-md border border-line bg-bg px-2.5 py-1.5 text-[12px] text-ink placeholder-faint outline-none focus:border-accent/60';
export const selectCls =
  'cursor-pointer rounded-md border border-line bg-bg px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent/60';

export function Toggle({ on, onChange }: { on: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      role="switch"
      type="button"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors ${on ? 'bg-accent' : 'bg-raised'}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-ink transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
      {children}
    </h3>
  );
}

export function FieldRow({ label, hint, noBorder, children }: {
  label: string;
  hint?: string;
  noBorder?: boolean;
  children: ReactNode;
}) {
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

export function ResetTabButton({ onReset, disabled }: { onReset: () => void; disabled?: boolean }) {
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

