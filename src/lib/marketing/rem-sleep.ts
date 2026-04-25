/**
 * Marketing rem-sleep consolidation rules. Called by `mk rem-sleep`
 * (which the dreamcontext-rem-sleep agent invokes during sleep).
 *
 * Four passes:
 *   1. pruneRuns           — keep latest N runs/*.json by mtime, delete rest.
 *                            runs/by-idem/*.json are kept (idempotency cache,
 *                            pruned by ageOnly threshold separately).
 *   2. compactInsights     — collapse hour-bucketed snapshots: keep one per
 *                            day for last `weeklyAfterDays`, then one per
 *                            ISO week for older.
 *   3. mergeDailyLearnings — append per-day marketing-learnings older than
 *                            `retainDays` into the current-quarter rollup;
 *                            delete the per-day files. Index is rewritten:
 *                            rejected recs are dropped, confirmed + evergreen
 *                            entries kept.
 *   4. redactRunsSweep     — re-run redactSecrets across runs/*.json bodies
 *                            (defense in depth — writes are already redacted
 *                            via redactDeep, but agents can mutate the file
 *                            after the fact).
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync,
  statSync, unlinkSync, renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { MARKETING_PATHS, marketingRootIfExists } from './paths.js';
import { redactSecrets } from './secrets.js';
import { loadIndex, type LearningEntry, type LearningsIndex } from './learnings.js';

// ─── Atomic write helper ─────────────────────────────────────────────────────

function atomicWriteFile(path: string, data: string): void {
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path);
}

// ─── 1. pruneRuns ────────────────────────────────────────────────────────────

export interface PruneRunsOpts {
  keepLast?: number;       // default 100
  dryRun?: boolean;
}

export interface PruneRunsResult {
  scanned: number;
  kept: number;
  deleted: number;
  deletedFiles: string[];
}

export function pruneRuns(opts: PruneRunsOpts = {}): PruneRunsResult {
  const keepLast = opts.keepLast ?? 100;
  const dir = MARKETING_PATHS.runsDir();
  if (!existsSync(dir)) return { scanned: 0, kept: 0, deleted: 0, deletedFiles: [] };

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const p = join(dir, f);
      try { return { f, p, mtimeMs: statSync(p).mtimeMs }; }
      catch { return null; }
    })
    .filter((x): x is { f: string; p: string; mtimeMs: number } => x !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (files.length <= keepLast) {
    return { scanned: files.length, kept: files.length, deleted: 0, deletedFiles: [] };
  }

  const toDelete = files.slice(keepLast);
  const deletedFiles: string[] = [];
  if (!opts.dryRun) {
    for (const x of toDelete) {
      try { unlinkSync(x.p); deletedFiles.push(x.f); }
      catch { /* ignore */ }
    }
  } else {
    deletedFiles.push(...toDelete.map((x) => x.f));
  }

  return {
    scanned: files.length,
    kept: keepLast,
    deleted: deletedFiles.length,
    deletedFiles,
  };
}

// ─── 2. compactInsights ──────────────────────────────────────────────────────

export interface CompactInsightsOpts {
  /** After this many days, drop to weekly resolution. Default: 14. */
  weeklyAfterDays?: number;
  dryRun?: boolean;
  now?: Date;
}

export interface CompactInsightsResult {
  scanned: number;
  kept: number;
  deleted: number;
  deletedFiles: string[];
}

interface SnapshotFile {
  f: string;
  p: string;
  mtimeMs: number;
  entityId: string;
  bucket: string;       // YYYY-MM-DD-HH from filename
}

const SNAP_RE = /^(.+)__(\d{4}-\d{2}-\d{2})-\d{2}\.json$/;

