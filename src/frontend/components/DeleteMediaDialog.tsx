import { Loader2 } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import type { MediaItem } from '../lib/types';

export interface DeleteMediaDialogState {
  target: MediaItem;
  pending: boolean;
  error: string | null;
}

export default function DeleteMediaDialog({
  state,
  onCancel,
  onConfirm,
}: {
  state: DeleteMediaDialogState | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AnimatePresence>
      {state && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="fixed inset-0 z-60 flex items-center justify-center bg-black/70 p-4"
          onClick={() => {
            if (!state.pending) onCancel();
          }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-media-title"
            aria-describedby="delete-media-description"
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-[340px] space-y-4 rounded-2xl border border-line bg-surface p-6 text-center shadow-2xl"
          >
            <div className="space-y-1.5">
              <h2 id="delete-media-title" className="text-[16px] font-bold text-ink">Delete this gallery item?</h2>
              <p id="delete-media-description" className="text-[12.5px] leading-relaxed text-muted">
                This cannot be undone.
              </p>
            </div>
            {state.error && (
              <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11.5px] text-red-400">
                {state.error}
              </div>
            )}
            <div className="space-y-2 pt-2">
              <button
                type="button"
                onClick={onCancel}
                disabled={state.pending}
                className="w-full rounded-full bg-accent py-2.5 text-[12.5px] font-semibold text-bg transition hover:brightness-110 disabled:bg-raised disabled:text-muted"
              >
                Keep item
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={state.pending}
                className="flex w-full items-center justify-center gap-1.5 rounded-full border border-red-500/30 py-2.5 text-[12.5px] font-medium text-red-400 transition hover:border-red-500/50 hover:bg-red-500/10 disabled:border-line disabled:text-muted"
              >
                {state.pending ? <><Loader2 size={12} className="animate-spin" />Deleting…</> : 'Delete permanently'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
