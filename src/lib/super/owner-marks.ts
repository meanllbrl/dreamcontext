/**
 * What the owner did by hand reaches the Super with his NEXT message, never at once (task
 * ajanda-gunluk C5, owner 2026-11-14). One carrier for every hand action: an agenda line's status,
 * Done, add and remove; a task he created or moved by hand (a kanban drag included).
 *
 * A mark is recorded only for a request proven to be his (the shell's owner key) and only while
 * that Super is on. It queues no event, starts no turn and touches no `away`. An agenda mark is
 * applied INSIDE the write of its action; a task mark in its own write right after the task file.
 * Marks coalesce per key, so a revert, or an add then a remove, leaves nothing. A mark never
 * blocks an action: every caller applies it inside a try.
 */
import { cleanPadText, type OwnerMark, type OwnerMarkKind, type SuperState } from './types.js';

export interface OwnerMarkInput {
  key: string;
  kind: OwnerMarkKind;
  text: string;
  from?: string;
  to?: string;
  at: number;
}

const created = (k: OwnerMarkKind) => k === 'pad-add' || k === 'task-created';
const removed = (k: OwnerMarkKind) => k === 'pad-remove';

/** Record one hand action on `s` (pure mutation; the store's sanitize bounds the bytes). Nothing
 *  while the Super is off. */
export function applyOwnerMark(s: SuperState, input: OwnerMarkInput): void {
  if (!s.enabled) return;
  const marks = [...(s.ownerMarks ?? [])];
  const i = marks.findIndex((m) => m.key === input.key);
  const was = i >= 0 ? marks[i] : null;
  const text = cleanPadText(input.text);
  const seq = (s.ownerMarkSeq ?? 0) + 1;
  let next: OwnerMark | null;
  if (!was) {
    // A status change to where it already was is no change.
    next = !created(input.kind) && !removed(input.kind) && input.from !== undefined && input.from === input.to ? null
      : { key: input.key, kind: input.kind, text, at: input.at, seq, ...(input.from ? { from: input.from } : {}), ...(input.to ? { to: input.to } : {}) };
  } else if (created(was.kind)) {
    // Added then removed: nothing happened. Added then moved: still the add, with its latest status.
    next = removed(input.kind) ? null : { ...was, text: text || was.text, at: input.at, seq, ...(input.to ? { to: input.to } : {}) };
  } else if (removed(input.kind)) {
    next = { key: was.key, kind: input.kind, text: text || was.text, at: input.at, seq, ...(was.from ? { from: was.from } : {}) };
  } else {
    // A newer status replaces the older one and keeps the first `from`; back to it = no change.
    const from = was.from ?? input.from;
    next = input.to !== undefined && input.to === from ? null
      : { key: was.key, kind: input.kind, text: text || was.text, at: input.at, seq, ...(from ? { from } : {}), ...(input.to ? { to: input.to } : {}) };
  }
  if (i >= 0) marks.splice(i, 1);
  if (next) marks.push(next);
  s.ownerMarkSeq = seq;
  if (marks.length) s.ownerMarks = marks; else delete s.ownerMarks;
}

/** Record a mark, never failing the write it rides (plan build note). */
export function tryOwnerMark(s: SuperState, input: OwnerMarkInput): void {
  try { applyOwnerMark(s, input); } catch (err) {
    console.warn(`[super] the owner's hand mark for ${input.key} was not recorded: ${(err as Error).message}`);
  }
}

/** Remove the carried marks that are still the ones carried (same key and seq, or key and at for
 *  an unnumbered one): a mark made between the read and the write stays. Mutates `s`. */
export function dropCarriedMarks(s: SuperState, carried: readonly Pick<OwnerMark, 'key' | 'at' | 'seq'>[]): void {
  if (!s.ownerMarks?.length || !carried.length) return;
  const same = (m: OwnerMark, c: Pick<OwnerMark, 'key' | 'at' | 'seq'>) =>
    m.key === c.key && (m.seq !== undefined && c.seq !== undefined ? m.seq === c.seq : m.at === c.at);
  s.ownerMarks = s.ownerMarks.filter((m) => !carried.some((c) => same(m, c)));
  if (!s.ownerMarks.length) delete s.ownerMarks;
}

/** A status word as the owner reads it in the block. */
const STATUS_WORDS: Record<string, string> = {
  'not-started': 'Not started', 'in-progress': 'In progress', 'almost-done': 'Almost done', waiting: 'Waiting', done: 'Done',
};
export function markWord(v: string | undefined): string {
  return v ? STATUS_WORDS[v] ?? v : '';
}

/** One mark's head line (no text: that goes through `wrapUntrusted`). */
export function markHead(m: OwnerMark, clock: (ms: number) => string): string {
  const what = m.kind === 'pad-add' ? 'added an agenda line' : m.kind === 'pad-remove' ? 'removed his agenda line'
    : m.kind === 'pad-status' ? 'changed an agenda line' : m.kind === 'task-created' ? 'created a task' : 'moved a task';
  const move = m.from || m.to ? ` ${markWord(m.from) || '?'} -> ${markWord(m.to) || '?'}` : '';
  return `- ${m.key} ${what}${m.kind === 'pad-add' || m.kind === 'task-created' ? (m.to ? ` (${markWord(m.to)})` : '') : move} at ${clock(m.at)}`;
}

/** The block's closing instruction. */
export const OWNER_MARKS_RULE = 'The owner did these by hand since his last message. They stand: never redo or undo them. Mention one only when it changes what you do.';
/** The block is bounded by its own bytes when built: older marks fold into one plain line. */
export const MAX_OWNER_MARKS_BLOCK = 8 * 1024;
