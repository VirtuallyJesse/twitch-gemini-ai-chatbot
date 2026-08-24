import { useEffect, useRef, useState } from 'react';
import { Clapperboard, Play, Pause, ImageOff, VideoOff } from 'lucide-react';
import type { MediaItem } from '../lib/types';
import { fmtSecs } from '../lib/time';
import { claimPlayback } from '../lib/mediaBus';
import TileCaption from './TileCaption';
import SourceLink from './SourceLink';

function Fallback({ video }: { video?: boolean }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[#0c0d0f]">
      {video ? <VideoOff size={18} className="text-faint" /> : <ImageOff size={18} className="text-faint" />}
      <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-faint">Source unavailable</span>
    </div>
  );
}

/* ------------------------------- image ------------------------------- */

function ImageTile({ item }: { item: MediaItem }) {
  const [error, setError] = useState(false);
  return (
    <>
      {error || !item.src ? (
        <Fallback />
      ) : (
        <img
          src={item.src}
          alt={item.prompt}
          loading="lazy"
          onError={() => setError(true)}
          className="h-full w-full object-cover"
        />
      )}
    </>
  );
}

/* ------------------------------- video ------------------------------- */

function VideoTile({ item }: { item: MediaItem }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [dur, setDur] = useState(0);
  const [time, setTime] = useState(0);
  const [error, setError] = useState(false);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const tick = () => {
      setTime(v.currentTime);
      if (!v.paused) rafRef.current = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      setPlaying(true);
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };
    const onPause = () => {
      setPlaying(false);
      cancelAnimationFrame(rafRef.current);
      setTime(v.currentTime);
    };
    const onEnded = () => {
      setPlaying(false);
      cancelAnimationFrame(rafRef.current);
      setTime(0);
      v.currentTime = 0.01;
    };
    v.addEventListener('pause', onPause);
    v.addEventListener('play', onPlay);
    v.addEventListener('ended', onEnded);
    return () => {
      v.removeEventListener('pause', onPause);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('ended', onEnded);
      cancelAnimationFrame(rafRef.current);
      v.pause();
    };
  }, []);

  const toggle = () => {
    const v = videoRef.current;
    if (!v || error || !item.src) return;
    if (v.paused) {
      claimPlayback(v);
      void v.play();
    } else {
      v.pause();
    }
  };

  if (error || !item.src) return <Fallback video />;

  return (
    <>
      <video
        ref={videoRef}
        src={item.src}
        preload="metadata"
        playsInline
        onClick={toggle}
        onError={() => setError(true)}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          setDur(v.duration);
          if (v.currentTime === 0) v.currentTime = 0.01;
        }}
        className="h-full w-full cursor-pointer object-cover"
      />

      <span className="pointer-events-none absolute left-2 top-2 z-10 flex items-center gap-1 rounded bg-black/45 px-1.5 py-0.5 font-mono text-[9px] font-medium text-ink/90">
        <Clapperboard size={9} strokeWidth={2.4} />
        {time > 0.05 ? `${fmtSecs(time) || '0:00'} / ${fmtSecs(dur) || item.duration || '–:––'}` : fmtSecs(dur) || item.duration || '–:––'}
      </span>

      <button
        onClick={toggle}
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
  );
}

/* -------------------------------- card ------------------------------- */

export default function MediaTile({ item, index }: { item: MediaItem; index?: number }) {
  return (
    <article
      className="tile-in group relative h-full w-full overflow-hidden bg-surface-2 transition-[filter] duration-200 hover:brightness-[1.12]"
      style={index !== undefined ? { animationDelay: `${Math.min(index, 8) * 40}ms` } : undefined}
    >
      {item.type === 'image' ? <ImageTile item={item} /> : <VideoTile item={item} />}

      {item.src && <SourceLink href={item.src} label={item.type} />}

      <TileCaption item={item} />

      <span className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-transparent transition-colors duration-200 group-hover:ring-accent/40" />
    </article>
  );
}
