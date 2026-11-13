// WHEN the desktop server runs the 24-hour background brain sync (src/lib/brain-auto-sync.ts owns
// what happens). A first check a few minutes after the server listens, off the boot path, then
// one every ten minutes. A check reads a few small files per project and spawns nothing until a
// project is a day past its last full sync and no agent works there.

import { runBrainAutoSync, defaultRunSync, type BrainAutoSyncDeps } from '../lib/brain-auto-sync.js';
import { diskBusyReason } from '../lib/project-catch-up.js';
import { projectChatBusy } from './project-catch-up-job.js';

export const BRAIN_AUTO_SYNC_FIRST_TICK_MS = 3 * 60_000;
export const BRAIN_AUTO_SYNC_TICK_MS = 10 * 60_000;

export interface BrainAutoSyncGate {
  env?: NodeJS.ProcessEnv;
  ppid?: number;
  argv1?: string;
  firstTickMs?: number;
  tickMs?: number;
  deps?: BrainAutoSyncDeps;
}

/**
 * Why this server must not run the job, or null when it should: only the server the desktop app
 * owns (it is on while the app runs), one per Mac, and `DREAMCONTEXT_BRAIN_SYNC=0` turns it off
 * like the session-start pull.
 */
export function brainAutoSyncDisabledReason(
  env: NodeJS.ProcessEnv,
  ppid: number = process.ppid,
  argv1: string | undefined = process.argv[1],
): string | null {
  if (env.VITEST || env.NODE_ENV === 'test') return 'test run';
  if (env.DREAMCONTEXT_BRAIN_SYNC === '0') return 'DREAMCONTEXT_BRAIN_SYNC=0';
  if (env.DREAMCONTEXT_DESKTOP !== '1') return 'not the desktop app';
  if (ppid !== Number(env.DREAMCONTEXT_PARENT_PID)) return 'not the app-owned server';
  if (!(env.DREAMCONTEXT_CLI || argv1)) return 'no CLI entry';
  return null;
}

/** Start the check loop. Returns a stop function, or undefined when gated off. */
export function startBrainAutoSyncJob(gate: BrainAutoSyncGate = {}): (() => void) | undefined {
  const env = gate.env ?? process.env;
  const argv1 = gate.argv1 ?? process.argv[1];
  const reason = brainAutoSyncDisabledReason(env, gate.ppid ?? process.ppid, argv1);
  if (reason) {
    console.log(`  [brain-auto-sync] disabled: ${reason}`);
    return undefined;
  }
  let stopped = false;
  let interval: NodeJS.Timeout | undefined;
  const deps: BrainAutoSyncDeps = {
    busy: (path, name) => (projectChatBusy(path, name) ? 'an agent session is working' : diskBusyReason(path, Date.now())),
    runSync: defaultRunSync((env.DREAMCONTEXT_CLI || argv1) as string),
    stopped: () => stopped,
    ...gate.deps,
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const r = await runBrainAutoSync(deps);
    if (r.synced.length || r.paused.length) {
      console.log(`  [brain-auto-sync] synced ${r.synced.join(', ') || 'none'}; paused ${r.paused.join(', ') || 'none'}`);
    }
  };

  const first = setTimeout(() => {
    void tick();
    if (stopped) return;
    interval = setInterval(() => { void tick(); }, gate.tickMs ?? BRAIN_AUTO_SYNC_TICK_MS);
    interval.unref?.();
  }, gate.firstTickMs ?? BRAIN_AUTO_SYNC_FIRST_TICK_MS);
  first.unref?.();

  return () => {
    stopped = true;
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
