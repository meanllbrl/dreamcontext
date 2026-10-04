import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Keep every build's content-hashed chunks reachable for the life of this server.
 *
 * A dashboard tab keeps running the build it was served, and its lazy `import()`s
 * (the Excalidraw canvas, the whiteboard, the 3D brain) name that build's chunk
 * hashes. Rebuild the dashboard underneath a running server — `npm run build` in a
 * linked checkout, where `dist/dashboard` is removed and re-copied — and those
 * files are gone: the first board opened afterwards 404s and `lazyWithReload`
 * reloads the whole app, which reads as a crash-and-restart.
 *
 * So whenever this server hands out an index.html it has not handed out before, it
 * hard-links that build's `assets/` into a per-process snapshot. A link costs no
 * copy, and because builds REPLACE files (unlink + write a new inode), never
 * rewrite them in place, the linked bytes stay exactly what the old tab expects.
 * A miss under `/assets/` falls back to the newest snapshot that still has the
 * file. Lives in the OS temp dir, never under `dist/`, so it can't ship.
 */

const MAX_BUILDS = 8;
const DIR_PREFIX = 'dreamcontext-dashboard-builds-';

let snapshotRoot = join(tmpdir(), `${DIR_PREFIX}${process.pid}`);
const seenBuilds = new Set<string>();
const snapshots: string[] = [];
let initialized = false;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** First use: drop snapshots left by servers that died without their exit hook, then arm ours. */
function init(): void {
  if (initialized) return;
  initialized = true;
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith(DIR_PREFIX)) continue;
      const pid = Number(name.slice(DIR_PREFIX.length));
      if (Number.isInteger(pid) && pid !== process.pid && !isAlive(pid)) {
        rmSync(join(tmpdir(), name), { recursive: true, force: true });
      }
    }
  } catch { /* best-effort sweep */ }
  process.once('exit', () => {
    try { rmSync(snapshotRoot, { recursive: true, force: true }); } catch { /* exiting anyway */ }
  });
}

/** Snapshot the assets of the build whose index.html is being served, once per distinct build. */
export function retainBuildAssets(staticDir: string, indexHtml: Buffer): void {
  const key = createHash('sha1').update(indexHtml).digest('hex').slice(0, 12);
  if (seenBuilds.has(key)) return;
  seenBuilds.add(key);
  init();

  const source = join(staticDir, 'assets');
  const target = join(snapshotRoot, key);
  try {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) {
      // A file the build is still writing, or a cross-device temp dir, just isn't
      // retained — a miss falls through to the 404 the client already recovers from.
      try { linkSync(join(source, name), join(target, name)); } catch { /* skip */ }
    }
  } catch {
    return;
  }
  snapshots.push(target);
  while (snapshots.length > MAX_BUILDS) {
    rmSync(snapshots.shift()!, { recursive: true, force: true });
  }
}

/** The retained copy of a missing `/assets/<file>`, newest build first, or null. */
export function findRetainedAsset(pathname: string): string | null {
  if (!pathname.startsWith('/assets/')) return null;
  const name = pathname.slice('/assets/'.length);
  if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.')) return null;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const candidate = join(snapshots[i], name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Tests only: point the snapshots at a scratch dir and forget every build seen so far. */
export function resetRetainedAssetsForTests(root: string): void {
  snapshotRoot = root;
  seenBuilds.clear();
  snapshots.length = 0;
}
