import type { IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  createWriteStream, linkSync, lstatSync, mkdirSync, readdirSync, realpathSync, unlinkSync,
  type Dirent,
} from 'node:fs';
import { extname, join, sep } from 'node:path';
import { TASK_SLUG_RE } from './task-slug.js';

/**
 * A task's attachments: the files under `<vault>/_dream_context/state/assets/<slug>/`.
 *
 * The folder is LOCAL: the brain's `.gitignore` ignores `state/` and brain sync carries only
 * `state/*.md`, so attachments never reach a teammate, ClickUp or GitHub. Everything here is
 * written for a folder a teammate cannot plant links in, but still refuses symlinks at every
 * level, because a local tool (or an unzip) can.
 */

export const ASSETS_DIR = join('state', 'assets');

/** Upload ceiling and how many uploads one server takes at once. Mutable for tests only. */
export const TASK_ASSET_LIMITS = { capBytes: 100 * 1024 * 1024, maxConcurrent: 4 };

/** Listing walk bounds: the detail shows a recursive total, never an unbounded walk. */
const WALK_MAX_ENTRIES = 2000;
const WALK_MAX_DEPTH = 6;
/** A left-behind `.upload-*` (a crash mid-upload) older than this is deleted on the next upload. */
const STALE_UPLOAD_MS = 60 * 60 * 1000;
const UPLOAD_PREFIX = '.upload-';
/** A stored file name is at most this many bytes, extension kept. */
export const MAX_ASSET_NAME_BYTES = 200;

export type AssetKind = 'image' | 'video' | 'audio' | 'pdf' | 'file';

export class TaskAssetsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'TaskAssetsError';
  }
}

const KIND_BY_EXT: Record<string, AssetKind> = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image',
  '.mp4': 'video', '.webm': 'video', '.mov': 'video',
  '.mp3': 'audio', '.m4a': 'audio', '.wav': 'audio',
  '.pdf': 'pdf',
};