export function compactInsights(opts: CompactInsightsOpts = {}): CompactInsightsResult {
  const weeklyAfterDays = opts.weeklyAfterDays ?? 14;
  const now = opts.now ?? new Date();
  const dir = MARKETING_PATHS.insightsDir();
  if (!existsSync(dir)) return { scanned: 0, kept: 0, deleted: 0, deletedFiles: [] };

  const files: SnapshotFile[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const m = f.match(SNAP_RE);
    if (!m) continue;
    const p = join(dir, f);
    try {
      const stat = statSync(p);
      files.push({ f, p, mtimeMs: stat.mtimeMs, entityId: m[1]!, bucket: m[2]! });
    } catch { /* ignore */ }
  }

  // Group by entityId
  const byEntity = new Map<string, SnapshotFile[]>();
  for (const sf of files) {
    if (!byEntity.has(sf.entityId)) byEntity.set(sf.entityId, []);
    byEntity.get(sf.entityId)!.push(sf);
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const weeklyCutoffMs = now.getTime() - weeklyAfterDays * dayMs;
  const keepFiles = new Set<string>();

  for (const list of byEntity.values()) {
    // Always keep the very latest snapshot per entity (it's the live read).
    list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (list[0]) keepFiles.add(list[0].p);

    // Day-bucketing: for snapshots within `weeklyAfterDays`, keep latest per day.
    const daily = new Map<string, SnapshotFile>();
    const weekly = new Map<string, SnapshotFile>();
    for (const sf of list) {
      if (sf.mtimeMs >= weeklyCutoffMs) {
        const dayKey = sf.bucket; // YYYY-MM-DD
        const cur = daily.get(dayKey);
        if (!cur || sf.mtimeMs > cur.mtimeMs) daily.set(dayKey, sf);
      } else {
        const weekKey = isoWeekKey(new Date(sf.mtimeMs));
        const cur = weekly.get(weekKey);
        if (!cur || sf.mtimeMs > cur.mtimeMs) weekly.set(weekKey, sf);
      }
    }
    for (const sf of daily.values()) keepFiles.add(sf.p);
    for (const sf of weekly.values()) keepFiles.add(sf.p);
  }

  const toDelete = files.filter((sf) => !keepFiles.has(sf.p));
  const deletedFiles: string[] = [];
  if (!opts.dryRun) {
    for (const sf of toDelete) {
      try { unlinkSync(sf.p); deletedFiles.push(sf.f); }
      catch { /* ignore */ }
    }
  } else {
    deletedFiles.push(...toDelete.map((sf) => sf.f));
  }

  return {
    scanned: files.length,
    kept: files.length - deletedFiles.length,
    deleted: deletedFiles.length,
    deletedFiles,
  };
}

function isoWeekKey(d: Date): string {
  // ISO-8601 week: Thursday rule
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// ─── 3. mergeDailyLearnings ──────────────────────────────────────────────────

export interface MergeDailyLearningsOpts {
  /** Keep per-day files newer than this many days. Default: 7. */
  retainDays?: number;
  dryRun?: boolean;
  now?: Date;
}

export interface MergeDailyLearningsResult {
  scanned: number;
  merged: number;
  archivePath: string | null;
  droppedRejected: number;
  mergedFiles: string[];
}

export function mergeDailyLearnings(opts: MergeDailyLearningsOpts = {}): MergeDailyLearningsResult {
  const retainDays = opts.retainDays ?? 7;
  const now = opts.now ?? new Date();
  const dir = MARKETING_PATHS.learningsDir();
  if (!existsSync(dir)) {
    return { scanned: 0, merged: 0, archivePath: null, droppedRejected: 0, mergedFiles: [] };
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const cutoff = now.getTime() - retainDays * dayMs;

  // Identify per-day .md files older than cutoff
  const candidates: { f: string; p: string; date: string }[] = [];
  for (const f of readdirSync(dir)) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!m) continue;
    const date = m[1]!;
    const dateMs = new Date(`${date}T00:00:00Z`).getTime();
    if (dateMs < cutoff) candidates.push({ f, p: join(dir, f), date });
  }

  if (candidates.length === 0) {
    return { scanned: 0, merged: 0, archivePath: null, droppedRejected: 0, mergedFiles: [] };
  }

  // Group by quarter using the first (oldest) candidate's date — but we
  // really need to bucket each candidate into its own quarter, so do that.
  const byQuarter = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const q = quarterKey(c.date);
    if (!byQuarter.has(q)) byQuarter.set(q, []);
    byQuarter.get(q)!.push(c);
  }

  const mergedFiles: string[] = [];
  let lastArchivePath: string | null = null;

  for (const [q, list] of byQuarter) {
    const archivePath = join(dir, `_archive-${q}.md`);
    list.sort((a, b) => a.date.localeCompare(b.date));
    const sections: string[] = [];
    if (existsSync(archivePath)) {
      sections.push(readFileSync(archivePath, 'utf8').trimEnd());
    } else {
      sections.push(`# Marketing learnings archive — ${q}\n`);
    }
    for (const c of list) {
      const body = readFileSync(c.p, 'utf8').trimEnd();
      sections.push(body);
    }
    if (!opts.dryRun) {
      atomicWriteFile(archivePath, sections.join('\n\n') + '\n');
      for (const c of list) {
        try { unlinkSync(c.p); mergedFiles.push(c.f); }
        catch { /* ignore */ }
      }
    } else {
      mergedFiles.push(...list.map((c) => c.f));
    }
    lastArchivePath = archivePath;
  }

  // Index hygiene: drop rejected recommendations whose date_file was archived.
  // Keep confirmed recs + ledger (evergreen).
  const archivedDates = new Set(candidates.map((c) => c.date));
  const idx: LearningsIndex = loadIndex();
  const before = idx.entries.length;
  const next: LearningEntry[] = idx.entries.filter((e) => {
    if (!archivedDates.has(e.date_file)) return true;
    if (e.type === 'recommendation' && e.status === 'rejected') return false;
    return true;
  });
  const droppedRejected = before - next.length;

  if (!opts.dryRun && droppedRejected > 0) {
    atomicWriteFile(
      MARKETING_PATHS.learningsIndex(),
      JSON.stringify({ ...idx, entries: next }, null, 2) + '\n',
    );
  }

  return {
    scanned: candidates.length,
    merged: mergedFiles.length,
    archivePath: lastArchivePath,
    droppedRejected,
    mergedFiles,
  };
}

