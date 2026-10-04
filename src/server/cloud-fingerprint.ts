import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLOUD_FINGERPRINT_FILE, isCloud } from './cloud-mode.js';

/**
 * The build fingerprint (AC18): one hash over the installed package's `dist/` (the CLI bundle
 * and the dashboard bundle under it), so the laptop can tell whether the cloud runs its exact
 * build.
 *
 * PINNED algorithm (the root supervisor, `cloud/supervisor.mjs`, computes the same over what
 * it installed; a unit test holds the two together): every regular file under
 * `<packageRoot>/dist`, recursively, symlinks skipped; one line per file
 * `<posix path relative to packageRoot>\0<sha256 hex of its bytes>\n`; lines sorted by
 * code unit; the fingerprint is the sha256 hex of their concatenation.
 */
export function computeBuildFingerprint(packageRoot: string): string | null {
  const dist = join(packageRoot, 'dist');
  if (!existsSync(dist)) return null;
  const lines: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isDirectory()) visit(abs);
      else if (st.isFile()) {
        const rel = relative(packageRoot, abs).split(sep).join('/');
        lines.push(`${rel}\0${createHash('sha256').update(readFileSync(abs)).digest('hex')}\n`);
      }
    }
  };
  visit(dist);
  lines.sort();
  const h = createHash('sha256');
  for (const l of lines) h.update(l);
  return h.digest('hex');
}

let cached: { value: string | null } | null = null;

/** This process's fingerprint: the supervisor's root-owned file in the cloud, else computed
 *  once over the package this code runs from. */
export function buildFingerprint(): string | null {
  if (isCloud()) {
    try {
      const v = readFileSync(CLOUD_FINGERPRINT_FILE, 'utf-8').trim();
      return /^[0-9a-f]{64}$/.test(v) ? v : null;
    } catch {
      return null;
    }
  }
  if (!cached) {
    let value: string | null = null;
    try {
      // Bundled: this file is dist/index.js, so the package root is its parent's parent.
      const here = dirname(fileURLToPath(import.meta.url));
      const root = here.endsWith(`${sep}dist`) ? dirname(here) : null;
      value = root ? computeBuildFingerprint(root) : null;
    } catch { /* unknown */ }
    cached = { value };
  }
  return cached.value;
}
