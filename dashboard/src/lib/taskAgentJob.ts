import type { AgentJob, AgentJobDelivery, AgentTaskState, StatusHistoryRow, Task } from '../hooks/useTasks';
import type { LinkedRepo } from '../hooks/useLinkedRepos';
import { tr, type Translate } from './assignToAgent';

/**
 * A task's agent job, as the task surfaces read it (AI Team v2 C2): the drawer's agent row, the
 * board's chips and filter, the stage's Tasks strip. Pure, so the tests drive it directly. The
 * server is the authority on every start and refusal; these only say where the job stands.
 */

/** States in which the job is moving on its own: the drawer and the board refresh while one holds. */
export const LIVE_STATES: ReadonlySet<AgentTaskState> = new Set(['scheduled', 'queued', 'starting', 'running']);

/** States that wait on the owner. */
export const NEEDS_OWNER_STATES: ReadonlySet<AgentTaskState> = new Set(['waiting_owner', 'blocked', 'stopped', 'stalled', 'stuck']);

export type ChipTone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad';

export interface JobChip {
  /** Stable key: the board filter and the tests read it. */
  key: 'scheduled' | 'queued' | 'running' | 'reviewing' | 'sent-back' | 'passed' | 'delivered' | 'waiting' | 'blocked' | 'stopped' | 'stalled' | 'stuck';
  tone: ChipTone;
  label: string;
}

