/**
 * The Super chat's job filter (plan super-v3 D9, K11): tapping an agenda row narrows the chat to
 * that job until he taps it again or "Show all". One window-wide value, never written to the
 * record. W1 opens the seam (the card outline reads it); W2 fills `inJob`.
 */
import { useSyncExternalStore } from 'react';
import { splitAboutParts, superBatchOf } from './superHandover';

let current: string | null = null;
const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The job the chat is narrowed to (a child's session id or an agenda line's id), or null. */
export function useJobFilter(): string | null {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/** Narrow the chat to `job`, or clear it with null. */
export function setJobFilter(job: string | null): void {
  if (job === current) return;
  current = job;
  for (const fn of [...listeners]) fn();
}

/** The agenda's Stop on a job (D9 = D2's red light on that job): the job's own card answers it
 *  (its sheet when it works, else it ends with Undo) and marks the event handled. */
export const STOP_JOB_EVENT = 'super:stop-job';
export function requestStopJob(child: string): boolean {
  if (typeof window === 'undefined' || !child) return false;
  const detail = { child, handled: false };
  window.dispatchEvent(new CustomEvent(STOP_JOB_EVENT, { detail }));
  return detail.handled;
}

/** The value now, outside React. */
export function jobFilterNow(): string | null { return current; }

/** What else names the job the chat is narrowed to: its agenda lines' ids, its queue items' ids
 *  and its stage cards' ids (published by the stage from the record, K11). An owner message whose
 *  About head names one of them is about the job. */
let tokens: ReadonlySet<string> = new Set();
/** The Super session whose stage set the filter: only ITS chat narrows (a member's never). */
let filterOwner: string | null = null;
export function publishJobTokens(next: ReadonlySet<string>, superSession: string | null): void { tokens = next; filterOwner = superSession; }
export function jobTokensNow(): ReadonlySet<string> { return tokens; }
/** The job `superSession`'s chat is narrowed to (null for any other chat). */
export function useJobFilterFor(superSession: string | null): string | null {
  const job = useJobFilter();
  return job && superSession && filterOwner === superSession ? job : null;
}

/** The ids that name `child` in the record: its notes (`for`), queue items and stage cards. */
export function jobTokensOf(state: {
  pad?: ReadonlyArray<{ id: string; for?: string }>;
  queue?: ReadonlyArray<{ id: string; sessionId: string }>;
  containers?: ReadonlyArray<{ id: string; ref: string }>;
} | null | undefined, child: string | null): Set<string> {
  const out = new Set<string>();
  if (!state || !child) return out;
  out.add(child);
  for (const p of state.pad ?? []) if (p.for === child) out.add(p.id);
  for (const q of state.queue ?? []) if (q.sessionId === child) out.add(q.id);
  for (const c of state.containers ?? []) if (c.ref === child) out.add(c.id);
  return out;
}

/**
 * Does a turn's HEAD (an owner message or an event line, both `user` items) belong to `job`
 * (K11)? An event line when one of its jobs is the job; an owner message when an About or card
 * head it opened with names the job, its line, item or card, or his words name the job's id.
 * A turn is kept or dropped whole (`keepJobTurns`), so the Super's reply goes with its message.
 */
export function inJob(item: { kind: string; text?: string }, job: string | null, names: ReadonlySet<string> = tokens): boolean {
  if (!job) return true;
  if (item.kind !== 'user' || typeof item.text !== 'string') return false;
  const ev = superBatchOf(item.text);
  if (ev) return ev.items.some((x) => x.child === job);
  const { parts } = splitAboutParts(item.text);
  if (parts.some((p) => p.about.kind !== 'reply' && (names.has(p.about.id) || p.about.id === job))) return true;
  return item.text.includes(job);
}

/**
 * The chat narrowed to `job`: whole turns (a `user` head and what follows it up to the next
 * `user` item) whose head is in the job, plus every item `keep` names (an open question card's
 * anchor: the filter never hides an open question card). Items before the first head (none in a
 * Super chat) stay. Same array when nothing is narrowed.
 */
export function keepJobTurns<T extends { id: string; kind: string; text?: string }>(items: T[], job: string | null, keep: ReadonlySet<string>, names: ReadonlySet<string> = tokens): T[] {
  if (!job) return items;
  const out: T[] = [];
  let on = true;
  for (const it of items) {
    if (it.kind === 'user') on = inJob(it, job, names);
    if (on || keep.has(it.id)) out.push(it);
  }
  return out;
}
