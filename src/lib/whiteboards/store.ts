import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import { generateNKeysBetween } from 'fractional-indexing';
import { slugify } from '../id.js';
import { acquireFileLockWithin, releaseFileLock } from '../file-lock.js';
import { safeChildPath } from '../../server/safe-path.js';
import { emptyWhiteboard, parseWhiteboard, serializeWhiteboard, sortElements, type Whiteboard } from './format.js';
import { stripTombstones } from './merge.js';
import { isValidWhiteboardSlug, validateElement } from './validate.js';
import {
  WhiteboardCorruptError,
  WhiteboardLockError,
  WhiteboardNotFoundError,
  WhiteboardValidationError,
} from './errors.js';
import type { WhiteboardElement } from './widgets.js';

/**
 * The whiteboard store (D2, D4). Every board lives at
 * `<contextRoot>/whiteboards/<slug>/<slug>.excalidraw.md`, and every write — the CLI and the
 * dashboard's PUT alike — goes through {@link mutateWhiteboard}: take the board's O_EXCL
 * lockfile, read disk, apply the change, validate what changed, strip tombstones, and write
 * atomically (tmp + rename) only when the bytes actually differ.
 *
 * `root` is always the context root (`…/_dream_context`), injected, so tests never touch a
 * real brain.
 *
 * Paths are never followed through a symlink: the slug is pattern-checked, joined with
 * `safeChildPath`, every hop is `lstat`ed, and the realpath must stay inside `whiteboards/`.
 * A committed `whiteboards/x -> ~/.ssh` is reported as "no such board", never read.
 */

export const WHITEBOARDS_DIR = 'whiteboards';
export const BOARD_SUFFIX = '.excalidraw.md';

/**
 * Written once into `whiteboards/`. `merge=binary` makes git hand every two-sided edit of a
 * board to the whiteboard-md merge handler instead of splicing two copies of an element (D13).
 * Nested attribute files are honoured by git, so no root file is touched.
 */
const GITATTRIBUTES = '* merge=binary\n';
/** Keeps the machine-local lock files and half-written temp files out of every commit. */
const GITIGNORE = '.locks/\n*.tmp\n';

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

/**
 * The board the dashboard's "Control Panel" rail entry opens (A15). Created on first ask by
 * {@link ensureDefaultWhiteboard}; the DELETE route refuses it.
 */
export const DEFAULT_WHITEBOARD = { slug: 'control-panel', name: 'Control Panel' } as const;

/**
 * Slugs `createWhiteboard` never hands out: `GET /api/whiteboards/default`, `…/pages` and
 * `…/trash` are routes, so a board slugged any of them could never be opened by GET.
 */
const RESERVED_SLUGS = new Set(['default', 'pages', 'trash']);

export function whiteboardsDir(root: string): string {
  return join(root, WHITEBOARDS_DIR);
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Resolve a board's directory and file, refusing anything that is not a plain, contained path. */
export function resolveWhiteboardPath(root: string, slug: string): { dir: string; file: string } {
  if (!isValidWhiteboardSlug(slug)) throw new WhiteboardNotFoundError(`invalid whiteboard slug '${slug}'`);
  const base = whiteboardsDir(root);
  const missing = () => new WhiteboardNotFoundError(`no whiteboard '${slug}'`);
  let baseStat;
  try {
    baseStat = lstatSync(base);
  } catch {
    throw missing();
  }
  if (!baseStat.isDirectory()) throw missing();
  const dir = safeChildPath(base, slug);
  if (!dir) throw missing();
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory()) throw missing();
  } catch (err) {
    if (err instanceof WhiteboardNotFoundError) throw err;
    throw missing();
  }
  const file = safeChildPath(dir, `${slug}${BOARD_SUFFIX}`);
  if (!file) throw missing();
  try {
    const st = lstatSync(file);
    if (!st.isFile()) throw missing();
  } catch (err) {
    if (err instanceof WhiteboardNotFoundError) throw err;
    throw missing();
  }
  const realBase = realpathSync(base);
  const realFile = realpathSync(file);
  if (!realFile.startsWith(realBase + sep)) throw missing();
  return { dir, file };
}

/**
 * Create `whiteboards/` (never through a symlink) and its git hygiene files. `.locks`,
 * `.gitattributes` and `.gitignore` are `lstat`ed too: `existsSync` follows a link, so a
 * committed dangling `whiteboards/.gitignore -> ~/.bashrc` would otherwise be written through.
 */