/** A short local time for a start instant: today → "14:00", another day → "Mon 14:00". */
export function shortWhen(iso: string | null, now: Date = new Date(), locale?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

/** The job's one chip: what the board card and the stage strip show. Null when there is nothing to say. */
export function jobChip(job: AgentJob | null | undefined, t: Translate, now: Date = new Date()): JobChip | null {
  if (!job?.state) return null;
  const reviewing = job.step === 'review';
  switch (job.state) {
    case 'scheduled':
      return { key: 'scheduled', tone: 'neutral', label: tr(t, 'tasks.job.chip.scheduled', 'Starts {when}', { when: shortWhen(job.startAt, now) }) };
    case 'queued':
      if (reviewing) return { key: 'reviewing', tone: 'accent', label: tr(t, 'tasks.job.chip.reviewQueued', 'Review queued') };
      if (job.step === 'rework') return { key: 'sent-back', tone: 'warn', label: tr(t, 'tasks.job.chip.sentBack', 'Round {round} sent back', { round: String(job.round) }) };
      return { key: 'queued', tone: 'neutral', label: tr(t, 'tasks.job.chip.queued', 'Queued') };
    case 'starting':
    case 'running':
      if (reviewing) return { key: 'reviewing', tone: 'accent', label: tr(t, 'tasks.job.chip.reviewing', 'Reviewing · round {round}', { round: String(job.round) }) };
      return { key: 'running', tone: 'accent', label: tr(t, 'tasks.job.chip.running', 'Working') };
    case 'delivered':
      return job.reviewPassed
        ? { key: 'passed', tone: 'good', label: tr(t, 'tasks.job.chip.passed', 'Reviewer passed') }
        : { key: 'delivered', tone: 'good', label: tr(t, 'tasks.job.chip.delivered', 'Delivered') };
    case 'waiting_owner':
      return { key: 'waiting', tone: 'warn', label: tr(t, 'tasks.job.chip.waiting', 'Waiting on you') };
    case 'blocked':
      return { key: 'blocked', tone: 'bad', label: tr(t, 'tasks.job.chip.blocked', 'Blocked') };
    case 'stopped':
      return { key: 'stopped', tone: 'neutral', label: tr(t, 'tasks.job.chip.stopped', 'Stopped') };
    case 'stalled':
      return { key: 'stalled', tone: 'warn', label: tr(t, 'tasks.job.chip.stalled', 'Stalled') };
    case 'stuck':
      return { key: 'stuck', tone: 'bad', label: tr(t, 'tasks.job.chip.stuck', 'Stuck at round {round}', { round: String(job.round) }) };
    default:
      return null;
  }
}

/** The agent whose turn it is: the reviewer on a review step, else the doer. */
export function stepAgent(task: Pick<Task, 'agent' | 'agent_job'>): string | null {
  const job = task.agent_job;
  if (job?.step === 'review' && job.reviewer) return job.reviewer;
  return task.agent ?? null;
}

/**
 * Where a queued task stands in its step agent's line (1 = next), or null when it is not queued.
 * Same order as the server's drain: oldest `queuedAt` first (an unknown time last).
 */
export function queuePosition(task: Task, all: readonly Task[]): number | null {
  if (task.agent_job?.state !== 'queued') return null;
  const who = stepAgent(task);
  if (!who) return null;
  const at = (x: Task) => Date.parse(x.agent_job?.queuedAt ?? '') || Number.MAX_SAFE_INTEGER;
  const line = all
    .filter((x) => x.agent_job?.state === 'queued' && stepAgent(x) === who)
    .sort((a, b) => at(a) - at(b) || a.slug.localeCompare(b.slug));
  const i = line.findIndex((x) => x.slug === task.slug);
  return i < 0 ? null : i + 1;
}

/** Where the work happens, guessed: code when a repo is linked here and the task names a code layer. */
export function guessWorkspace(task: Pick<Task, 'tags'>, repos: readonly LinkedRepo[] | undefined): 'code' | 'doc' {
  const present = (repos ?? []).some((r) => r.present);
  const codeTag = (task.tags ?? []).some((tag) => /^layer:/.test(tag) || tag === 'kind:bug' || tag === 'kind:feature');
  return present && codeTag ? 'code' : 'doc';
}

/** A `<input type="datetime-local">` value as an absolute instant (ISO), or null when unreadable. */
export function localInputToInstant(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** An instant as a `datetime-local` value in this machine's zone (the field shows local time). */
export function instantToLocalInput(iso: string | null): string {
  const d = iso ? new Date(iso) : null;
  if (!d || !Number.isFinite(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * What came of a delivered round: passed, sent back by the reviewer, sent back by the owner,
 * failed at the review cap, stuck (no usable verdict), being reviewed now, or waiting on the
 * owner (no reviewer agent).
 */
export type RoundResult = 'passed' | 'sent-back' | 'owner-sent-back' | 'failed' | 'stuck' | 'reviewing' | 'owner';

export interface ReviewRound {
  round: number;
  deliveredAt: string;
  by: string;
  result: RoundResult;
  /** Who decided it, as the task's changelog names them (the reviewer's title), or null. */
  who: string | null;
  /** The reviewer's findings the changelog carries (its first 300 characters), or null. */
  findings: string | null;
}

/** `Review round N: sent back|passed|failed|stuck (<reviewer>)[: <findings>]`, the host's lines. */
const REVIEWER_LINE = /^Review round (\d+): (sent back|passed|failed|stuck)(?: \(([^)]*)\))?(?:[:.]\s*(.*))?$/;
/** `Review round N: sent back by the owner.`, the owner's send-back. */
const OWNER_LINE = /^Review round (\d+): sent back by the owner\b/;
const RESULT_OF: Record<string, RoundResult> = { 'sent back': 'sent-back', passed: 'passed', failed: 'failed', stuck: 'stuck' };

/**
 * One row per delivered round, newest first, from the task's history: the reviewer's own lines
 * (sent back with its findings, passed, failed at the cap, stuck) and the owner's send-back, the
 * newest line of a round deciding it. A round with no line falls back to the job itself: the
 * current round passed, stuck, being reviewed, or the owner's (no reviewer agent).
 */
export function reviewRounds(job: AgentJob | null | undefined, deliveries: readonly AgentJobDelivery[], history: readonly StatusHistoryRow[]): ReviewRound[] {
  const decided = new Map<number, { result: RoundResult; who: string | null; findings: string | null }>();
  // History is newest first: the first line for a round is its latest word.
  for (const h of history) {
    if (!h.reason) continue;
    if (h.by === 'owner') {
      const m = OWNER_LINE.exec(h.reason);
      if (m && !decided.has(Number(m[1]))) decided.set(Number(m[1]), { result: 'owner-sent-back', who: null, findings: null });
      continue;
    }
    if (!h.by?.startsWith('reviewer:')) continue;
    const m = REVIEWER_LINE.exec(h.reason);
    if (!m || decided.has(Number(m[1]))) continue;
    const rest = (m[4] ?? '').trim();
    decided.set(Number(m[1]), {
      result: RESULT_OF[m[2]],
      who: m[3]?.trim() || null,
      findings: (m[2] === 'sent back' || m[2] === 'failed') && rest ? rest : null,
    });
  }
  const latest = new Map<number, AgentJobDelivery>();
  for (const d of deliveries) latest.set(d.round, d);
  return [...latest.values()].sort((a, b) => b.round - a.round).map((d) => {
    const current = !!job && d.round === job.round;
    const line = decided.get(d.round);
    // A decided round is over (a rework delivers the next round), so its line is final.
    let result: RoundResult = 'owner';
    if (line) result = line.result;
    else if (current && job!.reviewPassed) result = 'passed';
    else if (current && job!.state === 'stuck') result = 'stuck';
    else if (current && job!.step === 'review') result = 'reviewing';
    return { round: d.round, deliveredAt: d.at, by: d.by, result, who: line?.who ?? null, findings: line?.findings ?? null };
  });
}

/**
 * Who the job waits on, in one line (mockup r8-11), from its state and step:
 *  - `reviewer`: the reviewer is on it (queued or running); nothing is needed from the owner;
 *  - `doer`: the doer is on it (work, rework, plan, queued or running); nothing from the owner;
 *  - `owner`: it is the owner's turn (a delivery to approve, a plan, a question);
 *  - `stuck`: it stopped and needs the owner (stuck at the cap, blocked, stopped, stalled).
 * Null when there is no job or it has not started (scheduled says its own time).
 */
export type JobWaitKey = 'reviewer' | 'doer' | 'owner' | 'stuck';

export function jobWaitKey(job: Pick<AgentJob, 'state' | 'step'> | null | undefined): JobWaitKey | null {
  if (!job?.state) return null;
  switch (job.state) {
    case 'queued':
    case 'starting':
    case 'running':
      return job.step === 'review' ? 'reviewer' : 'doer';
    case 'delivered':
    case 'waiting_owner':
      return 'owner';
    case 'stuck':
    case 'blocked':
    case 'stopped':
    case 'stalled':
      return 'stuck';
    default:
      return null;
  }
}

export interface JobWaitLine {
  key: JobWaitKey;
  /** The bold half: "İnceleyici çalışıyor", "Senin onayında", "Takıldı". */
  label: string;
  /** "tur 2/5" once a round was delivered, else ''. */
  round: string;
  /** The quiet half: "senden bir şey beklemiyor" while an agent works, else ''. */
  hint: string;
}

/** The job line in words. `name` is the doer's name (the doer's line names it). */
export function jobWaitLine(job: AgentJob | null | undefined, t: Translate, name: string): JobWaitLine | null {
  const key = jobWaitKey(job);
  if (!key || !job) return null;
  const label = key === 'reviewer'
    ? tr(t, 'tasks.job.wait.reviewer', 'Reviewer at work')
    : key === 'doer'
      ? tr(t, 'tasks.job.wait.doer', '{name} is working', { name })
      : key === 'owner'
        ? tr(t, 'tasks.job.wait.owner', 'Waiting for your approval')
        : tr(t, 'tasks.job.wait.stuck', 'Stuck');
  // The round on the line is the one in play: the review's round, the rework's next one.
  const shown = job.step === 'rework' ? job.round + 1 : job.round;
  const round = shown > 0 && job.cap > 0 ? tr(t, 'tasks.job.wait.round', 'round {round}/{cap}', { round: String(shown), cap: String(job.cap) }) : '';
  const hint = key === 'reviewer' || key === 'doer' ? tr(t, 'tasks.job.wait.notYou', 'nothing needed from you') : '';
  return { key, label, round, hint };
}

/**
 * Whether a task step can run on each tool: mirrors `HEADLESS_ENVELOPES['task-step']`
 * (`src/lib/t3-bridge/headless-envelope.ts`), pinned by a drift test. `null` = Claude only today.
 */
export const TASK_STEP_TOOL_MODES: Readonly<Record<'codex' | 'antigravity', string | null>> = { codex: null, antigravity: null };

/** The member's tool when a task step cannot run on it (it would be refused at assignment), else null. */
export function taskToolBlocked(agent: { tool?: 'claude' | 'codex' | 'antigravity' } | null | undefined): 'codex' | 'antigravity' | null {
  const tool = agent?.tool;
  if (tool !== 'codex' && tool !== 'antigravity') return null;
  return TASK_STEP_TOOL_MODES[tool] === null ? tool : null;
}

/**
 * The member is waiting on the one approval card: its approval does not match what it is now
 * (a synced or authority-widening change, or never approved here), read from the fields the
 * server already sends. A teammate's read-only member never is.
 */
export function waitsOnApprovalCard(a: { approvedToRun: boolean; approvalReason: string | null; readOnly?: boolean }): boolean {
  if (a.approvedToRun || a.readOnly) return false;
  return a.approvalReason === 'manifest-changed' || a.approvalReason === 'payload-format-changed' || a.approvalReason === 'never-approved';
}

/** Who made a status change, in words. `nameOf` turns an agent slug into its name. */
export function authorText(by: string | null, t: Translate, nameOf: (slug: string) => string): string {
  if (!by) return '';
  if (by === 'owner') return tr(t, 'tasks.history.byOwner', 'you');
  if (by === 'claude') return tr(t, 'tasks.history.byClaude', 'a Claude session');
  if (by === 'sleep') return tr(t, 'tasks.history.bySleep', 'sleep');
  const [kind, slug] = by.split(':');
  if (kind === 'agent' && slug) return nameOf(slug);
  if (kind === 'reviewer' && slug) return tr(t, 'tasks.history.byReviewer', '{name} (reviewer)', { name: nameOf(slug) });
  return by;
}
