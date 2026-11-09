/**
 * An AI Team member's bot commands (owner 2026-11-09): `/dur` and `/durum`, scoped to THAT member
 * in the project its bot talks in (`memberContextRoot`). `/gundem` and `/handsfree` stay the
 * Super's; typed here they get a line naming this bot's own two.
 *
 *  - `/dur`: every running job of the member stops through the paths that already exist, never a
 *    new one: its task jobs through the Mac's task Stop (`stopTaskAction`), then each in-flight
 *    run left (a thread turn, a routine run, a Super team job: all leave a run record) through
 *    `automations kill` (`killRunGroup`, one slot at a time).
 *  - `/durum`: what runs now, what waits on the owner (its open questions), the last few done,
 *    in the Super's /durum rows (`statusLineHtml`).
 */
import { dirname } from 'node:path';
import { listRunSidecars } from '../../lib/automations/store.js';
import { killRunGroup } from '../../lib/automations/runner.js';
import { listQuestions } from '../../lib/automations/hitl.js';
import { readThread } from '../../lib/automations/threads.js';
import type { RunSidecar, ThreadEntry } from '../../lib/automations/types.js';
import { readTaskJobs, type TaskClaim } from '../../lib/agents/task-jobs.js';
import { stopTaskAction } from '../../lib/agents/task-starter.js';
import { escapeHtml, redactSecrets } from '../../lib/telegram/format.js';
import { statusLineHtml } from '../../lib/telegram/system-lines.js';
import { cleanTitle } from '../../lib/telegram/urls.js';

export const MEMBER_CMD_LINES = {
  stopped: (n: number) => (n === 1 ? 'Durduruldu.' : `${n} iş durduruldu.`),
  nothingRunning: 'Şu an çalışan bir iş yok.',
  notStopped: "Durduramadım; Mac'te üyenin sayfasına bak.",
  superOnly: (cmd: string) => `/${cmd} yalnız Super'in botunda var. Bu botun komutları: /dur /durum`,
  unknown: 'Bu komut yok. Bu botun komutları: /dur /durum',
} as const;

/** Task steps whose process runs now; a step waiting on the owner or already delivered does not. */
const RUNNING_PHASES = new Set<TaskClaim['phase']>(['claiming', 'active', 'stalled']);
/** /dur also stops an orphaned step: the task Stop closes its inbox row too. */
const STOP_PHASES = new Set<TaskClaim['phase']>([...RUNNING_PHASES, 'orphaned']);
/** The runner kills its child at `timeoutAt`; a record past it (plus this) is no live run. */
const TIMEOUT_GRACE_MS = 2 * 60 * 1000;

export interface MemberJobsDeps {
  claims?: (projectRoot: string) => TaskClaim[];
  stopTask?: (contextRoot: string, taskId: string) => { ok: boolean };
  sidecars?: (contextRoot: string, slug: string) => RunSidecar[];
  kill?: (contextRoot: string, slug: string, o: { slot: string; force: boolean }) => { killed: boolean; found: boolean };
  isAlive?: (pid: number) => boolean;
  /** This server's pid: a record it wrote itself is a turn whose `finally` clears it. */
  selfPid?: number;
  now?: () => number;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException)?.code !== 'ESRCH'; }
}

function parts(d: MemberJobsDeps) {
  return {
    claims: d.claims ?? ((p: string) => readTaskJobs(p).claims),
    stopTask: d.stopTask ?? ((r: string, id: string) => stopTaskAction(r, id)),
    sidecars: d.sidecars ?? listRunSidecars,
    kill: d.kill ?? ((r: string, s: string, o: { slot: string; force: boolean }) => killRunGroup(r, s, o)),
    isAlive: d.isAlive ?? pidAlive,
    selfPid: d.selfPid ?? process.pid,
    now: d.now ?? Date.now,
  };
}

/** Inside the run's own deadline: a record past it cannot be a live run (whatever a pid probe says). */
function withinDeadline(s: RunSidecar, p: ReturnType<typeof parts>): boolean {
  const at = Date.parse(s.timeoutAt);
  return Number.isFinite(at) && p.now() <= at + TIMEOUT_GRACE_MS;
}

/**
 * The member's in-flight run records that are a live run. A pid probe alone is no proof: a runner
 * ended by SIGTERM (a shutdown, the task Stop) leaves its record behind, and after a reboot its pids
 * belong to other programs. So a record also has to be inside its own deadline, and its RUNNER
 * must live: a child pid alone may be reused after a reboot, and /dur asks nobody to confirm (an
 * orphan whose runner died stays the Mac's `automations kill`, where a human sees what dies).
 */
function liveRuns(root: string, slug: string, p: ReturnType<typeof parts>): RunSidecar[] {
  let all: RunSidecar[] = [];
  try { all = p.sidecars(root, slug); } catch { all = []; }
  return all.filter((s) => withinDeadline(s, p) && (s.runnerPid === p.selfPid || p.isAlive(s.runnerPid)));
}

