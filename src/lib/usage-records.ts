/**
 * The few facts a transcript cannot give the Stats screen, each one line in a small file.
 *
 *   `~/.dreamcontext/usage-limit-history.jsonl`  limit readings over time. Each reading used to
 *        overwrite the last, so "how much did this window rise" had no answer.
 *   `<vault>/_dream_context/state/.sleep-runs.jsonl`  one line at `sleep start`, one at `sleep
 *        done`, same `run`. The transcript already gives a sleep's edges and tokens; this adds
 *        the debt, the trigger and what a background run's result said it cost.
 *
 * A write here can never fail the command it hangs off: losing a line loses a detail on a screen.
 */
import { appendFileSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Append one line to a file inside a vault's `state/`. A cloned vault can COMMIT `state` or the
 * file itself as a symlink (context-watch.ts `ensureStateDir`), and the line carries text the
 * vault supplies, so neither link is followed.
 */
function appendInState(contextRoot: string, name: string, line: string): void {
  const state = join(contextRoot, 'state');
  if (existsSync(state) && !lstatSync(state).isDirectory()) return;
  mkdirSync(state, { recursive: true });
  const fd = openSync(join(state, name), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, `${line}\n`); } finally { closeSync(fd); }
}

export interface LimitPoint { ts: number; account: string; key: string; percent: number; resetsAt: number }

export function limitHistoryPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'usage-limit-history.jsonl');
}

const HISTORY_MAX_BYTES = 8 * 1024 * 1024;

export function recordLimitPoints(points: LimitPoint[], home: string = homedir()): void {
  if (points.length === 0) return;
  const file = limitHistoryPath(home);
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, points.map((p) => JSON.stringify(p)).join('\n') + '\n', { mode: 0o600 });
    if (statSync(file).size > HISTORY_MAX_BYTES) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      writeFileSync(file, lines.slice(lines.length >> 1).join('\n'), { mode: 0o600 });
    }
  } catch { /* a missed point narrows one estimate */ }
}

export function readLimitHistory(home: string = homedir()): LimitPoint[] {
  let raw: string;
  try { raw = readFileSync(limitHistoryPath(home), 'utf-8'); } catch { return []; }
  const out: LimitPoint[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const p = JSON.parse(line) as LimitPoint;
      if (typeof p.ts === 'number' && typeof p.account === 'string' && typeof p.key === 'string' && typeof p.percent === 'number') out.push(p);
    } catch { /* a torn last line */ }
  }
  return out;
}

export type SleepTrigger = 'you' | 'background' | 'automation';

export interface SleepRunRecord {
  run: string;
  session: string | null;
  account: string | null;
  trigger: SleepTrigger;
  startedAt: string;
  endedAt?: string;
  debtBefore?: number;
  debtAfter?: number;
  costUsd?: number;
}

const runsPath = (contextRoot: string) => join(contextRoot, 'state', '.sleep-runs.jsonl');

function appendRunLine(contextRoot: string, line: Partial<SleepRunRecord> & { run: string }): void {
  try { appendInState(contextRoot, '.sleep-runs.jsonl', JSON.stringify(line)); } catch { /* the transcript still has the run */ }
}

export function sleepTriggerFromEnv(env: NodeJS.ProcessEnv = process.env): SleepTrigger {
  if (env.DREAMCONTEXT_AUTO_SLEEP === '1') return 'background';
  if (env.DREAMCONTEXT_AUTOMATION_RUN) return 'automation';
  return 'you';
}

/** `sleep start`. Returns the run id, which `.sleep.json` does not need: `done` closes the open line. */
export function openSleepRun(contextRoot: string, debtBefore: number, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): string {
  const run = `${now.getTime().toString(36)}-${randomBytes(3).toString('hex')}`;
  appendRunLine(contextRoot, {
    run,
    session: env.CLAUDE_CODE_SESSION_ID || null,
    account: env.CLAUDE_CONFIG_DIR || null,
    trigger: sleepTriggerFromEnv(env),
    startedAt: now.toISOString(),
    debtBefore,
  });
  return run;
}

export function readSleepRuns(contextRoot: string): SleepRunRecord[] {
  let raw: string;
  try { raw = readFileSync(runsPath(contextRoot), 'utf-8'); } catch { return []; }
  const byRun = new Map<string, SleepRunRecord>();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const o = JSON.parse(line) as SleepRunRecord;
      if (typeof o.run !== 'string') continue;
      byRun.set(o.run, { ...(byRun.get(o.run) as SleepRunRecord), ...o });
    } catch { /* a torn last line */ }
  }
  return [...byRun.values()];
}

/** `sleep done`: closes the newest run still open. */
export function closeSleepRun(contextRoot: string, debtAfter: number, now: Date = new Date()): void {
  const open = readSleepRuns(contextRoot).filter((r) => !r.endedAt).at(-1);
  if (open) appendRunLine(contextRoot, { run: open.run, endedAt: now.toISOString(), debtAfter });
}

/** A background run's own result reports its cost; it was read and thrown away until this. */
export function noteSleepRunCost(contextRoot: string, session: string | null | undefined, costUsd: number | null | undefined): void {
  if (!session || typeof costUsd !== 'number') return;
  const run = readSleepRuns(contextRoot).filter((r) => r.session === session).at(-1);
  if (run) appendRunLine(contextRoot, { run: run.run, costUsd });
}

/**
 * A handoff that was taken, kept: the records in `.handoff-requests/` are pruned after 7 days and
 * keyed by pane, so a 30-day Eco number needs its own line.
 */
export interface HandoffLine {
  title: string; at: string; contextTokens: number | null; fromSession: string; toSession?: string; actedAt?: string; consumedAt: string;
}

const handoffLogPath = (contextRoot: string) => join(contextRoot, 'state', '.handoff-log.jsonl');

export function logHandoff(contextRoot: string, line: HandoffLine): void {
  try { appendInState(contextRoot, '.handoff-log.jsonl', JSON.stringify(line)); } catch { /* one fewer row on a screen */ }
}

export function readHandoffLog(contextRoot: string): HandoffLine[] {
  let raw: string;
  try { raw = readFileSync(handoffLogPath(contextRoot), 'utf-8'); } catch { return []; }
  const out: HandoffLine[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line) as HandoffLine); } catch { /* a torn last line */ }
  }
  return out;
}