function quarterKey(yyyymmdd: string): string {
  const year = yyyymmdd.slice(0, 4);
  const month = parseInt(yyyymmdd.slice(5, 7), 10);
  const q = Math.floor((month - 1) / 3) + 1;
  return `${year}-Q${q}`;
}

// ─── 4. redactRunsSweep ──────────────────────────────────────────────────────

export interface RedactRunsResult {
  scanned: number;
  rewritten: number;
  rewrittenFiles: string[];
}

export function redactRunsSweep(opts: { dryRun?: boolean } = {}): RedactRunsResult {
  const dir = MARKETING_PATHS.runsDir();
  if (!existsSync(dir)) return { scanned: 0, rewritten: 0, rewrittenFiles: [] };

  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const rewrittenFiles: string[] = [];
  for (const f of files) {
    const p = join(dir, f);
    let raw: string;
    try { raw = readFileSync(p, 'utf8'); }
    catch { continue; }
    const redacted = redactSecrets(raw);
    if (redacted !== raw) {
      if (!opts.dryRun) {
        try { atomicWriteFile(p, redacted); rewrittenFiles.push(f); }
        catch { /* ignore */ }
      } else {
        rewrittenFiles.push(f);
      }
    }
  }
  return { scanned: files.length, rewritten: rewrittenFiles.length, rewrittenFiles };
}

// ─── Top-level driver ────────────────────────────────────────────────────────

export interface RemSleepOpts {
  keepRuns?: number;
  weeklyAfterDays?: number;
  retainDailyLearningsDays?: number;
  dryRun?: boolean;
  now?: Date;
}

export interface RemSleepResult {
  ranAt: string;
  marketingPresent: boolean;
  runs: PruneRunsResult;
  insights: CompactInsightsResult;
  learnings: MergeDailyLearningsResult;
  redaction: RedactRunsResult;
}

export function runRemSleep(opts: RemSleepOpts = {}): RemSleepResult {
  const ranAt = (opts.now ?? new Date()).toISOString();
  const root = marketingRootIfExists();
  if (!root || !existsSync(root)) {
    return {
      ranAt,
      marketingPresent: false,
      runs: { scanned: 0, kept: 0, deleted: 0, deletedFiles: [] },
      insights: { scanned: 0, kept: 0, deleted: 0, deletedFiles: [] },
      learnings: { scanned: 0, merged: 0, archivePath: null, droppedRejected: 0, mergedFiles: [] },
      redaction: { scanned: 0, rewritten: 0, rewrittenFiles: [] },
    };
  }

  const runs = pruneRuns({ keepLast: opts.keepRuns ?? 100, dryRun: opts.dryRun });
  const insights = compactInsights({
    weeklyAfterDays: opts.weeklyAfterDays ?? 14,
    dryRun: opts.dryRun,
    now: opts.now,
  });
  const learnings = mergeDailyLearnings({
    retainDays: opts.retainDailyLearningsDays ?? 7,
    dryRun: opts.dryRun,
    now: opts.now,
  });
  const redaction = redactRunsSweep({ dryRun: opts.dryRun });

  // Touch directories so cwd-relative consumers can detect a recent sweep
  void mkdirSync; // keep import side-effect; no-op
  return { ranAt, marketingPresent: true, runs, insights, learnings, redaction };
}
