import { msgRef } from '../../../lib/superTypes';
import { groupSuperEventTurns } from './superHandover';

/**
 * WHAT IS UNREAD in the Super Agent's chat (owner 2026-10-30, draft A): the pure half.
 * `useSuperUnread` holds the DOM, the timer and the wire; every rule lives here so it is tested
 * without a browser. The record itself is the server's (src/lib/super/read-marks.ts).
 *
 * A UNIT is one thing the owner can miss: a finished prose block of the Super Agent, an event
 * line standing for a turn folded behind it, or an open question card. The owner's own messages
 * are never one.
 */

export interface ReadMark { key: string; ts: number }
export interface ReadMarks { since: number; read: readonly ReadMark[] }

export interface UnreadUnit {
  key: string;
  /** The message's own time; 0 = unknown. */
  ts: number;
  /** The row's `data-item-id`; a question card has none. */
  itemId: string | null;
  /** The card's `data-item`. */
  question: string | null;
}

/** Enough of a chat item for the rules here. */
export interface UnreadItem {
  kind: string;
  id: string;
  text?: string;
  ts?: number;
  done?: boolean;
  stageMedia?: unknown;
  name?: string;
  input?: unknown;
}

/** Event turns that are bookkeeping unless the Super Agent actually said something in them. */
const QUIET_EVENTS: ReadonlySet<string> = new Set(['handover', 'fresh']);

/** The same words on another render path (live stream or replay, a reply mark's comment head
 *  or not) must give the same key, or a message read yesterday comes back unread. */
export function wordsKey(text: string): string {
  return msgRef(text.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' '));
}

/** Finished items do not change, and the list is walked on every token of a live turn. */
const keys = new WeakMap<object, string>();
function keyOf(it: UnreadItem): string {
  let k = keys.get(it);
  if (k === undefined) { k = wordsKey(it.text ?? ''); keys.set(it, k); }
  return k;
}

/** An injected turn's live chip and its stored prompt are different words for one event, so its
 *  key is what the event IS. The same event again goes by `SAME_MESSAGE_MS`. */
function eventKey(g: { kind: string; batch: string | null; items: ReadonlyArray<{ child: string }> }): string {
  return `e:${msgRef([g.kind, g.batch ?? '', ...g.items.map((i) => i.child)].join('|'))}`;
}

/** Every unit in the conversation, oldest first. `fold` is on when the pane folds event turns. */
export function unreadUnits(
  items: readonly UnreadItem[],
  opts: { fold: boolean; ownerBatches: readonly string[]; openQuestions: ReadonlyArray<{ id: string; createdAt: number }> },
): UnreadUnit[] {
  const folded = new Set<string>();
  const anchors = new Map<string, string>();
  if (opts.fold) {
    const { groups } = groupSuperEventTurns(items, { ownerBatches: opts.ownerBatches, expanded: new Set() });
    const textIds = new Set(items.filter((it) => it.kind === 'text' && it.text?.trim()).map((it) => it.id));
    for (const g of groups.values()) {
      for (const id of g.folded) folded.add(id);
      // A batch he was asked in is drawn full: its prose rows speak for it.
      if (!g.full && (!QUIET_EVENTS.has(g.kind) || g.folded.some((id) => textIds.has(id)))) anchors.set(g.anchor, eventKey(g));
    }
  }
  const units: UnreadUnit[] = [];
  for (const it of items) {
    const ts = it.ts ?? 0;
    const anchor = anchors.get(it.id);
    if (anchor) {
      units.push({ key: anchor, ts, itemId: it.id, question: null });
    } else if (it.kind === 'text' && it.done && it.text?.trim() && !folded.has(it.id)) {
      units.push({ key: `t:${keyOf(it)}`, ts, itemId: it.id, question: null });
    }
  }
  for (const q of opts.openQuestions) units.push({ key: `q:${q.id}`, ts: q.createdAt, itemId: null, question: q.id });
  return units.sort((a, b) => a.ts - b.ts);
}

/** How far a mark reaches past the time it was read at: a replay dates a message a little
 *  differently from the live stream, but the same words hours later are a new message. */
export const SAME_MESSAGE_MS = 10 * 60_000;

/** What is still unread. Null marks (not loaded yet) flag nothing: no flash of false dots. A
 *  unit with no time cannot be placed against the record, so it is never flagged. */
export function unreadOf(units: readonly UnreadUnit[], marks: ReadMarks | null): UnreadUnit[] {
  if (!marks) return [];
  const newest = new Map<string, number>();
  for (const m of marks.read) newest.set(m.key, Math.max(newest.get(m.key) ?? 0, m.ts));
  return units.filter((u) => {
    if (u.ts <= marks.since) return false;
    const m = newest.get(u.key);
    return m === undefined || u.ts > m + SAME_MESSAGE_MS;
  });
}

/** Add-only, like the server's merge, so a slow answer cannot bring a dot back. */
export function withRead(marks: ReadMarks, read: readonly ReadMark[]): ReadMarks {
  return { since: marks.since, read: [...marks.read, ...read] };
}

export function mergeMarks(a: ReadMarks, b: ReadMarks): ReadMarks {
  const byKey = new Map(a.read.map((m) => [m.key, m]));
  for (const m of b.read) {
    const held = byKey.get(m.key);
    if (!held || held.ts < m.ts) byKey.set(m.key, m);
  }
  return { since: Math.max(a.since, b.since), read: [...byKey.values()] };
}

/** A body of the marks or null, read off the wire. */
export function readMarksOf(raw: unknown): ReadMarks | null {
  const o = raw as Partial<ReadMarks> | null;
  if (!o || typeof o !== 'object' || typeof o.since !== 'number' || !Array.isArray(o.read)) return null;
  return { since: o.since, read: o.read.filter((m) => m && typeof m.key === 'string' && typeof m.ts === 'number') };
}

// ─── Seen: the reading rule ──────────────────────────────────────────────────────

/** ~1 second on screen, mostly visible. */
export const DWELL_MS = 1000;
export const MOSTLY_VISIBLE = 0.6;

export interface Span { top: number; bottom: number }

/** Mostly visible: most of the row is in view, or a row taller than the view fills most of it. */
export function mostlyVisible(row: Span, view: Span): boolean {
  const height = row.bottom - row.top;
  const inView = Math.min(row.bottom, view.bottom) - Math.max(row.top, view.top);
  if (height <= 0 || inView <= 0) return false;
  return inView / height >= MOSTLY_VISIBLE || inView / (view.bottom - view.top) >= MOSTLY_VISIBLE;
}

/** Above the view, below it, or in it. */
export function sideOf(row: Span, view: Span): 'above' | 'below' | 'in' {
  if (row.bottom <= view.top) return 'above';
  if (row.top >= view.bottom) return 'below';
  return 'in';
}

/** A tab or window in the back reads nothing, nor does a pane something else covers. */
export function ownerCanRead(s: { docVisible: boolean; focused: boolean; paneShown: boolean }): boolean {
  return s.docVisible && s.focused && s.paneShown;
}

/**
 * One tick of the clock: `started` holds when each unit came into view. A unit leaving the view
 * loses its time, so scrolling past does not add up to a read.
 */
export function advanceDwell(
  started: ReadonlyMap<string, number>,
  visible: readonly string[],
  now: number,
): { started: Map<string, number>; seen: string[] } {
  const next = new Map<string, number>();
  const seen: string[] = [];
  for (const key of visible) {
    const from = started.get(key) ?? now;
    if (now - from >= DWELL_MS) seen.push(key);
    else next.set(key, from);
  }
  return { started: next, seen };
}
