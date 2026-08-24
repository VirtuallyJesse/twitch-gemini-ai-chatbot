import { ExternalLink } from 'lucide-react';

/* Top-right hotlink to the original, uncropped media file. */
export default function SourceLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open source ${label}`}
      aria-label={`Open source ${label} in a new tab`}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute right-2 top-2 z-20 flex h-6 w-6 items-center justify-center rounded bg-black/45 text-ink/70 opacity-0 transition-opacity duration-200 hover:bg-black/70 hover:text-ink group-hover:opacity-100"
    >
      <ExternalLink size={11} strokeWidth={2.2} />
    </a>
  );
}
