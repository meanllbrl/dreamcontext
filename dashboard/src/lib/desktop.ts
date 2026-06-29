/**
 * Tauri-aware helpers. Every Tauri import is dynamic so the plain browser build
 * (and `npm run build`, which has no Tauri runtime) never fails when the desktop
 * APIs are absent. Outside the desktop app these fall back to web behaviour.
 */

/** True only inside the Tauri v2 webview (the desktop shell). */
export function isDesktop(): boolean {
  return !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
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
  if (target instanceof Element && target.closest('button, input, a, select, textarea, [role="button"], [data-no-drag]')) {
    return;
  }
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().startDragging();
  } catch { /* ACL / non-desktop — ignore */ }
}

/** Toggle maximize on a title-bar double-click (standard macOS behaviour). */
export async function toggleMaximizeWindow(target: EventTarget | null): Promise<void> {
  if (!isDesktop()) return;
  if (target instanceof Element && target.closest('button, input, a, select, textarea, [role="button"], [data-no-drag]')) {
    return;
  }
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().toggleMaximize();
  } catch { /* ACL / non-desktop — ignore */ }
}

/**
 * Pick a folder. In the desktop app this is the native macOS folder picker via
 * the Tauri dialog plugin; in a browser (dev) it falls back to a prompt so the
 * flow is still exercisable. Returns the chosen absolute path, or null if the
 * user cancelled.
 */
export async function openFolderPicker(): Promise<string | null> {
  if (isDesktop()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ directory: true, multiple: false });
    // The plugin returns string | string[] | null; we requested a single dir.
    if (typeof selected === 'string') return selected;
    return null;
  }
  const entered = window.prompt('Enter an absolute path to a dreamcontext project:');
  return entered && entered.trim() ? entered.trim() : null;
}

/**
 * Open a vault in its OWN window. In the desktop app this invokes the Rust
 * `open_vault` command (which builds / focuses a dedicated WebviewWindow); in a
 * browser it opens a new tab pinned to that vault via the `?vault=` param.
 */
export async function openVaultWindow(name: string): Promise<void> {
  if (isDesktop()) {
    // Use the BUILT-IN WebviewWindow API (governed by the granted
    // `core:webview:allow-create-webview-window` permission) rather than a custom
    // Rust command — custom commands are rejected by the ACL on remote-loaded
    // pages ("not allowed by ACL"), but core permissions pass.
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const label = `vault-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      await existing.setFocus();
      return;
    }
    // Use an ABSOLUTE URL on the same origin (the Node dashboard server). A
    // relative URL would resolve against Tauri's bundled frontendDist
    // (the "starting…" placeholder), not the real dashboard.
    const win = new WebviewWindow(label, {
      url: `${window.location.origin}/?vault=${encodeURIComponent(name)}`,
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
    await new Promise<void>((resolve, reject) => {
      win.once('tauri://created', () => resolve());
      win.once('tauri://error', (e) =>
        reject(new Error(`window create failed: ${String(e.payload)}`)),
      );
    });
    return;
  }
  window.open(`/?vault=${encodeURIComponent(name)}`, '_blank');
}
