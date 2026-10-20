import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { canonicalEntry, convertJournalText } from './task-backend/legacy-journal.js';
import { SyncLedger, hashContent } from './task-backend/sync-state.js';
import { TaskFileBusyError, withTaskFileLock } from './task-file-lock.js';
import { readLedger } from './migration-ledger.js';

/**
 * Fold the reverted 0.33.0 task journals back onto their cards.
 *
 * 0.33.0 (installed on a few machines, never published, then reverted) moved
 * every task's `## Changelog` into `state/journal/<slug>.md`. This CLI knows no
 * journals: on such a vault a task shows no history, and recall indexes every
 * journal as a second "task" with the card's slug. For each journal this puts
 * the history back where this CLI reads it:
 *
 *   - the journal's entries go into the card's `## Changelog` (created at the
 *     end of the card when it has none), newest first, each a
 *     `### <date> - <title>` block; 0.33.0 headings are rewritten to that shape
 *     and every entry the card already holds is skipped (copy-counted), so a
 *     second run adds nothing;
 *   - a remote backend's sync ledger learns that the folded history was
 *     already posted: each task's base snapshot gains the same entries, which
 *     is exactly what the push diffs against (see `pushTask`), so the next sync
 *     sends no comment for any of them. A card that was in sync stays in sync;
 *   - only then does the journal leave `state/journal/`, MOVED (never deleted)
 *     into `tmp/folded-journals-<stamp>/journal/`, beside a copy of every card
 *     it rewrote and of the sync ledger. `tmp/` is outside every corpus: the
 *     task lister reads `state/*.md`, recall reads named folders (state/ among
 *     them, tmp/ not). The backup carries its own `.gitignore` (`*`): it is one
 *     machine's undo buffer, not team content.
 *
 * A journal whose card is busy, unreadable or unwritable stays where it is and
 * counts as failed, so the next run retries; a journal with no card anywhere
 * (live or archived) is moved to the backup and named, never folded or dropped.
 * The task-sync lock is held for the whole run, so no sync can push a folded
 * card before the ledger knows its history was posted.
 */

const SYNC_LOCK_STALE_MS = 3 * 60 * 1000;
const FENCE = /^\s*(```|~~~)/;
const SECTION = /^##\s+(.+)$/;
const ENTRY_HEADING = /^###\s/;
const ENTRY_DATE = /^###\s+(\d{4}-\d{2}-\d{2})\b/;
const COMMENT_LINE = /^\s*<!--.*-->\s*$/;
const LIFO_NOTE = '<!-- LIFO: newest entry at top -->';

export interface JournalFoldReport {
  /** Journal files found under `state/journal/`. */
  journals: number;
  /** Slugs whose journal is now on the card and out of `state/journal/`. */
  folded: string[];
  /** Entries written onto cards this run. */
  entriesAdded: number;
  /** Journal entries the card already held (a rerun, or history logged twice). */
  entriesPresent: number;
  /** Log entries the reverted CLI had misfiled at a card's end, moved into its Changelog. */
  entriesRescued: number;
  rescuedCards: string[];
  /** Journals with no card, live or archived: moved to the backup, not folded. */
  orphans: string[];
  failed: Array<{ slug: string; reason: string }>;
  /** Sync-ledger tasks whose base now holds the folded history. */
  ledgerSeeded: number;
  backupDir: string | null;
  lockBusy: boolean;
}

/** Split changelog text into entry texts (newest first): a `###` line outside a fence starts one. */
export function splitEntryTexts(content: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = cur.join('\n').trim();
    if (text && !/^<!--[\s\S]*-->$/.test(text)) out.push(text);
    cur = [];
  };
  for (const line of content.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    if (!inFence && ENTRY_HEADING.test(line)) flush();
    cur.push(line);
  }
  flush();
  return out;
}

