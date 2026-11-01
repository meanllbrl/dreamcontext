import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { heavyRepoDir } from './builder-tools.js';
import { currentScope } from './run-budget.js';

/**
 * Where a Develop run's minutes went, from records and never from memory: `builder open` starts
 * the clock, `builder heavy` and `builder test` write each check's real wait and run, `builder
 * mark` brackets the review. `code` is what is left of the run's clock, so it also holds the
 * lead's thinking and any pause. A speed claim speaks with these numbers.
 *
 * One JSON line per record in the git common dir, beside the budget. Appending never fails a
 * check. tests/unit/run-ledger.test.ts pins the sums.
 *
 * Every check is written, a run open or not, and a `start` row goes down the moment it runs: a
 * ledger that kept only finished checks of open runs read as "slot free" at 15 of 30 moments the
 * slot files said full (2026-11-01). Each wait carries its reason (`waitWhy`, `builder why`).
 */

/** The run of a check on a branch with no `builder open`. */
export const NO_RUN = '-';

/** Where a wait's time went. `lockMs` and `slotLineMs` passed with a machine slot possibly free. */
export interface WaitParts { lockMs: number; slotFullMs: number; slotLineMs: number; limit: number }

export type LedgerMark = 'open' | 'review-start' | 'review-end' | 'close';

export type LedgerRow =
  | { type: 'mark'; run: string; what: LedgerMark; at: number }
  | { type: 'start'; run: string; label: string; line: string; asked: number; ran: number; pid: number }
  | ({ type: 'check'; run: string; label: string; line: string; asked: number; ran: number; ended: number; exit: number | null } & Partial<WaitParts>);

export const ledgerPath = (cwd: string): string => join(heavyRepoDir(cwd), 'dc-run-ledger.jsonl');

export function appendLedger(path: string, row: LedgerRow): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(row)}\n`);
  } catch { /* the ledger never fails a check */ }
}

const runOf = (cwd: string, at: number): string => {
  try { return currentScope(cwd, at)?.run ?? NO_RUN; } catch { return NO_RUN; }
};

/** A check got its slot. It stays in the record if it is killed before it ends. */
export function recordStart(cwd: string, c: { label: string; line: string; asked: number; ran: number }): void {
  try {
    appendLedger(ledgerPath(cwd), { type: 'start', run: runOf(cwd, c.ran), ...c, label: c.label.slice(0, 120), pid: process.pid });
  } catch { /* the ledger never fails a check */ }
}

/** Write one check, against the run open on this branch or {@link NO_RUN}. */
export function recordCheck(cwd: string, c: { label: string; line: string; asked: number; ran: number; ended: number; exit: number | null; waits?: WaitParts }): void {
  try {
    const { waits, ...row } = c;
    appendLedger(ledgerPath(cwd), { type: 'check', run: runOf(cwd, c.ended), ...row, ...waits, label: c.label.slice(0, 120) });
  } catch { /* the ledger never fails a check */ }
}

export function readLedger(path: string, run?: string): LedgerRow[] {
  let text: string;
  try { text = readFileSync(path, 'utf-8'); } catch { return []; }
  const rows: LedgerRow[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const row = JSON.parse(line) as LedgerRow;
      if (run === undefined || row.run === run) rows.push(row);
    } catch { /* a torn line */ }
  }
  return rows;
}

type Span = [number, number];

/** Time under any of these spans, an overlap counted once. */
function covered(spans: Span[]): number {
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    if (b <= a || b <= end) continue; // a row past close clips to nothing
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
}

export interface LedgerSummary {
  totalMs: number; codeMs: number; queueMs: number; checkMs: number; reviewMs: number | null;
  checks: number; longestWaitMs: number; closed: boolean;
}

/** The run's sums, or null when it has no `open` record. A review still open counts up to the end. */
export function summarize(rows: readonly LedgerRow[], nowMs: number): LedgerSummary | null {
  const marks = rows.filter((r) => r.type === 'mark');
  const checks = rows.filter((r) => r.type === 'check');
  const open = marks.find((m) => m.what === 'open');
  if (!open) return null;
  const close = [...marks].reverse().find((m) => m.what === 'close');
  const end = close?.at ?? nowMs;
  const clip = (a: number, b: number): Span => [Math.max(a, open.at), Math.max(open.at, Math.min(b, end))];
  const waits = checks.map((c) => clip(c.asked, c.ran));
  const runs = checks.map((c) => clip(c.ran, c.ended));
  const reviews: Span[] = [];
  let from: number | null = null;
  for (const m of marks) {
    if (m.what === 'review-start' && from === null) from = m.at;
    if (m.what === 'review-end' && from !== null) { reviews.push(clip(from, m.at)); from = null; }
  }
  if (from !== null) reviews.push(clip(from, end));
  const sum = (s: Span[]) => s.reduce((n, [a, b]) => n + Math.max(0, b - a), 0);
  const totalMs = Math.max(0, end - open.at);
  return {
    totalMs,
    codeMs: Math.max(0, totalMs - covered([...waits, ...runs, ...reviews])),
    queueMs: sum(waits),
    checkMs: sum(runs),
    reviewMs: reviews.length ? sum(reviews) : null,
    checks: checks.length,
    longestWaitMs: Math.max(0, ...waits.map(([a, b]) => b - a)),
    closed: close !== undefined,
  };
}

const minutes = (ms: number): string => `${(ms / 60_000).toFixed(1)} min`;

/** The one line a run closes with. A review nobody marked is said to be missing, never a zero. */
export function ledgerLine(run: string, s: LedgerSummary): string {
  const review = s.reviewMs === null ? 'review not marked (it sits inside code)' : `review ${minutes(s.reviewMs)}`;
  return `ledger ${run}: code ${minutes(s.codeMs)} / queue ${minutes(s.queueMs)} / checks ${minutes(s.checkMs)} / ${review} (total ${minutes(s.totalMs)}${s.closed ? '' : ' so far'}; ${s.checks} checks, longest wait ${minutes(s.longestWaitMs)})`;
}

const span = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};

/** Why one check waited, in one line. */
export function waitWhy(r: Extract<LedgerRow, { type: 'check' }>): string {
  const at = new Date(r.asked).toTimeString().slice(0, 5);
  const head = `${at} ${r.label} (${r.line}): waited ${span(r.ran - r.asked)}`;
  const tail = r.exit === null && r.ended === r.ran ? ', gave up, nothing ran' : '';
  if (r.lockMs === undefined) return `${head}, no reason kept (an older row)${tail}`;
  const parts = [
    r.lockMs >= 1000 ? `${span(r.lockMs)} behind this checkout's lock` : '',
    (r.slotFullMs ?? 0) >= 1000 ? `${span(r.slotFullMs!)} all ${r.limit ?? '?'} slots full` : '',
    (r.slotLineMs ?? 0) >= 1000 ? `${span(r.slotLineMs!)} behind others in the slot line` : '',
  ].filter(Boolean);
  return `${head}${parts.length ? `: ${parts.join(', ')}` : ''}${tail}`;
}
