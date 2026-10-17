import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateId, today as todayUtc } from './id.js';
import { safeResolveInside } from './safe-resolve.js';
import { readSetupConfig } from './setup-config.js';
import { isCancelled, isDone, type StatusDef } from './task-status.js';
import type { Family, TaskBrief } from './task-parent.js';

/**
 * Cycles: the planning time box, apart from the queue and from releases.
 *
 * A cycle is a date range with a one-sentence goal. Its id is random and
 * stable (`cy_<nanoid8>`), so two machines that each open one never collide;
 * the number people see is DERIVED from start-date order on every read and is
 * never stored, never sent to a remote, never parsed back. Exactly one cycle is
 * active at a time. A team merge (or a textual git merge that never reached the
 * merge driver) can leave two active: the one that started first stays active,
 * the other reads as planned, and the read says so.
 *
 * `core/CYCLES.json` is git-tracked: cycles travel with the brain repo, while
 * a task's membership travels on the card (`cycle:` in frontmatter, the
 * `cycle:cy_<id>` label on a remote).
 */

export type CycleStatus = 'planned' | 'active' | 'closed';

export interface Cycle {
  id: string;
  goal: string;
  /** First day, YYYY-MM-DD. */
  start: string;
  /** Last day (inclusive), YYYY-MM-DD. */
  end: string;
  status: CycleStatus;
  created_at: string;
  closed_at?: string;
  /** Slugs carried out of this cycle into the next one at close. */
  carried?: string[];
  /** Slugs sent back to the queue at close. */
  backed?: string[];
  /** Slugs cancelled at close. */
  cancelled?: string[];
  /** Leaves done / leaves counted, recorded at close (0/0 for an empty cycle). */
  result?: { done: number; total: number };
  /**
   * A close in progress: every decision, written BEFORE any card moves, so a
   * close that stops halfway resumes with the same decisions instead of losing
   * its carries (the moves themselves are idempotent). Cleared when it closes.
   */
  closing?: ClosePlan;
}

export interface ClosePlan {
  carried: string[];
  backed: string[];
  cancelled: string[];
  result: { done: number; total: number };
  /** The cycle carried work goes into (null when nothing is carried). */
  into: string | null;
}

export interface CycleView extends Cycle {
  /** Display number: 1-based position by start date (id breaks ties). */
  number: number;
}

export interface CyclesRead {
  cycles: CycleView[];
  /** Human-facing notes: entries dropped as unreadable, a second active cycle demoted. */
  notes: string[];
}

export const CYCLES_REL = 'core/CYCLES.json';
export const DEFAULT_CYCLE_WEEKS = 1;
const ID_RE = /^cy_[A-Za-z0-9_-]{4,32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUS_RANK: Record<CycleStatus, number> = { planned: 0, active: 1, closed: 2 };

export function isCycleId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v);
}

export function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function lengthDays(c: Pick<Cycle, 'start' | 'end'>): number {
  return daysBetween(c.start, c.end) + 1;
}

function isValidDate(v: unknown): v is string {
  return typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

function strings(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  return out.length > 0 ? [...new Set(out)] : undefined;
}

/** One stored entry, or null when it is not a cycle this code can reason about. */
function sanitize(raw: unknown): Cycle | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isCycleId(r.id) || !isValidDate(r.start) || !isValidDate(r.end) || r.end < r.start) return null;
  const status: CycleStatus = r.status === 'active' || r.status === 'closed' ? r.status : 'planned';
  const c: Cycle = {
    id: r.id,
    goal: typeof r.goal === 'string' ? r.goal : '',
    start: r.start,
    end: r.end,
    status,
    created_at: isValidDate(r.created_at) ? r.created_at : r.start,
  };
  if (isValidDate(r.closed_at)) c.closed_at = r.closed_at;
  for (const k of ['carried', 'backed', 'cancelled'] as const) {
    const arr = strings(r[k]);
    if (arr) c[k] = arr;
  }
  const res = r.result as Record<string, unknown> | undefined;
  if (res && typeof res.done === 'number' && typeof res.total === 'number') {
    c.result = { done: res.done, total: res.total };
  }
  const cl = r.closing as Record<string, unknown> | undefined;
  const clRes = cl?.result as Record<string, unknown> | undefined;
  if (status !== 'closed' && cl && typeof cl === 'object' && clRes && typeof clRes.done === 'number' && typeof clRes.total === 'number') {
    c.closing = {
      carried: strings(cl.carried) ?? [],
      backed: strings(cl.backed) ?? [],
      cancelled: strings(cl.cancelled) ?? [],
      result: { done: clRes.done, total: clRes.total },
      into: isCycleId(cl.into) ? cl.into : null,
    };
  }
  return c;
}

