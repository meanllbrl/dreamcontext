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
 */

export type LedgerMark = 'open' | 'review-start' | 'review-end' | 'close';

export type LedgerRow =
  | { type: 'mark'; run: string; what: LedgerMark; at: number }
  | { type: 'check'; run: string; label: string; line: string; asked: number; ran: number; ended: number; exit: number | null };

export const ledgerPath = (cwd: string): string => join(heavyRepoDir(cwd), 'dc-run-ledger.jsonl');

export function appendLedger(path: string, row: LedgerRow): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(row)}\n`);
  } catch { /* the ledger never fails a check */ }
}

/** Write one check against the run open on this branch; outside a run nothing is kept. */
export function recordCheck(cwd: string, c: { label: string; line: string; asked: number; ran: number; ended: number; exit: number | null }): void {
  try {
    const scope = currentScope(cwd, c.ended);
    if (scope) appendLedger(ledgerPath(cwd), { type: 'check', run: scope.run, ...c, label: c.label.slice(0, 120) });
  } catch { /* the ledger never fails a check */ }
}

export function readLedger(path: string, run: string): LedgerRow[] {
  let text: string;
  try { text = readFileSync(path, 'utf-8'); } catch { return []; }
  const rows: LedgerRow[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const row = JSON.parse(line) as LedgerRow;
      if (row.run === run) rows.push(row);
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
