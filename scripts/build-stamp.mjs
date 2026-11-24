// The build stamp (kesim-geri-donus K6, D7): which commit a built `dist/` came from, so an
// installed CLI can say what it holds and `npm run install:cut` can check that a new install
// drops no work. Outside git (a tarball build, CI without history) `sha` is null: never a failure.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const gitOut = (cwd, args) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }).trim();
  } catch {
    return null;
  }
};

/** The stamp of the checkout at `cwd`. */
export function buildStamp(cwd = process.cwd(), now = new Date()) {
  const head = gitOut(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const sha = head && /^[0-9a-f]{40,64}$/.test(head) ? head : null;
  const branch = sha ? gitOut(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']) || null : null;
  const status = sha ? gitOut(cwd, ['status', '--porcelain']) : null;
  return { sha, branch, dirty: status === null ? sha !== null : status.length > 0, builtAt: now.toISOString() };
}

/** Write `<distDir>/build-commit.json`; `extra` (install:cut's accepted drops) joins the stamp. */
export function writeBuildStamp(distDir = 'dist', cwd = process.cwd(), extra = {}) {
  const stamp = { ...buildStamp(cwd), ...extra };
  writeFileSync(join(distDir, 'build-commit.json'), JSON.stringify(stamp, null, 2) + '\n');
  return stamp;
}
