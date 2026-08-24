import { useCallback, useLayoutEffect, useRef } from 'react';

const TOKEN_RE = /\{[a-zA-Z0-9_]+\}/g;

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlight(text: string, placeholder?: string) {
  if (!text) {
    return `<span style="color: #62676e;">${escapeHtml(placeholder || '')}</span>`;
  }
  return escapeHtml(text).replace(
    TOKEN_RE,
    (m) => `<span style="color: #a273ff; font-weight: 600;">${m}</span>`
  );
}

interface TokenInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  className?: string;
}

export default function TokenInput({
  value,
  onChange,
  placeholder,
  maxLength,
  inputRef,
  className = '',
}: TokenInputProps) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const taRef = inputRef || localRef;
  const mirrorRef = useRef<HTMLDivElement>(null);

  const autoResize = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const h = Math.max(34, el.scrollHeight);
    el.style.height = `${h}px`;
    if (mirrorRef.current) {
      mirrorRef.current.style.height = `${h}px`;
    }
  }, [taRef]);

  useLayoutEffect(() => {
    autoResize();
  }, [value, autoResize]);

  const syncScroll = useCallback(() => {
    if (!taRef.current || !mirrorRef.current) return;
    mirrorRef.current.scrollTop = taRef.current.scrollTop;
    mirrorRef.current.scrollLeft = taRef.current.scrollLeft;
  }, [taRef]);

  const sharedCls =
    'w-full px-2.5 py-1.5 font-mono text-[12px] leading-snug tracking-normal whitespace-pre-wrap break-words box-border rounded-md';

  return (
    <div
      className={`relative w-full rounded-md border border-line bg-bg transition-colors focus-within:border-accent/60 ${className}`}
    >
      {/* Pixel-perfect mirror layer */}
      <div
        ref={mirrorRef}
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 overflow-hidden border border-transparent bg-transparent text-ink select-none ${sharedCls}`}
        dangerouslySetInnerHTML={{ __html: highlight(value, placeholder) + '\n' }}
      />
      {/* Real native transparent textarea */}
      <textarea
        ref={taRef}
        rows={1}
        spellCheck={false}
        value={value}
        maxLength={maxLength}
        onChange={(e) => {
          onChange(e.target.value);
          autoResize();
        }}
        onScroll={syncScroll}
        className={`relative z-10 block resize-none overflow-hidden border border-transparent bg-transparent text-transparent caret-white outline-none selection:bg-accent/40 selection:text-transparent ${sharedCls}`}
      />
    </div>
  );
}
