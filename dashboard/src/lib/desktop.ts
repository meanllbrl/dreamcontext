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
