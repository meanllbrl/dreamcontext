/**
 * The agenda's pure model (task ajanda-gunluk, plan C3, C4, C8): which group each row falls in,
 * the order inside a group, the day it belongs to, today's Done merge, the progress count and,
 * above all, `rowActions`: the ONE place any view learns what a row may do. React-free and
 * DOM-free, so every rule here is a unit test (agendaGroups.test.ts).
 */
import type { SuperPadItem } from '../../../lib/superTypes';
import type { OwnerInboxRow } from '../../../hooks/useAgents';
import type { SuperApproval } from './superApprovals';
import { agendaUpdatedAt, padStatusOf, type AgendaRow } from './superHandover';

/** The groups of today's view, in the order he reads them (decision: by who acts next). */
export type AgendaGroup = 'earlier' | 'waiting' | 'super' | 'mine' | 'done';
export const TODAY_GROUPS: readonly AgendaGroup[] = ['earlier', 'waiting', 'super', 'mine', 'done'];
/** A past day's two lists (C4). */
export type DayGroup = 'dayDone' | 'dayOpen';

export type EntryKind = 'line' | 'question' | 'owed' | 'approval' | 'task' | 'recall' | 'sync';

/** One row of the agenda, of any kind, with the time it sorts by. */
export interface AgendaEntry {
  key: string;
  kind: EntryKind;
  group: AgendaGroup | DayGroup;
  /** C3: the newest update, or null (kept below the timed rows, in its old order). */
  at: number | null;
  /** A pad line, a question or an unanswered line. */
  row?: AgendaRow;
  approval?: SuperApproval;
  inbox?: OwnerInboxRow;
  /** A line whose id is in the pushed pad. A day file's copy never is (C8). */
  live: boolean;
  /** The local day the line was opened (`bornAt`), when it differs from the day it is listed under. */
  fromDay?: string;
}

/** The local day of `ms`, `YYYY-MM-DD`. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `day` moved by `delta` days, `YYYY-MM-DD` (local calendar, DST-safe). */
export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return localDay(new Date(y, m - 1, d + delta, 12).getTime());
}

/** Noon of a local day, as ms (a safe point to format it). */
export function dayNoon(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 12).getTime();
}

const lineRow = (p: SuperPadItem): AgendaRow => ({
  key: `n:${p.id}`, section: p.section, text: p.text, note: p.id, at: p.at, status: padStatusOf(p),
  ...(p.author === 'owner' ? { author: 'owner' as const } : {}),
  ...(typeof p.bornAt === 'number' ? { bornAt: p.bornAt } : {}),
  ...(p.for ? { for: p.for } : {}),
  ...(p.section === 'done' && p.by === 'auto' ? { auto: true } : {}),
});

/**
 * Today's Done lines (C4 read rule, client half): the pushed pad's Done lines of today, plus the
 * route's answer for today, one copy per id. The pushed pad wins for ANY id it holds (a reopened
 * line is not Done any more); between route copies the newest `at`.
 */
export function mergeTodayDone(pad: readonly SuperPadItem[], routeDone: readonly SuperPadItem[] | null | undefined, today: string): Array<{ item: SuperPadItem; live: boolean }> {
  const inPad = new Set(pad.map((p) => p.id));
  const out = new Map<string, { item: SuperPadItem; live: boolean }>();
  for (const p of pad) if (p.section === 'done' && localDay(p.at) === today) out.set(p.id, { item: p, live: true });
  for (const p of routeDone ?? []) {
    if (inPad.has(p.id)) continue;
    const have = out.get(p.id);
    if (!have || have.item.at < p.at) out.set(p.id, { item: p, live: false });
  }
  return [...out.values()];
}

/** Newest first; a row with no time keeps its old order, below the timed rows. Pure, stable. */
export function sortEntries(entries: readonly AgendaEntry[]): AgendaEntry[] {
  return entries.map((e, i) => ({ e, i })).sort((a, b) => {
    if (a.e.at === null && b.e.at === null) return a.i - b.i;
    if (a.e.at === null) return 1;
    if (b.e.at === null) return -1;
    return b.e.at - a.e.at || a.i - b.i;
  }).map((x) => x.e);
}

/**
 * The order held while the pointer is over the list (C3): rows already drawn keep the order they
 * had (`held`, their keys); a row that was not drawn yet goes on top. Null = no hold.
 */
export function holdOrder(entries: readonly AgendaEntry[], held: readonly string[] | null): AgendaEntry[] {
  if (!held) return [...entries];
  const at = new Map(held.map((k, i) => [k, i]));
  const fresh = entries.filter((e) => !at.has(e.key));
  const kept = entries.filter((e) => at.has(e.key)).sort((a, b) => (at.get(a.key)! - at.get(b.key)!));
  return [...fresh, ...kept];
}

