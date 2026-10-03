// Reap the dev servers and emulators a chat tab's agent left running after the tab's claude
// is gone. The rule (which groups) lives in src/lib/orphan-processes.ts; this file owns WHEN:
// grace counted in observed time, a ledger line before every signal, and a two-phase
// SIGTERM → SIGKILL spread across ticks so no timer can signal after the sweeper stops.
//
// Scope: the desktop app's OWN dashboard server on macOS only. A builder- or verify-launched
// `dashboard` inherits DREAMCONTEXT_DESKTOP=1 and DREAMCONTEXT_PARENT_PID, but its ppid is not
// that parent, so it never sweeps. One app-owned server per app → no cross-server lock.

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isPidAlive as defaultIsPidAlive } from '../lib/auto-sleep.js';
import {
  PsError,
  classifyOrphanGroups,
  ledgerProgram,
  runPs as defaultRunPs,
  takeSnapshot,
  type OrphanGroup,
  type RunPs,
} from '../lib/orphan-processes.js';

export const ORPHAN_SWEEP_INTERVAL_MS = 5 * 60_000;
export const ORPHAN_GRACE_MS = 30 * 60_000;
export const ORPHAN_KILL_BACKOFF_MS = 60 * 60_000;
const STUCK_AFTER_ABORTS = 6;
const LEDGER_MEMBERS = 20;

export function orphanLedgerPath(home: string): string {
  return join(home, '.dreamcontext', 'orphan-sweep.log');
}

export interface OrphanSweepDeps {
  home?: string;
  /** Monotonic ms. performance.now stops while the Mac sleeps, so grace is AWAKE time. */
  now?: () => number;
  kill?: (pid: number, sig: NodeJS.Signals) => void;
  runPs?: RunPs;
  isPidAlive?: (pid: number) => boolean;
  selfPid?: number;
  selfEnv?: NodeJS.ProcessEnv;
  uid?: number;
  intervalMs?: number;
}

interface Entry {
  pgid: number;
  /** `pid:lstart` of the members seen on the last tick. */
  members: Set<string>;
  observedMs: number;
  termAt?: number;
  backoffUntil?: number;
}

export interface OrphanSweeper {
  tick(): Promise<void>;
  stop(): void;
}

const memberKey = (r: { pid: number; lstart: string }): string => `${r.pid}:${r.lstart}`;

