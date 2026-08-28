/**
 * Tauri-aware helpers. Every Tauri import is dynamic so the plain browser build
 * (and `npm run build`, which has no Tauri runtime) never fails when the desktop
 * APIs are absent. Outside the desktop app these fall back to web behaviour.
 */
import { checklistWindowLabel } from './checklistStore';
import { showWebviewConfirm } from './confirmDialog';

/** True only inside the Tauri v2 webview (the desktop shell). */
export function isDesktop(): boolean {
  return !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

/**
 * Interactive controls that a title-bar gesture must never hijack — a mousedown
 * on any of these starts neither a window drag nor a double-click maximize.
 * Single-sourced so the exempt set stays in lock-step across the three gestures.
 */
const DRAG_EXEMPT_SELECTOR = 'button, input, a, select, textarea, [role="button"], [data-no-drag]';

/** True when `target` is (or is inside) a control that title-bar gestures must ignore. */
function isDragExempt(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(DRAG_EXEMPT_SELECTOR) !== null;
}

/**
 * Cached `@tauri-apps/api/window` module. The drag gesture is latency-critical:
 * `startDragging()` only works while the mouse button is still down, and on a
 * quick flick the button is up within ~100ms — a cold dynamic import can lose
 * that race, making the drag silently do nothing. `startTitleBarDrag` warms this
 * on mousedown so the threshold-crossing call resolves from cache.
 */
let windowApiPromise: Promise<typeof import('@tauri-apps/api/window')> | null = null;
function windowApi(): Promise<typeof import('@tauri-apps/api/window')> {
  if (!windowApiPromise) {
    windowApiPromise = import('@tauri-apps/api/window');
    // A failed load must not poison every future gesture — retry next time.
    windowApiPromise.catch(() => { windowApiPromise = null; });
  }
  return windowApiPromise;
}

/**
 * Pre-load the window module without needing it yet. Call on pointer-DOWN in any
 * surface that may hand off to `dragWindowNow()` later in the same gesture:
 * `startDragging()` only works while the button is still held, and a cold dynamic
 * import can lose that race on a quick flick.
 */
export function warmWindowApi(): void {
  if (!isDesktop()) return;
  void windowApi().catch(() => { /* retried on the next gesture */ });
}

/**
 * Start dragging the current window from a title-bar mousedown.
 *
 * Why this exists instead of `data-tauri-drag-region`: our windows are created
 * with `dragDropEnabled: false` (so the Kanban / Eisenhower HTML5 drag-and-drop
 * works — see `openVaultWindow`). On Tauri v2 / wry that same flag also disables
 * the built-in `data-tauri-drag-region` handler, so the custom title bar became
 * un-draggable. We re-implement dragging manually: a left-button mousedown on
 * the bar (but NOT on an interactive control) calls `startDragging()`.
 *
 * No-op outside the desktop shell, so the web/dev build is unaffected.
 */
export async function startWindowDrag(target: EventTarget | null): Promise<void> {
  if (!isDesktop()) return;
  // Never hijack a click meant for a control (buttons, inputs, links, etc.).
  if (isDragExempt(target)) return;
  await dragWindowNow();
}

/**
 * Hand the current pointer-down straight to the native window drag, WITHOUT the
 * `[data-no-drag]` check.
 *
 * For surfaces that opt out of the page-wide drag handle because they own their
 * own pointer gestures, but that can still tell — from the gesture itself — that
 * this particular drag was meant for the window. The Space launcher is the case
 * this exists for: its sky spins on horizontal drag, so a vertical drag on empty
 * sky means nothing to it and moves the window instead (the Space covers the
 * whole launcher below the top bar, so without this there is almost nothing left
 * to grab). Callers own the "is this really a window drag?" decision.
 */
export async function dragWindowNow(): Promise<void> {
  if (!isDesktop()) return;
  try {
    const { getCurrentWindow } = await windowApi();
    await getCurrentWindow().startDragging();
  } catch (err) {
    // NEVER silent. This catch used to be bare, and it cost a real bug: the
    // Meeting Room window's label matched no capability, so `startDragging()`
    // was denied by the ACL and swallowed here — the window simply would not
    // move, with nothing in the console to say why. A permission gap is a
    // developer error, not an expected condition; it belongs on the record even
    // though the gesture itself must still fail soft.
    console.warn('[desktop] startDragging() was rejected — is this window label in a capability?', err);
  }
}

/**
 * Close the current window. Used by the relaunch flow: after the server has
 * detached the `open <app>` relauncher, closing this window quits the app so the
 * freshly-swapped bundle is what re-opens. `core:window:allow-close` is already
 * granted in the capability. No-op (and harmless) outside the desktop shell.
 */
export async function closeCurrentWindow(): Promise<void> {
  if (!isDesktop()) return;
  try {
    const { getCurrentWindow } = await windowApi();
    await getCurrentWindow().close();
  } catch { /* ACL / non-desktop — ignore */ }
}

/**
 * Close EVERY open app window so the app actually quits — the auto-relaunch flow
 * needs a real quit, and closing a single window doesn't quit a multi-window app
 * (launcher + one window per vault). After the server has armed its detached
 * `open <app>` relauncher, quitting tears down the stale server and the reopened
 * (swapped) bundle spawns a fresh one. Falls back to closing just this window if
 * the window list can't be enumerated. No-op off-desktop.
 */
export async function closeAllWindows(): Promise<void> {
  if (!isDesktop()) return;
  try {
    const mod = await import('@tauri-apps/api/webviewWindow');
    const WW = mod.WebviewWindow as unknown as { getAll?: () => Promise<Array<{ close: () => Promise<void> }>> };
    const wins = WW.getAll ? await WW.getAll() : [];
    if (wins.length > 0) {
      await Promise.all(wins.map((w) => w.close().catch(() => { /* already gone */ })));
      return;
    }
  } catch { /* fall through to single-window close */ }
  await closeCurrentWindow();
}

/**
 * Minimal structural shape of a mousedown event — satisfied by BOTH the DOM
 * `MouseEvent` and React's synthetic `MouseEvent`, so this module stays free of
 * React types while still being callable straight from a JSX `onMouseDown`.
 */
interface DragMouseEvent {
  button: number;
  target: EventTarget | null;
  clientX: number;
  clientY: number;
}

/**
 * Title-bar drag gesture, shared by the vault Header and the Launcher top bar.
 *
 * Drag starts ONLY after the pointer moves past a 4px threshold, so plain clicks
 * and double-clicks are NOT forwarded to the native window (which would trigger
 * native zoom on top of our own double-click-maximize). Interactive controls
 * (and anything marked `[data-no-drag]`) never start a drag. No-op off-desktop.
 */
export function startTitleBarDrag(e: DragMouseEvent): void {
  if (!isDesktop()) return;
  if (e.button !== 0) return;
  const target = e.target;
  if (isDragExempt(target)) return;
  // Warm the Tauri module NOW, while the pointer is still inside the 4px
  // threshold — by the time the drag actually starts the import is a cache hit,
  // so a fast flick can't out-race the module load.
  warmWindowApi();
  const sx = e.clientX;
  const sy = e.clientY;
  const onMove = (me: MouseEvent) => {
    if (Math.abs(me.clientX - sx) > 4 || Math.abs(me.clientY - sy) > 4) {
      cleanup();
      void startWindowDrag(target);
    }
  };
  const cleanup = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', cleanup);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', cleanup);
}

