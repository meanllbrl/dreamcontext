/**
 * sleep-cycle-report — what the specialists observed this cycle, recorded by THEM (SL-3).
 *
 * The recidivism streak and the owner-ask counts used to travel through the orchestrator: a
 * specialist wrote `--flag …` lines in its report and the main agent was supposed to copy each
 * one into `sleep done`. It did in 4 of 8 runs, so `.sleep-flags.json` stayed `[]` while the
 * same two problems were flagged 8 cycles running. Now each specialist records its own:
 *
 *   dreamcontext sleep flag add <key> <label> [--task <slug>] --by sleep-state
 *   dreamcontext sleep flag none --by sleep-tasks          (looked, nothing recurring)
 *   dreamcontext sleep asks set criterion=a,subtask=b,task=c,unplaced=d --by sleep-tasks
 *
 * into `tmp/sleep/cycle.json` (machine-local, gitignored), and `sleep done` reads it.
 *
 * A CYCLE THAT REPORTED NOTHING KEEPS THE STREAKS. A flag is dropped only when a cycle that did
 * report (any `flag add` or `flag none`, or a `--flag` on `sleep done`) did not re-observe it.
 * A cycle where nobody reported is not evidence that a problem went away
 * (knowledge/patterns/a-delete-is-never-inferred-from-absence.md).
 *
 * Parallel specialists write this one file, so every write is a locked read-modify-write.
 * `sleep done` CONSUMES it: the content is renamed to `cycle.last.json` (the receipt of what the
 * cycle reported), never deleted.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withFileLockSync } from './file-lock.js';
import type { SleepFlag } from './sleep-flags.js';

export const CYCLE_REPORT_REL = 'tmp/sleep/cycle.json';
export const CYCLE_REPORT_LAST_REL = 'tmp/sleep/cycle.last.json';

export type AskCounts = Record<'criterion' | 'subtask' | 'task' | 'unplaced', number>;

export interface CycleFlag extends Pick<SleepFlag, 'key' | 'label' | 'task_slug'> {
  by: string;
  at: string;
}

export interface CycleReport {
  /** Specialists that reported this cycle (a flag, or `flag none`). Non-empty = the cycle reported. */
  reported_by: string[];
  flags: CycleFlag[];
  asks: { counts: AskCounts; by: string; at: string } | null;
}

function emptyReport(): CycleReport {
  return { reported_by: [], flags: [], asks: null };
}

function reportPath(root: string): string {
  return join(root, CYCLE_REPORT_REL);
}

/** Refuse a symlinked tmp/, tmp/sleep/ or report file (soul: vault paths never follow links). */
function assertNoLinks(root: string, file: string): void {
  for (const p of [join(root, 'tmp'), dirname(file), file]) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error(`refusing to use the sleep cycle report: ${p} is a symlink`);
  }
}

/** The current cycle's report; an absent or unreadable file reads as nothing reported. */
export function readCycleReport(root: string): CycleReport {
  const file = reportPath(root);
  try {
    if (!existsSync(file) || lstatSync(file).isSymbolicLink()) return emptyReport();
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<CycleReport>;
    return {
      reported_by: Array.isArray(raw.reported_by) ? raw.reported_by.filter((x): x is string => typeof x === 'string') : [],
      flags: Array.isArray(raw.flags)
        ? raw.flags.filter((f): f is CycleFlag => !!f && typeof f === 'object' && typeof (f as CycleFlag).key === 'string' && typeof (f as CycleFlag).label === 'string')
        : [],
      asks: raw.asks && typeof raw.asks === 'object' && raw.asks.counts ? raw.asks as CycleReport['asks'] : null,
    };
  } catch {
    return emptyReport();
  }
}

function mutate(root: string, fn: (r: CycleReport) => void): CycleReport {
  const file = reportPath(root);
  assertNoLinks(root, file);
  mkdirSync(dirname(file), { recursive: true });
  return withFileLockSync(`${file}.lock`, () => {
    const r = readCycleReport(root);
    fn(r);
    writeFileSync(file, JSON.stringify(r, null, 2) + '\n', 'utf-8');
    return r;
  }, { waitMs: 5_000 });
}

function noteReporter(r: CycleReport, by: string): void {
  if (!r.reported_by.includes(by)) r.reported_by.push(by);
}

/** Record one observed flag. The same key twice keeps one entry (the latest label wins). */
export function recordCycleFlag(root: string, flag: Pick<SleepFlag, 'key' | 'label' | 'task_slug'>, by: string, nowISO: string = new Date().toISOString()): CycleReport {
  return mutate(root, (r) => {
    noteReporter(r, by);
    r.flags = r.flags.filter((f) => f.key !== flag.key);
    r.flags.push({ key: flag.key, label: flag.label, task_slug: flag.task_slug ?? null, by, at: nowISO });
  });
}

/** A specialist looked and saw nothing recurring: the cycle counts as reported. */
export function recordNoFlags(root: string, by: string): CycleReport {
  return mutate(root, (r) => noteReporter(r, by));
}

/** Record where the owner's asks landed (sleep-tasks). A second call replaces the first. */
export function recordCycleAsks(root: string, counts: AskCounts, by: string, nowISO: string = new Date().toISOString()): CycleReport {
  return mutate(root, (r) => {
    r.asks = { counts, by, at: nowISO };
  });
}

/**
 * Move the report to `cycle.last.json` once `sleep done` has used it: the receipt of what the
 * cycle reported stays readable until the next cycle's report replaces it. Best effort.
 */
export function consumeCycleReport(root: string): boolean {
  const file = reportPath(root);
  try {
    if (!existsSync(file) || lstatSync(file).isSymbolicLink()) return false;
    assertNoLinks(root, join(root, CYCLE_REPORT_LAST_REL));
    renameSync(file, join(root, CYCLE_REPORT_LAST_REL));
    return true;
  } catch {
    return false;
  }
}
