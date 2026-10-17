import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { cardHasChangelog, isTemplateComment, splitCard } from './task-card.js';
import { foldEntryTexts, journalPath, readJournal, splitEntryTexts, writeJournalRaw } from './task-journal.js';
import { TaskFileBusyError, withTaskFileLock } from './task-file-lock.js';
import { SyncLedger, hashContent } from './task-backend/sync-state.js';
import { seedPostedFromBase } from './task-backend/journal-sync.js';

/**
 * The one-time move of every task's history off its card (structure only).
 *
 * For each top-level `state/*.md` (`state/archive/` is NOT touched):
 *   - the `## Changelog` body moves VERBATIM into `state/journal/<slug>.md`
 *     (or folds, copy-counted, into a journal that already exists — so a rerun
 *     after a crash between the two writes adds nothing),
 *   - the old template HTML comments are stripped,
 *   - ticked criteria that name no evidence get ` (evidence: legacy)`.
 * A byte ledger proves nothing was lost: per file, card + journal + stripped
 * bytes reassemble to the original exactly (the legacy marks are the only
 * added bytes); a file whose ledger does not balance is left untouched.
 *
 * Safety: everything is copied to `_dream_context/tmp/pre-migration-<stamp>/`
 * first (tmp/ is ignored by the generated brain gitignore — never under
 * state/); the task-sync lock is held for the run and each file under its own
 * task lock; journal written (temp + rename) before the card. A busy lock
 * counts as a FAILED file so the version stays pinned and the next run retries.
 *
 * A remote backend's ledger is brought along: `posted_journal_ids` is seeded
 * from each task's old base snapshot (everything in it had been posted), and
 * the base loses only its Changelog — it stays what the remote holds, so a
 * card whose description changed (comments stripped, legacy marks) is pushed
 * once, and one that did not is left in sync.
 */

const SYNC_LOCK_STALE_MS = 3 * 60 * 1000;

export interface JournalMigrationReport {
  scanned: number;
  migrated: string[];
  journalsWritten: number;
  /** Legacy entries already present in an existing journal (rerun / crash recovery). */
  duplicatesCollapsed: number;
  templateComments: number;
  legacyTicks: number;
  failed: Array<{ slug: string; reason: string }>;
  backupDir: string | null;
  ledgerSeeded: number;
  bytes: { original: number; card: number; journal: number; stripped: number; added: number };
  lockBusy: boolean;
}

function needsWork(raw: string): boolean {
  if (cardHasChangelog(raw)) return true;
  let inFence = false;
  for (const line of raw.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (!inFence && isTemplateComment(line)) return true;
  }
  return false;
}

function taskFiles(stateDir: string): string[] {
  if (!existsSync(stateDir)) return [];
  return readdirSync(stateDir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .filter((f) => {
      try {
        const st = lstatSync(join(stateDir, f));
        return st.isFile() && !st.isSymbolicLink();
      } catch {
        return false;
      }
    })
    .sort()
    .map((f) => join(stateDir, f));
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, path);
}

