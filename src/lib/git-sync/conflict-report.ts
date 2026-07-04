import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MergeClass } from './semantic-merge.js';

/**
 * The agent handoff contract (resolves the reentrancy-wedge — amendment 1).
 * When `resolveConflicts` defers files, the CLI writes this report + snapshot
 * files so `/dream-sync` (or a human) can read three clean versions and write
 * a semantic prose merge, then call `brain sync --continue`.
 *
 * Lives at `<contextRoot>/state/.brain-merge/`, gitignored (table C).
 */

const MERGE_DIR = 'state/.brain-merge';
const REPORT_FILE = 'report.json';

export interface DeferredEntry {
  path: string;
  class: MergeClass;
  reason: string;
  basePath: string;
  oursPath: string;
  theirsPath: string;
}

export interface ConflictReport {
  startedAt: number;
  remoteRef: string;
  resolvedByCli: string[];
  deferred: DeferredEntry[];
  status: 'awaiting-agent';
}

export interface WriteConflictReportInput {
  remoteRef: string;
  resolvedByCli: string[];
  deferred: { path: string; class: MergeClass; reason: string; base: string; ours: string; theirs: string }[];
}

function mergeDir(contextRoot: string): string {
  return join(contextRoot, MERGE_DIR);
}

function reportPath(contextRoot: string): string {
  return join(mergeDir(contextRoot), REPORT_FILE);
}

/** A stable, filesystem-safe slug for a conflicted repo-relative path. */
function slugForPath(relPath: string): string {
  return relPath.replace(/[\\/]/g, '__');
}

export function writeConflictReport(contextRoot: string, input: WriteConflictReportInput): void {
  const dir = mergeDir(contextRoot);
  mkdirSync(dir, { recursive: true });

  const deferred: DeferredEntry[] = input.deferred.map((d) => {
    const slug = slugForPath(d.path);
    const basePath = `${MERGE_DIR}/${slug}.base.md`;
    const oursPath = `${MERGE_DIR}/${slug}.ours.md`;
    const theirsPath = `${MERGE_DIR}/${slug}.theirs.md`;
    writeFileSync(join(contextRoot, basePath), d.base, 'utf-8');
    writeFileSync(join(contextRoot, oursPath), d.ours, 'utf-8');
    writeFileSync(join(contextRoot, theirsPath), d.theirs, 'utf-8');
    return { path: d.path, class: d.class, reason: d.reason, basePath, oursPath, theirsPath };
  });

  const report: ConflictReport = {
    startedAt: Date.now(),
    remoteRef: input.remoteRef,
    resolvedByCli: input.resolvedByCli,
    deferred,
    status: 'awaiting-agent',
  };
  writeFileSync(reportPath(contextRoot), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
}

export function readConflictReport(contextRoot: string): ConflictReport | null {
  const p = reportPath(contextRoot);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as ConflictReport;
  } catch {
    return null;
  }
}

/**
 * Remove `report.json` AND every base/ours/theirs snapshot file. Called at:
 * `--continue` success (after re-scrub + push), `--resume` start (supersede
 * the OLD pull-only report before a fresh attempt), and stale-report
 * auto-clear (the reentrancy guard's clause 4). A LIVE `pendingAgentMerge:true`
 * report is never routed through this by the guard — see sync-engine.ts.
 */
export function clearConflictReport(contextRoot: string): void {
  const report = readConflictReport(contextRoot);
  if (report) {
    for (const d of report.deferred) {
      for (const rel of [d.basePath, d.oursPath, d.theirsPath]) {
        try {
          unlinkSync(join(contextRoot, rel));
        } catch {
          /* already gone */
        }
      }
    }
  }
  try {
    unlinkSync(reportPath(contextRoot));
  } catch {
    /* already gone */
  }
}