/** Parse the file's text (object `{cycles: []}` or a bare array). Unreadable entries are dropped and counted. */
export function parseCycles(text: string): { cycles: Cycle[]; dropped: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text || '{}');
  } catch {
    return { cycles: [], dropped: 0 };
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { cycles?: unknown }).cycles)
      ? (parsed as { cycles: unknown[] }).cycles
      : [];
  const cycles: Cycle[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of arr) {
    const c = sanitize(raw);
    if (!c || seen.has(c.id)) { dropped++; continue; }
    seen.add(c.id);
    cycles.push(c);
  }
  return { cycles, dropped };
}

function byStart(a: Cycle, b: Cycle): number {
  return a.start.localeCompare(b.start) || a.id.localeCompare(b.id);
}

/**
 * The one-active rule. With more than one active cycle the earliest start
 * stays active and every other one becomes planned; the notes say which.
 */
export function enforceOneActive(cycles: Cycle[]): { cycles: Cycle[]; notes: string[] } {
  const sorted = [...cycles].sort(byStart);
  const active = sorted.filter((c) => c.status === 'active');
  if (active.length <= 1) return { cycles: sorted, notes: [] };
  const keep = active[0];
  const numberOf = new Map(sorted.map((c, i) => [c.id, i + 1]));
  const notes = active.slice(1).map((c) =>
    `two cycles were active after a merge: kept #${numberOf.get(keep.id)} (${keep.id}, started ${keep.start}); ` +
    `#${numberOf.get(c.id)} (${c.id}, started ${c.start}) is planned again.`);
  const demoted = new Set(active.slice(1).map((c) => c.id));
  return { cycles: sorted.map((c) => (demoted.has(c.id) ? { ...c, status: 'planned' as const } : c)), notes };
}

export function numberCycles(cycles: Cycle[]): CycleView[] {
  return [...cycles].sort(byStart).map((c, i) => ({ ...c, number: i + 1 }));
}

function cyclesPath(contextRoot: string): string {
  return safeResolveInside(contextRoot, CYCLES_REL);
}

export function readCycles(contextRoot: string): CyclesRead {
  const path = cyclesPath(contextRoot);
  if (!existsSync(path)) return { cycles: [], notes: [] };
  const { cycles, dropped } = parseCycles(readFileSync(path, 'utf-8'));
  const one = enforceOneActive(cycles);
  const notes = [...one.notes];
  if (dropped > 0) notes.push(`${dropped} unreadable cycle entr${dropped === 1 ? 'y was' : 'ies were'} ignored in ${CYCLES_REL}.`);
  return { cycles: numberCycles(one.cycles), notes };
}

export function serializeCycles(cycles: Cycle[]): string {
  const clean = [...cycles].sort(byStart).map((c) => {
    const { number: _n, ...rest } = c as CycleView;
    return rest;
  });
  return `${JSON.stringify({ cycles: clean }, null, 2)}\n`;
}

/** Write the store (temp + rename); the one-active rule holds on every write. */
export function writeCycles(contextRoot: string, cycles: Cycle[]): CycleView[] {
  const path = cyclesPath(contextRoot);
  mkdirSync(dirname(path), { recursive: true });
  const { cycles: fixed } = enforceOneActive(cycles);
  // The temp file goes through the same containment check (a committed symlink
  // named like it must not redirect the write) and is created exclusively.
  const tmp = safeResolveInside(contextRoot, `${CYCLES_REL}.${process.pid}.tmp`);
  if (existsSync(tmp)) unlinkSync(tmp);
  writeFileSync(tmp, serializeCycles(fixed), { encoding: 'utf-8', flag: 'wx' });
  renameSync(tmp, path);
  return numberCycles(fixed);
}

export function activeCycle(cycles: CycleView[]): CycleView | null {
  return cycles.find((c) => c.status === 'active') ?? null;
}

/** The planned cycle that comes next (earliest start), or null. */
export function nextPlannedCycle(cycles: CycleView[], exceptId?: string): CycleView | null {
  return cycles.filter((c) => c.status === 'planned' && c.id !== exceptId).sort(byStart)[0] ?? null;
}

/**
 * Resolve what a person typed: `now` (the active cycle), an id, or a display
 * number (`3`, `#3`, `c3`, and the old `v3` spelling). Null when nothing matches.
 */
