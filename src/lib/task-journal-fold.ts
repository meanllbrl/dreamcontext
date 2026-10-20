import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { canonicalEntry, convertJournalText } from './task-backend/legacy-journal.js';
import { SyncLedger, hashContent } from './task-backend/sync-state.js';
import { TaskFileBusyError, withTaskFileLock } from './task-file-lock.js';
import { readLedger } from './migration-ledger.js';
import { normalizeSectionName, sectionHeadingName } from './markdown.js';
import matter from 'gray-matter';
import { readSetupConfig } from './setup-config.js';
import { resolveBrainSyncEnabled } from './git-sync/brain-repo.js';
import { gitAvailable, getRemoteUrl, isGitRepo } from './git-sync/git.js';

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
 * In a brain that travels by git (brain sync on, or the journals tracked by git)
 * the journals are folded but NOT moved: a move reaches every teammate as a git
 * deletion, and a teammate still on 0.33.0 would lose its only copy (then
 * re-create it, and the next fold here delete it again). The fold is
 * idempotent, so they stay in `state/journal/`, read by neither the task lister
 * nor recall; a per-machine stamp (`tmp/journal-fold/`, self-gitignored) names
 * each journal as folded, so a later run costs one directory listing and a
 * stat per journal, and folds again only a journal whose content changed (a
 * teammate's 0.33.0 appended to it) or an orphan whose card appeared.
 *
 * A journal whose card is busy, unreadable or unwritable stays where it is and
 * counts as failed, so the next run retries; a journal with no card anywhere
 * (live or archived) is moved to the backup and named, never folded or dropped.
 * The task-sync lock is held for the whole run, so no sync can push a folded
 * card before the ledger knows its history was posted.
 */

const SYNC_LOCK_STALE_MS = 3 * 60 * 1000;
const FENCE = /^\s*(```|~~~)/;
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
  /** The brain travels by git: the journals were folded and left in `state/journal/`. */
  kept: boolean;
  /** Slugs whose card this run rewrote. */
  cardsWritten: string[];
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
 * The first line of the card's body: the line after the frontmatter, exactly
 * where gray-matter (which every CLI reader parses with) starts the content. A
 * `## ` line inside the frontmatter is YAML, not a section, to every reader.
 */
function bodyStartLine(card: string): number {
  let content: string;
  try {
    content = matter(card).content;
  } catch {
    return 0; // unparseable frontmatter: the readers see no sections either; nothing to skip
  }
  if (!card.endsWith(content)) return 0;
  return card.slice(0, card.length - content.length).split('\n').length - 1;
}

/**
 * Line range [start, end) of the `## Changelog` section (start = its heading), or
 * null. Found EXACTLY the way the CLI's reader finds it (markdown.ts parseSections
 * + findSection: in the body after the frontmatter, the first line
 * sectionHeadingName reads as a heading whose name normalises to "changelog",
 * fences not considered; a CRLF `## Changelog\r` is no heading there, so not
 * here), so the history lands in the section `tasks show`, `tasks log` and the
 * sync read, never in one they would not see.
 */
function changelogSection(lines: string[], from: number): { start: number; end: number } | null {
  const start = lines.findIndex((l, i) => {
    if (i < from) return false;
    const name = sectionHeadingName(l);
    return name !== null && normalizeSectionName(name) === 'changelog';
  });
  if (start < 0) return null;
  const next = lines.findIndex((l, i) => i > start && sectionHeadingName(l) !== null);
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

const CLI_ENTRY = /^### (\d{4}-\d{2}-\d{2}) - (.+)$/;
/** The titles the CLI's changelog writers give an entry: tasks log, status/complete, priority/urgency, handoff, builder sessions. */
const CLI_TITLE = /^(?:Session Update|Completed|Cancelled|Status → [\w-]+|Priority changed|Urgency changed|Handoff)$/;
/** What those writers put under the heading: `- ` bullets, nothing else. */
const CLI_BULLET = /^- \S/;
/** No CLI heading is longer; a longer line is not even looked at. */
const MAX_ENTRY_HEADING = 500;

/**
 * The entries the reverted CLI appended at EOF: on a card with no Changelog,
 * `tasks log` (and every other changelog writer) used to append the raw entry
 * at the end of the file, inside whatever section came last. They form a run of
 * blocks at the very end of the card, and a block is taken only in the CLI's own
 * shape, so a dated heading the owner wrote (`### 2026-11-03 - Beta ship` at the
 * end of `## Plan`) is never moved:
 *
 *   - `### <date> - <title>`, the title one the CLI writes (CLI_TITLE);
 *   - dated between the 0.33.0 split (`since`) and `today`, both included: the
 *     reverted CLI wrote nothing before the split, and nothing in the future;
 *   - a body of `- ` bullets only (or none: a bare status line);
 *   - nowhere inside a code fence, and never taking a fence line: an entry in a
 *     fence is an example, and a block that took the fence would split it.
 *
 * The run ends at the first block that is not, or at a section heading.
 * Returns the card without them and the blocks, oldest first (append order).
 */
function trailingMisfiled(card: string, since: string, today: string): { rest: string; blocks: string[] } {
  const lines = card.trimEnd().split('\n');
  const fenced: boolean[] = [];
  let open = false;
  for (const line of lines) {
    const fence = FENCE.test(line);
    fenced.push(open || fence);
    if (fence) open = !open;
  }
  const blocks: string[] = [];
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (fenced[i] || sectionHeadingName(lines[i]) !== null) break; // a fence or a section boundary ends the run
    const m = lines[i].length <= MAX_ENTRY_HEADING ? CLI_ENTRY.exec(lines[i]) : null;
    if (!m) continue;
    if (m[1] < since || m[1] > today || !CLI_TITLE.test(m[2])) break;
    const body = lines.slice(i + 1, end).join('\n').trim();
    if (body !== '' && !body.split('\n').every((l) => CLI_BULLET.test(l))) break;
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
 * entries the reverted CLI misfiled at its end (dated from this date to `today`,
 * in the CLI's own shape: see trailingMisfiled) move into the new Changelog too,
 * on top. They are left out of the base on purpose:
 * the remote holds them only inside the description, so the next push takes
 * them out of it and posts them as the comments they always should have been.
 */
export function foldJournalIntoCard(
  card: string,
  journalRaw: string,
  opts: { rescueSince?: string; /** UTC `YYYY-MM-DD`, as the CLI dates entries; defaults to now. */ today?: string } = {},
): CardFold {
  const converted = convertJournalText(journalRaw).trim();
  const incoming = splitEntryTexts(converted);
  if (incoming.length === 0) return { text: card, added: 0, present: 0, rescued: 0 };

  const lines = card.split('\n');
  const sec = changelogSection(lines, bodyStartLine(card));
  if (!sec) {
    // The journal text is the card's old Changelog body, moved verbatim by 0.33.0:
    // putting it back as-is restores those bytes exactly.
    const today = opts.today ?? new Date().toISOString().slice(0, 10);
    const { rest, blocks } = opts.rescueSince ? trailingMisfiled(card, opts.rescueSince, today) : { rest: card, blocks: [] };
    const top = blocks.length > 0 ? `${[...blocks].reverse().join('\n\n')}\n\n` : '';
    return {
      text: `${rest.trimEnd()}\n\n## Changelog\n${LIFO_NOTE}\n\n${top}${converted}\n`,
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

/** Anything at all at `path`, a dangling symlink included (existsSync follows links). */
function pathTaken(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

interface JournalSet {
  dir: string;
  /** Real `.md` files: no dotfiles, no symlinks, no directories. */
  files: string[];
  /** `.deleted/` when it is a real directory. */
  deletedDir: string | null;
}

/**
 * What `state/journal/` holds that the fold acts on. The ONE predicate: the cheap
 * check (`hasTaskJournals`) and the fold read the same set, so a symlink or a
 * directory named `x.md` can never make the check say "work" while the fold finds
 * none (which used to cost a fresh, empty backup folder on every run).
 */
function listJournals(contextRoot: string): JournalSet | null {
  const dir = join(contextRoot, 'state', 'journal');
  if (!isRealDir(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.') && isRealFile(join(dir, f)))
    .sort()
    .map((f) => join(dir, f));
  const deleted = join(dir, '.deleted');
  return { dir, files, deletedDir: isRealDir(deleted) ? deleted : null };
}

/**
 * What this machine has already folded in a brain that keeps its journals (see
 * the module doc): per journal its size+mtime signature and content hash, and
 * whether `.deleted/` was seen. Per machine by construction: it lives in tmp/
 * behind its own `.gitignore` (`*`), whatever the vault's gitignore says.
 */
interface FoldStamp {
  version: 1;
  journals: Record<string, { sig: string; hash: string; orphan?: boolean }>;
  deletedSeen?: boolean;
}

function stampDir(contextRoot: string): string {
  return join(contextRoot, 'tmp', 'journal-fold');
}

/**
 * The stamp folder is used only as a real directory, or created as one. A symlink there is
 * never written through, and a stamp read through one is never trusted (it could mark
 * journals as folded so the fold skips them).
 */
function stampDirUsable(contextRoot: string): boolean {
  try {
    const st = lstatSync(stampDir(contextRoot));
    return st.isDirectory() && !st.isSymbolicLink();
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function readFoldStamp(contextRoot: string): FoldStamp {
  try {
    const file = join(stampDir(contextRoot), 'stamp.json');
    if (stampDirUsable(contextRoot) && lstatSync(file).isFile()) {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<FoldStamp>;
      if (raw && raw.version === 1 && raw.journals && typeof raw.journals === 'object') return raw as FoldStamp;
    }
  } catch { /* none yet, or unreadable: nothing is known folded */ }
  return { version: 1, journals: {} };
}

function writeFoldStamp(contextRoot: string, stamp: FoldStamp): void {
  if (!stampDirUsable(contextRoot)) return;
  const dir = stampDir(contextRoot);
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, '.gitignore'), '*\n');
  atomicWrite(join(dir, 'stamp.json'), `${JSON.stringify(stamp, null, 2)}\n`);
}

/** Size and mtime: what a later run compares, without reading the file. */
function sigOf(path: string): string {
  try {
    const st = lstatSync(path);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return '';
  }
}

function cardPathOf(stateDir: string, slug: string): string | null {
  const live = join(stateDir, `${slug}.md`);
  const archived = join(stateDir, 'archive', `${slug}.md`);
  return isRealFile(live) ? live : isRealFile(archived) ? archived : null;
}

/** The journals a run has to look at: everything not stamped as folded, unchanged, on this machine. */
function pendingJournals(set: JournalSet, stateDir: string, stamp: FoldStamp): string[] {
  return set.files.filter((f) => {
    const e = stamp.journals[basename(f, '.md')];
    if (!e || e.sig !== sigOf(f)) return true;
    return e.orphan === true && cardPathOf(stateDir, basename(f, '.md')) !== null;
  });
}

function insideGitWorkTree(dir: string): boolean {
  for (let d = dir; ; d = dirname(d)) {
    if (pathTaken(join(d, '.git'))) return true;
    if (dirname(d) === d) return false;
  }
}

/**
 * True when moving a journal out of `state/journal/` would reach other machines
 * as a git deletion: brain sync is on for this vault (brain-repo.ts
 * resolveBrainSyncEnabled, the same answer the sync engine acts on), or git
 * already tracks a journal (a push of any kind would carry the deletion). Git is
 * only run inside a work tree and when it is really installed (never the macOS
 * stub, which would pop the Command Line Tools dialog).
 */
export function journalsTravelByGit(contextRoot: string): boolean {
  const projectRoot = dirname(contextRoot);
  const useGit = insideGitWorkTree(contextRoot) && gitAvailable();
  const gitModule = useGit ? { isGitRepo, getRemoteUrl } : { isGitRepo: () => false, getRemoteUrl: () => null };
  if (resolveBrainSyncEnabled(projectRoot, readSetupConfig(projectRoot), gitModule).enabled) return true;
  // A work tree git cannot be asked about (no real git here) keeps its journals: a move it
  // cannot see could still reach a teammate as a deletion.
  if (!useGit) return insideGitWorkTree(contextRoot);
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', join('state', 'journal')], {
      cwd: contextRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
    });
    return out.length > 0;
  } catch {
    return true; // git could not answer (dubious ownership, a timeout): keep, never move
  }
}

/** True when `state/journal/` holds anything this fold would act on. Cheap: no file is read. */
export function hasTaskJournals(contextRoot: string): boolean {
  const j = listJournals(contextRoot);
  if (!j) return false;
  const stamp = readFoldStamp(contextRoot);
  if (j.deletedDir && !stamp.deletedSeen) return true;
  return pendingJournals(j, join(contextRoot, 'state'), stamp).length > 0;
}

/**
 * `tmp/` may receive the backup only as a real directory, or by being created.
 * A symlink there (or a file) would send the pre-fold cards and the sync ledger
 * wherever it points, so the fold refuses before it writes anything.
 */
function tmpRefusal(contextRoot: string): string | null {
  const tmp = join(contextRoot, 'tmp');
  try {
    const st = lstatSync(tmp);
    if (st.isSymbolicLink()) return 'tmp/ is a symlink: the backup would land wherever it points';
    if (!st.isDirectory()) return 'tmp/ is not a directory';
    return null;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : `tmp/ cannot be read: ${(err as Error).message}`;
  }
}

export function foldTaskJournals(
  contextRoot: string,
  opts: { now?: Date; /** Overrides journalsTravelByGit (tests). */ keepJournals?: boolean } = {},
): JournalFoldReport {
  const report: JournalFoldReport = {
    journals: 0, folded: [], entriesAdded: 0, entriesPresent: 0, entriesRescued: 0, rescuedCards: [], orphans: [], failed: [],
    ledgerSeeded: 0, backupDir: null, lockBusy: false, kept: false, cardsWritten: [],
  };
  const set = listJournals(contextRoot);
  if (!set || (set.files.length === 0 && !set.deletedDir)) return report;
  const { dir: journalDir, deletedDir } = set;
  const stateDir = join(contextRoot, 'state');
  const stamp = readFoldStamp(contextRoot);
  // Journals this machine already folded (a brain that keeps them) are not looked at again.
  const files = pendingJournals(set, stateDir, stamp);
  if (files.length === 0 && (!deletedDir || stamp.deletedSeen)) return report;
  report.journals = files.length;

  const refused = tmpRefusal(contextRoot);
  if (refused) {
    for (const f of files) report.failed.push({ slug: basename(f, '.md'), reason: refused });
    if (files.length === 0) report.failed.push({ slug: '.deleted', reason: refused });
    return report;
  }

  const now = opts.now ?? new Date();
  // The day 0.33.0 split the cards: no CLI-shaped entry at a card's end dated from
  // then on was written by anything but the reverted CLI's EOF append.
  const split = readLedger(contextRoot).find((e) => e.version === '0.33.0' && e.step === 'task-journal-split');
  const rescueSince = split?.timestamp?.slice(0, 10);
  const keep = opts.keepJournals ?? journalsTravelByGit(contextRoot);
  report.kept = keep;
  const ledger = new SyncLedger(contextRoot);
  if (!ledger.acquireSyncLock(now.getTime(), SYNC_LOCK_STALE_MS)) {
    report.lockBusy = true;
    for (const f of files) report.failed.push({ slug: basename(f, '.md'), reason: 'a task sync is running' });
    return report;
  }

  try {
    // Created the first time something is about to be written into it, never before:
    // a run that writes nothing leaves no folder behind.
    const timeTag = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const backup = (): string => {
      if (report.backupDir) return report.backupDir;
      let dir = join(contextRoot, 'tmp', `folded-journals-${timeTag}`);
      for (let n = 2; pathTaken(dir); n++) dir = join(contextRoot, 'tmp', `folded-journals-${timeTag}-${n}`);
      mkdirSync(join(dir, 'journal'), { recursive: true });
      writeFileSync(join(dir, '.gitignore'), '*\n', 'utf-8');
      report.backupDir = dir;
      return dir;
    };
    const syncFile = join(stateDir, '.tasks-sync.json');

    const done: Array<{ slug: string; file: string; journal: string; live: boolean; before: string; after: string; rescued: boolean }> = [];
    /** Each journal this run read, as it was when read: what the stamp records. */
    const seen = new Map<string, { sig: string; hash: string; orphan?: boolean }>();
    for (const file of files) {
      const slug = basename(file, '.md');
      const live = join(stateDir, `${slug}.md`);
      const cardPath = cardPathOf(stateDir, slug);
      const sig = sigOf(file); // before the read: a journal changed after it is looked at again
      if (!cardPath) {
        report.orphans.push(slug);
        try { seen.set(slug, { sig, hash: hashContent(readFileSync(file, 'utf-8')), orphan: true }); } catch { /* not stamped: looked at again */ }
        continue;
      }
      try {
        withTaskFileLock(contextRoot, slug, () => {
          const journal = readFileSync(file, 'utf-8');
          const hash = hashContent(journal);
          const known = stamp.journals[slug];
          if (keep && known && !known.orphan && known.hash === hash) {
            // Same content as the journal this machine folded: only its mtime moved (a
            // checkout). Folding it again would put back entries removed from the card since.
            seen.set(slug, { sig, hash });
            return;
          }
          const before = readFileSync(cardPath, 'utf-8');
          const fold = foldJournalIntoCard(before, journal, { rescueSince, today: now.toISOString().slice(0, 10) });
          if (fold.text !== before) {
            const copy = join(backup(), 'cards', cardPath === live ? `${slug}.md` : join('archive', `${slug}.md`));
            mkdirSync(dirname(copy), { recursive: true });
            writeFileSync(copy, before, 'utf-8');
            atomicWrite(cardPath, fold.text);
            report.cardsWritten.push(slug);
          }
          report.entriesAdded += fold.added;
          report.entriesPresent += fold.present;
          if (fold.rescued > 0) {
            report.entriesRescued += fold.rescued;
            report.rescuedCards.push(slug);
          }
          done.push({ slug, file, journal, live: cardPath === live, before, after: fold.text, rescued: fold.rescued > 0 });
          seen.set(slug, { sig, hash });
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
      report.ledgerSeeded = seedSyncLedger(ledger, syncFile, done, () => cpSync(syncFile, join(backup(), '.tasks-sync.json')));
    } catch (err) {
      for (const d of done) report.failed.push({ slug: d.slug, reason: `sync ledger not updated: ${(err as Error).message}` });
      return report;
    }

    if (keep) {
      // Left in place (see the module doc). The stamp names what is now folded on this
      // machine; a failed journal is not in it, so the next run looks at it again.
      for (const d of done) report.folded.push(d.slug);
      const next: FoldStamp = { ...stamp, journals: { ...stamp.journals } };
      for (const [slug, e] of seen) next.journals[slug] = e;
      if (deletedDir) next.deletedSeen = true;
      try {
        writeFoldStamp(contextRoot, next);
      } catch { /* best-effort: the next run repeats the no-op fold, nothing else */ }
      return report;
    }

    const move = (from: string, slug: string): boolean => {
      try {
        renameSync(from, join(backup(), 'journal', basename(from)));
        return true;
      } catch (err) {
        report.failed.push({ slug, reason: `journal not moved: ${(err as Error).message}` });
        return false;
      }
    };
    for (const d of done) if (move(d.file, d.slug)) report.folded.push(d.slug);
    for (const slug of report.orphans) move(join(journalDir, `${slug}.md`), slug);
    if (deletedDir) move(deletedDir, '.deleted');
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
  /** Keeps a copy of the ledger as it was, called once, right before it is rewritten. */
  beforeWrite: () => void,
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
  if (seeded > 0) {
    beforeWrite();
    ledger.writeSyncState(state);
  }
  return seeded;
}
