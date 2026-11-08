/**
 * App window screenshots (dreamcontext-apps plan r19, "Runner snapshot").
 *
 * The runner uploads a PNG; the server writes it ONLY under
 * `~/.dreamcontext/apps/shots/<hash>/<id>.png` (dir 0700, file 0600, the id the server
 * minted, never a client path) and deletes it after 30 minutes. `apps screenshot` then copies
 * it into the project's `_dream_context/tmp/apps/<id>.png` so a headless agent can read it:
 *   1. lstat `tmp/`, `tmp/apps/` and `.gitignore`: a symlink anywhere refuses the copy;
 *   2. `ensureSelfIgnoredDir` (`tmp/` is not ignored in every project), then the file must hold
 *      exactly a `*` line and no `!` line;
 *   3. write 0600, exclusive.
 * Pruning removes only `<id>.png` files older than 30 minutes; `.gitignore` stays.
 */

import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSelfIgnoredDir } from '../embeddings/ignored-dir.js';
import { appsHome } from './registry.js';

export const SHOT_TTL_MS = 30 * 60_000;
export const SHOT_MAX_BYTES = 8 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SHOT_RE = /^[A-Za-z0-9_-]{16,64}\.png$/;

export function shotsRoot(home: string): string {
  return join(appsHome(home), 'shots');
}

export function shotPath(home: string, hash: string, id: string): string {
  if (!ID_RE.test(id) || !/^[0-9a-f]{16}$/.test(hash)) throw new Error('bad shot id');
  return join(shotsRoot(home), hash, `${id}.png`);
}

export function writeShot(home: string, hash: string, id: string, png: Buffer): string {
  if (png.length > SHOT_MAX_BYTES) throw new Error('shot too large');
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG');
  const dir = join(shotsRoot(home), hash);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error('shots dir is a symlink');
  const p = shotPath(home, hash, id);
  writeFileSync(p, png, { mode: 0o600, flag: 'wx' });
  return p;
}

function pruneDir(dir: string, now: number): void {
  let names: string[] = [];
  try {
    if (lstatSync(dir).isSymbolicLink()) return;
    names = readdirSync(dir);
  } catch { return; }
  for (const n of names) {
    if (!SHOT_RE.test(n)) continue;
    const p = join(dir, n);
    try {
      const st = lstatSync(p);
      if (st.isFile() && now - st.mtimeMs > SHOT_TTL_MS) rmSync(p, { force: true });
    } catch { /* gone */ }
  }
}

/** Remove server-side shots older than 30 minutes (every app). */
export function pruneShots(home: string, now = Date.now()): void {
  const root = shotsRoot(home);
  let hashes: string[] = [];
  try { hashes = readdirSync(root); } catch { return; }
  for (const h of hashes) if (/^[0-9a-f]{16}$/.test(h)) pruneDir(join(root, h), now);
}

export function removeShots(home: string, hash: string): void {
  if (!/^[0-9a-f]{16}$/.test(hash)) return;
  rmSync(join(shotsRoot(home), hash), { recursive: true, force: true });
}

function isLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** The project's `_dream_context/tmp/apps`, or why it cannot be used. */
export function projectShotsDir(contextRoot: string): { ok: true; dir: string } | { ok: false; reason: string } {
  const tmp = join(contextRoot, 'tmp');
  const dir = join(tmp, 'apps');
  const ignore = join(dir, '.gitignore');
  for (const p of [tmp, dir, ignore]) if (isLink(p)) return { ok: false, reason: `${p} is a symlink` };
  try {
    ensureSelfIgnoredDir(dir);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  if (isLink(ignore)) return { ok: false, reason: `${ignore} is a symlink` };
  let lines: string[] = [];
  try { lines = readFileSync(ignore, 'utf-8').split(/\r?\n/).map((l) => l.trim()); } catch { return { ok: false, reason: 'cannot read tmp/apps/.gitignore' }; }
  if (!lines.includes('*') || lines.some((l) => l.startsWith('!'))) return { ok: false, reason: 'tmp/apps/.gitignore does not ignore everything' };
  return { ok: true, dir };
}

/** Copy a server shot into the project (0600, exclusive). */
export function copyShotToProject(src: string, contextRoot: string, id: string): { ok: true; path: string } | { ok: false; reason: string } {
  if (!ID_RE.test(id)) return { ok: false, reason: 'bad shot id' };
  const d = projectShotsDir(contextRoot);
  if (!d.ok) return d;
  pruneDir(d.dir, Date.now());
  const dest = join(d.dir, `${id}.png`);
  try {
    writeFileSync(dest, readFileSync(src), { mode: 0o600, flag: 'wx' });
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** Copy a shot to a caller-chosen file: no symlink followed, 0600, exclusive. */
export function copyShotTo(src: string, out: string): { ok: true; path: string } | { ok: false; reason: string } {
  if (isLink(out)) return { ok: false, reason: `${out} is a symlink` };
  try {
    writeFileSync(out, readFileSync(src), { mode: 0o600, flag: 'wx' });
    return { ok: true, path: out };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