/** Toggle maximize on a title-bar double-click (standard macOS behaviour). */
export async function toggleMaximizeWindow(target: EventTarget | null): Promise<void> {
  if (!isDesktop()) return;
  if (isDragExempt(target)) return;
  try {
    const { getCurrentWindow } = await windowApi();
    await getCurrentWindow().toggleMaximize();
  } catch { /* ACL / non-desktop — ignore */ }
}

/**
 * Bounce the app's Dock icon to say "something here is blocked on you".
 *
 * `Critical` (not `Informational`) because the thing that raises this is a question
 * Claude cannot proceed past: macOS bounces the icon until you activate the app,
 * whereas Informational bounces exactly once and is easy to miss while you're in
 * another window. AppKit itself no-ops the request when dreamcontext is ALREADY the
 * active app and cancels it the moment you switch back, so there is nothing to
 * clear afterwards — the bounce only ever exists while you're away.
 *
 * macOS-shaped but not macOS-gated: on Windows the same call flashes the taskbar
 * button, which is the same message in that platform's language. No-op off-desktop.
 */
export async function bounceDockIcon(): Promise<void> {
  if (!isDesktop()) return;
  try {
    const { getCurrentWindow, UserAttentionType } = await windowApi();
    await getCurrentWindow().requestUserAttention(UserAttentionType.Critical);
  } catch { /* ACL / non-desktop — ignore */ }
}

