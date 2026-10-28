import { useCallback, useRef, useState } from 'react';
import { useVault } from '../../context/VaultContext';
import { readWhiteboardPref, writeWhiteboardPref } from '../../components/whiteboard/whiteboardPrefs';
import { sanitizeExplorerPrefs, type ExplorerPrefs } from './explorerLogic';

/**
 * The board explorer's memory (open, collapsed groups, pins, recents, empty groups), per
 * machine and per project, in whiteboardPrefs.ts beside the tab layout, so it survives the
 * desktop app's relaunch. Written NOW, not inside a state updater, as useTabLayout does.
 */
const KEY_PREFIX = 'dreamcontext:whiteboard-explorer:';
const PREF_KEY = 'explorer';
const storageKey = (vault: string | null) => `${KEY_PREFIX}${vault ?? ''}`;

function readPrefs(vault: string | null): ExplorerPrefs {
  try {
    const raw = readWhiteboardPref(vault ?? '', PREF_KEY, storageKey(vault));
    return sanitizeExplorerPrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizeExplorerPrefs(null);
  }
}

export function useExplorerPrefs(): [ExplorerPrefs, (update: (p: ExplorerPrefs) => ExplorerPrefs) => void] {
  const { vault } = useVault();
  const [prefs, setPrefs] = useState(() => readPrefs(vault));
  const latest = useRef(prefs);
  const change = useCallback((update: (p: ExplorerPrefs) => ExplorerPrefs) => {
    const cur = latest.current;
    const next = update(cur);
    if (next === cur) return;
    latest.current = next;
    writeWhiteboardPref(vault ?? '', PREF_KEY, storageKey(vault), JSON.stringify(next));
    setPrefs(next);
  }, [vault]);
  return [prefs, change];
}