/**
 * Line range [start, end) of the `## Changelog` section (start = its heading), or
 * null. Found EXACTLY the way the CLI's reader finds it (markdown.ts parseSections
 * + findSection: the first `## ` line whose name normalises to "changelog", fences
 * not considered), so the history lands in the section `tasks show`, `tasks log`
 * and the sync read, never in a second one they would not see.
 */
function changelogSection(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((l) => {
    const h = SECTION.exec(l);
    return h !== null && h[1].toLowerCase().replace(/[^a-z0-9]/g, '') === 'changelog';
  });
  if (start < 0) return null;
  const next = lines.findIndex((l, i) => i > start && SECTION.test(l));
  return { start, end: next < 0 ? lines.length : next };
}

/** Merge two newest-first lists by `### <date>`; an undated fragment keeps its place in its own list. */
function mergeNewestFirst(card: string[], incoming: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  let j = 0;
  const dateOf = (e: string) => ENTRY_DATE.exec(e)?.[1] ?? null;
  while (i < card.length && j < incoming.length) {
    const a = dateOf(card[i]);
    const b = dateOf(incoming[j]);
    if (a === null) out.push(card[i++]);
    else if (b === null) out.push(incoming[j++]);
    else if (a >= b) out.push(card[i++]); // same day: what the card got later is newer
    else out.push(incoming[j++]);
  }
  return [...out, ...card.slice(i), ...incoming.slice(j)];
}

export interface CardFold {
  text: string;
  added: number;
  present: number;
  /** Entries moved from the card's tail into the Changelog (see `rescueSince`). */
  rescued: number;
}

const CLI_ENTRY = /^### (\d{4}-\d{2}-\d{2}) - \S/;

/**
 * The entries the reverted CLI appended at EOF: on a card with no Changelog,
 * `tasks log` (and every other changelog writer) used to append the raw entry
 * at the end of the file, inside whatever section came last. They form a run of
 * `### <date> - <title>` blocks at the very end of the card, each dated on or
 * after the 0.33.0 split (nothing else writes such a block after that date).
 * Returns the card without them and the blocks, oldest first (append order).
 */
function trailingMisfiled(card: string, since: string): { rest: string; blocks: string[] } {
  const lines = card.replace(/\s+$/, '').split('\n');
  const blocks: string[] = [];
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^##\s/.test(lines[i])) break; // a section boundary ends the run
    const m = CLI_ENTRY.exec(lines[i]);
    if (!m) continue;
    if (m[1] < since) break;
    blocks.unshift(lines.slice(i, end).join('\n').trim());
    end = i;
  }
  return { rest: lines.slice(0, end).join('\n'), blocks };
}

/**
 * Put a journal's entries into a task file's `## Changelog`. Pure: returns the
 * new text (the same string when nothing is missing). Used for the card AND
 * for its sync base snapshot, so both end up holding the same history.
 *
 * `rescueSince` (card only, never the base): on a card with no Changelog, the
 * entries the reverted CLI misfiled at its end (dated on/after this date) move
 * into the new Changelog too, on top. They are left out of the base on purpose:
 * the remote holds them only inside the description, so the next push takes
 * them out of it and posts them as the comments they always should have been.
 */