/**
 * Post a native OS notification banner. Resolves `true` only when one was actually
 * handed to the OS, so callers can fall back to the browser's own Notification API.
 *
 * The permission dance is kept even though the plugin's DESKTOP backend answers both
 * `isPermissionGranted` and `requestPermission` with a flat "granted": macOS has no
 * per-app opt-in to ask for up front — whether a banner is drawn is decided at delivery
 * time by System Settings → Notifications for the bundled app. The calls are what the
 * browser and mobile backends genuinely need, and they cost one IPC round-trip.
 *
 * Delivery requires the BUNDLED `.app` (mac-notification-sys resolves the bundle
 * identifier through LaunchServices), so an unbundled `tauri dev` run may post nothing.
 * That's why this returns a boolean instead of throwing: the chime and the Dock bounce
 * still carry the signal on their own.
 */
export async function sendDesktopNotification(title: string, body: string): Promise<boolean> {
  if (!isDesktop()) return false;
  try {
    const { isPermissionGranted, requestPermission, sendNotification } =
      await import('@tauri-apps/plugin-notification');
    if (!(await isPermissionGranted()) && (await requestPermission()) !== 'granted') return false;
    sendNotification({ title, body });
    return true;
  } catch {
    return false; // plugin absent (older shell) / ACL — the chime and bounce still fired
  }
}

/**
 * Open the native macOS picker via the shell's own `pick_paths` command.
 *
 * NOT `@tauri-apps/plugin-dialog`: that plugin's rfd backend reads
 * `+[NSOpenPanel openPanel]` through a non-null-typed binding, so on the days
 * AppKit hands back nil it panicked — and the desktop shell builds with
 * `panic = "abort"`, so the whole app died mid-pick. `pick_paths` guards the nil
 * and rejects instead. Resolves to [] when the user cancels; rejects only when
 * the picker genuinely could not be shown — see {@link pickSafely}.
 */
async function pickNative(directory: boolean, multiple: boolean): Promise<string[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string[]>('pick_paths', { directory, multiple });
}

/**
 * The last reason the native picker refused to open, for call sites that have an
 * error channel to show it in (the rest degrade to "nothing got picked"). Set on
 * every failure and cleared on every successful open, so it always describes the
 * most recent attempt.
 */
let lastPickerError: string | null = null;

/** Message from the most recent failed picker attempt, or null if it worked. */
export function pickerError(): string | null {
  return lastPickerError;
}

export interface ConfirmOptions {
  /** The question, as the sheet's bold first line. */
  title: string;
  /** The consequence, in smaller type under it. Optional but usually the point. */
  body?: string;
  /** Label for the affirmative button (default "OK"). It is the DEFAULT button. */
  confirmLabel?: string;
  /** Label for the negative button (default "Cancel"). */
  cancelLabel?: string;
  /** Draw it as a critical alert — for deletes and anything unrecoverable. */
  destructive?: boolean;
}