/** What a tile shows for an extension. SVG is a plain file: it can carry script, so it is never rendered inline. */
export function kindOf(ext: string): AssetKind {
  return KIND_BY_EXT[ext.toLowerCase()] ?? 'file';
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function exists(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}

/**
 * The real path `assets/<slug>` must live at: `realpath(<vault>/_dream_context)/state/assets/<slug>`.
 * A symlinked `state`, `state/assets` or `assets/<slug>` resolves elsewhere and fails this.
 */
function assertContained(contextRoot: string, dir: string, slug: string): void {
  let realRoot: string;
  let realDir: string;
  try {
    realRoot = realpathSync.native(contextRoot);
    realDir = realpathSync.native(dir);
  } catch {
    throw new TaskAssetsError(400, 'invalid_path', 'The task assets folder cannot be resolved.');
  }
  const expected = join(realRoot, ASSETS_DIR) + sep;
  if (!realDir.startsWith(expected) || realDir.slice(expected.length) !== slug) {
    throw new TaskAssetsError(400, 'invalid_path', 'The task assets folder is outside state/assets.');
  }
}

/**
 * `<contextRoot>/state/assets/<slug>`, checked. A bad slug is 400; a symlinked folder (at
 * `assets/<slug>` or above it) is refused. With `create`, the folder is made first and then
 * re-checked. Returns `exists: false` (and does not create) for a task with no attachments.
 */
export function assetsDirFor(
  contextRoot: string,
  slug: string,
  opts: { create?: boolean } = {},
): { dir: string; exists: boolean } {
  if (typeof slug !== 'string' || !TASK_SLUG_RE.test(slug)) {
    throw new TaskAssetsError(400, 'invalid_slug', `Invalid task slug: ${String(slug).slice(0, 80)}`);
  }
  const dir = join(contextRoot, ASSETS_DIR, slug);
  if (isSymlink(join(contextRoot, 'state')) || isSymlink(join(contextRoot, ASSETS_DIR)) || isSymlink(dir)) {
    throw new TaskAssetsError(400, 'invalid_path', 'The task assets folder is a symlink; refusing to use it.');
  }
  if (!exists(dir)) {
    if (!opts.create) return { dir, exists: false };
    mkdirSync(dir, { recursive: true });
  }
  assertContained(contextRoot, dir, slug);
  return { dir, exists: true };
}

export interface AssetFileEntry { name: string; path: string; kind: AssetKind; size: number }
export interface AssetFolderEntry { name: string; path: string; kind: 'folder'; count: number }
export type AssetEntry = AssetFileEntry | AssetFolderEntry;

export interface AssetListing {
  /** Top-level files and folders, files first, each group by name. */
  entries: AssetEntry[];
  /** Files under the folder, recursively (within the walk bounds). */
  total: number;
  /** True when the walk stopped at its entry or depth bound. */
  truncated: boolean;
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);

function visible(d: Dirent): boolean {
  return !d.name.startsWith('.') && !d.isSymbolicLink();
}

/**
 * List an assets folder. Symlinks and dotfiles are skipped at every depth. The TOP level is
 * listed first, in full (up to the entry bound), so a huge subfolder can never hide a file
 * that sits beside it; folder counts then share what is left of the walk bound.
 */
export function listAssets(dir: string): AssetListing {
  let truncated = false;
  let top: Dirent[];
  try { top = readdirSync(dir, { withFileTypes: true }); } catch { return { entries: [], total: 0, truncated: false }; }
  const shown = top.filter((d) => visible(d) && (d.isFile() || d.isDirectory())).sort(byName);
  if (shown.length > WALK_MAX_ENTRIES) { truncated = true; shown.length = WALK_MAX_ENTRIES; }
  let budget = WALK_MAX_ENTRIES - shown.length;

  /** Files under `abs`, recursively, within what is left of the walk bound. */
  const countFiles = (abs: string, depth: number): number => {
    if (depth > WALK_MAX_DEPTH) { truncated = true; return 0; }
    let ents: Dirent[];
    try { ents = readdirSync(abs, { withFileTypes: true }); } catch { return 0; }
    let n = 0;
    for (const d of ents) {
      if (!visible(d)) continue;
      if (budget <= 0) { truncated = true; break; }
      budget--;
      if (d.isFile()) n++;
      else if (d.isDirectory()) n += countFiles(join(abs, d.name), depth + 1);
    }
    return n;
  };

  const files: AssetFileEntry[] = [];
  const folders: AssetFolderEntry[] = [];
  let total = 0;
  for (const d of shown) {
    if (!d.isFile()) continue;
    let size = 0;
    try { size = lstatSync(join(dir, d.name)).size; } catch { continue; }
    files.push({ name: d.name, path: d.name, kind: kindOf(extname(d.name)), size });
    total++;
  }
  for (const d of shown) {
    if (!d.isDirectory()) continue;
    const count = countFiles(join(dir, d.name), 2);
    folders.push({ name: d.name, path: d.name, kind: 'folder', count });
    total += count;
  }
  return { entries: [...files, ...folders], total, truncated };
}

/**
 * The board card's clip: how many top-level entries a task's folder holds and the first
 * top-level image (by name). ONE directory read, no stat and no recursion: this runs per
 * task on every `GET /api/tasks`. Never throws; an unusable folder reads as empty.
 */
export function summarizeAssets(contextRoot: string, slug: string): { count: number; cover: string | null } {
  const empty = { count: 0, cover: null };
  let dir: string;
  try {
    const r = assetsDirFor(contextRoot, slug);
    if (!r.exists) return empty;
    dir = r.dir;
  } catch { return empty; }
  let ents: Dirent[];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return empty; }
  const shown = ents.filter((d) => visible(d) && (d.isFile() || d.isDirectory()));
  const cover = shown
    .filter((d) => d.isFile() && kindOf(extname(d.name)) === 'image')
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b))[0] ?? null;
  return { count: shown.length, cover };
}

/** Cap a (sanitized, ASCII) name at {@link MAX_ASSET_NAME_BYTES}, keeping its extension. */
export function capAssetName(name: string): string {
  if (Buffer.byteLength(name) <= MAX_ASSET_NAME_BYTES) return name;
  const ext = extname(name);
  const keepExt = ext.length > 0 && Buffer.byteLength(ext) < 32 ? ext : '';
  let base = keepExt ? name.slice(0, -keepExt.length) : name;
  while (base.length > 0 && Buffer.byteLength(base + keepExt) > MAX_ASSET_NAME_BYTES) base = base.slice(0, -1);
  return base + keepExt;
}

