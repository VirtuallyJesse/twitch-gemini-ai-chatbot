import { useSyncExternalStore } from 'react';
import type { ConfigEditor } from './ConfigEditor';

export function useConfigEditor(editor: ConfigEditor) {
  return useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
}

