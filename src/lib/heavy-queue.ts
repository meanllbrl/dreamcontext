import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { FAST_SLOTS } from './builder-tools.js';
import { heavyStep, shellSegments, type HeavyStep } from './run-budget.js';

/**
 * Which line a check stands in, and its place there. Measured 2026-10-31 (session 40822564, first
 * 57 minutes): code 5, standing in line with nothing running 20. One line per repo meant a
 * one-file test waited behind a whole browser script, and a wait that ran out lost its place.
 *
 * Two lines:
 *   fast   a short check: a few named test files, a related run that reaches few test files
 *          (`countRelatedTests`), `tsc` on its own, a `look.mjs` glance. It never touches the repo's heavy lock, only a small machine-wide
 *          set of fast slots (`fastSlotLimit`), so memory stays bounded.
 *   heavy  everything else, anything this file cannot prove short included. Fail closed: a wrong
 *          "heavy" costs a wait, a wrong "fast" puts a long job beside the others.
 *
 * Tickets: every waiter has a file. In a line the smaller job goes first, and nobody starves: past
 * {@link QUEUE_AGE_MS} a ticket outranks every size, oldest first. A wait that runs out does not
 * lose the ticket: it stays parked for {@link QUEUE_KEEP_MS}, blocks nobody, and the same command
 * from the same checkout takes its old place back.
 *
 * THE table of which command goes where is `queueOf`, here and nowhere else.
 * tests/unit/heavy-queue.test.ts pins it. Any fs trouble fails open: a check is never blocked by
 * its own bookkeeping.
 */

export type QueueLine = 'fast' | 'heavy';

export const FAST_TEST_FILES = 8;
export { FAST_SLOTS };
export const QUEUE_AGE_MS = 10 * 60 * 1000;
/** How long a place outlives its process: time for the agent to read the message and come back. */
export const QUEUE_KEEP_MS = 15 * 60 * 1000;
const HEARTBEAT_MS = 20_000;

/** Machine-wide, every repo together: two when the Mac is calm, one when load passes the cores. 0 = none: very hot means one step machine-wide, whatever its size. */
export function fastSlotLimit(heatLimit: number, machineBusy: boolean): number {
  if (heatLimit <= 1) return 0;
  return machineBusy ? 1 : FAST_SLOTS;
}

export interface QueuePick { line: QueueLine; size: number; why: string }

const SIZE = { check: 1, look: 2, unknown: 3, build: 3, browser: 4, suite: 5 } as const;

/** Shell glue that runs nothing long around a real step. */
const GLUE = /^(?:cd\s|export\s|true$|echo\s|tail\b|head\b|grep\b|tee\b|wc\b|cat$)/;

function stepSize(step: HeavyStep): number {
  if (step.kind === 'browser') return step.scoped ? SIZE.look : SIZE.browser;
  return SIZE[step.kind];
}

/** How many test files reach these sources, or null when it cannot tell. */
export type RelatedCount = (sources: string[]) => number | null;

function isFast(step: HeavyStep, countRelated?: RelatedCount): boolean {
  if (step.kind === 'browser') return step.scoped === 1;
  if (step.kind !== 'check') return false;
  if (step.target === 'tsc') return true;
  if (step.related) {
    // Three source files can be a central module's whole import graph (648 tests, measured here).
    const n = step.related.length > 0 ? countRelated?.(step.related) ?? null : null;
    return n !== null && n <= FAST_TEST_FILES;
  }
  return step.scoped !== undefined && step.scoped > 0 && step.scoped <= FAST_TEST_FILES;
}

const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+|require\(\s*|vi\.mock\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const TEST_FILE = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * The test files that reach `sources` through relative imports, read from the tracked files with
 * `git ls-files`. It stops counting past `cap`. Null: not a repo, or nothing to read. A dynamic
 * or aliased import is not seen, so this is a good estimate and not a proof.
 */
export function countRelatedTests(cwd: string, sources: readonly string[], cap: number = FAST_TEST_FILES): number | null {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.ts', '*.tsx', '*.mts', '*.js', '*.mjs'], { cwd: root, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
    const known = new Set(files);
    const importers = new Map<string, string[]>();
    const noExt = (p: string) => p.replace(/\.[cm]?[jt]sx?$/, '');
    const byStem = new Map<string, string>();
    for (const f of files) { byStem.set(noExt(f), f); byStem.set(noExt(f).replace(/\/index$/, ''), f); }
    for (const f of files) {
      let text: string;
      try { text = readFileSync(join(root, f), 'utf-8'); } catch { continue; }
      for (const m of text.matchAll(IMPORT)) {
        const target = byStem.get(noExt(resolve('/', dirname(f), m[1]).slice(1)));
        if (target) importers.set(target, [...(importers.get(target) ?? []), f]);
      }
    }
    const seen = new Set<string>();
    const tests = new Set<string>();
    const todo = sources.map((s) => (s.startsWith('/') ? s.slice(root.length + 1) : join(cwd, s).slice(root.length + 1))).filter((s) => known.has(s));
    if (todo.length === 0) return null;
    while (todo.length > 0) {
      const f = todo.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      if (TEST_FILE.test(f)) tests.add(f);
      if (tests.size > cap) return tests.size;
      todo.push(...(importers.get(f) ?? []));
    }
    return tests.size;
  } catch {
    return null;
  }
}

/**
 * What a waiter may show of its command: words from this fixed list and nothing of the command.
 * A label lands in another repo's transcript and in the ledger for good, and any part of a shell
 * line can be a secret (three reviews, three more forms), so none of it is copied.
 */