/** Delete `.upload-*` files older than an hour (a crash left them). Best-effort. */
export function pruneStaleUploads(dir: string, now = Date.now()): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(UPLOAD_PREFIX)) continue;
    const p = join(dir, name);
    try {
      const st = lstatSync(p);
      if (st.isFile() && now - st.mtimeMs > STALE_UPLOAD_MS) unlinkSync(p);
    } catch { /* one locked entry must not abort the prune */ }
  }
}

/**
 * Take `name` in `dir` without ever overwriting: `link(tmp, candidate)` fails with EEXIST
 * when the name is taken, so `photo.png`, then `photo-1.png`, `photo-2.png`… `rename` is
 * never used, because it replaces an existing file silently.
 */
export function claimName(tmp: string, dir: string, name: string): string {
  const ext = extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? name : `${base}-${i}${ext}`;
    try {
      linkSync(tmp, join(dir, candidate));
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new TaskAssetsError(409, 'name_taken', `Too many files named like ${name}.`);
}

export type UploadResult =
  | { ok: true; name: string; size: number }
  | { ok: false; status: number; code: string; message: string };

/**
 * Stream a request body into `dir/name`. The bytes go to a `.upload-<random>` file in the
 * same folder with a running count; past `capBytes` the write stops, the partial file is
 * deleted and the result is 413. An aborted or failed request deletes the partial file too.
 * On success the final name is claimed atomically ({@link claimName}). Always resolves.
 */
export function writeUploadStream(
  req: IncomingMessage,
  dir: string,
  name: string,
  capBytes: number,
): Promise<UploadResult> {
  // A request that died while the caller was still awaiting (before these listeners exist)
  // will never emit close/aborted again: settle now, or the caller's slot is never released.
  if (req.destroyed || req.readableAborted || req.socket?.destroyed) {
    return Promise.resolve({ ok: false, status: 400, code: 'aborted', message: 'The upload was interrupted.' });
  }
  pruneStaleUploads(dir);
  const tmp = join(dir, `${UPLOAD_PREFIX}${randomBytes(8).toString('hex')}`);
  return new Promise((resolve) => {
    let settled = false;
    let ended = false;
    let size = 0;
    const ws = createWriteStream(tmp, { flags: 'wx' });
    const cleanup = (): void => { try { unlinkSync(tmp); } catch { /* already gone */ } };
    const fail = (status: number, code: string, message: string): void => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      ws.destroy();
      // The write stream may still hold the fd for a tick; unlink both now and once it closes.
      cleanup();
      ws.once('close', cleanup);
      resolve({ ok: false, status, code, message });
    };
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      size += chunk.length;
      if (size > capBytes) {
        fail(413, 'too_large', `The file exceeds the ${Math.round(capBytes / (1024 * 1024))} MB limit.`);
        return;
      }
      if (!ws.write(chunk)) req.pause();
    };
    ws.on('drain', () => { if (!settled) req.resume(); });
    ws.on('error', () => fail(500, 'write_failed', 'Could not save the file.'));
    req.on('data', onData);
    req.on('error', () => fail(400, 'aborted', 'The upload was interrupted.'));
    req.on('aborted', () => fail(400, 'aborted', 'The upload was interrupted.'));
    req.on('close', () => { if (!ended) fail(400, 'aborted', 'The upload was interrupted.'); });
    req.on('end', () => {
      ended = true;
      if (settled) return;
      ws.end(() => {
        if (settled) return;
        settled = true;
        if (size === 0) {
          cleanup();
          resolve({ ok: false, status: 400, code: 'empty', message: 'No file data was received.' });
          return;
        }
        try {
          const finalName = claimName(tmp, dir, name);
          cleanup();
          resolve({ ok: true, name: finalName, size });
        } catch (err) {
          cleanup();
          const e = err instanceof TaskAssetsError ? err : null;
          resolve({ ok: false, status: e?.status ?? 500, code: e?.code ?? 'write_failed', message: e?.message ?? 'Could not save the file.' });
        }
      });
    });
  });
}
