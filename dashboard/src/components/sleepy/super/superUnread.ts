import { msgRef } from '../../../lib/superTypes';
import { groupSuperEventTurns, superEventOf } from './superHandover';

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
/** The same, told by the prompt itself: the server re-sending a turn the Super owes a reply. It
 *  tells the owner nothing, and its replay is drawn as an event line its live copy never was, so
 *  it came back unread after every reload (and, with the follow, the reload landed on it). */
const QUIET_PREFIXES: ReadonlySet<string> = new Set(['[super owed]']);

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
 *  key is what the event IS: its batch id when it has one (a batch's item lines differ between the
 *  two), else its kind and children. `prose` is the finished blocks folded behind it, so a reply
 *  landing after the line was read flags the line again. */
function eventKey(g: { kind: string; batch: string | null; items: ReadonlyArray<{ child: string }> }, prose: number): string {
  const what = g.batch ? `b|${g.batch}` : [g.kind, ...g.items.map((i) => i.child)].join('|');
  return `e:${msgRef(what)}.${prose}`;
}

/** Every unit in the conversation, oldest first. `fold` is on when the pane folds event turns. */
export function unreadUnits(
  items: readonly UnreadItem[],
  opts: {
    fold: boolean;
    ownerBatches: readonly string[];
    openQuestions: ReadonlyArray<{ id: string; createdAt: number }>;
    /** A member Super's turns for main Super (plan-r10 1, `mainBatches`): main-handed work is never
     *  the owner's to read, so nothing under such a batch (its event line, its prose) is a unit. */
    mainBatches?: readonly string[];
  },
): UnreadUnit[] {
  const folded = new Set<string>();
  const anchors = new Map<string, string>();
  /** Items under a main batch: the event turn itself and every item up to the next user item. */
  const forMain = new Set<string>();
  if (opts.mainBatches?.length) {
    const main = new Set(opts.mainBatches);
    const { groups } = groupSuperEventTurns(items, { ownerBatches: opts.ownerBatches, expanded: new Set(items.map((it) => it.id)) });
    let open: string | null = null;
    for (const it of items) {
      const g = groups.get(it.id);
      if (g) { open = g.batch !== null && main.has(g.batch) ? g.anchor : null; if (open) forMain.add(it.id); continue; }
      if (it.kind === 'user') open = null;
      if (open) forMain.add(it.id);
    }
  }
  if (opts.fold) {
    const { groups } = groupSuperEventTurns(items, { ownerBatches: opts.ownerBatches, expanded: new Set() });
    const textIds = new Set(items.filter((it) => it.kind === 'text' && it.done && it.text?.trim()).map((it) => it.id));
    const textOf = new Map(items.map((it) => [it.id, it.text ?? '']));
    for (const g of groups.values()) {
      for (const id of g.folded) folded.add(id);
      // A batch he was asked in is drawn full: its prose rows speak for it.
      const prose = g.folded.filter((id) => textIds.has(id)).length;
      const quiet = QUIET_EVENTS.has(g.kind) || QUIET_PREFIXES.has(superEventOf(textOf.get(g.anchor) ?? '')?.prefix ?? '');
      if (!g.full && (!quiet || prose > 0)) anchors.set(g.anchor, eventKey(g, prose));
    }
  }
  const units: UnreadUnit[] = [];
  // Before the first user item the replay's tail may have cut a turn in half: prose whose event
  // line is gone would read as a new, unmarked message.
  let opened = false;
  for (const it of items) {
    if (it.kind === 'user') opened = true;
    if (!opened || forMain.has(it.id)) continue;
    const ts = it.ts ?? 0;
    const anchor = anchors.get(it.id);
    if (anchor) units.push({ key: anchor, ts, itemId: it.id, question: null });
    else if (it.kind === 'text' && it.done && it.text?.trim() && !folded.has(it.id)) units.push({ key: `t:${keyOf(it)}`, ts, itemId: it.id, question: null });
  }
  for (const q of opts.openQuestions) units.push({ key: `q:${q.id}`, ts: q.createdAt, itemId: null, question: q.id });
  return units.sort((a, b) => a.ts - b.ts);
}

/** A mark covers its message at about its time: a replay dates a block by when it was written, the
 *  live stream by when it began. The same words further apart are another message; a position in
 *  the list could not say so, the replay keeps only the newest items. */
export const SAME_MESSAGE_MS = 3 * 60_000;

/** What is still unread. Null marks (not loaded yet) flag nothing: no flash of false dots. A
 *  unit with no time cannot be placed against the record, so it is never flagged. */
export function unreadOf(units: readonly UnreadUnit[], marks: ReadMarks | null): UnreadUnit[] {
  if (!marks) return [];
  const times = new Map<string, number[]>();
  for (const m of marks.read) {
    const held = times.get(m.key);
    if (held) held.push(m.ts); else times.set(m.key, [m.ts]);
  }
  return units.filter((u) => {
    if (u.ts <= marks.since) return false;
    return !times.get(u.key)?.some((t) => Math.abs(u.ts - t) <= SAME_MESSAGE_MS);
  });
}