export function foldJournalIntoCard(card: string, journalRaw: string, opts: { rescueSince?: string } = {}): CardFold {
  const converted = convertJournalText(journalRaw).trim();
  const incoming = splitEntryTexts(converted);
  if (incoming.length === 0) return { text: card, added: 0, present: 0, rescued: 0 };

  const lines = card.split('\n');
  const sec = changelogSection(lines);
  if (!sec) {
    // The journal text is the card's old Changelog body, moved verbatim by 0.33.0:
    // putting it back as-is restores those bytes exactly.
    const { rest, blocks } = opts.rescueSince ? trailingMisfiled(card, opts.rescueSince) : { rest: card, blocks: [] };
    const top = blocks.length > 0 ? `${[...blocks].reverse().join('\n\n')}\n\n` : '';
    return {
      text: `${rest.replace(/\s+$/, '')}\n\n## Changelog\n${LIFO_NOTE}\n\n${top}${converted}\n`,
      added: incoming.length,
      present: 0,
      rescued: blocks.length,
    };
  }

  const body = lines.slice(sec.start + 1, sec.end);
  const lead: string[] = [];
  let k = 0;
  while (k < body.length && (body[k].trim() === '' || COMMENT_LINE.test(body[k]))) {
    if (body[k].trim() !== '') lead.push(body[k]);
    k++;
  }
  const existing = splitEntryTexts(body.slice(k).join('\n'));
  const have = new Map<string, number>();
  for (const e of existing) {
    const n = canonicalEntry(e);
    have.set(n, (have.get(n) ?? 0) + 1);
  }
  const missing: string[] = [];
  for (const e of incoming) {
    const n = canonicalEntry(e);
    const left = have.get(n) ?? 0;
    if (left > 0) have.set(n, left - 1);
    else missing.push(e);
  }
  const present = incoming.length - missing.length;
  if (missing.length === 0) return { text: card, added: 0, present, rescued: 0 };

  const section = [lines[sec.start], ...(lead.length > 0 ? lead : [LIFO_NOTE]), '', mergeNewestFirst(existing, missing).join('\n\n'), ''];
  const after = lines.slice(sec.end);
  return {
    text: [...lines.slice(0, sec.start), ...section, ...after].join('\n').replace(/\n*$/, '\n'),
    added: missing.length,
    present,
    rescued: 0,
  };
}

function isRealDir(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function isRealFile(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, path);
}

/** True when `state/journal/` holds anything this fold would act on. Cheap: no file is read. */
export function hasTaskJournals(contextRoot: string): boolean {
  const dir = join(contextRoot, 'state', 'journal');
  if (!isRealDir(dir)) return false;
  return isRealDir(join(dir, '.deleted')) || readdirSync(dir).some((f) => f.endsWith('.md') && !f.startsWith('.'));
}