/**
 * Ask the user to confirm, and resolve to whether they did.
 *
 * ALWAYS USE THIS INSTEAD OF `window.confirm` in dashboard code. `window.confirm`
 * is not merely discouraged here, it is BROKEN in the desktop app and broken
 * silently: wry's `WKUIDelegate` implements none of WebKit's JavaScript panel
 * methods, and WebKit's documented behaviour for a delegate that doesn't is to
 * show no dialog and return `false`. So `if (!window.confirm(…)) return;` inside
 * the app is an unconditional early return — the button does nothing, with no
 * error anywhere. In a browser tab the identical code works, which is exactly
 * why it survived so long.
 *
 * Inside the app this prefers the shell's native `confirm_dialog` sheet, which
 * looks and behaves like macOS. Everywhere else — and whenever that call fails —
 * it falls back to {@link showWebviewConfirm}, a dialog the dashboard renders
 * itself out of plain DOM.
 *
 * That fallback is the load-bearing part, not a browser nicety. The app shell is
 * INSTALLED separately from the dashboard, which the CLI serves over http and
 * updates on its own cadence, so a user on an older `.app` runs today's JS
 * against a shell where `invoke('confirm_dialog')` rejects with "command not
 * found". Falling back to `window.confirm` there put us straight back into the
 * dead-button failure above — every confirmation silently answering "no" — which
 * is exactly the bug reported against task delete. Owning the DOM means the
 * confirmation cannot depend on which shell build the user happens to have.
 *
 * Fails CLOSED throughout: a dismissal, an Escape, or a dialog that could not be
 * presented at all is `false`. A confirmation that cannot be shown must never
 * read as consent.
 */
export async function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  const { title, body, confirmLabel, cancelLabel, destructive } = opts;
  if (isDesktop()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<boolean>('confirm_dialog', {
        title,
        body,
        confirmLabel,
        cancelLabel,
        destructive,
      });
    } catch (err) {
      // An older shell has no such command. Expected, recoverable, and NOT a
      // reason to swallow the user's click — fall through to our own dialog.
      console.warn('[confirm] native confirmation unavailable, using the in-app dialog:', err);
    }
  }
  return showWebviewConfirm({ title, body, confirmLabel, cancelLabel, destructive });
}

/** Run a picker, recording — never throwing — a failure to present the panel. */
async function pickSafely(directory: boolean, multiple: boolean): Promise<string[]> {
  try {
    const picked = await pickNative(directory, multiple);
    lastPickerError = null;
    return picked;
  } catch (err) {
    lastPickerError = err instanceof Error ? err.message : String(err);
    console.error('[picker] native file picker failed:', lastPickerError);
    return [];
  }
}

/**
 * Pick a folder. In the desktop app this is the native macOS folder picker; in a
 * browser (dev) it falls back to a prompt so the flow is still exercisable.
 * Returns the chosen absolute path, or null if the user cancelled.
 */
export async function openFolderPicker(): Promise<string | null> {
  if (isDesktop()) {
    const [selected] = await pickSafely(true, false);
    return selected ?? null;
  }
  const entered = window.prompt('Enter an absolute path to a dreamcontext project:');
  return entered && entered.trim() ? entered.trim() : null;
}

/**
 * Pick one or more FILES via the native macOS file picker (multi-select), returning
 * their absolute paths. In the desktop app these are real on-disk paths — so callers
 * can hand them straight to a Claude session (no byte upload needed, unlike a webview
 * drag-drop which hides the OS path). In a browser (dev) it falls back to a prompt so
 * the flow stays exercisable. Returns [] if the user cancelled or picked nothing.
 */
