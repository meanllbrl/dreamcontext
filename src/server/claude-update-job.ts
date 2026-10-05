// Keep the Claude Code CLI current for a user who only ever drives it through the app. The
// check + update itself lives in src/lib/claude-update.ts; this file owns WHEN: one tick ~30 s
// after listen (off the boot path), then one every hour, both timers unref'd so they never hold
// the process open. The tick only ASKS: the state file's 6 h checkedAt throttle decides whether a
// check runs. A 6 h timer would drift past the throttle (and macOS timers pause in sleep), so the
// real cadence would be 12 h. Every desktop server may tick: the shared checkedAt throttles them
// all together, and a second call in one process joins the run in flight.

import {
  CLAUDE_UPDATE_INTERVAL_MS,
  runClaudeUpdateCheck,
  type ClaudeUpdateDeps,
} from '../lib/claude-update.js';

export const CLAUDE_UPDATE_FIRST_TICK_MS = 30_000;
export const CLAUDE_UPDATE_TICK_MS = 60 * 60_000;

export interface ClaudeUpdateJobGate {
  env?: NodeJS.ProcessEnv;
  firstTickMs?: number;
  tickMs?: number;
  ppid?: number;
  deps?: ClaudeUpdateDeps;
}

/**
 * Why the job must not run here, or null when it should. Same env reads as isDesktop()/isCloud(),
 * plus the orphan sweep's app-owned-server rule: a builder- or verify-launched `dashboard`
 * inherits DREAMCONTEXT_DESKTOP=1 (often under a scratch HOME, so no shared throttle and blind
 * to the real opt-out), but its ppid is not DREAMCONTEXT_PARENT_PID, so it never updates.
 */
export function claudeUpdateJobDisabledReason(env: NodeJS.ProcessEnv, ppid: number = process.ppid): string | null {
  if (env.DREAMCONTEXT_CLOUD === '1') return 'cloud server';
  if (env.DREAMCONTEXT_DESKTOP !== '1') return 'not the desktop app';
  if (env.VITEST || env.NODE_ENV === 'test') return 'test run';
  if (env.DREAMCONTEXT_CLAUDE_AUTOUPDATE === '0') return 'DREAMCONTEXT_CLAUDE_AUTOUPDATE=0';
  if (ppid !== Number(env.DREAMCONTEXT_PARENT_PID)) return 'ppid is not DREAMCONTEXT_PARENT_PID (not the app-owned server)';
  return null;
}

/**
 * Start the background check in the app-owned desktop server: one boot line, a first tick after
 * ~30 s, then one every hour (the 6 h throttle decides). Returns a stop function, or undefined
 * when gated off.
 */
export function startClaudeUpdateJob(gate: ClaudeUpdateJobGate = {}): (() => void) | undefined {
  const reason = claudeUpdateJobDisabledReason(gate.env ?? process.env, gate.ppid ?? process.ppid);
  if (reason) {
    console.log(`  [claude-update] disabled: ${reason}`);
    return undefined;
  }
  const deps = gate.deps ?? {};
  const intervalMs = deps.intervalMs ?? CLAUDE_UPDATE_INTERVAL_MS;
  const tickMs = gate.tickMs ?? CLAUDE_UPDATE_TICK_MS;
  let stopped = false;
  let interval: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await runClaudeUpdateCheck({}, deps);
      if (result.ran) console.log(`  [claude-update] ${result.message.split('\n')[0]}`);
    } catch {
      /* runClaudeUpdateCheck never throws; a timer callback must not either */
    }
  };

  console.log(`  [claude-update] enabled: a check every ${Math.round(intervalMs / 3_600_000)} h, asked every ${Math.round(tickMs / 60_000)} min`);
  const first = setTimeout(() => {
    void tick();
    if (stopped) return;
    interval = setInterval(() => { void tick(); }, tickMs);
    interval.unref?.();
  }, gate.firstTickMs ?? CLAUDE_UPDATE_FIRST_TICK_MS);
  first.unref?.();

  return () => {
    stopped = true;
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
