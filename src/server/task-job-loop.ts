import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { listRegisteredProjects } from '../lib/automations/registry.js';
import { reconcileTaskJobs, startDueTaskJobs } from '../lib/agents/task-starter.js';

/**
 * The server's half of the task-job drain (AI Team v2 C1-3): on start and every minute while it
 * is up, settle what died and start what is due in every project this machine's scheduler ticks.
 * The scheduler's own tick does the same every five minutes with no server at all; this only
 * makes a step that just became due (a delivery queued its review, the owner answered) start
 * within a minute while the app is open. Both go through the same claim, so they never double up.
 */
export const TASK_JOB_LOOP_MS = 60_000;

export function drainTaskJobsOnce(log: (line: string) => void = () => {}): void {
  for (const projectRoot of listRegisteredProjects()) {
    const contextRoot = join(projectRoot, '_dream_context');
    if (!existsSync(contextRoot)) continue;
    try {
      reconcileTaskJobs(contextRoot, { log });
      const started = startDueTaskJobs(contextRoot, { log });
      if (started.length) log(`  [tasks] started ${started.length} task job step(s) in ${projectRoot}`);
    } catch (err) {
      log(`  [tasks] task drain failed for ${projectRoot}: ${(err as Error).message}`);
    }
  }
}

export function startTaskJobLoop(intervalMs = TASK_JOB_LOOP_MS): () => void {
  const log = (line: string): void => { console.log(line); };
  drainTaskJobsOnce(log);
  const timer = setInterval(() => drainTaskJobsOnce(log), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