export async function pickFiles(): Promise<string[]> {
  if (isDesktop()) return pickSafely(false, true);
  const entered = window.prompt('Enter absolute file path(s), comma-separated:');
  return entered ? entered.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Pick one or more FOLDERS via the native macOS picker (multi-select), returning their
 * absolute paths. A separate call from {@link pickFiles} because NSOpenPanel exposes
 * "choose directories" as a flag — one native panel cannot offer files AND folders
 * mixed. Returns [] if the user cancelled or picked nothing.
 */
export async function pickFolders(): Promise<string[]> {
  if (isDesktop()) return pickSafely(true, true);
  const entered = window.prompt('Enter absolute folder path(s), comma-separated:');
  return entered ? entered.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Structural shape of a freshly-built `WebviewWindow` — just the `once` we await.
 * Avoids a value import of the Tauri type into the plain browser build.
 */
interface CreatableWindow {
  once(event: string, cb: (e: { payload: unknown }) => void): Promise<unknown>;
}

/** Resolve once a new `WebviewWindow` reports created; reject on its error event. */
function awaitWindowCreated(win: CreatableWindow, what: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    void win.once('tauri://created', () => resolve());
    void win.once('tauri://error', (e) =>
      reject(new Error(`${what} window create failed: ${String(e.payload)}`)),
    );
  });
}

/**
 * Vault window label — single-sourced so a second caller can derive the SAME
 * target a vault window was actually created under without duplicating the
 * sanitizer (the checklist submit bridge does exactly this: it `emitTo`s a
 * vault window by label, and drift here would make a submit miss silently).
 *
 * Deliberately LOSSY: `vault-a.b` and `vault-a-b` already collide for window
 * REUSE, a pre-existing quirk of this sanitizer, not something to fix here —
 * tightening it would orphan the label of every currently-open vault window.
 */