export interface TodayInput {
  /** The notepad's rows (superNotepad): questions and today's live lines. */
  notepad: { waiting: AgendaRow[]; now: AgendaRow[]; done: AgendaRow[] };
  unanswered: AgendaRow[];
  pad: readonly SuperPadItem[];
  /** The route's Done lines for today (agenda-day), once fetched. */
  routeDone?: readonly SuperPadItem[] | null;
  approvals?: readonly SuperApproval[];
  taskRows?: readonly OwnerInboxRow[];
  recallRows?: readonly OwnerInboxRow[];
  syncRows?: readonly OwnerInboxRow[];
  children?: Parameters<typeof agendaUpdatedAt>[1];
  now: number;
}

const inboxAt = (r: OwnerInboxRow): number | null => {
  const t = Date.parse(r.createdAt);
  return Number.isFinite(t) ? t : null;
};

/**
 * Today's view, grouped and sorted (C3, C4). Waiting on you: every row today's Waiting section
 * showed (questions, permissions, refusals, routines, members, unanswered, the Super's waiting
 * lines, approvals, task, recall and sync rows). Super is on it: the Super's open lines. Added by
 * you: his open lines. Done: today's finished lines. From earlier days: open lines opened before
 * today, above the groups.
 */
export function todayGroups(input: TodayInput): Record<AgendaGroup, AgendaEntry[]> {
  const today = localDay(input.now);
  const out: Record<AgendaGroup, AgendaEntry[]> = { earlier: [], waiting: [], super: [], mine: [], done: [] };
  const time = (r: AgendaRow) => agendaUpdatedAt(r, input.children);
  for (const r of input.unanswered) out.waiting.push({ key: r.key, kind: 'owed', group: 'waiting', at: Number.isFinite(r.at) ? r.at : null, row: r, live: false });
  for (const r of [...input.notepad.waiting, ...input.notepad.now]) {
    if (!r.note) { out.waiting.push({ key: r.key, kind: 'question', group: 'waiting', at: Number.isFinite(r.at) ? r.at : null, row: r, live: false }); continue; }
    const born = localDay(r.bornAt ?? r.at);
    const group: AgendaGroup = born < today ? 'earlier' : r.author === 'owner' ? 'mine' : r.section === 'waiting' ? 'waiting' : 'super';
    out[group].push({ key: r.key, kind: 'line', group, at: time(r), row: r, live: true, ...(group === 'earlier' ? { fromDay: born } : {}) });
  }
  for (const a of input.approvals ?? []) out.waiting.push({ key: a.key, kind: 'approval', group: 'waiting', at: null, approval: a, live: false });
  for (const r of input.recallRows ?? []) out.waiting.push({ key: r.id, kind: 'recall', group: 'waiting', at: inboxAt(r), inbox: r, live: false });
  for (const r of input.syncRows ?? []) out.waiting.push({ key: r.id, kind: 'sync', group: 'waiting', at: inboxAt(r), inbox: r, live: false });
  for (const r of input.taskRows ?? []) out.waiting.push({ key: r.id, kind: 'task', group: 'waiting', at: inboxAt(r), inbox: r, live: false });
  for (const { item, live } of mergeTodayDone(input.pad, input.routeDone, today)) {
    const r = lineRow(item);
    const born = localDay(item.bornAt ?? item.at);
    out.done.push({ key: r.key, kind: 'line', group: 'done', at: item.at, row: r, live, ...(born !== today ? { fromDay: born } : {}) });
  }
  for (const g of TODAY_GROUPS) out[g] = sortEntries(out[g]);
  return out;
}

/**
 * A past day (C4): "Done that day" (the route's answer, which already holds the live pad's Done
 * lines of that day) and "Started that day, still open" (the pushed pad's open lines born that
 * day). Live = the id is in the pushed pad.
 */
