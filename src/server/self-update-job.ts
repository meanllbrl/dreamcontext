// Keep the dreamcontext CLI current from the desktop app itself, not only from a Claude prompt
// (src/lib/self-update.ts owns the check; this file owns WHEN). One tick ~90 s after listen (off
// the boot path, after the window is up), then one every 30 min, both timers unref'd. The tick
// only ASKS: the shared state file's 6 h throttle decides whether a check runs, and a deferred
// check (a chat was mid-turn) is simply asked again on the next tick.

import { realpathSync } from 'node:fs';
import { readDreamcontextVersionFromDisk } from '../lib/manifest.js';
import { cliPackageVersion } from '../lib/npm-target.js';
import { runSelfUpdateCheck, type SelfUpdateDeps } from '../lib/self-update.js';
import { compareVersions } from '../lib/version-check.js';
import { anyChatBusy } from './chat-activity.js';
import { startUpgradeRun } from './upgrade-job.js';

export const SELF_UPDATE_FIRST_TICK_MS = 90_000;
export const SELF_UPDATE_TICK_MS = 30 * 60_000;

export interface SelfUpdateJobGate {
  env?: NodeJS.ProcessEnv;
  ppid?: number;
  platform?: NodeJS.Platform;
  firstTickMs?: number;
  tickMs?: number;
  deps?: SelfUpdateDeps;
}

const envMs = (v: string | undefined): number | undefined => {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * Why the job must not run here, or null when it should. The app-owned desktop server only
 * (the same rule as the Claude Code update job): a builder- or verify-launched `dashboard`
 * inherits DREAMCONTEXT_DESKTOP=1 but its ppid is not DREAMCONTEXT_PARENT_PID. Windows keeps its
 * bundled-first CLI and NSIS updater; the login-shell upgrade below is a unix path.
 */
export function selfUpdateJobDisabledReason(
  env: NodeJS.ProcessEnv,
  ppid: number = process.ppid,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (env.DREAMCONTEXT_DESKTOP !== '1') return 'not the desktop app';
  if (env.VITEST || env.NODE_ENV === 'test') return 'test run';
  if (platform === 'win32') return 'Windows updates through the app installer';
  if (ppid !== Number(env.DREAMCONTEXT_PARENT_PID)) return 'ppid is not DREAMCONTEXT_PARENT_PID (not the app-owned server)';
  return null;
}

const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

/**
 * The version the desktop ready watch compares with the running one: this process's own
 * package, or — when the shell started its bundled copy while a global CLI exists
 * (DREAMCONTEXT_GLOBAL_CLI is not the running entry) — the global install's version when that is
 * strictly newer. Without it an app running the bundle never relaunched onto the global CLI its
 * own self-update had just upgraded. The relaunch then picks the global (it is newer), so this
 * cannot loop.
 */
export function readyVersionOnDisk(
  env: NodeJS.ProcessEnv = process.env,
  argv1: string | undefined = process.argv[1],
  own: () => string = readDreamcontextVersionFromDisk,
  globalVersion: (entry: string) => string | null = (e) => cliPackageVersion(e),
): string {
  const mine = own();
  const global = env.DREAMCONTEXT_GLOBAL_CLI;
  if (!global || !argv1 || real(global) === real(argv1)) return mine;
  const g = globalVersion(global);
  return g && compareVersions(g, mine) > 0 ? g : mine;
}

/** The upgrade job the "Upgrade everything" badge runs, awaited. */
export async function runUpgradeJob(): Promise<{ ok: boolean; output: string }> {
  const started = startUpgradeRun({ trigger: 'auto' });
  if ('error' in started) return { ok: false, output: 'Could not locate the dreamcontext CLI entry to upgrade.' };
  const run = await started.done;
  return { ok: run.state === 'done', output: run.output };
}

/**
 * Start the background self-update in the app-owned desktop server. Returns a stop function,
 * or undefined when gated off. The opt-out is NOT a gate here: it is read on every tick, so
 * flipping the Settings switch takes effect without a restart.
 */
export function startSelfUpdateJob(gate: SelfUpdateJobGate = {}): (() => void) | undefined {
  const env = gate.env ?? process.env;
  const reason = selfUpdateJobDisabledReason(env, gate.ppid ?? process.ppid, gate.platform ?? process.platform);
  if (reason) {
    console.log(`  [self-update] disabled: ${reason}`);
    return undefined;
  }
  const deps: SelfUpdateDeps = { busy: () => anyChatBusy(), runUpgrade: runUpgradeJob, ...gate.deps };
  const tickMs = gate.tickMs ?? envMs(env.DREAMCONTEXT_SELF_UPDATE_TICK_MS) ?? SELF_UPDATE_TICK_MS;
  let stopped = false;
  let interval: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await runSelfUpdateCheck({}, deps);
      if (result.ran || result.state === 'deferred') console.log(`  [self-update] ${result.message.split('\n')[0]}`);
    } catch {
      /* runSelfUpdateCheck never throws; a timer callback must not either */
    }
  };

  console.log(`  [self-update] enabled: a check every 6 h, asked every ${Math.round(tickMs / 60_000)} min`);
  const first = setTimeout(() => {
    void tick();
    if (stopped) return;
    interval = setInterval(() => { void tick(); }, tickMs);
    interval.unref?.();
  }, gate.firstTickMs ?? envMs(env.DREAMCONTEXT_SELF_UPDATE_FIRST_TICK_MS) ?? SELF_UPDATE_FIRST_TICK_MS);
  first.unref?.();

  return () => {
    stopped = true;
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
