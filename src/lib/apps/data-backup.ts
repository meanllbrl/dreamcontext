/**
 * The app data's backup, OUTSIDE every repo (owner, 2026-11-02): the data folder is ignored by
 * git, so `git clean -fdX` or `git stash --all` would delete it. A copy goes to
 * `~/.dreamcontext/apps/backup/<hash>/<stamp>/` when the backend starts, when it stops and every
 * 30 minutes while it runs, only when something changed. The newest {@link BACKUP_KEEP} stay.
 * Links are never copied. `dreamcontext apps restore <slug>` brings one back; whatever the data
 * folder holds then is backed up first, so a restore can itself be undone.
 *
 * Never synced and never read by the app's assistant (`appCredentialDenies` names `apps/backup`).
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { cp, mkdir, readdir, lstat, rename, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { acquireFileLock, releaseFileLock } from '../file-lock.js';
import { appsHome } from './registry.js';
import { ensureAppDataDir, isEmptyDir } from './data-dir.js';

export const BACKUP_KEEP = 5;
/** Bigger data is not copied on every change: the owner hears it instead. */
export const BACKUP_MAX_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const STAMP_RE = /^\d{8}T\d{6}Z-[0-9a-f]{4}$/;

export function backupRoot(home: string, hash: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(hash)) throw new Error('bad app hash');
  return join(appsHome(home), 'backup', hash);
}

interface Fingerprint { sum: string; files: number; bytes: number; tooMany: boolean }

/** Path, size and mtime of every file (links skipped): cheap, lstat only. */
function fingerprint(dir: string): Fingerprint {
  const h = createHash('sha256');
  let files = 0;
  let bytes = 0;
  let entries = 0;
  let tooMany = false;
  const walk = (d: string): void => {
    let names: string[];
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const name of names) {
      if (++entries > MAX_ENTRIES) { tooMany = true; return; }
      const p = join(d, name);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { h.update(`d ${relative(dir, p)}\n`); walk(p); if (tooMany) return; continue; }
      if (!st.isFile()) continue;
      files++;
      bytes += st.size;
      h.update(`f ${relative(dir, p)} ${st.size} ${Math.floor(st.mtimeMs)}\n`);
    }
  };
  walk(dir);
  return { sum: h.digest('hex'), files, bytes, tooMany };
}

