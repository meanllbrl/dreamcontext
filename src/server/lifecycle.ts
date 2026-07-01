// Desktop-server process lifecycle: keep the dashboard server from outliving the
// desktop app, and reap the child processes it spawns.
//
// THE LEAK THIS FIXES — orphaned dashboard servers (~25 observed):
// The Tauri shell (desktop/src-tauri/src/lib.rs) spawns ONE `node dist/index.js
// dashboard --launcher` per app launch and tries to kill it from its Rust exit
// handler. But that handler does not run on every way the app can die — a
// force-quit, a crash, an abrupt `tauri dev` Ctrl+C, or a dev rebuild swapping the
// binary all terminate the app WITHOUT the handler firing. When that happens the
// Node server is reparented to launchd (PID 1) and lives forever, holding its
// loopback port. Repeated open/close (or the dev ⌘Q+reopen loop) piles these up.
//
// The defense below is OS-level and does not depend on the parent running any
// cleanup code: the server watches its parent's liveness and exits the moment the
// parent is gone, no matter how the parent died.

import type { ChildProcess } from 'node:child_process';

/** Kill callbacks for live children (PTYs, capture spawns) we want reaped on exit. */
const liveChildren = new Set<() => void>();

/**
 * Register a child so it is killed when the server shuts down. Returns an
 * unregister function — call it once the child has exited on its own so the set
 * doesn't leak dead entries. Accepts either a kill callback or a ChildProcess.
 */
export function trackChild(child: ChildProcess | (() => void)): () => void {
  const kill = typeof child === 'function' ? child : () => { try { child.kill(); } catch { /* gone */ } };
  liveChildren.add(kill);
  return () => liveChildren.delete(kill);
}

/** Kill every tracked child. Best-effort: a child that's already dead is ignored. */
export function killTrackedChildren(): void {
  for (const kill of liveChildren) {
    try { kill(); } catch { /* already dead */ }
  }
  liveChildren.clear();
}

/**
 * When the dashboard server was launched by the desktop app, make it exit if its
 * parent (the Tauri shell) dies for ANY reason. This is the root-cause fix for the
 * orphaned-dashboard-server leak: it runs entirely inside the Node server, so it
 * works even on the parent-death paths that skip the Rust exit handler.
 *
 * Mechanism: probe the parent PID's liveness with signal 0 (no signal sent, just an
 * existence/permission check that throws ESRCH once the process is gone). The PID is
 * read once at startup, when it is guaranteed to be our real, live parent — we
 * prefer the explicit DREAMCONTEXT_PARENT_PID the shell passes, falling back to
 * `process.ppid` so this still works against an older app bundle that doesn't set it.
 *
 * Gated on DREAMCONTEXT_DESKTOP=1 so a plain `dreamcontext dashboard` run from a
 * terminal (managed by the user, Ctrl+C to stop) is never affected.
 *
 * @returns a stop function (clears the poll), or undefined if no watch was started.
 */
export function startParentDeathWatch(onParentGone: () => void): (() => void) | undefined {
  if (process.env.DREAMCONTEXT_DESKTOP !== '1') return undefined;

  const envPid = Number(process.env.DREAMCONTEXT_PARENT_PID);
  const parentPid = Number.isInteger(envPid) && envPid > 1 ? envPid : process.ppid;
  // <= 1 means we're already orphaned (parent is launchd) or the PID is unknown —
  // nothing meaningful to watch.
  if (!Number.isInteger(parentPid) || parentPid <= 1) return undefined;

  let fired = false;
  const timer = setInterval(() => {
    let gone = false;
    try {
      process.kill(parentPid, 0); // existence probe; ESRCH once the parent is gone
    } catch (err) {
      // ESRCH = no such process (gone). EPERM = exists but not ours → NOT gone.
      gone = (err as NodeJS.ErrnoException).code === 'ESRCH';
    }
    if (gone && !fired) {
      fired = true;
      clearInterval(timer);
      onParentGone();
    }
  }, 2000);

  // Never keep the event loop alive just for this poll — the HTTP server already
  // does. If the server has otherwise exited, the watchdog shouldn't hold it open.
  timer.unref?.();

  return () => clearInterval(timer);
}
