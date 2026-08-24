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

  const [size, setSize] = useState(() => ({
    w: typeof window !== 'undefined' ? Math.max(320, window.innerWidth - 420) : 800,
    h: typeof window !== 'undefined' ? Math.max(400, window.innerHeight - 120) : 600,
  }));
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

  /* measure the scroll viewport */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const measure = () => {
      const w = el.clientWidth || (typeof window !== 'undefined' ? window.innerWidth - 420 : 800);
      const h = el.clientHeight || (typeof window !== 'undefined' ? window.innerHeight - 120 : 600);
      if (w > 0 && h > 0) {
        setSize({ w, h });
      }
    };

    measure();

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cr = entry.contentRect;
        const w = cr.width || el.clientWidth;
        const h = cr.height || el.clientHeight;
        if (w > 0 && h > 0) {
          setSize({ w, h });
        }
      }
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
  const effectiveW = size.w > 0 ? size.w : (typeof window !== 'undefined' ? Math.max(320, window.innerWidth - 420) : 800);
  const effectiveH = size.h > 0 ? size.h : (typeof window !== 'undefined' ? Math.max(400, window.innerHeight - 120) : 600);

  const visible = items.slice(0, Math.min(loaded, items.length));
  const cols = effectiveW >= 1080 ? 4 : effectiveW >= 620 ? 3 : 2;
  const tile = Math.max(80, (effectiveW - (cols - 1) * GAP) / cols);
  const rowH = tile + GAP;
  const totalRows = Math.ceil(visible.length / cols);
  const gridH = Math.max(0, totalRows * rowH - GAP);

  const startRow = rowH > 0 ? Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN) : 0;
  const endRow = rowH > 0 ? Math.min(totalRows, Math.ceil((scrollTop + effectiveH) / rowH) + OVERSCAN) : 0;
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
    <div className="relative h-full w-full">
      <div ref={scrollRef} onScroll={onScroll} className="scroll-slim h-full w-full overflow-y-auto">
        {/* virtual canvas */}
        <div className="relative w-full" style={{ height: gridH }}>
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