function stampNow(now: Date): string {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${iso}-${randomBytes(2).toString('hex')}`;
}

function ensureRoot(home: string, hash: string): string {
  const root = backupRoot(home, hash);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const st = lstatSync(root);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('the backup folder is a symlink or not a folder');
  return root;
}

export interface BackupInfo { stamp: string; path: string; files: number; bytes: number; reason: string }

function readMeta(dir: string): { files: number; bytes: number; reason: string; sum: string } | null {
  try {
    const r = JSON.parse(readFileSync(join(dir, '.backup.json'), 'utf-8')) as Record<string, unknown>;
    return { files: Number(r.files) || 0, bytes: Number(r.bytes) || 0, reason: String(r.reason ?? ''), sum: String(r.sum ?? '') };
  } catch { return null; }
}

/** Newest first. Never throws. */
export function listBackups(home: string, hash: string): BackupInfo[] {
  let root: string;
  try { root = backupRoot(home, hash); } catch { return []; }
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  const out: BackupInfo[] = [];
  for (const stamp of names) {
    if (!STAMP_RE.test(stamp)) continue;
    const path = join(root, stamp);
    try { if (!lstatSync(path).isDirectory()) continue; } catch { continue; }
    const meta = readMeta(path);
    if (!meta) continue;
    out.push({ stamp, path, files: meta.files, bytes: meta.bytes, reason: meta.reason });
  }
  return out.sort((a, b) => (a.stamp < b.stamp ? 1 : -1));
}

async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { mode: 0o700 });
  for (const name of await readdir(from)) {
    if (name === '.backup.json') continue;
    const src = join(from, name);
    const dst = join(to, name);
    const st = await lstat(src);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) await copyTree(src, dst);
    else if (st.isFile()) await cp(src, dst, { preserveTimestamps: true, errorOnExist: true, force: false });
  }
}

export type BackupResult =
  | { ok: true; stamp: string; files: number; bytes: number }
  | { ok: false; skipped: 'empty' | 'unchanged' | 'too_big' | 'busy' | 'missing'; bytes?: number }
  | { ok: false; error: string };

/**
 * One backup of `dataDir`, unless nothing changed since the newest one. Serialized per app by a
 * PID lock; a second caller meanwhile gets `busy` (the first one's copy is as good).
 */
export async function backupAppData(home: string, hash: string, dataDir: string, opts: { reason: string; now?: Date; force?: boolean }): Promise<BackupResult> {
  try {
    if (!existsSync(dataDir)) return { ok: false, skipped: 'missing' };
    const st = lstatSync(dataDir);
    if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, error: 'the data folder is a symlink or not a folder' };
    if (isEmptyDir(dataDir)) return { ok: false, skipped: 'empty' };
    const root = ensureRoot(home, hash);
    const lock = join(root, '.lock');
    if (!acquireFileLock(lock, Date.now(), 10 * 60_000, { verifyPidLiveness: true })) return { ok: false, skipped: 'busy' };
    try {
      const fp = fingerprint(dataDir);
      if (fp.bytes > BACKUP_MAX_BYTES || fp.tooMany) return { ok: false, skipped: 'too_big', bytes: fp.bytes };
      const newest = listBackups(home, hash)[0];
      if (!opts.force && newest && readMeta(newest.path)?.sum === fp.sum) return { ok: false, skipped: 'unchanged' };
      const stamp = stampNow(opts.now ?? new Date());
      const tmp = join(root, `.tmp-${randomBytes(4).toString('hex')}`);
      try {
        await copyTree(dataDir, tmp);
        writeFileSync(join(tmp, '.backup.json'), JSON.stringify({ files: fp.files, bytes: fp.bytes, reason: opts.reason, sum: fp.sum }) + '\n', { mode: 0o600 });
        await rename(tmp, join(root, stamp));
      } catch (e) {
        await rm(tmp, { recursive: true, force: true }).catch(() => {});
        throw e;
      }
      for (const old of listBackups(home, hash).slice(BACKUP_KEEP)) {
        try { rmSync(old.path, { recursive: true, force: true }); } catch { /* next time */ }
      }
      return { ok: true, stamp, files: fp.files, bytes: fp.bytes };
    } finally {
      releaseFileLock(lock);
    }
  } catch (e) {
    return { ok: false, error: (e as NodeJS.ErrnoException).code ?? (e as Error).message };
  }
}

export type RestoreResult =
  | { ok: true; stamp: string; files: number; previous: string | null }
  | { ok: false; code: 'no_backup' | 'backup_not_found' | 'restore_failed'; message: string };

/**
 * Put a backup back as the app's data folder. The folder's current content is backed up first
 * (forced, so the restore can be undone with the next-newest stamp), then set aside, the copy
 * renamed in, the aside removed. The caller makes sure the backend is not running.
 */
export async function restoreAppData(home: string, rec: { hash: string; projectRoot: string; slug: string }, opts: { at?: string } = {}): Promise<RestoreResult> {
  const all = listBackups(home, rec.hash);
  if (!all.length) return { ok: false, code: 'no_backup', message: 'this app has no backup yet' };
  const pick = opts.at ? all.find((b) => b.stamp === opts.at) : all[0];
  if (!pick) return { ok: false, code: 'backup_not_found', message: `no backup ${opts.at}; see dreamcontext apps restore ${rec.slug} --list` };
  let dataDir: string;
  try { dataDir = ensureAppDataDir(rec.projectRoot, rec.slug); } catch (e) {
    return { ok: false, code: 'restore_failed', message: (e as Error).message };
  }
  const meta = readMeta(pick.path);
  const parent = join(dataDir, '..');
  const incoming = join(parent, `.${rec.slug}.restoring-${randomBytes(4).toString('hex')}`);
  const aside = join(parent, `.${rec.slug}.replaced-${randomBytes(4).toString('hex')}`);
  // The picked copy comes in FIRST: the pre-restore backup below prunes to the newest few, and
  // the pick (the oldest, say) may be one it removes.
  try { await copyTree(pick.path, incoming); } catch (e) {
    await rm(incoming, { recursive: true, force: true }).catch(() => {});
    return { ok: false, code: 'restore_failed', message: `the backup could not be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); nothing was changed` };
  }
  let previous: string | null = null;
  if (!isEmptyDir(dataDir)) {
    const b = await backupAppData(home, rec.hash, dataDir, { reason: 'before-restore', force: true });
    if (!b.ok && !('skipped' in b && b.skipped === 'unchanged')) {
      await rm(incoming, { recursive: true, force: true }).catch(() => {});
      return { ok: false, code: 'restore_failed', message: `the current data could not be backed up first (${'error' in b ? b.error : b.skipped}); nothing was changed` };
    }
    previous = b.ok ? b.stamp : null;
  }
  try {
    renameSync(dataDir, aside);
    try { renameSync(incoming, dataDir); } catch (e) { renameSync(aside, dataDir); throw e; }
  } catch (e) {
    await rm(incoming, { recursive: true, force: true }).catch(() => {});
    return { ok: false, code: 'restore_failed', message: (e as NodeJS.ErrnoException).code ?? (e as Error).message };
  }
  await rm(aside, { recursive: true, force: true }).catch(() => {});
  return { ok: true, stamp: pick.stamp, files: meta?.files ?? 0, previous };
}

/** The data folder is missing or empty while a backup exists (git clean, a wiped folder). */
export function dataLostWithBackup(home: string, hash: string, dataDir: string): boolean {
  if (existsSync(dataDir) && !isEmptyDir(dataDir)) return false;
  return listBackups(home, hash).length > 0;
}

/** For tests and the CLI's `--list`. */
export const BACKUP_STAMP_RE = STAMP_RE;
