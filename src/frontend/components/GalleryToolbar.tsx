import { LayoutGrid, Image as ImageIcon, Clapperboard, AudioLines, Search, X } from 'lucide-react';
import type { MediaType } from '../lib/types';

export type Filter = 'all' | MediaType;

interface Props {
  filter: Filter;
  onFilter: (f: Filter) => void;
  counts: Record<Filter, number>;
  query: string;
  onQuery: (q: string) => void;
}

const FILTERS: { id: Filter; label: string; icon: React.ReactElement }[] = [
  { id: 'all', label: 'All', icon: <LayoutGrid size={13} strokeWidth={2.2} /> },
  { id: 'image', label: 'Images', icon: <ImageIcon size={13} strokeWidth={2.2} /> },
  { id: 'video', label: 'Videos', icon: <Clapperboard size={13} strokeWidth={2.2} /> },
  { id: 'audio', label: 'Audio', icon: <AudioLines size={13} strokeWidth={2.2} /> },
];

export default function GalleryToolbar({ filter, onFilter, counts, query, onQuery }: Props) {
  return (
    <div className="shrink-0 border-b border-line bg-surface px-2 py-1.5 sm:px-3">
      <div className="flex flex-wrap items-center gap-1 rounded-full border border-line bg-bg p-1">
        {FILTERS.map((f) => {
          const active = filter === f.id;
          return (
            <button
              key={f.id}
              onClick={() => onFilter(f.id)}
              className={`flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors ${
                active
                  ? 'bg-accent text-bg shadow-[0_0_12px_rgba(162,115,255,0.35)]'
                  : 'text-muted hover:text-ink'
              }`}
            >
              {f.icon}
              <span className="hidden sm:inline">{f.label}</span>
              <span className={`font-mono text-[10px] ${active ? 'text-bg/70' : 'text-faint'}`}>
                {counts[f.id] ?? 0}
              </span>
            </button>
          );
        })}

        {/* inline scoped search */}
        <div className="flex min-w-[200px] flex-1 items-center gap-2 border-line pl-3 pr-1 sm:border-l">
          <Search size={13} className="shrink-0 text-faint" strokeWidth={2.2} />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search"
            className="min-w-0 flex-1 bg-transparent py-1.5 text-[12px] text-ink placeholder-faint outline-none"
          />
          {query && (
            <button
              onClick={() => onQuery('')}
              aria-label="Clear filter"
              className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted transition-colors hover:bg-raised hover:text-ink"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
