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
 * `lib/sleepy.ts`'s config; see `knowledge/patterns/shared-local-config-split.md`.
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