export function resolveCycleRef(cycles: CycleView[], ref: string): CycleView | null {
  const r = ref.trim();
  if (!r) return null;
  if (r.toLowerCase() === 'now' || r.toLowerCase() === 'active') return activeCycle(cycles);
  const byId = cycles.find((c) => c.id === r);
  if (byId) return byId;
  const m = /^(?:#|c|v)?(\d+)$/i.exec(r);
  if (m) return cycles.find((c) => c.number === Number(m[1])) ?? null;
  return null;
}

/** `tasks.cycleDefaultWeeks` in `state/.config.json`, else 1. */
export function configuredDefaultWeeks(contextRoot: string): number {
  return readSetupConfig(dirname(contextRoot))?.tasks?.cycleDefaultWeeks ?? DEFAULT_CYCLE_WEEKS;
}

/**
 * The length a new cycle gets when none is asked for: the length of the cycle
 * opened most recently (the last one used), else the configured default.
 */
export function defaultLengthDays(contextRoot: string, cycles: Cycle[]): number {
  const last = [...cycles].sort((a, b) => a.created_at.localeCompare(b.created_at) || byStart(a, b)).pop();
  if (last) return lengthDays(last);
  return Math.round(configuredDefaultWeeks(contextRoot) * 7);
}

export class CycleError extends Error {}

export interface NewCycleInput {
  goal: string;
  weeks?: number;
  /** Explicit last day (inclusive). */
  end?: string;
  /** Explicit first day; default: today, or the day after the last open cycle ends. */
  start?: string;
  today?: string;
}

export function validateGoal(goal: string): string {
  const g = goal.replace(/\s+/g, ' ').trim();
  if (!g) throw new CycleError('A cycle needs a goal: one sentence saying what it is for (--goal "...").');
  if (g.length > 200) throw new CycleError(`A cycle goal is one sentence (≤ 200 characters); this one is ${g.length}.`);
  return g;
}

export function newCycle(contextRoot: string, input: NewCycleInput): CycleView {
  const { cycles } = readCycles(contextRoot);
  const now = input.today ?? todayUtc();
  const goal = validateGoal(input.goal);
  const open = cycles.filter((c) => c.status !== 'closed').sort(byStart);
  const start = input.start ?? (open.length > 0 ? addDays(open[open.length - 1].end, 1) : now);
  if (!isValidDate(start)) throw new CycleError(`Start must be YYYY-MM-DD, got "${start}".`);
  let end: string;
  if (input.end !== undefined) {
    if (!isValidDate(input.end)) throw new CycleError(`End must be YYYY-MM-DD, got "${input.end}".`);
    end = input.end;
  } else {
    const days = input.weeks !== undefined ? Math.round(input.weeks * 7) : defaultLengthDays(contextRoot, cycles);
    if (!(days >= 1 && days <= 366)) throw new CycleError('A cycle is between 1 day and a year long.');
    end = addDays(start, days - 1);
  }
  if (end < start) throw new CycleError(`End (${end}) is before start (${start}).`);
  const cycle: Cycle = { id: generateId('cy'), goal, start, end, status: 'planned', created_at: now };
  const views = writeCycles(contextRoot, [...cycles, cycle]);
  return views.find((c) => c.id === cycle.id)!;
}

/**
 * Start a planned cycle. Refused while another is active (close it first). A
 * cycle started before its planned first day moves to start today, keeping
 * its length.
 */
export function startCycle(contextRoot: string, ref: string, now: string = todayUtc()): CycleView {
  const { cycles } = readCycles(contextRoot);
  const target = resolveCycleRef(cycles, ref);
  if (!target) throw new CycleError(`No cycle "${ref}". See: dreamcontext cycle list`);
  if (target.status === 'active') throw new CycleError(`Cycle #${target.number} is already active.`);
  if (target.status === 'closed') throw new CycleError(`Cycle #${target.number} is closed.`);
  const running = activeCycle(cycles);
  if (running) throw new CycleError(`Cycle #${running.number} is still active; close it first (dreamcontext cycle close).`);
  const updated: Cycle = { ...target, status: 'active' };
  if (target.start > now) {
    updated.start = now;
    updated.end = addDays(now, lengthDays(target) - 1);
  }
  const views = writeCycles(contextRoot, cycles.map((c) => (c.id === target.id ? updated : c)));
  return views.find((c) => c.id === target.id)!;
}

export interface CloseRecord {
  carried: string[];
  backed: string[];
  cancelled: string[];
  result: { done: number; total: number };
  closedAt?: string;
}

/** Write a close's decisions onto the cycle before any card moves (see {@link Cycle.closing}). */
export function markClosing(contextRoot: string, id: string, plan: ClosePlan): CycleView {
  const { cycles } = readCycles(contextRoot);
  const target = cycles.find((c) => c.id === id);
  if (!target) throw new CycleError(`No cycle ${id}.`);
  const views = writeCycles(contextRoot, cycles.map((c) => (c.id === id ? { ...c, closing: plan } : c)));
  return views.find((c) => c.id === id)!;
}

export function recordClose(contextRoot: string, id: string, rec: CloseRecord): CycleView {
  const { cycles } = readCycles(contextRoot);
  const target = cycles.find((c) => c.id === id);
  if (!target) throw new CycleError(`No cycle ${id}.`);
  const { closing: _done, ...rest } = target as CycleView;
  const closed: Cycle = { ...rest, status: 'closed', closed_at: rec.closedAt ?? todayUtc(), result: rec.result };
  for (const k of ['carried', 'backed', 'cancelled'] as const) {
    if (rec[k].length > 0) closed[k] = [...new Set(rec[k])];
    else delete closed[k];
  }
  const views = writeCycles(contextRoot, cycles.map((c) => (c.id === id ? closed : c)));
  return views.find((c) => c.id === id)!;
}

/** How many times a task was carried from one cycle into the next. */
export function carryCount(cycles: Cycle[], slug: string): number {
  return cycles.filter((c) => (c.carried ?? []).includes(slug)).length;
}

// ─── Leaves: what capacity and progress count ───────────────────────────────

/** A leaf is a task with no children: a parent's work is counted through its children. */
export function isLeaf(family: Family, slug: string): boolean {
  return !(family.children.get(slug)?.length);
}

export interface CycleProgress {
  /** Leaves in the cycle that are not cancelled (capacity). */
  total: number;
  /** Of those, the done ones. */
  done: number;
  /** Leaves still open (what a close must decide on). */
  open: TaskBrief[];
}

export function cycleProgress(family: Family, defs: readonly StatusDef[], cycleId: string): CycleProgress {
  let total = 0;
  let done = 0;
  const open: TaskBrief[] = [];
  for (const b of family.bySlug.values()) {
    if (b.cycle !== cycleId || !isLeaf(family, b.slug)) continue;
    if (isCancelled(defs, b.status)) continue;
    total++;
    if (isDone(defs, b.status)) done++;
    else open.push(b);
  }
  open.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.slug.localeCompare(b.slug));
  return { total, done, open };
}