export function ensureWhiteboardsDir(root: string): string {
  const base = whiteboardsDir(root);
  if (isSymlink(base)) throw new WhiteboardValidationError('whiteboards/ is a symlink; refusing to write through it');
  mkdirSync(base, { recursive: true });
  for (const name of ['.locks', '.gitattributes', '.gitignore']) {
    if (isSymlink(join(base, name))) {
      throw new WhiteboardValidationError(`whiteboards/${name} is a symlink; refusing to write through it`);
    }
  }
  const attrs = join(base, '.gitattributes');
  if (!existsSync(attrs)) writeFileSync(attrs, GITATTRIBUTES, 'utf-8');
  const ignore = join(base, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, GITIGNORE, 'utf-8');
  return base;
}

// ─── rev ──────────────────────────────────────────────────────────────────

const revCache = new Map<string, { mtimeMs: number; size: number; rev: string }>();

function sha1(bytes: string | Buffer): string {
  return createHash('sha1').update(bytes).digest('hex');
}

/** sha1 of the board's bytes, cached by mtime + size (D5: the dashboard polls this every 2s). */
export function whiteboardRev(root: string, slug: string): string {
  const { file } = resolveWhiteboardPath(root, slug);
  const st = statSync(file);
  const cached = revCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.rev;
  const rev = sha1(readFileSync(file));
  revCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, rev });
  return rev;
}

// ─── fractional indices ───────────────────────────────────────────────────

/**
 * `n` fresh indices above everything on the board — Excalidraw's own scheme (D11). An index
 * the library rejects (a hand-edited board) is skipped in favour of the highest valid one.
 */
export function nextIndices(elements: readonly WhiteboardElement[], n: number): string[] {
  const indices = elements
    .map((el) => el.index)
    .filter((i): i is string => typeof i === 'string' && i.length > 0)
    .sort()
    .reverse();
  for (const idx of indices) {
    try {
      return generateNKeysBetween(idx, null, n);
    } catch {
      /* invalid key — try the next lower one */
    }
  }
  return generateNKeysBetween(null, null, n);
}

// ─── read / list / create ─────────────────────────────────────────────────

export interface WhiteboardSummary {
  slug: string;
  name: string;
  description: string;
  /** Live (non-deleted) element count. */
  elements: number;
  updatedAt: string;
  /** Set when the board does not parse; it is listed so the user can see and fix it. */
  corrupt?: string;
  /** The default "Control Panel" board ({@link DEFAULT_WHITEBOARD}). */
  isDefault?: true;
}

export interface ReadWhiteboard {
  slug: string;
  path: string;
  board: Whiteboard;
  rev: string;
}

/** Read and parse a board. Throws NotFound / Corrupt. */
export function readWhiteboard(root: string, slug: string): ReadWhiteboard {
  const { file } = resolveWhiteboardPath(root, slug);
  const raw = readFileSync(file, 'utf-8');
  return { slug, path: file, board: parseWhiteboard(raw), rev: sha1(raw) };
}

export function boardName(board: Whiteboard, slug: string): string {
  const n = board.frontmatter.name;
  return typeof n === 'string' && n ? n : slug;
}

export function listWhiteboards(root: string): WhiteboardSummary[] {
  const base = whiteboardsDir(root);
  let entries: string[];
  try {
    if (!lstatSync(base).isDirectory()) return [];
    entries = readdirSync(base).sort();
  } catch {
    return [];
  }
  const out: WhiteboardSummary[] = [];
  for (const slug of entries) {
    if (slug.startsWith('.') || !isValidWhiteboardSlug(slug)) continue;
    // lstat every entry: a symlinked board folder is never followed.
    let file: string;
    try {
      ({ file } = resolveWhiteboardPath(root, slug));
    } catch {
      continue;
    }
    const updatedAt = statSync(file).mtime.toISOString();
    const mark = slug === DEFAULT_WHITEBOARD.slug ? { isDefault: true as const } : {};
    try {
      const board = parseWhiteboard(readFileSync(file, 'utf-8'));
      out.push({
        slug,
        name: boardName(board, slug),
        description: typeof board.frontmatter.description === 'string' ? board.frontmatter.description : '',
        elements: board.elements.filter((e) => e.isDeleted !== true).length,
        updatedAt,
        ...mark,
      });
    } catch (err) {
      out.push({ slug, name: slug, description: '', elements: 0, updatedAt, corrupt: (err as Error).message, ...mark });
    }
  }
  return out;
}

const MAX_SLUG = 64;

function slugBase(name: string): string {
  return slugify(name).slice(0, MAX_SLUG).replace(/-+$/, '') || 'board';
}

/**
 * Create a board (D15): slug from `slugify` cut to 64 chars, `board` when the name folds to
 * nothing, `-2`, `-3`… on collision. The display name is kept verbatim in the frontmatter.
 */