/**
 * Which unit leads: one with no row yet is above the window (a question card can be drawn at the
 * chat's tail however old it is, so time order alone is not the page's order), else the topmost.
 * `tops[i]` is the unit's row top, null with no row. -1: no unit.
 */
export function leadIndex(tops: ReadonlyArray<number | null>): number {
  let best = -1;
  for (let i = 0; i < tops.length; i++) {
    const top = tops[i];
    if (top === null) return i;
    if (best < 0 || top < (tops[best] as number)) best = i;
  }
  return best;
}

/**
 * Where a jump goes: the OLDEST unread out of view, so the reader walks the list in reading order.
 * Anything whose start is above the view (or above the window: no row) comes first, then the
 * nearest below. A
 * walk under way passes `after`, the row it stands on: it goes on forward while there is a row
 * ahead, or a row still inside its dwell would call every click back. -1: all on screen.
 */
export function nextUnreadIndex(rows: ReadonlyArray<Span | null>, view: Span, after: Span | null = null): number {
  let below = -1;
  let above = -1;
  let ahead = -1;
  let unmounted = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) { if (unmounted < 0) unmounted = i; continue; }
    // By the START: a tall unread whose first line is above the view is above, however much of
    // it fills the view (owner 2026-11-12). A start inside the view counts as on screen only when
    // the row is SEEN by the read rule (startSeen): a first line peeking in at the bottom edge is
    // not being read, so it is ahead below, or the jump would pass it and scroll it away unread.
    const at = startSide(row, view);
    const side = at === 'in' && !startSeen(row, view) ? 'below' : at;
    if (side === 'above' && (above < 0 || row.top < (rows[above] as Span).top)) above = i;
    if (side === 'below' && (below < 0 || row.top < (rows[below] as Span).top)) below = i;
    if (after && side !== 'in' && row.top > after.top && (ahead < 0 || row.top < (rows[ahead] as Span).top)) ahead = i;
  }
  if (ahead >= 0) return ahead;
  if (unmounted >= 0) return unmounted;
  return above >= 0 ? above : below;
}

/**
 * The "Unread" line does not follow the reading. It holds its row while that row is on screen, so
 * nothing moves under the reader's eyes; off screen it goes to the current lead; and a message
 * landing at the bottom of a pinned view, being read as it arrives, draws no line at all.
 */
export function chooseLine(s: { held: boolean; heldInView: boolean; heldIsLead: boolean; lead: boolean; leadInView: boolean; pinned: boolean }): 'held' | 'lead' | 'none' {
  if (s.held && (s.heldInView || s.heldIsLead)) return 'held';
  if (!s.lead || (s.pinned && s.leadInView)) return 'none';
  return 'lead';
}

/** The first PROSE or event row mounted. A question card proves nothing about the window: it
 *  sits in the always-mounted tail, with unmounted rows newer than it. */
export function firstMountedRow(units: readonly Pick<UnreadUnit, 'itemId'>[], mounted: readonly boolean[]): number {
  return units.findIndex((u, i) => mounted[i] && u.itemId);
}

/** Add-only, like the server's merge, so a slow answer cannot bring a dot back. */
export function withRead(marks: ReadMarks, read: readonly ReadMark[]): ReadMarks {
  return { since: marks.since, read: [...marks.read, ...read] };
}

export function mergeMarks(a: ReadMarks, b: ReadMarks): ReadMarks {
  const byId = new Map([...a.read, ...b.read].map((m) => [`${m.key}|${m.ts}`, m]));
  return { since: Math.max(a.since, b.since), read: [...byId.values()] };
}

/** A body of the marks or null, read off the wire. */
export function readMarksOf(raw: unknown): ReadMarks | null {
  const o = raw as Partial<ReadMarks> | null;
  if (!o || typeof o !== 'object' || typeof o.since !== 'number' || !Array.isArray(o.read)) return null;
  return { since: o.since, read: o.read.filter((m) => m && typeof m.key === 'string' && typeof m.ts === 'number') };
}

// ─── The jump ────────────────────────────────────────────────────────────────────

export const GLIDE_MS = 260;
/** The longest stretch a jump animates. A long way is covered at once and only the last of it
 *  glides: animating thousands of pixels of mounted rows is what stuttered. */
export const GLIDE_REACH = 480;

export function glideFrom(from: number, to: number, reach = GLIDE_REACH): number {
  return Math.abs(to - from) <= reach ? from : to - Math.sign(to - from) * reach;
}