export function foldTaskJournals(contextRoot: string, opts: { now?: Date } = {}): JournalFoldReport {
  const report: JournalFoldReport = {
    journals: 0, folded: [], entriesAdded: 0, entriesPresent: 0, entriesRescued: 0, rescuedCards: [], orphans: [], failed: [],
    ledgerSeeded: 0, backupDir: null, lockBusy: false,
  };
  if (!hasTaskJournals(contextRoot)) return report;

  const stateDir = join(contextRoot, 'state');
  const journalDir = join(stateDir, 'journal');
  const deletedDir = join(journalDir, '.deleted');
  const files = readdirSync(journalDir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.') && isRealFile(join(journalDir, f)))
    .sort()
    .map((f) => join(journalDir, f));
  report.journals = files.length;

  const now = opts.now ?? new Date();
  // The day 0.33.0 split the cards: no CLI-shaped entry at a card's end dated from
  // then on was written by anything but the reverted CLI's EOF append.
  const split = readLedger(contextRoot).find((e) => e.version === '0.33.0' && e.step === 'task-journal-split');
  const rescueSince = split?.timestamp?.slice(0, 10);
  const ledger = new SyncLedger(contextRoot);
  if (!ledger.acquireSyncLock(now.getTime(), SYNC_LOCK_STALE_MS)) {
    report.lockBusy = true;
    for (const f of files) report.failed.push({ slug: basename(f, '.md'), reason: 'a task sync is running' });
    return report;
  }

  try {
    const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
    let backupDir = join(contextRoot, 'tmp', `folded-journals-${stamp}`);
    for (let n = 2; existsSync(backupDir); n++) backupDir = join(contextRoot, 'tmp', `folded-journals-${stamp}-${n}`);
    mkdirSync(join(backupDir, 'journal'), { recursive: true });
    writeFileSync(join(backupDir, '.gitignore'), '*\n', 'utf-8');
    report.backupDir = backupDir;
    const syncFile = join(stateDir, '.tasks-sync.json');
    if (existsSync(syncFile)) cpSync(syncFile, join(backupDir, '.tasks-sync.json'));

    const done: Array<{ slug: string; file: string; journal: string; live: boolean; before: string; after: string; rescued: boolean }> = [];
    for (const file of files) {
      const slug = basename(file, '.md');
      const live = join(stateDir, `${slug}.md`);
      const archived = join(stateDir, 'archive', `${slug}.md`);
      const cardPath = isRealFile(live) ? live : isRealFile(archived) ? archived : null;
      if (!cardPath) {
        report.orphans.push(slug);
        continue;
      }
      try {
        withTaskFileLock(contextRoot, slug, () => {
          const journal = readFileSync(file, 'utf-8');
          const before = readFileSync(cardPath, 'utf-8');
          const fold = foldJournalIntoCard(before, journal, { rescueSince });
          if (fold.text !== before) {
            const copy = join(backupDir, 'cards', cardPath === live ? `${slug}.md` : join('archive', `${slug}.md`));
            mkdirSync(dirname(copy), { recursive: true });
            writeFileSync(copy, before, 'utf-8');
            atomicWrite(cardPath, fold.text);
          }
          report.entriesAdded += fold.added;
          report.entriesPresent += fold.present;
          if (fold.rescued > 0) {
            report.entriesRescued += fold.rescued;
            report.rescuedCards.push(slug);
          }
          done.push({ slug, file, journal, live: cardPath === live, before, after: fold.text, rescued: fold.rescued > 0 });
        });
      } catch (err) {
        report.failed.push({
          slug,
          reason: err instanceof TaskFileBusyError ? 'the task file is locked by another writer' : (err as Error).message,
        });
      }
    }

    // The ledger learns the history was posted BEFORE any journal moves: a crash
    // between the two leaves the journals in place, and the rerun (which adds
    // nothing to the cards) seeds again and then moves them.
    try {
      report.ledgerSeeded = seedSyncLedger(ledger, syncFile, done);
    } catch (err) {
      for (const d of done) report.failed.push({ slug: d.slug, reason: `sync ledger not updated: ${(err as Error).message}` });
      return report;
    }

    const move = (from: string, slug: string): boolean => {
      try {
        renameSync(from, join(backupDir, 'journal', basename(from)));
        return true;
      } catch (err) {
        report.failed.push({ slug, reason: `journal not moved: ${(err as Error).message}` });
        return false;
      }
    };
    for (const d of done) if (move(d.file, d.slug)) report.folded.push(d.slug);
    for (const slug of report.orphans) move(join(journalDir, `${slug}.md`), slug);
    if (isRealDir(deletedDir)) move(deletedDir, '.deleted');
    try { rmdirSync(journalDir); } catch { /* not empty: what failed stays for the retry */ }
  } finally {
    ledger.releaseSyncLock();
  }
  return report;
}

/** Fold each journal into its task's sync base too, and keep an in-sync card in sync. Returns tasks changed. */
function seedSyncLedger(
  ledger: SyncLedger,
  syncFile: string,
  done: Array<{ slug: string; journal: string; live: boolean; before: string; after: string; rescued: boolean }>,
): number {
  if (!existsSync(syncFile)) return 0;
  const state = ledger.readSyncState();
  let seeded = 0;
  for (const d of done) {
    // Archived cards are not synced (the push reads `state/*.md` only).
    const entry = d.live ? state.tasks?.[d.slug] : undefined;
    if (!entry) continue;
    let changed = false;
    if (entry.base_snapshot) {
      const base = foldJournalIntoCard(entry.base_snapshot.body, d.journal).text;
      if (base !== entry.base_snapshot.body) {
        entry.base_snapshot = { hash: hashContent(base), body: base };
        changed = true;
      }
    }
    // A rescued card must push once: its description still carries the misfiled entries.
    if (!d.rescued && d.after !== d.before && entry.localHash === hashContent(d.before)) {
      entry.localHash = hashContent(d.after);
      changed = true;
    }
    if (changed) seeded++;
  }
  if (seeded > 0) ledger.writeSyncState(state);
  return seeded;
}
