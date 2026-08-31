import { createContext, useContext, type ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import type { MediaItem } from '../lib/types';
import SourceLink from './SourceLink';

interface GalleryActionsContextValue {
  canDelete: boolean;
  requestDelete: (item: MediaItem) => void;
}

const GalleryActionsContext = createContext<GalleryActionsContextValue>({
  canDelete: false,
  requestDelete: () => {},
});

export function GalleryActionsProvider({
  canDelete,
  requestDelete,
  children,
}: GalleryActionsContextValue & { children: ReactNode }) {
  return (
    <GalleryActionsContext.Provider value={{ canDelete, requestDelete }}>
      {children}
    </GalleryActionsContext.Provider>
  );
}

export default function GalleryItemActions({ item }: { item: MediaItem }) {
  const { canDelete, requestDelete } = useContext(GalleryActionsContext);
  if (!item.src && !(canDelete && item.persistedId)) return null;

  return (
    <div className="gallery-actions absolute right-2 top-2 z-20 flex flex-col gap-1">
      {item.src && <SourceLink href={item.src} label={item.type} />}
      {canDelete && item.persistedId && (
        <button
          type="button"
          title="Delete from gallery history"
          aria-label="Delete from gallery history"
          onClick={(event) => {
            event.stopPropagation();
            requestDelete(item);
          }}
          onPointerDown={(event) => event.stopPropagation()}
          className="flex h-6 w-6 items-center justify-center rounded bg-black/55 text-red-300 transition-colors hover:bg-red-950/90 hover:text-red-200"
        >
          <Trash2 size={11} strokeWidth={2.2} />
        </button>
      )}
    </div>
  );
}