/** Cycle ids that cards point at but the store does not hold (not yet synced). */
export function unresolvedCycleRefs(family: Family, cycles: Cycle[]): Map<string, string[]> {
  const known = new Set(cycles.map((c) => c.id));
  const out = new Map<string, string[]>();
  for (const b of family.bySlug.values()) {
    if (!b.cycle || known.has(b.cycle)) continue;
    const arr = out.get(b.cycle) ?? [];
    arr.push(b.slug);
    out.set(b.cycle, arr);
  }
  return out;
}

/** Days left in a cycle, counting today (0 once it has ended). */
export function daysLeft(c: Pick<Cycle, 'end'>, now: string = todayUtc()): number {
  return Math.max(0, daysBetween(now, c.end) + 1);
}

// ─── Merge (core/CYCLES.json, team sync) ────────────────────────────────────

/**
 * Three-way merge of two machines' CYCLES.json. Union by id; for one id on
 * both sides a field changed on one side only takes that side, status moves
 * forward only (planned → active → closed), the close lists are unioned. Then
 * the one-active rule runs and its notes become the merge report.
 */
export function mergeCyclesJson(base: string, ours: string, theirs: string): { merged: string; notes: string[] } {
  const b = new Map(parseCycles(base).cycles.map((c) => [c.id, c]));
  const o = parseCycles(ours).cycles;
  const t = new Map(parseCycles(theirs).cycles.map((c) => [c.id, c]));
  const out: Cycle[] = [];
  const seen = new Set<string>();
  for (const mine of o) {
    seen.add(mine.id);
    const yours = t.get(mine.id);
    if (!yours) { out.push(mine); continue; }
    const was = b.get(mine.id);
    const pick = <K extends 'goal' | 'start' | 'end' | 'closed_at'>(k: K): Cycle[K] =>
      was && mine[k] === was[k] ? yours[k] : mine[k];
    const merged: Cycle = {
      id: mine.id,
      goal: pick('goal'),
      start: pick('start'),
      end: pick('end'),
      status: STATUS_RANK[yours.status] > STATUS_RANK[mine.status] ? yours.status : mine.status,
      created_at: mine.created_at <= yours.created_at ? mine.created_at : yours.created_at,
    };
    const closedAt = pick('closed_at') ?? mine.closed_at ?? yours.closed_at;
    if (closedAt) merged.closed_at = closedAt;
    for (const k of ['carried', 'backed', 'cancelled'] as const) {
      const u = [...new Set([...(mine[k] ?? []), ...(yours[k] ?? [])])];
      if (u.length > 0) merged[k] = u;
    }
    const result = mine.result ?? yours.result;
    if (result) merged.result = result;
    const closing = mine.closing ?? yours.closing;
    if (closing && merged.status !== 'closed') merged.closing = closing;
    if (merged.end < merged.start) merged.end = merged.start;
    out.push(merged);
  }
  for (const [id, yours] of t) if (!seen.has(id)) out.push(yours);
  const { cycles, notes } = enforceOneActive(out);
  return { merged: serializeCycles(cycles), notes };
}
