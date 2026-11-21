import { jobsRows, type JobRow, type JobsSource } from '../../../../../src/lib/super/jobs-view.js';

/**
 * "While you were away" (plan super-v3 D10, K13): what the empty Super screen tells him when he
 * comes back, read from the record alone (the same rows as the `jobs` view, `jobsRows`), never
 * from what the agent typed. Three groups: finished, wait for you, running; each its count, the
 * newest job's name and one more line. No time left anywhere (D4): a running job says when its
 * last step was.
 */

/** An absence as the record held it (`SuperStateView.away`), kept by this window (below). */
export interface AwaySpan { since: number; until: number; viaTelegram: number }

export interface AwaySummary {
  span: AwaySpan | null;
  finished: { n: number; lead: string; others: string[] };
  waiting: { n: number; lead: string; commands: number; more: number; itemId?: string; firstJob?: string };
  running: { n: number; lead: string; at: number; firstJob?: string };
  /** The finished jobs' ids (Show what finished draws them). */
  finishedIds: string[];
}

/**
 * The summary of `record`'s jobs. With a known absence, "finished" counts only the jobs whose
 * last update came after it began; without one, every job still on the record that finished.
 */
export function awaySummary(record: JobsSource, needsOwner: (q: unknown) => boolean, span: AwaySpan | null): AwaySummary {
  const { rows } = jobsRows(record, needsOwner as Parameters<typeof jobsRows>[1]);
  const done = rows.filter((r) => r.state === 'done' && (!span || r.at >= span.since));
  const waiting = rows.filter((r) => r.state === 'waiting');
  const running = rows.filter((r) => r.state === 'running');
  const first = (list: JobRow[]) => list[0];
  // Led by a question or approval in words; the commands to allow are the line under it (frame E).
  const w = waiting.find((r) => r.waitingOn !== 'permission') ?? first(waiting);
  const restWaiting = waiting.filter((r) => r !== w);
  const commands = restWaiting.filter((r) => r.waitingOn === 'permission').length;
  const run = first(running);
  return {
    span,
    finished: { n: done.length, lead: first(done)?.name ?? '', others: done.slice(1).map((r) => r.name) },
    waiting: {
      n: waiting.length, lead: w?.name ?? '', commands, more: restWaiting.length - commands,
      ...(w?.itemId ? { itemId: w.itemId } : {}), ...(w && w.kind === 'child' ? { firstJob: w.id } : {}),
    },
    running: { n: running.length, lead: run?.name ?? '', at: run?.at ?? 0, ...(run && run.kind === 'child' ? { firstJob: run.id } : {}) },
    finishedIds: done.map((r) => r.id),
  };
}

/** Anything to show: a screen with no job keeps its ordinary empty state. */
export function awayHasAny(s: AwaySummary): boolean {
  return s.finished.n + s.waiting.n + s.running.n > 0;
}

/** The "and …" line under the finished tile's name: up to two more names, then a count. */
export function finishedOthersText(others: readonly string[], words: { too: string; more: string }): string {
  if (!others.length) return '';
  const named = others.slice(0, 2).join(' and ');
  const rest = others.length - 2;
  return rest > 0 ? `${others.slice(0, 2).join(', ')} ${words.more.replace('{n}', String(rest))}` : words.too.replace('{names}', named);
}

/**
 * The window's memory of the last absence per Super session: the server clears `away` the moment
 * he comes back (the return recap), so the span he was away for is kept here from the last record
 * that carried one. Module state in this window only (a reload starts clean: the tiles still show
 * the counts, without the span line).
 */
const spans = new Map<string, AwaySpan>();
const SPAN_CAP = 50;

export function rememberAwaySpan(session: string, away: { since: number | null; until?: number; viaTelegram?: number } | undefined): AwaySpan | null {
  if (away && away.since !== null) {
    const span: AwaySpan = { since: away.since, until: away.until ?? away.since, viaTelegram: away.viaTelegram ?? 0 };
    spans.delete(session);
    spans.set(session, span);
    if (spans.size > SPAN_CAP) spans.delete(spans.keys().next().value as string);
    return span;
  }
  return spans.get(session) ?? null;
}

export function _resetAwaySpans(): void { spans.clear(); }