export function safeLabel(command: string, scripts: Record<string, string> = {}): string {
  const names = shellSegments(command).map((s) => {
    const step = heavyStep(s, scripts);
    if (!step) return null;
    if (step.kind === 'browser') return step.scoped ? 'look' : 'browser script';
    return step.kind === 'check' ? (step.target === 'tsc' ? 'tsc' : 'tests') : step.kind;
  });
  return [...new Set(names.filter(Boolean))].join(' + ') || 'a check';
}

/**
 * Which line this command stands in. Every shell segment counts: `look.mjs; npm run build` is a
 * build, and a segment nobody recognises (`sleep 900`) could be anything, so it is heavy.
 */
export function queueOf(command: string, scripts: Record<string, string> = {}, countRelated?: RelatedCount): QueuePick {
  const steps: HeavyStep[] = [];
  let unknown = false;
  for (const s of shellSegments(command)) {
    const step = heavyStep(s, scripts);
    if (step) steps.push(step);
    else if (!GLUE.test(s)) unknown = true;
  }
  const size = Math.max(steps.length === 0 || unknown ? SIZE.unknown : 0, ...steps.map(stepSize));
  if (unknown || steps.length === 0) return { line: 'heavy', size, why: 'not a known short check' };
  const long = steps.find((s) => !isFast(s, countRelated));
  if (long) return { line: 'heavy', size, why: long.kind === 'check' ? `${long.target}: too many tests, or unnamed` : `${long.kind} ${long.target}` };
  return { line: 'fast', size, why: steps.map((s) => s.target).join(' + ') };
}

/** The same command from the same checkout is the same job: that is what keeps its place. */
export const jobKey = (cwd: string, command: string): string =>
  createHash('sha256').update(`${cwd}\0${command}`).digest('hex').slice(0, 16);

export interface Ticket {
  key: string;
  pid: number;
  /** When this job first asked. A retry keeps it: that IS the kept place. */
  at: number;
  /** The last sign of life of its waiter. */
  seen: number;
  size: number;
  label: string;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException)?.code !== 'ESRCH'; }
}

const isLive = (t: Ticket, now: number): boolean => now - t.seen <= HEARTBEAT_MS * 4 && alive(t.pid);

function write(dir: string, t: Ticket): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${t.key}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(t));
  renameSync(tmp, path);
}

/** Every ticket worth keeping; one past its keep, or unreadable, is deleted on the way. */
export function readTickets(dir: string, now: number): Ticket[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: Ticket[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    let t: Ticket | null = null;
    try { t = JSON.parse(readFileSync(path, 'utf-8')) as Ticket; } catch { /* torn or gone */ }
    if (t && typeof t.key === 'string' && typeof t.at === 'number' && typeof t.seen === 'number' && now - t.seen <= QUEUE_KEEP_MS) {
      out.push(t);
      continue;
    }
    try { rmSync(path, { force: true }); } catch { /* raced */ }
  }
  return out;
}

/** Who goes next: the starving by age, then the smallest, then the first to ask. */
export function ordered(tickets: readonly Ticket[], now: number): Ticket[] {
  const aged = (t: Ticket) => now - t.at >= QUEUE_AGE_MS;
  return [...tickets].sort((a, b) => {
    if (aged(a) !== aged(b)) return aged(a) ? -1 : 1;
    if (aged(a)) return a.at - b.at;
    return a.size - b.size || a.at - b.at || a.key.localeCompare(b.key);
  });
}

export interface QueueSpot { position: number; ahead: Ticket[] }

/** One waiter's ticket in one line. */
export class QueuePlace {
  private lastBeat = 0;
  private constructor(private readonly dir: string, private readonly key: string) {}

  /** Take a place, or the one this job already has. Never throws. */
  static enter(dir: string, job: { key: string; size: number; label: string }, now: number): QueuePlace {
    const place = new QueuePlace(dir, job.key);
    try {
      const old = readTickets(dir, now).find((t) => t.key === job.key);
      write(dir, { key: job.key, pid: process.pid, at: old?.at ?? now, seen: now, size: job.size, label: job.label.slice(0, 120) });
      place.lastBeat = now;
    } catch { /* no ticket: spot() reads as first in line */ }
    return place;
  }

  /** Parked tickets block nobody: only this one and the live ones stand in the line. */
  spot(now: number): QueueSpot {
    const all = readTickets(this.dir, now);
    if (!all.some((t) => t.key === this.key)) return { position: 1, ahead: [] };
    const line = ordered(all.filter((t) => t.key === this.key || isLive(t, now)), now);
    const i = line.findIndex((t) => t.key === this.key);
    return { position: i + 1, ahead: line.slice(0, i) };
  }

  /** May this waiter try for the lock now? Also its heartbeat. */
  myTurn(now: number): boolean {
    try {
      if (now - this.lastBeat >= HEARTBEAT_MS) {
        const me = readTickets(this.dir, now).find((t) => t.key === this.key);
        if (me) write(this.dir, { ...me, pid: process.pid, seen: now });
        this.lastBeat = now;
      }
      return this.spot(now).position === 1;
    } catch {
      return true;
    }
  }

  /** The check got its lock: the place is spent. */
  leave(): void {
    try { rmSync(join(this.dir, `${this.key}.json`), { force: true }); } catch { /* gone */ }
  }

  /** The wait ran out: the file stays, and its seen time starts the keep. */
  park(now: number): void {
    try {
      const me = readTickets(this.dir, now).find((t) => t.key === this.key);
      if (me) write(this.dir, { ...me, seen: now });
    } catch { /* the place is a courtesy */ }
  }
}

/** One readable row: `#2 tsc (first asked 40s ago)`. */
export function ticketRow(t: Ticket, i: number, now: number): string {
  return `#${i + 1} ${t.label} (first asked ${Math.round((now - t.at) / 1000)}s ago)`;
}