export function migrateTaskJournals(
  contextRoot: string,
  opts: { dryRun?: boolean; now?: Date } = {},
): JournalMigrationReport {
  const stateDir = join(contextRoot, 'state');
  const report: JournalMigrationReport = {
    scanned: 0, migrated: [], journalsWritten: 0, duplicatesCollapsed: 0, templateComments: 0,
    legacyTicks: 0, failed: [], backupDir: null, ledgerSeeded: 0,
    bytes: { original: 0, card: 0, journal: 0, stripped: 0, added: 0 }, lockBusy: false,
  };
  const files = taskFiles(stateDir);
  report.scanned = files.length;
  const todo = files.filter((f) => {
    try { return needsWork(readFileSync(f, 'utf-8')); } catch { return false; }
  });

  if (opts.dryRun) {
    for (const file of todo) {
      const raw = readFileSync(file, 'utf-8');
      const split = splitCard(raw, { markLegacyTicks: true });
      report.migrated.push(basename(file, '.md'));
      account(report, raw, split);
      if (split.journal.trim()) report.journalsWritten++;
    }
    return report;
  }
  if (todo.length === 0) return report;

  const ledger = new SyncLedger(contextRoot);
  const now = opts.now ?? new Date();
  if (!ledger.acquireSyncLock(now.getTime(), SYNC_LOCK_STALE_MS)) {
    report.lockBusy = true;
    for (const f of todo) report.failed.push({ slug: basename(f, '.md'), reason: 'task sync is running' });
    return report;
  }
  try {
    // Backup first: cards + journals, beside nothing that syncs.
    const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
    let backupDir = join(contextRoot, 'tmp', `pre-migration-${stamp}`);
    for (let n = 2; existsSync(backupDir); n++) backupDir = join(contextRoot, 'tmp', `pre-migration-${stamp}-${n}`);
    mkdirSync(backupDir, { recursive: true });
    for (const f of files) cpSync(f, join(backupDir, basename(f)));
    if (existsSync(join(stateDir, 'journal'))) cpSync(join(stateDir, 'journal'), join(backupDir, 'journal'), { recursive: true });
    const syncFile = join(stateDir, '.tasks-sync.json');
    if (existsSync(syncFile)) cpSync(syncFile, join(backupDir, '.tasks-sync.json'));
    report.backupDir = backupDir;

    const migratedRaw = new Map<string, { raw: string; card: string }>();
    for (const file of todo) {
      const slug = basename(file, '.md');
      try {
        withTaskFileLock(contextRoot, slug, () => {
          const raw = readFileSync(file, 'utf-8');
          if (!needsWork(raw)) return; // another writer got there first
          const split = splitCard(raw, { markLegacyTicks: true });
          const reassembled = split.segments.filter((s) => s.kind !== 'added').map((s) => s.text).join('');
          if (reassembled !== raw) throw new Error('byte ledger does not balance; left untouched');
          if (split.journal.trim()) {
            if (existsSync(journalPath(stateDir, slug))) {
              const incoming = splitEntryTexts(split.journal);
              const added = foldEntryTexts(stateDir, slug, incoming);
              report.duplicatesCollapsed += incoming.length - added;
            } else {
              writeJournalRaw(stateDir, slug, split.journal);
            }
            report.journalsWritten++;
          }
          atomicWrite(file, split.card);
          account(report, raw, split);
          report.migrated.push(slug);
          migratedRaw.set(slug, { raw, card: split.card });
        });
      } catch (err) {
        report.failed.push({
          slug,
          reason: err instanceof TaskFileBusyError ? 'task file is locked by another writer' : (err as Error).message,
        });
      }
    }

    // Remote ledger: seed what was posted, keep the base what the remote holds.
    // A task whose step failed (busy lock) still carries its Changelog and has
    // no journal: seeding it now would store an empty posted set for good (and
    // strip its base), so its retry would re-post the whole legacy history.
    // Leave it untouched; the retry seeds it.
    const failed = new Set(report.failed.map((f) => f.slug));
    const state = ledger.readSyncState();
    let touched = false;
    for (const [slug, entry] of Object.entries(state.tasks ?? {})) {
      if (!entry?.base_snapshot || failed.has(slug)) continue;
      const base = entry.base_snapshot.body;
      if (entry.posted_journal_ids === undefined) {
        const posted = new Set<string>();
        seedPostedFromBase(readJournal(stateDir, slug), base, posted);
        entry.posted_journal_ids = [...posted].sort();
        report.ledgerSeeded++;
        touched = true;
      }
      if (cardHasChangelog(base)) {
        const newBase = splitCard(base, { keepTemplateComments: true }).card;
        entry.base_snapshot = { hash: hashContent(newBase), body: newBase };
        const m = migratedRaw.get(slug);
        if (m && entry.localHash === hashContent(m.raw) && m.card === newBase) entry.localHash = hashContent(m.card);
        touched = true;
      }
    }
    if (touched) ledger.writeSyncState(state);
  } finally {
    ledger.releaseSyncLock();
  }
  return report;
}

function account(report: JournalMigrationReport, raw: string, split: ReturnType<typeof splitCard>): void {
  report.templateComments += split.templateComments;
  report.legacyTicks += split.legacyTicks;
  report.bytes.original += Buffer.byteLength(raw);
  report.bytes.card += Buffer.byteLength(split.card) - Buffer.byteLength(split.added);
  // A Changelog of blank lines writes no journal: those bytes are stripped, not moved.
  const moved = split.journal.trim() ? Buffer.byteLength(split.journal) : 0;
  report.bytes.journal += moved;
  report.bytes.stripped += Buffer.byteLength(split.stripped) + Buffer.byteLength(split.journal) - moved;
  report.bytes.added += Buffer.byteLength(split.added);
}

export function formatJournalMigrationReport(r: JournalMigrationReport, dryRun = false): string {
  const lines = [
    `${dryRun ? 'Dry run: would migrate' : 'Migrated'} ${r.migrated.length} of ${r.scanned} task cards (state/archive/ untouched).`,
    `  journals ${dryRun ? 'to write' : 'written'}: ${r.journalsWritten}; template comments stripped: ${r.templateComments}; ticked criteria marked (evidence: legacy): ${r.legacyTicks}`,
    `  bytes: original ${r.bytes.original} = card ${r.bytes.card} + journal ${r.bytes.journal} + stripped ${r.bytes.stripped} (added ${r.bytes.added} for legacy marks)`,
  ];
  if (r.duplicatesCollapsed > 0) lines.push(`  legacy entries already in a journal (collapsed, not duplicated): ${r.duplicatesCollapsed}`);
  if (r.ledgerSeeded > 0) lines.push(`  sync ledger: posted journal ids seeded for ${r.ledgerSeeded} tasks`);
  if (r.backupDir) lines.push(`  backup: ${r.backupDir}`);
  if (r.lockBusy) lines.push('  a task sync is running: nothing migrated, the next run retries');
  for (const f of r.failed.slice(0, 10)) lines.push(`  failed: ${f.slug} — ${f.reason}`);
  if (r.failed.length > 10) lines.push(`  …and ${r.failed.length - 10} more failed`);
  return lines.join('\n');
}
