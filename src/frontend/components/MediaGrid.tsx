import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, CheckCircle2, Loader2 } from 'lucide-react';
import type { MediaItem } from '../lib/types';
import MediaTile from './MediaTile';
import AudioCard from './AudioCard';

const PAGE = 36; // items per fetch
const OVERSCAN = 3; // extra rows above/below the viewport
const GAP = 2;

interface Props {
  items: MediaItem[];
  resetKey?: string;
}

export default function MediaGrid({ items, resetKey }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const timerRef = useRef(0);
  const loadingRef = useRef(false);

  const [size, setSize] = useState({ w: 0, h: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [loaded, setLoaded] = useState(PAGE);
  const [loading, setLoading] = useState(false);

  /* reset the feed whenever filter/search query changes */
  useEffect(() => {
    window.clearTimeout(timerRef.current);
    loadingRef.current = false;
    setLoading(false);
    setLoaded(PAGE);
    scrollRef.current?.scrollTo({ top: 0 });
    setScrollTop(0);
  }, [resetKey]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  /* measure the scroll viewport — re-attaches when items transition from empty (async hydration) so the scroll node exists */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [items.length]);

  /* rAF-throttled scroll tracking */
  const onScroll = () => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => setScrollTop(scrollRef.current?.scrollTop ?? 0));
  };

  /* request more items */
  const requestMore = useCallback(() => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    timerRef.current = window.setTimeout(() => {
      setLoaded((l) => l + PAGE);
      loadingRef.current = false;
      setLoading(false);
    }, 200);
  }, []);

  /* sentinel observer */
  const hasMore = loaded < items.length;
  useEffect(() => {
    const root = scrollRef.current;
    const target = sentinelRef.current;
    if (!root || !target || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) requestMore();
      },
      { root, rootMargin: '900px 0px' }
    );
    io.observe(target);
    return () => io.disconnect();
  }, [loaded, items, hasMore, requestMore]);

  /* ---------------- virtualization math ---------------- */
  const visible = items.slice(0, Math.min(loaded, items.length));
  const cols = size.w >= 1080 ? 4 : size.w >= 620 ? 3 : 2;
  const tile = size.w > 0 ? (size.w - (cols - 1) * GAP) / cols : 0;
  const rowH = tile + GAP;
  const totalRows = Math.ceil(visible.length / cols);
  const gridH = Math.max(0, totalRows * rowH - GAP);

  const startRow = rowH > 0 ? Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN) : 0;
  const endRow = rowH > 0 ? Math.min(totalRows, Math.ceil((scrollTop + size.h) / rowH) + OVERSCAN) : 0;
  const startIdx = startRow * cols;
  const endIdx = Math.min(visible.length, endRow * cols);
  const slice = visible.slice(startIdx, endIdx);

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-muted">
        Nothing matches this filter.
      </div>
    );
  }

  return (
    <div className="relative h-full">
      <div ref={scrollRef} onScroll={onScroll} className="scroll-slim h-full overflow-y-auto overflow-x-hidden">
        {/* virtual canvas */}
        <div className="relative" style={{ height: gridH }}>
          {slice.map((item, i) => {
            const idx = startIdx + i;
            const row = Math.floor(idx / cols);
            const col = idx % cols;
            const style: React.CSSProperties = {
              position: 'absolute',
              top: row * rowH,
              left: col * (tile + GAP),
              width: tile,
              height: tile,
            };
            return (
              <div key={item.id} style={style}>
                {item.type === 'audio' ? (
                  <AudioCard item={item} index={col} />
                ) : (
                  <MediaTile item={item} index={col} />
                )}
              </div>
            );
          })}
        </div>

        {/* skeleton shimmer row while fetching */}
        {loading && hasMore && (
          <div
            className="grid"
            style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: GAP, marginTop: GAP }}
          >
            {Array.from({ length: cols }, (_, i) => (
              <div key={i} className="shimmer aspect-square" />
            ))}
          </div>
        )}

        {/* sentinel */}
        {hasMore && <div ref={sentinelRef} className="h-px" />}

        {/* end of feed */}
        {!hasMore && (
          <div className="flex flex-col items-center gap-2 py-10">
            <CheckCircle2 size={18} className="text-faint" />
            <p className="text-[12px] text-muted">
              {items.length.toLocaleString()} items
            </p>
            <button
              onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
              className="cursor-pointer rounded-full border border-line px-3.5 py-1.5 text-[11.5px] font-medium text-muted transition-colors hover:border-accent/50 hover:text-ink"
            >
              Back to top
            </button>
          </div>
        )}
      </div>

      {/* feed status HUD */}
      <div className="pointer-events-none absolute bottom-16 right-3 z-10 flex items-center gap-1.5 rounded-md border border-line bg-bg/90 px-2 py-1 font-mono text-[9.5px] text-muted lg:bottom-3">
        {loading && <Loader2 size={10} className="animate-spin text-accent" />}
        {Math.min(loaded, items.length).toLocaleString()} / {items.length.toLocaleString()} loaded
        <span className="text-faint">· {slice.length} in DOM</span>
      </div>

      {/* scroll-to-top FAB */}
      {scrollTop > 1400 && (
        <button
          onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
          aria-label="Back to top"
          className="absolute bottom-28 right-3 z-10 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-line bg-raised text-ink shadow-lg transition-colors hover:border-accent/50 lg:bottom-14"
        >
          <ArrowUp size={15} />
        </button>
      )}
    </div>
  );
}
