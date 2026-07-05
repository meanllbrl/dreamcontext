/**
 * Shared desktop-gate for server routes.
 *
 * The desktop Rust shell exports `DREAMCONTEXT_DESKTOP=1`; interactive-shell and
 * privileged local features (agent terminal, file drop, session roster, the
 * brain cloud-sync routes) only exist inside the desktop app and 403 otherwise.
 *
 * `src/server/` is flat (no `lib/` sub-dir), so this lives at the server root.
 * It is DISTINCT from `dashboard/src/lib/desktop.ts`, which detects the desktop
 * shell client-side.
 */
export function isDesktop(): boolean {
  return process.env.DREAMCONTEXT_DESKTOP === '1';
}
