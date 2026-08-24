import { useEffect, useRef, useState } from 'react';
import { AudioLines, Play, Pause, VolumeX } from 'lucide-react';
import type { MediaItem } from '../lib/types';
import { AUDIO_TINT_HUES } from '../lib/audioTint';
import { fmtSecs } from '../lib/time';
import { claimPlayback } from '../lib/mediaBus';
import TileCaption from './TileCaption';
import SourceLink from './SourceLink';

/* flat wash mixing — base wash for the card body, stronger mix for the
   progress bars; chrome (pills, edges) stays uniform with image/video tiles */
function tint(hue: string, amount: number, base = '#141518'): string {
  const h = parseInt(hue.slice(1), 16);
  const b = parseInt(base.slice(1), 16);
  const mix = (a: number, c: number) => Math.round(c + (a - c) * amount);
  return `rgb(${mix((h >> 16) & 255, (b >> 16) & 255)},${mix((h >> 8) & 255, (b >> 8) & 255)},${mix(h & 255, b & 255)})`;
}

/* decode once per src, cache peaks across mounts/filter changes */
const peaksCache = new Map<string, number[]>();
const BARS = 48;

function usePeaks(src: string): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(() => peaksCache.get(src) ?? null);
  useEffect(() => {
    if (!src) return;
    if (peaksCache.has(src)) {
      setPeaks(peaksCache.get(src)!);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(src);
        const buf = await res.arrayBuffer();
        const AudioCtx = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx(1, 1, 22050);
        const decoded = await ctx.decodeAudioData(buf);
        const data = decoded.getChannelData(0);
        const step = Math.floor(data.length / BARS);
        const raw = Array.from({ length: BARS }, (_, i) => {
          let max = 0;
          const start = i * step;
          for (let j = start; j < start + step; j += 8) {
            const v = Math.abs(data[j]);
            if (v > max) max = v;
          }
          return max;
        });
        const top = Math.max(...raw, 0.01);
        const norm = raw.map((p) => Math.max(0.06, p / top));
        peaksCache.set(src, norm);
        if (!cancelled) setPeaks(norm);
      } catch {
        /* placeholder bars remain; playback still works */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src]);
  return peaks;
}

export default function AudioCard({
  item,
  index,
  tintIndex,
}: {
  item: MediaItem;
  index?: number;
  tintIndex: number;
}) {
  const hue = AUDIO_TINT_HUES[tintIndex];
  const src = item.src || '';
  const peaks = usePeaks(src);

  const audioRef = useRef<HTMLAudioElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const dragging = useRef(false);

  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [time, setTime] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState(false);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onMeta = () => {
      if (isFinite(a.duration) && a.duration > 0) {
        setTotal(a.duration);
      }
    };
    const onEnd = () => {
      setPlaying(false);
      setProgress(0);
      setTime(0);
      a.currentTime = 0;
    };
    const onPause = () => setPlaying(false);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('ended', onEnd);
    a.addEventListener('pause', onPause);
    return () => {
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('ended', onEnd);
      a.removeEventListener('pause', onPause);
      cancelAnimationFrame(rafRef.current);
      a.pause();
    };
  }, []);

  const tick = () => {
    const a = audioRef.current;
    if (!a) return;
    setTime(a.currentTime);
    const dur = isFinite(a.duration) && a.duration > 0 ? a.duration : total;
    setProgress(dur > 0 ? Math.min(1, a.currentTime / dur) : 0);
    if (!a.paused) rafRef.current = requestAnimationFrame(tick);
  };

  const toggle = () => {
    const a = audioRef.current;
    if (!a || error || !src) return;
    if (a.paused) {
      claimPlayback(a);
      void a.play();
      setPlaying(true);
      rafRef.current = requestAnimationFrame(tick);
    } else {
      a.pause();
      setPlaying(false);
    }
  };

  const seekFromEvent = (clientX: number) => {
    const a = audioRef.current;
    const el = stageRef.current;
    const dur = isFinite(a?.duration ?? NaN) && (a?.duration ?? 0) > 0 ? a!.duration : total;
    if (!a || !el || dur <= 0) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    a.currentTime = ratio * dur;
    setProgress(ratio);
    setTime(a.currentTime);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    seekFromEvent(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging.current) seekFromEvent(e.clientX);
  };
  const onPointerUp = () => {
    dragging.current = false;
  };

  const bars = peaks ?? Array.from({ length: BARS }, () => 0.12);
  const timeLabel =
    time > 0 ? `${fmtSecs(time) || '0:00'} / ${fmtSecs(total) || item.duration || '–:––'}` : fmtSecs(total) || item.duration || '–:––';

  return (
    <article
      onClick={toggle}
      className="tile-in group relative h-full w-full cursor-pointer overflow-hidden transition-[filter] duration-200 hover:brightness-[1.12]"
      style={{
        animationDelay: index !== undefined ? `${Math.min(index, 8) * 40}ms` : undefined,
        background: tint(hue, 0.11),
      }}
    >
      <audio ref={audioRef} src={src} preload="metadata" onError={() => setError(true)} />

      {/* duration pill */}
      <span
        className="pointer-events-none absolute left-2 top-2 z-10 flex items-center gap-1 rounded bg-black/45 px-1.5 py-0.5 font-mono text-[9px] font-medium text-ink/90"
      >
        <AudioLines size={9} strokeWidth={2.4} />
        {timeLabel}
      </span>

      {src && <SourceLink href={src} label="audio" />}

      {error || !src ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
          <VolumeX size={18} className="text-faint" />
          <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-faint">Source unavailable</span>
        </div>
      ) : (
        <>
          {/* waveform stage */}
          <div
            ref={stageRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onClick={(e) => e.stopPropagation()}
            className="absolute inset-x-0 top-1/2 h-[52%] -translate-y-1/2 cursor-ew-resize touch-none select-none"
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            {/* bars */}
            <div className="pointer-events-none absolute inset-x-3 inset-y-0 flex items-center gap-[2px]">
              {bars.map((p, i) => {
                const played = (i + 0.5) / BARS <= progress;
                return (
                  <span
                    key={i}
                    className="min-w-[2px] flex-1 rounded-[1px]"
                    style={{
                      height: `${p * 100}%`,
                      background: played ? hue : tint(hue, 0.3, '#4a505a'),
                      opacity: peaks === null ? (played ? 0.8 : 0.25) : played ? 1 : 0.55,
                    }}
                  />
                );
              })}
            </div>
          </div>

          {/* transport */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggle();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label={playing ? 'Pause' : 'Play'}
            className={`absolute left-1/2 top-1/2 z-10 flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-black/60 text-ink backdrop-blur-[2px] transition-opacity duration-200 hover:bg-black/75 ${
              playing ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'
            }`}
          >
            {playing ? (
              <Pause size={15} fill="currentColor" />
            ) : (
              <Play size={15} fill="currentColor" className="ml-0.5" />
            )}
          </button>
        </>
      )}

      <TileCaption item={item} />

      <span className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-transparent transition-colors duration-200 group-hover:ring-accent/40" />
    </article>
  );
}