export function createWhiteboard(root: string, name: string, description = ''): { slug: string; path: string } {
  const display = name.trim();
  if (!display) throw new WhiteboardValidationError('a whiteboard needs a name');
  const base = ensureWhiteboardsDir(root);
  const stem = slugBase(display);
  for (let n = 1; n < 10_000; n++) {
    const suffix = n === 1 ? '' : `-${n}`;
    const slug = `${stem.slice(0, MAX_SLUG - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (RESERVED_SLUGS.has(slug)) continue;
    const dir = join(base, slug);
    try {
      // Non-recursive: EEXIST (a live board, a symlink, a stray file) moves on to the next suffix,
      // and two concurrent creates of the same name can never share a folder.
      mkdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    const file = join(dir, `${slug}${BOARD_SUFFIX}`);
    writeFileSync(file, serializeWhiteboard(emptyWhiteboard(display, description)), { encoding: 'utf-8', flag: 'wx' });
    return { slug, path: file };
  }
  throw new WhiteboardValidationError(`could not find a free slug for '${display}'`);
}

/**
 * Make sure the default "Control Panel" board exists (A15); returns its slug and whether this
 * call created it. Runs under the board's own lockfile — the one `mutateWhiteboard` takes — so
 * two concurrent callers create it exactly once, and neither returns before the file is
 * written. An existing `control-panel` board is the default whatever its display name.
 */
export async function ensureDefaultWhiteboard(root: string): Promise<{ slug: string; created: boolean }> {
  const { slug, name } = DEFAULT_WHITEBOARD;
  const exists = () => {
    try {
      resolveWhiteboardPath(root, slug);
      return true;
    } catch (err) {
      if (err instanceof WhiteboardNotFoundError) return false;
      throw err;
    }
  };
  if (exists()) return { slug, created: false };
  const base = ensureWhiteboardsDir(root);
  const lockPath = join(base, '.locks', `${slug}.lock`);
  const held = await acquireFileLockWithin(lockPath, { waitMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS });
  if (!held) throw new WhiteboardLockError(`whiteboard '${slug}' is busy (another write holds its lock); try again`);
  try {
    if (exists()) return { slug, created: false };
    const dir = join(base, slug);
    // A symlink or a stray file at the slug is never written through; a plain empty folder
    // (a half-finished create) is filled in.
    if (isSymlink(dir)) throw new WhiteboardValidationError(`whiteboards/${slug} is a symlink; refusing to create the default board through it`);
    try {
      mkdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (!lstatSync(dir).isDirectory()) throw new WhiteboardValidationError(`whiteboards/${slug} is not a folder; refusing to create the default board`);
    }
    const file = join(dir, `${slug}${BOARD_SUFFIX}`);
    if (isSymlink(file)) throw new WhiteboardValidationError(`whiteboards/${slug}/${slug}${BOARD_SUFFIX} is a symlink; refusing to write through it`);
    try {
      writeFileSync(file, serializeWhiteboard(emptyWhiteboard(name, '')), { encoding: 'utf-8', flag: 'wx' });
    } catch (err) {
      // A `whiteboard create "Control Panel"` that raced us (it takes no lock) got there first.
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { slug, created: false };
      throw err;
    }
    return { slug, created: true };
  } finally {
    releaseFileLock(lockPath);
  }
}

// ─── mutate ───────────────────────────────────────────────────────────────

export interface MutateOptions {
  /** Server origin, so a web widget URL pointing back at the dashboard is refused (D7). */
  selfOrigin?: string;
  lockWaitMs?: number;
}

export interface MutateResult {
  board: Whiteboard;
  rev: string;
  /** False when the serialized result equalled the bytes on disk and nothing was written. */
  changed: boolean;
}

function identityKey(el: WhiteboardElement): string {
  return `${el.version}:${typeof el.versionNonce === 'number' ? el.versionNonce : 0}`;
}

/**
 * The single write path. `fn` receives a private copy of the parsed board and returns the new
 * board (or mutates the copy and returns nothing). A board that fails to parse is never
 * written over (D12); a board that does not exist is never re-created (D11).
 */
export async function mutateWhiteboard(
  root: string,
  slug: string,
  fn: (board: Whiteboard) => Whiteboard | void,
  opts: MutateOptions = {},
): Promise<MutateResult> {
  const { dir, file } = resolveWhiteboardPath(root, slug);
  const base = ensureWhiteboardsDir(root);
  const lockPath = join(base, '.locks', `${slug}.lock`);
  const held = await acquireFileLockWithin(lockPath, { waitMs: opts.lockWaitMs ?? LOCK_WAIT_MS, staleMs: LOCK_STALE_MS });
  if (!held) throw new WhiteboardLockError(`whiteboard '${slug}' is busy (another write holds its lock); try again`);
  try {
    // Re-resolve under the lock: the board may have been deleted while we waited.
    resolveWhiteboardPath(root, slug);
    const raw = readFileSync(file, 'utf-8');
    const current = parseWhiteboard(raw);
    const before = new Map(current.elements.map((e) => [e.id, identityKey(e)]));
    const draft = structuredClone(current);
    const next = fn(draft) ?? draft;

    const seen = new Set<string>();
    for (const el of next.elements) {
      if (seen.has(el.id)) throw new WhiteboardValidationError(`duplicate element id: ${el.id}`);
      seen.add(el.id);
      // Only what this write changes is validated: a hand-made board holding something Phase 1
      // would refuse (an image from Obsidian) stays editable around it.
      if (before.get(el.id) !== identityKey(el)) validateElement(el, { selfOrigin: opts.selfOrigin });
    }
    next.elements = stripTombstones(next.elements);

    const out = serializeWhiteboard(next);
    if (out === raw) return { board: current, rev: sha1(raw), changed: false };
    // Guard against ever writing something this module cannot read back — or reads back as a
    // different board: a text label holding its own `## Drawing` + json fence is found ahead of
    // the real block (format.ts), so the parsed-back elements must be the ones being written.
    let readBack: Whiteboard;
    try {
      readBack = parseWhiteboard(out);
    } catch (err) {
      throw new WhiteboardCorruptError(`refusing to write a board that would not parse: ${(err as Error).message}`);
    }
    const written = sortElements(next.elements).map((e) => e.id);
    const parsedIds = readBack.elements.map((e) => e.id);
    if (parsedIds.length !== written.length || parsedIds.some((id, i) => id !== written[i])) {
      throw new WhiteboardCorruptError(
        `refusing to write a board that reads back as ${parsedIds.length} element(s) instead of ${written.length}; `
        + 'a text label probably contains a "## Drawing" heading and a json fence',
      );
    }
    const tmp = join(dir, `.${slug}${BOARD_SUFFIX}.${process.pid}.${Date.now()}.tmp`);
    try {
      writeFileSync(tmp, out, 'utf-8');
      renameSync(tmp, file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    return { board: parseWhiteboard(out), rev: sha1(out), changed: true };
  } finally {
    releaseFileLock(lockPath);
  }
}

/**
 * Rename a board: its display name (frontmatter `name`, verbatim) changes, its slug does not,
 * so tabs, agent homes (`whiteboard:` in a manifest) and links keep pointing at it.
 */
export async function renameWhiteboard(root: string, slug: string, name: string): Promise<{ slug: string; name: string; rev: string }> {
  const display = name.trim();
  if (!display) throw new WhiteboardValidationError('a whiteboard needs a name');
  if (display.length > 200) throw new WhiteboardValidationError('a whiteboard name is at most 200 characters');
  // One line of text: a control or line-separator character would not survive the YAML round trip.
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(display)) {
    throw new WhiteboardValidationError('a whiteboard name is one line of text, without control characters');
  }
  const { board, rev } = await mutateWhiteboard(root, slug, (b) => {
    b.frontmatter = { ...b.frontmatter, name: display };
  });
  return { slug, name: boardName(board, slug), rev };
}

// ─── trash ────────────────────────────────────────────────────────────────

/**
 * A deleted board is never removed: its folder moves to `whiteboards/.trash/<slug>-<ms>/`, and
 * the trash carries its own `*` .gitignore, so the history stays on this machine and never
 * travels to teammates through brain sync. {@link restoreWhiteboard} brings it back.
 */
export const TRASH_DIR = '.trash';
const TRASH_ENTRY_RE = /^([a-z0-9][a-z0-9-]*)-(\d{10,})$/;

export interface TrashedWhiteboard {
  /** The trash folder's name, `<slug>-<ms>`: what {@link restoreWhiteboard} takes. */
  id: string;
  slug: string;
  name: string;
  elements: number;
  deletedAt: string;
}

function trashDir(root: string): string {
  return join(whiteboardsDir(root), TRASH_DIR);
}

function ensureTrashDir(root: string): string {
  const trash = trashDir(root);
  if (isSymlink(trash) || (existsSync(trash) && !lstatSync(trash).isDirectory())) {
    throw new WhiteboardValidationError('whiteboards/.trash is not a plain folder; refusing to move a board into it');
  }
  if (!existsSync(trash)) mkdirSync(trash);
  const ignore = join(trash, '.gitignore');
  if (isSymlink(ignore)) throw new WhiteboardValidationError('whiteboards/.trash/.gitignore is a symlink; refusing to write through it');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n', 'utf-8');
  return trash;
}

async function withBoardLock<T>(root: string, slug: string, fn: () => T): Promise<T> {
  const base = ensureWhiteboardsDir(root);
  const lockPath = join(base, '.locks', `${slug}.lock`);
  const held = await acquireFileLockWithin(lockPath, { waitMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS });
  if (!held) throw new WhiteboardLockError(`whiteboard '${slug}' is busy (another write holds its lock); try again`);
  try {
    return fn();
  } finally {
    releaseFileLock(lockPath);
  }
}

/**
 * Move a board into the trash. Taken under the board's own lock, so a write in flight either
 * lands before the move or finds the board gone, never a half-moved folder.
 */
export async function trashWhiteboard(root: string, slug: string): Promise<{ id: string }> {
  resolveWhiteboardPath(root, slug);
  return withBoardLock(root, slug, () => {
    const { dir } = resolveWhiteboardPath(root, slug);
    const trash = ensureTrashDir(root);
    let ms = Date.now();
    while (existsSync(join(trash, `${slug}-${ms}`))) ms++;
    const id = `${slug}-${ms}`;
    renameSync(dir, join(trash, id));
    return { id };
  });
}

/** A trash entry's folder and board file, refusing anything not plain and contained. */
function resolveTrashEntry(root: string, id: string): { dir: string; file: string; slug: string; ms: number } | null {
  const m = TRASH_ENTRY_RE.exec(id);
  if (!m || !isValidWhiteboardSlug(m[1])) return null;
  const trash = trashDir(root);
  try {
    if (!lstatSync(trash).isDirectory()) return null;
  } catch {
    return null;
  }
  const dir = safeChildPath(trash, id);
  if (!dir || isSymlink(dir)) return null;
  const file = safeChildPath(dir, `${m[1]}${BOARD_SUFFIX}`);
  if (!file) return null;
  try {
    if (!lstatSync(dir).isDirectory() || !lstatSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return { dir, file, slug: m[1], ms: Number(m[2]) };
}

/** The trash, newest first. A board that does not parse is listed under its slug. */
export function listTrashedWhiteboards(root: string): TrashedWhiteboard[] {
  let entries: string[];
  try {
    if (!lstatSync(trashDir(root)).isDirectory()) return [];
    entries = readdirSync(trashDir(root));
  } catch {
    return [];
  }
  const out: TrashedWhiteboard[] = [];
  for (const id of entries) {
    const entry = resolveTrashEntry(root, id);
    if (!entry) continue;
    let name = entry.slug;
    let elements = 0;
    try {
      const board = parseWhiteboard(readFileSync(entry.file, 'utf-8'));
      name = boardName(board, entry.slug);
      elements = board.elements.filter((e) => e.isDeleted !== true).length;
    } catch { /* listed by slug: it can still be restored and fixed by hand */ }
    out.push({ id, slug: entry.slug, name, elements, deletedAt: new Date(entry.ms).toISOString() });
  }
  return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

/**
 * Bring a trashed board back. It returns under its old slug when that is free; a board made
 * since under the same slug keeps it, and the restored one takes `<slug>-2`, `-3`….
 */
export async function restoreWhiteboard(root: string, id: string): Promise<{ slug: string }> {
  const first = resolveTrashEntry(root, id);
  if (!first) throw new WhiteboardNotFoundError(`nothing in the trash named '${id}'`);
  const base = ensureWhiteboardsDir(root);
  const free = (slug: string) => !RESERVED_SLUGS.has(slug) && !existsSync(join(base, slug)) && !isSymlink(join(base, slug));
  for (let n = 1; n < 10_000; n++) {
    const suffix = n === 1 ? '' : `-${n}`;
    const slug = `${first.slug.slice(0, MAX_SLUG - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!free(slug)) continue;
    const done = await withBoardLock(root, slug, () => {
      if (!free(slug)) return false;
      const entry = resolveTrashEntry(root, id);
      if (!entry) throw new WhiteboardNotFoundError(`nothing in the trash named '${id}'`);
      const dir = join(base, slug);
      renameSync(entry.dir, dir);
      if (slug !== entry.slug) renameSync(join(dir, `${entry.slug}${BOARD_SUFFIX}`), join(dir, `${slug}${BOARD_SUFFIX}`));
      return true;
    });
    if (done) return { slug };
  }
  throw new WhiteboardValidationError(`could not find a free slug to restore '${first.slug}'`);
}
