/**
 * Launcher window preferences — currently just which surface it opens on.
 *
 * Why this is not plain `localStorage`: the desktop shell picks a FRESH loopback
 * port on every launch (`pick_free_port()` in desktop/src-tauri/src/lib.rs), so
 * the webview's origin changes and `localStorage` starts empty each time. A
 * choice kept only client-side is therefore forgotten on every restart — which
 * is exactly what happened to Space: you picked it, quit, and reopened in List.
 *
 * So the server file is the source of truth (`~/.dreamcontext/launcher-ui.json`,
 * app-global — the launcher has no vault to scope it to) and `localStorage` is
 * the synchronous, flash-free mirror for the rest of THIS launch. Same shape as
 * `lib/agentSettings.ts`'s config; see `knowledge/patterns/shared-local-config-split.md`.
 */
import { api } from '../api/client';

/** Which surface the launcher opens on. */
export type LauncherView = 'space' | 'list';

/**
 * List leads until Space has been CHOSEN — Space is the newer surface and has to
 * be picked before it becomes someone's launcher. But the choice is sticky in
 * both directions, and now across restarts too.
 */
export const DEFAULT_LAUNCHER_VIEW: LauncherView = 'list';

const VIEW_KEY = 'dreamcontext.launcher.view';

function coerce(v: unknown): LauncherView | null {
  return v === 'space' || v === 'list' ? v : null;
}

/**
 * The mirrored choice for this launch, or `null` when nothing has been mirrored
 * yet (a fresh origin). `null` is meaningfully different from the default: it
 * means "ask the server before you commit to a surface".
 */
export function readLauncherViewLocal(): LauncherView | null {
  try {
    return coerce(window.localStorage.getItem(VIEW_KEY));
  } catch {
    return null;
  }
}

function writeLocal(view: LauncherView): void {
  try {
    window.localStorage.setItem(VIEW_KEY, view);
  } catch {
    /* private mode — the server copy still carries it */
  }
}

/**
 * Persist the user's pick: `localStorage` synchronously (so other windows opened
 * in this launch see it immediately) plus the server file, which is what makes
 * it survive the next launch's new origin. Fire-and-forget on the network half.
 */
export function writeLauncherView(view: LauncherView): void {
  writeLocal(view);
  void api.post('/launcher/ui-settings', { view }).catch(() => {
    /* best-effort — older backend without the route */
  });
}

/**
 * Load the persisted view from the server and seed the local mirror with it.
 * Falls back to the mirror, then the default, if the route is absent.
 */
export async function initLauncherViewFromServer(): Promise<LauncherView> {
  try {
    const raw = await api.get<{ view?: unknown }>('/launcher/ui-settings');
    const view = coerce(raw.view) ?? DEFAULT_LAUNCHER_VIEW;
    writeLocal(view);
    return view;
  } catch {
    return readLauncherViewLocal() ?? DEFAULT_LAUNCHER_VIEW;
  }
}

// ─── The shell switch and the new shell's window layout ─────────────────────────────────
//
// Same file, same reason: `~/.dreamcontext/launcher-ui.json`. The server MERGES every POST
// over the stored file, so each writer here sends only its own keys: a `lastVault` write
// never pins `shell`, and the default flip (W3) still reaches installs that never chose.

/** Which shell the windows open in. Read by `lib/uxMode.ts` ONLY (source guard). */
export type ShellPref = 'classic' | 'new';

/** Mirrors `src/server/routes/launcher.ts` (drift test: launcher-prefs.test.ts). */
export const MAX_LAYOUT_PROJECTS = 200;
export const DRAWER_WIDTH_MIN = 200;
export const DRAWER_WIDTH_MAX = 480;

export interface LayoutPrefs {
  lastVault: string | null;
  projectOrder: string[];
  drawerExpanded: string[];
  drawerWidth: number | null;
  drawerOpen: boolean | null;
}

const NO_LAYOUT: LayoutPrefs = { lastVault: null, projectOrder: [], drawerExpanded: [], drawerWidth: null, drawerOpen: null };

/** What "never chosen" means since W3: the new shell. Re-exported by `uxMode.ts` as
 *  `DEFAULT_SHELL`; kept here so the Settings row and the gate cannot disagree. */
export const DEFAULT_SHELL_PREF: ShellPref = 'new';

let shellPref: ShellPref | null = null;
/** The server answered the read (a stored choice or none); false while unread or on a failure. */
let shellAnswered = false;
let layout: LayoutPrefs = NO_LAYOUT;
let settled: Promise<void> | null = null;

function names(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX_LAYOUT_PROJECTS) : [];
}

/** Read the server file once for this window: the launcher view's mirror, the shell switch and
 *  the layout. Later calls share the first answer. A missing route or a failed read settles as
 *  "nothing stored", which every reader treats as classic. */
