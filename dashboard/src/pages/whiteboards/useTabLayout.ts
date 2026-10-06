import { useCallback, useRef, useState } from 'react';
import { useVault } from '../../context/VaultContext';
import { sanitizeLayout, type TabLayout } from './tabStripLogic';

/**
 * Which boards sit open as tabs, and how they are grouped, remembered per machine and per
 * project — like Chrome's tabs, a working arrangement rather than something the team shares.
 * Absent or unreadable → no tabs; the open board then takes the first one.
 */
const KEY_PREFIX = 'dreamcontext:whiteboard-tabs:';
const storageKey = (vault: string | null) => `${KEY_PREFIX}${vault ?? ''}`;

function readLayout(vault: string | null): TabLayout {
  try {
    const raw = localStorage.getItem(storageKey(vault));
    return sanitizeLayout(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizeLayout(null);
  }
}

export function useTabLayout(): [TabLayout, (update: (l: TabLayout) => TabLayout) => void] {
  const { vault } = useVault();
  const [layout, setLayout] = useState(() => readLayout(vault));
  const latest = useRef(layout);
  // Written NOW, not inside a state updater: closing the open tab also switches boards, which
  // remounts this strip before an updater would run, and the new strip reads storage.
  const change = useCallback((update: (l: TabLayout) => TabLayout) => {
    const cur = latest.current;
    const next = update(cur);
    if (next === cur) return;
    latest.current = next;
    try { localStorage.setItem(storageKey(vault), JSON.stringify(next)); } catch { /* best-effort */ }
    setLayout(next);
  }, [vault]);
  return [layout, change];
}
