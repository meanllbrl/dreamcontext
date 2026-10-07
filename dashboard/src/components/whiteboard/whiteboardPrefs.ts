/**
 * The Whiteboard page's per-machine memory (open tabs and their groups, the last board, each
 * board's viewport, the agent panel), kept where a relaunch cannot wipe it.
 *
 * localStorage alone is not enough: the desktop app picks a fresh loopback port every launch,
 * so the origin and its localStorage are new each time and every tab came back closed (owner,
 * 2026-10-07). So each value is ALSO written through to the server
 * (`/api/whiteboard-prefs` → `state/.whiteboard-prefs.json`, gitignored, per project), and the
 * page reads it back once before it renders (`hydrateWhiteboardPrefs`). localStorage stays the
 * mirror: on a stable origin, or against an older server, it still carries the state.
 * See `knowledge/patterns/shared-local-config-split.md`.
 *
 * Reads stay synchronous (the tab strip writes and re-reads within one remount), so the
 * server's values live in memory per project. No React, no CSS: root vitest imports this file.
 */

export interface PrefsTransport {
  load(): Promise<unknown>;
  save(values: Record<string, string>): Promise<unknown>;
}

interface VaultPrefs {
  values: Record<string, string>;
  transport: PrefsTransport;
  timer: ReturnType<typeof setTimeout> | null;
}

const SAVE_DELAY_MS = 300;

const hydrated = new Map<string, VaultPrefs>();
const pending = new Map<string, Promise<void>>();

function lsGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function lsSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* best-effort: the server copy still holds */ }
}

/** Only string values survive a read back: anything else in the file is a hand edit. */
function stringValues(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
  return out;
}

/**
 * Read the project's saved values once per app run. Resolves either way: a failed read leaves
 * the project on localStorage only, and nothing is written to the server for it this run, so a
 * blip never replaces the file with an empty layout.
 */
export function hydrateWhiteboardPrefs(vault: string, transport: PrefsTransport): Promise<void> {
  if (hydrated.has(vault)) return Promise.resolve();
  let p = pending.get(vault);
  if (!p) {
    p = transport.load().then(
      (raw) => { hydrated.set(vault, { values: stringValues(raw), transport, timer: null }); },
      () => { /* older server or offline: localStorage only */ },
    ).finally(() => { pending.delete(vault); });
    pending.set(vault, p);
  }
  return p;
}

export function isWhiteboardPrefsHydrated(vault: string): boolean {
  return hydrated.has(vault);
}

/** The saved value: the server's copy once read, else this origin's localStorage. */
export function readWhiteboardPref(vault: string, key: string, localKey: string): string | null {
  const saved = hydrated.get(vault)?.values[key];
  return saved !== undefined ? saved : lsGet(localKey);
}

export function writeWhiteboardPref(vault: string, key: string, localKey: string, value: string): void {
  lsSet(localKey, value);
  const prefs = hydrated.get(vault);
  if (!prefs || prefs.values[key] === value) return;
  prefs.values[key] = value;
  if (prefs.timer) clearTimeout(prefs.timer);
  prefs.timer = setTimeout(() => flush(vault), SAVE_DELAY_MS);
}

function flush(vault: string): void {
  const prefs = hydrated.get(vault);
  if (!prefs?.timer) return;
  clearTimeout(prefs.timer);
  prefs.timer = null;
  prefs.transport.save({ ...prefs.values }).catch(() => { /* best-effort: localStorage holds it */ });
}

/** Send every write still waiting on its delay (the window is going away). */
export function flushWhiteboardPrefs(): void {
  for (const vault of hydrated.keys()) flush(vault);
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', flushWhiteboardPrefs);

/** Tests only: forget every project. */
export function resetWhiteboardPrefsForTest(): void {
  for (const prefs of hydrated.values()) if (prefs.timer) clearTimeout(prefs.timer);
  hydrated.clear();
  pending.clear();
}
