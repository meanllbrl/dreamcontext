// WHEN the registered projects catch up with the installed CLI (src/lib/project-catch-up.ts owns
// what happens). The one trigger: a check shortly after the server listens, off the boot path,
// then one every few minutes. The repeat is for a project that had to wait for its agent, and
// for an `npm i -g` under a running app. With every project current a check reads N small
// configs and spawns nothing; a failed project is retried at the next server start, not here.

import { basename, resolve } from 'node:path';
import { activityOf, listChats } from '../lib/assistant/chat-registry.js';
import { devOrCachedCli, diskBusyReason, runProjectCatchUp, type CatchUpDeps } from '../lib/project-catch-up.js';
import { selfUpdateLockHeld } from '../lib/version-check.js';
import { liveChatsSnapshot } from './routes/agent-chat-live.js';
import { getUpgradeRun } from './upgrade-job.js';

export const CATCH_UP_FIRST_TICK_MS = 20_000;
export const CATCH_UP_TICK_MS = 5 * 60_000;

export interface CatchUpJobGate {
  env?: NodeJS.ProcessEnv;
  ppid?: number;
  argv1?: string;
  firstTickMs?: number;
  tickMs?: number;
  deps?: CatchUpDeps;
}

const envMs = (v: string | undefined): number | undefined => {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * Why this server must not run the job, or null when it should. The app-owned server or a
 * `dashboard` of a real install, and never when any CLI it could pick is a dev build: that
 * version is whatever the branch says, and stamping it on real projects skips the real release's
 * migrations for good (src/lib/migrate-and-stamp.ts).
 */
export function catchUpDisabledReason(
  env: NodeJS.ProcessEnv,
  ppid: number = process.ppid,
  argv1: string | undefined = process.argv[1],
): string | null {
  if (env.VITEST || env.NODE_ENV === 'test') return 'test run';
  if (env.DREAMCONTEXT_AUTO_PROJECT_UPDATE === '0') return 'DREAMCONTEXT_AUTO_PROJECT_UPDATE=0';
  if (env.DREAMCONTEXT_DESKTOP === '1' && ppid !== Number(env.DREAMCONTEXT_PARENT_PID)) return 'not the app-owned server';
  const entries = [argv1, env.DREAMCONTEXT_CLI, env.DREAMCONTEXT_GLOBAL_CLI].filter((e): e is string => !!e);
  if (entries.length === 0) return 'no CLI entry';
  return entries.some(devOrCachedCli) ? 'not an installed CLI' : null;
}

/** Is an in-app chat of this project mid-turn? The same reading as anyChatBusy, per project. */
export function projectChatBusy(projectRoot: string, name: string, now: number = Date.now()): boolean {
  const root = resolve(projectRoot);
  if (liveChatsSnapshot().some((e) => e.busy && resolve(e.projectRoot) === root)) return true;
  const label = new Set([name, basename(root)]);
  return listChats().some((e) => {
    if (!label.has(e.vault)) return false;
    const a = activityOf(e, now);
    return a === 'working' || a === 'starting' || a === 'asking' || a === 'stale';
  });
}

/** Start the check loop. Returns a stop function, or undefined when gated off. */
export function startProjectCatchUpJob(gate: CatchUpJobGate = {}): (() => void) | undefined {
  const env = gate.env ?? process.env;
  const reason = catchUpDisabledReason(env, gate.ppid ?? process.ppid, gate.argv1 ?? process.argv[1]);
  if (reason) {
    console.log(`  [project-updates] disabled: ${reason}`);
    return undefined;
  }
  let stopped = false;
  let interval: NodeJS.Timeout | undefined;
  const deps: CatchUpDeps = {
    busy: (path, name) => (projectChatBusy(path, name) ? 'an agent session is working' : diskBusyReason(path, Date.now())),
    blocked: () => getUpgradeRun()?.state === 'running' || selfUpdateLockHeld(),
    stopped: () => stopped,
    ...gate.deps,
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const result = await runProjectCatchUp(deps);
    if (result.ran) console.log(`  [project-updates] ${result.message.split('\n')[0]}`);
  };

  const first = setTimeout(() => {
    void tick();
    if (stopped) return;
    interval = setInterval(() => { void tick(); }, gate.tickMs ?? envMs(env.DREAMCONTEXT_PROJECT_UPDATE_TICK_MS) ?? CATCH_UP_TICK_MS);
    interval.unref?.();
  }, gate.firstTickMs ?? envMs(env.DREAMCONTEXT_PROJECT_UPDATE_FIRST_TICK_MS) ?? CATCH_UP_FIRST_TICK_MS);
  first.unref?.();

  return () => {
    stopped = true;
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