export function vaultWindowLabel(name: string): string {
  return `vault-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

/**
 * Open a vault in its OWN window. Each project keeps a single persistent window:
 * if it's already open we FOCUS it (never spawn a duplicate), otherwise we build
 * it. Either way the caller's current window is left untouched — switching to
 * project A from project B must not close B. In a browser it opens a new tab
 * pinned to that vault via the `?vault=` param.
 */
export async function openVaultWindow(name: string): Promise<void> {
  const url = `/?vault=${encodeURIComponent(name)}`;
  if (isDesktop()) {
    // Use the BUILT-IN WebviewWindow API (governed by the granted
    // `core:webview:allow-create-webview-window` permission) rather than a custom
    // Rust command — custom commands are rejected by the ACL on remote-loaded
    // pages ("not allowed by ACL"), but core permissions pass.
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const label = vaultWindowLabel(name);
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      // Already open — surface the existing window instead of opening another.
      await existing.setFocus();
      return;
    }
    // Use an ABSOLUTE URL on the same origin (the Node dashboard server). A
    // relative URL would resolve against Tauri's bundled frontendDist
    // (the "starting…" placeholder), not the real dashboard.
    const win = new WebviewWindow(label, {
      url: `${window.location.origin}${url}`,
      title: `dreamcontext — ${name}`,
      width: 1280,
      height: 800,
      // macOS: transparent title bar so our own header IS the title bar and the
      // traffic-light buttons float over it (matches the launcher window).
      titleBarStyle: 'overlay',
      hiddenTitle: true,
      // Off by default Tauri turns on an OS-level drag/drop handler that
      // swallows the webview's HTML5 dragover/drop events — which breaks the
      // Kanban / Eisenhower task drag-and-drop. Disable it so DnD works.
      dragDropEnabled: false,
    });
    await awaitWindowCreated(win, `vault "${name}"`);
    return;
  }
  window.open(url, '_blank');
}

/**
 * Focus an already-open window by its REAL Tauri label — the one half of "this project is
 * already open in another window, surface it instead of opening it twice" that has to happen
 * over there rather than here. The label comes from `windowRegistry.ts`, not from
 * {@link vaultWindowLabel}: with several projects per window, a label derived from a vault
 * name no longer names the window that holds it.
 *
 * Resolves `false` on every miss — no such window, an ACL denial, or off-desktop — because
 * every one of those means the same thing to the caller ("couldn't surface it, do something
 * else"), and the registry it came from is allowed to be stale by design.
 */
export async function focusWindow(label: string): Promise<boolean> {
  if (!isDesktop() || !label) return false;
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const win = await WebviewWindow.getByLabel(label);
    if (!win) return false;
    await win.setFocus();
    return true;
  } catch {
    return false; // ACL / window died between the lookup and the focus
  }
}

/**
 * Open the pinned checklist window for one project's checklist `id`. Mirrors
 * `openVaultWindow` exactly: focus an already-open window instead of spawning a
 * duplicate, otherwise build a new always-on-top window at the same dashboard
 * origin. Runs under the narrow `checklist-window` capability (see
 * `desktop/src-tauri/capabilities/checklist.json`), not the app-wide default —
 * this is the one window that renders agent-authored markdown and can hold a
 * pasted secret, so it gets none of the shell/global-shortcut permissions the
 * default capability grants every other window.
 *
 * The window makes zero API calls and never calls `setActiveVault` — `vault`
 * here is purely a storage-key / event-target selector, read back out of the
 * URL by `ChecklistWindow` to look up its `ChecklistEnvelope` (checklistStore.ts).
 */
export async function openChecklistWindow(id: string, vault: string): Promise<void> {
  if (isDesktop()) {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const label = checklistWindowLabel(vault, id);
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      await existing.setFocus();
      return;
    }
    const win = new WebviewWindow(label, {
      url: `${window.location.origin}/?checklist=${encodeURIComponent(id)}&vault=${encodeURIComponent(vault)}`,
      title: 'dreamcontext — checklist',
      width: 380,
      height: 560,
      minWidth: 300,
      minHeight: 260,
      alwaysOnTop: true,
      resizable: true,
      titleBarStyle: 'overlay',
      hiddenTitle: true,
      dragDropEnabled: false,
    });
    await awaitWindowCreated(win, `checklist "${id}"`);
    return;
  }
  window.open(`/?checklist=${encodeURIComponent(id)}&vault=${encodeURIComponent(vault)}`, '_blank');
}

/**
 * The Meeting Room's window label. One room exists on the machine (one global thread store,
 * one orchestrator in the launcher-mode server), so the label is a constant and a second
 * click FOCUSES rather than opening a second view of the same thread.
 */
export const MEETING_WINDOW_LABEL = 'meeting-room';

/**
 * Open the Meeting Room in its OWN window.
 *
 * It used to be a modal over the launcher, which is where a modal is wrong: the room is a
 * conversation you leave running and come back to, and a modal made it something you dismiss
 * to do anything else — including looking at the very projects it is talking to. A window is
 * also what lets it hold the real chat composer at a real size.
 *
 * Mirrors {@link openVaultWindow} rather than {@link openChecklistWindow}: this is a full
 * conversation surface, not a pinned strip, so it gets a normal resizable window with the
 * app's own header as its title bar — and NOT `alwaysOnTop`, which is the checklist's whole
 * reason for existing and would be an imposition here.
 */
export async function openMeetingWindow(): Promise<void> {
  if (isDesktop()) {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const existing = await WebviewWindow.getByLabel(MEETING_WINDOW_LABEL);
    if (existing) {
      await existing.setFocus();
      return;
    }
    const win = new WebviewWindow(MEETING_WINDOW_LABEL, {
      url: `${window.location.origin}/?meeting=1`,
      title: 'dreamcontext — Meeting Room',
      width: 900,
      height: 720,
      minWidth: 560,
      minHeight: 420,
      titleBarStyle: 'overlay',
      hiddenTitle: true,
      // Same reason as every other window here: Tauri's OS-level drop handler swallows the
      // webview's own dragover/drop events.
      dragDropEnabled: false,
    });
    await awaitWindowCreated(win, 'meeting room');
    return;
  }
  window.open('/?meeting=1', '_blank');
}

/**
 * Return to the Launcher (home) window — used by the ⌘P switcher's "Launcher" row.
 *
 * The Launcher is the persistent `main` window Rust builds at startup. If it's
 * still open we FOCUS it (never spawn a second launcher); if the user closed it
 * we rebuild it with the same options as the Rust-built original. Crucially we do
 * NOT navigate the current window — going home from a vault window must leave that
 * vault window open. In a browser (dev) there's only one tab, so we navigate it.
 */
export async function openLauncherHome(): Promise<void> {
  if (isDesktop()) {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const existing = await WebviewWindow.getByLabel('main');
    if (existing) {
      await existing.setFocus();
      return;
    }
    // Launcher was closed — rebuild it (mirrors the `main` window in lib.rs).
    const win = new WebviewWindow('main', {
      url: `${window.location.origin}/`,
      title: 'dreamcontext',
      width: 1280,
      height: 800,
      titleBarStyle: 'overlay',
      hiddenTitle: true,
      dragDropEnabled: false,
    });
    await awaitWindowCreated(win, 'launcher');
    return;
  }
  window.location.assign(`${window.location.origin}/`);
}

/** How a window that can hold chips takes over {@link goToProject}. */
type GoToProjectHandler = (vault: string) => Promise<void>;

/**
 * Set by whichever `WindowChrome` is mounted in THIS window; null in the launcher, the
 * capture bar, the perch and the checklist window, none of which hold projects.
 */
let goToProjectHandler: GoToProjectHandler | null = null;

/**
 * Register (or clear, with `null`) the in-window handler for {@link goToProject}.
 *
 * A registration seam rather than a direct call because this module is deliberately not
 * React: it is imported by plain libraries and by the launcher bundle, so it cannot reach
 * `useChrome()` — and importing chrome state here would drag the whole instance tree into
 * every file that just wants to open a folder picker. `WindowChrome` registers on mount and
 * clears on unmount; a window that registers nothing keeps the old behaviour untouched.
 */
export function setGoToProjectHandler(fn: GoToProjectHandler | null): void {
  goToProjectHandler = fn;
}

/**
 * Go to a project from the ⌘P switcher.
 *
 * The default INVERTED when one window started holding several projects: going to a project
 * now means adding a chip HERE (the registered handler), not spawning a second OS window for
 * it. A separate window is still reachable — it is just an explicit choice now (⇧-click in the
 * switcher, or a chip's "Open in New Window"), both of which call {@link openVaultWindow}
 * directly rather than coming through here.
 *
 * With no handler registered — the launcher window, and any surface that holds no projects —
 * this falls back to exactly what it always did, which is what the launcher needs: it has no
 * chip strip to add to, so picking a project there must open that project's own window.
 */
export async function goToProject(name: string): Promise<void> {
  if (goToProjectHandler) {
    await goToProjectHandler(name);
    return;
  }
  await openVaultWindow(name);
}

/**
 * Hand a URL to the user's default browser.
 *
 * In the desktop app this MUST leave the webview: the shell has no address bar, no
 * back button and no tabs, so a URL opened in-place replaces the app with a web page
 * the user cannot navigate back from. `plugin:shell|open` is the OS-level opener
 * (`shell:allow-open` is granted in `capabilities/default.json`); its Tauri-side
 * validator accepts `http`, `https`, `mailto` and `tel` only, so no `file://` or
 * `javascript:` URL can reach the OS through it.
 *
 * Invoked directly rather than through `@tauri-apps/plugin-shell` because the Rust
 * plugin is already a dependency while its JS wrapper is not — and the wrapper does
 * exactly this call. In a browser it opens a new tab, which is the same intent.
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (isDesktop()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('plugin:shell|open', { path: url });
      return;
    } catch { /* plugin/ACL unavailable — fall through to the web behaviour */ }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
