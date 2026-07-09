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
import { compareVersions } from '../lib/version-check.js';

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
/**
 * Exit the server when the installed package is UPGRADED under it — the
 * root-cause fix for stale-route errors ("No route: POST /api/tasks/token").
 *
 * The failure mode: the dashboard server is spawned detached (session-start
 * hook) and outlives agent sessions. An `npm install -g dreamcontext@latest`
 * replaces dist/ and the dashboard bundle ON DISK, but this process keeps its
 * old route table in memory — so it serves the NEW frontend bundle against the
 * OLD API and every newer route 404s. No manual capability list can keep up
 * with that; the only reliable fix is for the server to notice the upgrade and
 * get out of the way (the next session-start spawns a fresh one).
 *
 * Mechanism: poll the package.json version on disk and call `onDrift` once it
 * reads a VALID version different from the one this process started with.
 * '0.0.0' (unreadable/mid-upgrade/uninstalled) never triggers — we only exit
 * for a confirmed different version, not a transient read failure.
 *
 * Desktop-spawned servers (DREAMCONTEXT_DESKTOP=1) are excluded: the Tauri
 * shell owns that lifecycle (parent-death watch above), and an app update
 * relaunches the shell anyway — exiting mid-run would break a live window.
 */
export function startVersionDriftWatch(
  startupVersion: string,
  readDiskVersion: () => string,
  onDrift: (diskVersion: string) => void,
  pollMs = 30_000,
): (() => void) | undefined {
  if (process.env.DREAMCONTEXT_DESKTOP === '1') return undefined;
  if (!startupVersion || startupVersion === '0.0.0') return undefined;

  let fired = false;
  const timer = setInterval(() => {
    let disk = '0.0.0';
    try {
      disk = readDiskVersion();
    } catch {
      return; // read failure = unknown, never a drift signal
    }
    if (disk !== '0.0.0' && disk !== startupVersion && !fired) {
      fired = true;
      clearInterval(timer);
      onDrift(disk);
    }
  }, pollMs);

  // Same discipline as the parent-death watch: never hold the event loop open.
  timer.unref?.();

  return () => clearInterval(timer);
}

// ─── Desktop upgrade-ready flag (self-heal) ─────────────────────────────────────
//
// The desktop app is EXCLUDED from startVersionDriftWatch's self-exit: killing the
// server would blank a live window with nothing to respawn it. But it still MUST
// notice an on-disk upgrade — otherwise a long-lived app keeps serving the OLD
// dashboard bundle + OLD routes (a missing Settings section, "No route" errors)
// until the user manually quits and reopens. That was the whole "I updated but the
// app stays stale on another machine" report.
//
// This is the desktop counterpart to the drift watch: the SAME disk-version poll,
// but instead of exiting it records the newer version in a flag that
// GET /api/health exposes. The bundle polls health, sees a newer version is
// installed under it, and drives an AUTOMATIC relaunch (close windows → app quits →
// the server's detached `open <app>` reopens the swapped bundle → a fresh server
// spawns from the upgraded CLI). Ships via the normal npm/CLI bundle — no Tauri
// rebuild — so every future upgrade self-heals once the app is on a build with this.

// Intentionally process-global (NOT request/vault-scoped): the CLI version is
// vault-agnostic, and this is written ONLY by the internal timer below — never
// from request input — so there is no cross-vault or attacker-writable path here.
let upgradeReadyVersion: string | null = null;

/**
 * The newer on-disk version that landed while this (desktop) server was running,
 * or null if none has. Read by GET /api/health for the bundle's auto-relaunch.
 */
export function getUpgradeReadyVersion(): string | null {
  return upgradeReadyVersion;
}

/** Test-only: clear the flag between cases. */
export function __resetUpgradeReadyVersion(): void {
  upgradeReadyVersion = null;
}

/**
 * Desktop-only watch: poll the on-disk package.json version and flag a confirmed
 * upgrade (a VALID version different from startup) for the bundle to act on.
 * '0.0.0'/read-failure never flags (transient mid-upgrade state, not a real bump).
 * Gated to DREAMCONTEXT_DESKTOP=1 — a terminal `dreamcontext dashboard` is covered
 * by startVersionDriftWatch's self-exit instead. Returns a stop fn, or undefined.
 */
export function startUpgradeReadyWatch(
  startupVersion: string,
  readDiskVersion: () => string,
  pollMs = 30_000,
): (() => void) | undefined {
  if (process.env.DREAMCONTEXT_DESKTOP !== '1') return undefined;
  if (!startupVersion || startupVersion === '0.0.0') return undefined;

  upgradeReadyVersion = null;
  const timer = setInterval(() => {
    let disk = '0.0.0';
    try {
      disk = readDiskVersion();
    } catch {
      return; // read failure = unknown, never a flag
    }
    // Only flag a genuine UPGRADE (strictly newer), never a downgrade. A rollback
    // (e.g. `npm i -g dreamcontext@0.13.0` under a running 0.16.0) must NOT show
    // "updated to v0.13.0" and force-relaunch the app onto older code. '0.0.0'
    // (unreadable/mid-swap) compares below everything, so it never trips this.
    if (disk !== '0.0.0' && compareVersions(disk, startupVersion) > 0) {
      upgradeReadyVersion = disk;
      clearInterval(timer); // latched — the bundle relaunches from here
    }
  }, pollMs);

  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Shutdown request hook for `POST /api/admin/shutdown`: the route handler runs
 * long before the HTTP server (and its shutdown closure) exists, so the server
 * registers its shutdown here at listen time and the route calls
 * `requestShutdown()`. A no-op until a handler is registered.
 */
let shutdownHandler: (() => void) | null = null;

export function registerShutdownHandler(fn: () => void): void {
  shutdownHandler = fn;
}

/** Invoke the registered shutdown. Returns false when none is registered. */
export function requestShutdown(): boolean {
  if (!shutdownHandler) return false;
  shutdownHandler();
  return true;
}

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