export function initLauncherPrefsFromServer(): Promise<void> {
  if (!settled) {
    settled = api.get<Record<string, unknown>>('/launcher/ui-settings').then((raw) => {
      const view = coerce(raw.view);
      if (view) writeLocal(view);
      shellPref = raw.shell === 'new' || raw.shell === 'classic' ? raw.shell : null;
      shellAnswered = true;
      layout = {
        lastVault: typeof raw.lastVault === 'string' ? raw.lastVault : null,
        projectOrder: names(raw.projectOrder),
        drawerExpanded: names(raw.drawerExpanded),
        drawerWidth: typeof raw.drawerWidth === 'number' ? raw.drawerWidth : null,
        drawerOpen: typeof raw.drawerOpen === 'boolean' ? raw.drawerOpen : null,
      };
    }, () => { /* older backend or offline: nothing stored */ });
  }
  return settled;
}

/** Did the server answer the settle read? `uxMode.ts` only: "never chosen" is the default only
 *  when it is known, never when the file could not be read. */
export function readShellPrefAnswered(): boolean {
  return shellAnswered;
}

/** The stored switch as the server answered it (null = never chosen). `uxMode.ts` only. */
export function readShellPrefSettled(): ShellPref | null {
  return shellPref;
}

/** The new shell's layout as read at settle time, plus this window's own later writes. */
export function readLayoutPrefs(): LayoutPrefs {
  return layout;
}

/** Settings' "New layout" row. Returns the server's answer, so the save mark shows what was
 *  actually stored; takes effect when the app restarts (the gate is frozen per window). */
export async function writeShellMode(shell: ShellPref): Promise<ShellPref> {
  const res = await api.post<{ shell?: unknown }>('/launcher/ui-settings', { shell });
  if (res.shell !== 'new' && res.shell !== 'classic') throw new Error('shell not stored');
  return res.shell;
}

/** Fetch the stored switch fresh from the server (Settings reads the server, never a mirror). */
export async function fetchShellMode(): Promise<ShellPref> {
  const raw = await api.get<{ shell?: unknown }>('/launcher/ui-settings');
  // Never chosen reads as the default (ON since W3), the same rule the gate settles by.
  return raw.shell === 'new' || raw.shell === 'classic' ? raw.shell : DEFAULT_SHELL_PREF;
}

/** A device shell (the tunnel, a phone on the laptop listener) drives another machine's project
 *  set: its layout lives in memory for this page only, never read from or written to the Mac's
 *  file. Set by `uxMode.settleShellMode`, which owns the answer (one import direction). */
let deviceShellPrefs = false;
export function markDeviceShellPrefs(): void {
  deviceShellPrefs = true;
  pendingLayout = {};
  if (layoutTimer) clearTimeout(layoutTimer);
  layoutTimer = null;
}

let pendingLayout: Partial<LayoutPrefs> = {};
let layoutTimer: ReturnType<typeof setTimeout> | null = null;
export const LAYOUT_WRITE_DEBOUNCE_MS = 400;

/** Persist part of the layout. Server only (localStorage would not survive the next launch's
 *  origin), debounced: a drawer drag or a run of project switches writes once. */
export function writeLayoutPrefs(partial: Partial<LayoutPrefs>): void {
  layout = { ...layout, ...partial };
  // A device shell keeps its layout in memory only: nothing reaches the Mac's file.
  if (deviceShellPrefs) return;
  pendingLayout = { ...pendingLayout, ...partial };
  if (layoutTimer) clearTimeout(layoutTimer);
  layoutTimer = setTimeout(flushLayoutPrefs, LAYOUT_WRITE_DEBOUNCE_MS);
  armFlushOnHide();
}

function flushLayoutPrefs(): void {
  if (layoutTimer) clearTimeout(layoutTimer);
  layoutTimer = null;
  const body = pendingLayout;
  pendingLayout = {};
  if (!Object.keys(body).length) return;
  void api.post('/launcher/ui-settings', body).catch((err) => {
    console.warn('[launcher-ui] layout write failed:', err);
  });
}

/** A window closed inside the debounce (⌘Q right after a pick) still writes what it chose:
 *  `pagehide` sends the pending keys as a beacon, which outlives the page. */
let flushArmed = false;
function armFlushOnHide(): void {
  if (flushArmed || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  flushArmed = true;
  window.addEventListener('pagehide', () => {
    if (deviceShellPrefs || !Object.keys(pendingLayout).length) return;
    const body = JSON.stringify(pendingLayout);
    pendingLayout = {};
    if (layoutTimer) clearTimeout(layoutTimer);
    layoutTimer = null;
    try {
      navigator.sendBeacon('/api/launcher/ui-settings', new Blob([body], { type: 'application/json' }));
    } catch { /* the debounced write is the normal path; this is the last chance */ }
  });
}

/** Tests only. */
export function resetLauncherPrefsForTests(): void {
  shellPref = null;
  shellAnswered = false;
  layout = NO_LAYOUT;
  settled = null;
  pendingLayout = {};
  if (layoutTimer) clearTimeout(layoutTimer);
  layoutTimer = null;
  flushArmed = false;
  deviceShellPrefs = false;
}
