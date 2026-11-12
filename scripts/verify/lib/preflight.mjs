/**
 * What a browser check proves before it looks at the product: its own harness works.
 *
 * Measured 2026-11-12 (audit OR-5): 40% of browser checks came back red, and the first one of a run
 * was red in 50% of the runs, mostly on the script's own way in (a server that never answered, a
 * selector of a removed shell, a stale `dist/`). Each of those cost a full budgeted run and its
 * queue. So a check fails FAST and says so as HARNESS, with its own exit code, and
 * `dreamcontext builder heavy` does not count such a run against the repeat limit
 * (src/lib/run-budget.ts, VERIFY_HARNESS_EXIT and VERIFY_DIST_INPUTS mirror this file;
 * tests/unit/verify-preflight.test.ts holds the two together).
 *
 * No Playwright here, so the CLI's tests can import it.
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';

/** The exit of a check that stopped in its own setup, before the product. Not 1 (a finding), not 75/77 (the line). */
export const HARNESS_EXIT = 78;

/**
 * What each built output is made from: a source newer than its output means the build is stale.
 * Vite's own output is measured, never only the copy in dist/dashboard: build:cli re-copies an old
 * dashboard/dist with a fresh mtime. The dashboard bundles shared files of src/lib/. A path ending
 * in / is a folder (its git-listed files); any other is one file, read even when git ignores it.
 * Verify scripts are not inputs: fixing a script must not ask for a rebuild.
 */
export const DIST_INPUTS = [
  { output: 'dashboard/dist/index.html', inputs: ['dashboard/src/', 'dashboard/public/', 'dashboard/index.html', 'dashboard/vite.config.ts', 'dashboard/excalidraw-widget-link-icon.ts', 'dashboard/devProxyOrigin.ts', 'dashboard/package.json', 'package.json', 'src/lib/'], build: 'npm run build' },
  { output: 'dist/index.js', inputs: ['src/', 'package.json', 'tsup.config.ts', 'tsconfig.json'], build: 'npm run build:cli' },
  { output: 'dist/dashboard/index.html', inputs: ['dashboard/dist/index.html'], build: 'npm run build:cli' },
];

/** The one way to run a check of the built app on an older build on purpose, honored on both sides. */
export const OLD_BUILD_ON_PURPOSE = 'DC_VERIFY_DIST=dist/index.js';

export class HarnessError extends Error {
  constructor(stage, message) {
    super(message);
    this.stage = stage;
  }
}

/** Tracked files and untracked, not ignored ones under `paths`; null when git cannot say. */
function filesUnder(repo, paths) {
  const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...paths], { cwd: repo, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return r.stdout.split('\0').filter(Boolean);
}

const mtimeOf = (path) => { try { return statSync(path).mtimeMs; } catch { return null; } };

/**
 * Why the built app in `repo` is older than its code, or null when it is current (or cannot be
 * told: no git). Names the build that fixes it and up to three newer files.
 */
export function staleDist(repo) {
  for (const { output, inputs, build } of DIST_INPUTS) {
    const built = mtimeOf(join(repo, output));
    if (built === null) return { why: `there is no ${output}`, build };
    const folders = inputs.filter((p) => p.endsWith('/'));
    const listed = folders.length ? filesUnder(repo, folders) : [];
    if (listed === null) return null;
    const files = [...new Set([...listed, ...inputs.filter((p) => !p.endsWith('/'))])];
    const newer = files.filter((f) => (mtimeOf(join(repo, f)) ?? 0) > built);
    if (newer.length) return { why: `${output} is older than ${newer.slice(0, 3).join(', ')}${newer.length > 3 ? ` and ${newer.length - 3} more` : ''}`, build };
  }
  return null;
}

/** Print the HARNESS line and its way out; the exit code says it never reached the product. */
export function reportHarness(err, out = process.stdout) {
  const stage = err instanceof HarnessError ? err.stage : 'setup';
  const msg = err instanceof Error ? err.message : String(err);
  out.write(`HARNESS (${stage}): ${msg}\n`);
  out.write('HARNESS: the check stopped in its own setup and tested nothing of the product. Fix the setup or the script, not the product; builder heavy does not count this run.\n');
  return HARNESS_EXIT;
}