export function dayGroups(day: string, pad: readonly SuperPadItem[], routeDone: readonly SuperPadItem[] | null | undefined): Record<DayGroup, AgendaEntry[]> {
  const inPad = new Map(pad.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const done: AgendaEntry[] = [];
  for (const p of routeDone ?? []) {
    if (seen.has(p.id)) continue;
    const livePad = inPad.get(p.id);
    if (livePad && livePad.section !== 'done') continue;
    seen.add(p.id);
    const item = livePad ?? p;
    const r = lineRow(item);
    const born = localDay(item.bornAt ?? item.at);
    done.push({ key: r.key, kind: 'line', group: 'dayDone', at: item.at, row: r, live: !!livePad, ...(born !== day ? { fromDay: born } : {}) });
  }
  const open = pad.filter((p) => p.section !== 'done' && localDay(p.bornAt ?? p.at) === day).map((p): AgendaEntry => {
    const r = lineRow(p);
    return { key: r.key, kind: 'line', group: 'dayOpen', at: p.at, row: r, live: true };
  });
  return { dayDone: sortEntries(done), dayOpen: sortEntries(open) };
}

/** "X of Y done" (criterion 5): today's view plus leftovers; questions count in Y. */
export function agendaProgress(groups: Record<AgendaGroup, AgendaEntry[]>): { done: number; total: number; working: number; waiting: number } {
  const done = groups.done.length;
  const working = groups.super.filter((e) => e.row?.status === 'in-progress' || e.row?.status === 'almost-done').length;
  const total = TODAY_GROUPS.reduce((n, g) => n + groups[g].length, 0);
  return { done, total, working, waiting: groups.waiting.length };
}

/** Medium's three counts are filters (local UI state): waiting, on it (every open line), done. */
export type AgendaFilter = 'waiting' | 'onit' | 'done';
export function filterEntries(groups: Record<AgendaGroup, AgendaEntry[]>, f: AgendaFilter): AgendaEntry[] {
  if (f === 'waiting') return groups.waiting;
  if (f === 'done') return groups.done;
  return sortEntries([...groups.super, ...groups.mine, ...groups.earlier]);
}

/** The small widget's lines: Waiting on you first, then Super is on it, each by the sort. */
export function smallEntries(groups: Record<AgendaGroup, AgendaEntry[]>, n = 3): AgendaEntry[] {
  return [...groups.waiting, ...groups.super, ...groups.mine, ...groups.earlier].slice(0, n);
}

// ─── C8: what a row may do ─────────────────────────────────────────────

export type RowMark = 'status' | 'check' | 'icon';
export type RowPress = 'detail' | 'legacy' | 'none';
export type HoverAction = 'done' | 'ask' | 'notNeeded';
export interface RowActions {
  /** The leading mark: a status circle, a plain check (archived), or the row kind's icon. */
  mark: RowMark;
  /** The circle opens the five-status menu. */
  menu: boolean;
  /** What a press on the row does: its detail, today's action, or nothing. */
  press: RowPress;
  hover: HoverAction[];
  detail: 'full' | 'readonly' | 'none';
  /** The detail offers Remove (his own open line only). */
  remove: boolean;
}

const NONE: RowActions = { mark: 'icon', menu: false, press: 'legacy', hover: [], detail: 'none', remove: false };

/**
 * The ONE source of a row's mark, press, hover actions and detail (C8). Keyed by the row's kind
 * AND by whether the line is live in the pushed pad: a line from a day file is archived (check,
 * Ask, read-only detail), so no pad call is ever sent for an id the server cannot find. The phone
 * passes `readOnly`: no hover action, no menu, and a line's press does what it did there before
 * (nothing).
 */
export function rowActions(entry: Pick<AgendaEntry, 'kind' | 'live' | 'row'>, opts: { readOnly?: boolean } = {}): RowActions {
  const ro = !!opts.readOnly;
  switch (entry.kind) {
    case 'line': {
      if (!entry.live) return ro ? { ...NONE, mark: 'check', press: 'none' } : { mark: 'check', menu: false, press: 'detail', hover: ['ask'], detail: 'readonly', remove: false };
      if (ro) return { ...NONE, mark: 'status', press: 'none' };
      const done = entry.row?.section === 'done';
      return {
        mark: 'status', menu: true, press: 'detail', hover: done ? ['ask'] : ['done', 'ask'], detail: 'full',
        remove: !done && entry.row?.author === 'owner',
      };
    }
    case 'question':
      // Today's About chip stays on every notepad question row; its press answers it, as today.
      return ro ? NONE : { ...NONE, hover: ['ask'] };
    case 'owed':
      return ro ? NONE : { ...NONE, hover: ['notNeeded', 'ask'] };
    default:
      // Approvals, task, recall and sync rows keep today's behaviour: nothing new.
      return NONE;
  }
}

// ─── Where a floating panel goes (the detail beside a card, the status menu) ─────────

export interface Box { x: number; y: number; width: number; height: number }
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * A panel of `w` x `h` beside `card` (plan build notes): on the side with room on the screen,
 * never off it and, when a side allows, never over `avoid` (the centre chat). Right first, then
 * left; with no clean side, the one that fits the screen, clamped into it. Pure.
 */
export function placeBeside(card: Box, w: number, h: number, view: { width: number; height: number }, avoid?: Box | null, gap = 8): { x: number; y: number } {
  const y = Math.max(gap, Math.min(card.y, view.height - h - gap));
  const right = { x: card.x + card.width + gap, y, width: w, height: h };
  const left = { x: card.x - gap - w, y, width: w, height: h };
  const fits = (b: Box) => b.x >= gap && b.x + b.width <= view.width - gap;
  for (const b of [right, left]) if (fits(b) && !(avoid && overlaps(b, avoid))) return { x: b.x, y: b.y };
  for (const b of [right, left]) if (fits(b)) return { x: b.x, y: b.y };
  return { x: Math.max(gap, Math.min(right.x, view.width - w - gap)), y };
}

/** A menu under its anchor, flipped above when there is no room below, kept on screen. Pure. */
export function placeBelow(anchor: Box, w: number, h: number, view: { width: number; height: number }, gap = 4): { x: number; y: number } {
  const below = anchor.y + anchor.height + gap;
  const y = below + h <= view.height - gap ? below : Math.max(gap, anchor.y - gap - h);
  const x = Math.max(gap, Math.min(anchor.x, view.width - w - gap));
  return { x, y };
}