export function glideEase(t: number): number {
  return 1 - (1 - t) ** 3;
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

// ─── The follow: new content never pushes an unread START out of view (owner 2026-11-12) ───

/** A row's first line counts as on screen this close to the view's top edge. */
export const START_SLACK = 8;
/** A follow target this close to the bottom IS the bottom: the view stays pinned. The pin's own
 *  `BOTTOM_SLACK` (chat/chatEntities.ts), mirrored so this file stays free of the pane's imports;
 *  a drift test holds them equal. */
export const FOLLOW_SLACK = 48;
/** Where a prose or event row lands below the view's top: ChatPane's `RAIL_CLEARANCE`, mirrored
 *  (the pane imports this file, not the other way round). */
export const PROSE_LANDING = 64;

/** The row's first line is inside the view. */
export function startInView(row: Span, view: Span): boolean {
  return row.top >= view.top - START_SLACK && row.top < view.bottom;
}

/** Which side of the view the row's FIRST LINE is on: a tall row whose start is above is above,
 *  however much of it fills the view. */
export function startSide(row: Span, view: Span): 'above' | 'below' | 'in' {
  if (row.top < view.top - START_SLACK) return 'above';
  if (row.top >= view.bottom) return 'below';
  return 'in';
}

/** Seen = its start is on screen AND it is mostly visible: the end of a tall row alone is not. */
export function startSeen(row: Span, view: Span): boolean {
  return startInView(row, view) && mostlyVisible(row, view);
}

/**
 * Where a pinned view goes when content lands: the bottom, unless that would put the anchor's
 * start above the view; then the anchor's start, `landing` below the top, and the view is HELD
 * there (unpinned) until the reader moves it. Offsets are the scroller's content coordinates.
 * `floor`: a pinned view only ever moves DOWN (its current offset), so nothing it holds can pull
 * it up; only the first landing of an opened pane passes 0 (plan r1 C1).
 */
export function followTop(bottomTop: number, anchorTop: number | null, landing: number, floor = 0): { top: number; held: boolean } {
  const bottom = Math.max(0, bottomTop);
  if (anchorTop === null) return { top: bottom, held: false };
  const capped = Math.max(0, floor, anchorTop - landing);
  if (capped >= bottom - FOLLOW_SLACK) return { top: bottom, held: false };
  return { top: capped, held: true };
}

export type FollowAnchor = { itemId: string; unit: UnreadUnit | null } | { question: string; unit: UnreadUnit };

/**
 * What the reader chose to go past (Latest, a send, his own scroll to the end). Units by what the
 * read marks match them by, key and time (a replay re-ids every row, plan r1 C1); the live text by
 * its row id, which it keeps while it is being written.
 */
export interface Passed { units: ReadMark[]; live: Set<string> }
export const emptyPassed = (): Passed => ({ units: [], live: new Set() });

/**
 * What the follow must keep in view: the first, in transcript order, of an unread unit the reader
 * has not passed or the Super text still being written. A question card ranks after every item.
 */
export function followAnchors(
  items: ReadonlyArray<{ id: string }>,
  unread: readonly UnreadUnit[],
  passed: Passed,
  liveText: string | null,
): FollowAnchor[] {
  // The marks' own matcher: passed is a read the reader chose, without the dot going.
  const open = unreadOf(unread, { since: -Infinity, read: passed.units });
  const rows = new Map<string, UnreadUnit | null>();
  for (const u of open) if (u.itemId) rows.set(u.itemId, u);
  if (liveText && !passed.live.has(liveText) && !rows.has(liveText)) rows.set(liveText, null);
  const out: FollowAnchor[] = [];
  if (rows.size) for (const it of items) if (rows.has(it.id)) out.push({ itemId: it.id, unit: rows.get(it.id) ?? null });
  for (const q of open) if (q.question) out.push({ question: q.question, unit: q });
  return out;
}

/** The first candidate (the pane walks the rest when a candidate draws no row). */
export function followAnchor(...args: Parameters<typeof followAnchors>): FollowAnchor | null {
  return followAnchors(...args)[0] ?? null;
}

/** Pass every current unit and the live text. */
export function passAll(passed: Passed, unread: readonly UnreadUnit[], liveText: string | null): void {
  const have = new Set(passed.units.map((m) => `${m.key}|${m.ts}`));
  for (const u of unread) if (!have.has(`${u.key}|${u.ts}`)) passed.units.push({ key: u.key, ts: u.ts });
  if (liveText) passed.live.add(liveText);
}

/** How far below the view's top a unit lands: prose under the rail's clearance; a question card
 *  whole when it fits (as close to that clearance as its height allows), its top when it does not. */
export function landingFor(unit: 'prose' | 'question', rowHeight: number, viewHeight: number): number {
  if (unit === 'prose') return PROSE_LANDING;
  return Math.max(12, Math.min(PROSE_LANDING, viewHeight - rowHeight));
}

/**
 * A door to a question (the band's Answer, the agenda's waiting row; owner K1 = A): when an unread
 * message above the card has its start off screen, the door lands on the topmost such message
 * first. `rows` are those messages' spans (null: above the mounted window). -1: go to the card.
 */
export function doorTarget(rows: ReadonlyArray<Span | null>, card: Span | null, view: Span): number {
  let best = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) return i;
    if (card && row.top >= card.top) continue;
    if (startSide(row, view) === 'in') continue;
    if (best < 0 || row.top < (rows[best] as Span).top) best = i;
  }
  return best;
}

/** The door's contract between `showQuestionCard` and the Super pane: bubbling, cancelable,
 *  `detail.item` the question; the pane sets `detail.landed` to what it went to. */
export const SUPER_QUESTION_EVENT = 'dc:super-question';
export interface SuperQuestionDetail { item: string; landed?: 'card' | 'unread' }
