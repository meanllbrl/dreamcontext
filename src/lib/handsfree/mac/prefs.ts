/**
 * Mac mode's remembered choices (`~/.dreamcontext/handsfree-mac/prefs.json`, 0600). Unlike
 * `state.json`, which ends with the run and is cleared after a crash, this file outlives a
 * restart on purpose: the next start (panel or CLI) pre-sets from it. Uninstall removes it
 * with the rest of the Mac folder.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { MAC_BAG_MODE_DEFAULT } from './contract.js';

export interface MacPrefs {
  /** Bag mode: the thermal governor may slow heavy processes while the Mac is hot. */
  bagMode: boolean;
}

export function macPrefsPathOf(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'handsfree-mac', 'prefs.json');
}

/** The remembered choices; the defaults when the file is missing or unreadable. Never throws. */
export function readMacPrefs(home: string = homedir()): MacPrefs {
  try {
    const p = JSON.parse(readFileSync(macPrefsPathOf(home), 'utf8')) as Partial<MacPrefs> | null;
    if (p && typeof p.bagMode === 'boolean') return { bagMode: p.bagMode };
  } catch { /* none yet, or unreadable: the default */ }
  return { bagMode: MAC_BAG_MODE_DEFAULT };
}

/** Remember `prefs` (temp file + rename, 0600). A failed write is reported, never thrown:
 *  losing the remembered choice must not stop Mac mode from starting. */
export function writeMacPrefs(home: string, prefs: MacPrefs): void {
  const path = macPrefsPathOf(home);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ bagMode: prefs.bagMode }), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    console.warn('[handsfree-mac] could not save the bag-mode choice:', (err as Error)?.message ?? err);
  }
}