/** The record a task step's own process wrote (its host or child), so it is not counted twice. */
function ofClaim(s: RunSidecar, claims: TaskClaim[]): boolean {
  return claims.some((c) => (c.hostPid !== null && s.runnerPid === c.hostPid) || (c.childPid !== null && s.childPid === c.childPid));
}

function memberClaims(root: string, slug: string, p: ReturnType<typeof parts>, phases: Set<TaskClaim['phase']>): TaskClaim[] {
  let all: TaskClaim[] = [];
  try { all = p.claims(dirname(root)); } catch { all = []; }
  return all.filter((c) => c.agent === slug && phases.has(c.phase));
}

/** Stops every running job of `slug`: the line the owner reads. */
export function stopMemberJobs(root: string, slug: string, deps: MemberJobsDeps = {}): string {
  const p = parts(deps);
  let found = 0;
  let stopped = 0;
  const claims = memberClaims(root, slug, p, STOP_PHASES);
  for (const id of new Set(claims.map((c) => c.taskId))) {
    found += 1;
    try { if (p.stopTask(root, id).ok) stopped += 1; } catch { /* told below */ }
  }
  for (const s of liveRuns(root, slug, p)) {
    // A task step's run: the task Stop above already ended it (its host is signalled, not yet gone).
    if (ofClaim(s, claims)) continue;
    found += 1;
    // `force` (past killRunGroup's 60-minute pid-reuse guard) only for a turn THIS server runs:
    // its pid is ours, so it cannot be recycled, and its `finally` clears the record when the child
    // ends. Any other record keeps the guard; a refusal tells the owner to look at the Mac.
    let r: { killed: boolean; found: boolean };
    try { r = p.kill(root, slug, { slot: s.slot ?? '', force: s.runnerPid === p.selfPid }); } catch { r = { killed: false, found: true }; }
    if (r.killed) stopped += 1;
    else if (!r.found) found -= 1; // it ended on its own meanwhile
  }
  if (!found) return MEMBER_CMD_LINES.nothingRunning;
  if (!stopped) return MEMBER_CMD_LINES.notStopped;
  return MEMBER_CMD_LINES.stopped(stopped);
}

/** /durum of one member: running, waiting on the owner, the last few done. */
export function memberStatusText(root: string, slug: string, deps: MemberJobsDeps & { lastDone?: number } = {}): string {
  const p = parts(deps);
  let entries: ThreadEntry[] = [];
  try { entries = readThread(root, slug, { days: 7 }); } catch { entries = []; }
  const byRun = new Map<string, ThreadEntry[]>();
  for (const e of entries) { const l = byRun.get(e.runId); if (l) l.push(e); else byRun.set(e.runId, [e]); }
  const titleOf = (runId: string): string | null => {
    const ask = byRun.get(runId)?.find((e) => e.kind === 'user' && e.text.trim());
    return ask ? ask.text : null;
  };

  const rows: string[] = [];
  const claims = memberClaims(root, slug, p, RUNNING_PHASES);
  const taskRuns = new Set<string>();
  for (const c of claims) {
    if (taskRuns.has(c.taskId)) continue;
    taskRuns.add(c.taskId);
    rows.push(statusLineHtml('running', cleanTitle(`Görev: ${c.taskSlug}`, 60)));
  }
  const live = liveRuns(root, slug, p);
  for (const s of live) {
    if (ofClaim(s, claims)) continue; // the task row above already names it
    rows.push(statusLineHtml('running', cleanTitle(redactSecrets(titleOf(s.fireAt) ?? 'Zamanlanmış çalışma'), 60)));
  }

  let questions: ReturnType<typeof listQuestions> = [];
  try { questions = listQuestions(root, slug).filter((q) => q.state === 'pending'); } catch { questions = []; }
  const waiting = questions.slice(0, 8).map((q) => `${q.kind === 'approval' ? '✋' : '❓'} ${escapeHtml(cleanTitle(redactSecrets(q.question || 'Onay bekliyor'), 80))}`);

  const liveIds = new Set(live.map((s) => s.fireAt));
  const done: string[] = [];
  for (const runId of [...byRun.keys()].sort().reverse()) {
    if (done.length >= (deps.lastDone ?? 3)) break;
    if (liveIds.has(runId)) continue;
    const end = byRun.get(runId)!.filter((e) => e.kind === 'system' && (e.event === 'ok' || e.event === 'failed' || e.event === 'timeout')).pop();
    if (!end) continue;
    const title = titleOf(runId) ?? 'Zamanlanmış çalışma';
    done.push(statusLineHtml(end.event === 'ok' ? 'done' : 'stuck', cleanTitle(redactSecrets(title), 60)));
  }

  const out = ['<b>İşler</b>', ...(rows.length ? rows : ['Çalışan iş yok.'])];
  if (waiting.length) out.push('', '<b>Seni bekleyenler</b>', ...waiting);
  if (done.length) out.push('', '<b>Son bitenler</b>', ...done);
  return out.join('\n');
}

/** The line a command typed to a member bot gets, when it is not one of its own. */
export function memberCommandLine(cmd: string): string {
  return cmd === 'gundem' || cmd === 'handsfree' ? MEMBER_CMD_LINES.superOnly(cmd) : MEMBER_CMD_LINES.unknown;
}