/** The sweeper itself, ungated: tests drive `tick()` directly. Never throws. */
export function createOrphanSweeper(deps: OrphanSweepDeps = {}): OrphanSweeper {
  const home = deps.home ?? homedir();
  const now = deps.now ?? (() => performance.now());
  const kill = deps.kill ?? ((pid: number, sig: NodeJS.Signals) => { process.kill(pid, sig); });
  const run = deps.runPs ?? defaultRunPs;
  const isPidAlive = deps.isPidAlive ?? ((pid: number) => defaultIsPidAlive(pid));
  const selfPid = deps.selfPid ?? process.pid;
  const selfEnv = deps.selfEnv ?? process.env;
  const uid = deps.uid ?? process.getuid?.() ?? -1;
  const intervalMs = deps.intervalMs ?? ORPHAN_SWEEP_INTERVAL_MS;

  let entries = new Map<number, Entry>();
  let lastSuccessAt: number | null = null;
  let consecutiveAborts = 0;
  let inFlight = false;
  let stopped = false;

  /** Ledger line FIRST; false = not written, so the caller must not signal. */
  function appendLedger(group: OrphanGroup, signal: NodeJS.Signals): boolean {
    const line = {
      at: new Date().toISOString(),
      signal,
      pgid: group.pgid,
      tabId: group.tabId,
      sessionId: group.sessionId,
      memberCount: group.members.length,
      members: group.members.slice(0, LEDGER_MEMBERS).map((r) => ({ pid: r.pid, lstart: r.lstart, program: ledgerProgram(r.args) })),
    };
    try {
      mkdirSync(join(home, '.dreamcontext'), { recursive: true, mode: 0o700 });
      appendFileSync(orphanLedgerPath(home), JSON.stringify(line) + '\n', { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  /** True when a signal was ATTEMPTED (sent, ESRCH, or refused by the kernel) — the phase advances. */
  function signalGroup(group: OrphanGroup, leaderAlive: boolean, signal: NodeJS.Signals): boolean {
    const { pgid } = group;
    if (stopped || !Number.isInteger(pgid) || pgid <= 1 || leaderAlive) return false;
    if (!appendLedger(group, signal)) return false;
    if (stopped) return false;
    try {
      kill(-pgid, signal);
    } catch {
      // ESRCH = already gone; EPERM and the rest still count as the attempt, so nothing is
      // re-signalled every tick.
    }
    return true;
  }

  async function runTick(): Promise<void> {
    const snapshot = await takeSnapshot(run, isPidAlive, { selfPid, uid });
    if (stopped) return;
    if ('aborted' in snapshot) {
      // Fail closed: entries neither advance, reset nor get deleted.
      consecutiveAborts++;
      console.log(`  [orphan-sweep] tick aborted (${snapshot.aborted}), ${consecutiveAborts} in a row`);
      if (consecutiveAborts === STUCK_AFTER_ABORTS) {
        console.warn(`  [orphan-sweep] sweep stuck: ${STUCK_AFTER_ABORTS} aborted ticks in a row, nothing is being reaped`);
      }
      return;
    }
    consecutiveAborts = 0;

    const t = now();
    let observed = 0;
    if (lastSuccessAt !== null) {
      const gap = t - lastSuccessAt;
      if (gap < 0 || gap >= 3 * intervalMs) {
        console.log(`  [orphan-sweep] grace cleared (${entries.size} entr${entries.size === 1 ? 'y' : 'ies'}): ${gap < 0 ? 'clock moved back' : 'gap since the last successful tick'}`);
        entries = new Map();
      } else {
        observed = Math.min(gap, intervalMs + 60_000);
      }
    }
    lastSuccessAt = t;

    const { candidates, paused } = classifyOrphanGroups(snapshot, selfPid, selfEnv);
    const next = new Map<number, Entry>();
    for (const group of candidates) {
      const keys = group.members.map(memberKey);
      const prev = entries.get(group.pgid);
      const continues = !!prev && keys.some((k) => prev.members.has(k));
      const entry: Entry = continues ? prev! : { pgid: group.pgid, members: new Set(), observedMs: 0 };
      if (continues) entry.observedMs += observed;
      entry.members = new Set(keys);
      next.set(group.pgid, entry);
    }
    // Kept only because another live server may own the tab: frozen, not reset.
    for (const group of paused) {
      const prev = entries.get(group.pgid);
      if (prev && !next.has(group.pgid)) next.set(group.pgid, prev);
    }
    entries = next; // every other entry dies with its candidacy

    for (const group of candidates) {
      const entry = entries.get(group.pgid)!;
      const leaderAlive = snapshot.rows.has(group.pgid);
      if (entry.backoffUntil !== undefined) {
        if (t < entry.backoffUntil) continue;
        entry.backoffUntil = undefined;
        entry.termAt = undefined;
      }
      if (entry.termAt === undefined) {
        if (entry.observedMs >= ORPHAN_GRACE_MS && signalGroup(group, leaderAlive, 'SIGTERM')) entry.termAt = t;
      } else if (signalGroup(group, leaderAlive, 'SIGKILL')) {
        entry.backoffUntil = t + ORPHAN_KILL_BACKOFF_MS;
      }
    }
  }

  return {
    async tick() {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        await runTick();
      } catch (err) {
        // Never the error object: a ps failure may have carried env tokens.
        const name = err instanceof Error ? err.name : 'Error';
        const cls = err instanceof PsError ? ` (${err.psClass})` : '';
        console.log(`  [orphan-sweep] tick failed: ${name}${cls}`);
      } finally {
        inFlight = false;
      }
    },
    stop() {
      stopped = true;
    },
  };
}

export interface OrphanSweepGate {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  ppid?: number;
  deps?: OrphanSweepDeps;
}

/** Why the sweep must not run here, or null when it should. */
export function orphanSweepDisabledReason(gate: Required<Omit<OrphanSweepGate, 'deps'>>): string | null {
  const { env, platform, ppid } = gate;
  if (platform !== 'darwin') return `platform ${platform}`;
  if (env.DREAMCONTEXT_DESKTOP !== '1') return 'not the desktop app';
  if (env.VITEST || env.NODE_ENV === 'test') return 'test run';
  if (env.DREAMCONTEXT_ORPHAN_SWEEP === '0') return 'DREAMCONTEXT_ORPHAN_SWEEP=0';
  if (ppid !== Number(env.DREAMCONTEXT_PARENT_PID)) return 'ppid is not DREAMCONTEXT_PARENT_PID (not the app-owned server)';
  return null;
}

/**
 * Start the sweep in the app-owned desktop server: one boot line, then a tick every 5 min
 * (the first one interval after boot). Returns a stop function, or undefined when gated off.
 */
export function startOrphanSweep(gate: OrphanSweepGate = {}): (() => void) | undefined {
  const reason = orphanSweepDisabledReason({
    env: gate.env ?? process.env,
    platform: gate.platform ?? process.platform,
    ppid: gate.ppid ?? process.ppid,
  });
  if (reason) {
    console.log(`  [orphan-sweep] disabled: ${reason}`);
    return undefined;
  }
  const intervalMs = gate.deps?.intervalMs ?? ORPHAN_SWEEP_INTERVAL_MS;
  const sweeper = createOrphanSweeper(gate.deps);
  console.log(`  [orphan-sweep] enabled: every ${Math.round(intervalMs / 60_000)} min, ${ORPHAN_GRACE_MS / 60_000} min grace`);
  const timer = setInterval(() => { void sweeper.tick(); }, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    sweeper.stop();
  };
}
