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

export type RoundResult = 'passed' | 'sent-back' | 'reviewing' | 'owner';

export interface ReviewRound {
  round: number;
  deliveredAt: string;
  by: string;
  result: RoundResult;
}

const SENT_BACK = /^Review round (\d+): sent back/;

/**
 * One row per delivered round, newest first: passed (the reviewer passed it), sent back (the
 * reviewer's status change names that round), reviewing (the current round, review step), or
 * owner (delivered with no reviewer agent: the owner reviews).
 */
export function reviewRounds(job: AgentJob | null | undefined, deliveries: readonly AgentJobDelivery[], history: readonly StatusHistoryRow[]): ReviewRound[] {
  const sentBack = new Set<number>();
  for (const h of history) {
    const m = h.by?.startsWith('reviewer:') && h.reason ? SENT_BACK.exec(h.reason) : null;
    if (m) sentBack.add(Number(m[1]));
  }
  const latest = new Map<number, AgentJobDelivery>();
  for (const d of deliveries) latest.set(d.round, d);
  return [...latest.values()].sort((a, b) => b.round - a.round).map((d) => {
    let result: RoundResult = 'owner';
    if (sentBack.has(d.round)) result = 'sent-back';
    else if (job && d.round === job.round && job.reviewPassed) result = 'passed';
    else if (job && d.round === job.round && job.step === 'review') result = 'reviewing';
    return { round: d.round, deliveredAt: d.at, by: d.by, result };
  });
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
