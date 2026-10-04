/**
 * Build-fingerprint parity (AC18): after go the cloud runs the laptop's exact build.
 *
 * {@link buildFingerprint} follows the algorithm lane D pinned in
 * `src/server/cloud-fingerprint.ts` (and the root supervisor computes over what it
 * installed): every regular file under `<packageRoot>/dist`, recursively, symlinks skipped;
 * one line per file `<posix path relative to packageRoot>\0<sha256 hex>\n`; lines sorted by
 * code unit; the fingerprint is the sha256 hex of their concatenation. Null without `dist/`.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProcessRunner } from './git-snapshot.js';

/** The installed/checked-out dreamcontext package root (walks up to its package.json). */
export function packageRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let cur = from;
  for (;;) {
    const pj = join(cur, 'package.json');
    if (existsSync(pj)) {
      try {
        if ((JSON.parse(readFileSync(pj, 'utf8')) as { name?: string }).name === 'dreamcontext') return cur;
      } catch { /* keep walking */ }
    }
    const up = dirname(cur);
    if (up === cur) throw new Error('could not find the dreamcontext package root');
    cur = up;
  }
}

export function buildFingerprint(root: string = packageRoot()): string | null {
  const lines: string[] = [];
  const dist = join(root, 'dist');
  if (!existsSync(dist)) return null;
  const visit = (dir: string) => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = join(dir, n);
      const st = lstatSync(p);
      if (st.isDirectory()) visit(p);
      else if (st.isFile()) lines.push(`${relative(root, p).split(sep).join('/')}\0${createHash('sha256').update(readFileSync(p)).digest('hex')}\n`);
    }
  };
  visit(dist);
  const h = createHash('sha256');
  for (const l of lines.sort()) h.update(l);
  return h.digest('hex');
}

/** `npm pack` of the package into `destDir`; returns the tarball path. */
export async function npmPack(run: ProcessRunner, root: string, destDir: string): Promise<string> {
  const res = await run('npm', ['pack', '--silent', '--pack-destination', destDir], { cwd: root, timeoutMs: 10 * 60_000 });
  if (res.code !== 0) throw new Error(`npm pack failed: ${res.stderr.toString().trim().slice(0, 300)}`);
  const name = res.stdout.toString().trim().split('\n').pop() ?? '';
  if (!/^[A-Za-z0-9._@-]+\.tgz$/.test(name)) throw new Error(`npm pack printed an unexpected name ${JSON.stringify(name)}`);
  return join(destDir, name);
}
