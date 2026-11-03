/**
 * The sync stage pass's fallback (review round 3, Minor): when git cannot LIST its index, the
 * Super files are still dropped from it, and a planted record is set aside first, exactly as on
 * the listed path. `indexPaths` is made to throw; every other git call is real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/lib/git-sync/git.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/git-sync/git.js')>();
  return { ...real, indexPaths: () => { throw new Error('git ls-files failed'); } };
});

const { superStagePass } = await import('../../src/lib/super/pull-guard.js');
const { readMachineIdentity } = await import('../../src/lib/machine-id.js');
const { resetBindingCache } = await import('../../src/lib/super/record-binding.js');
const { emptySuperState } = await import('../../src/lib/super/types.js');

let dir: string;
let project: string;
let root: string;
let prevHome: string | undefined;
const git = (args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
const tracked = (rel: string) => git(['ls-files', '--', rel]).trim().length > 0;
const RECORD = '_dream_context/state/.super-agent.json';

beforeEach(() => {
  resetBindingCache();
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'super-stage-fallback-')));
  prevHome = process.env.HOME;
  process.env.HOME = join(dir, 'home');
  mkdirSync(process.env.HOME, { recursive: true });
  project = join(dir, 'project');
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'dev@example.test']);
  git(['config', 'user.name', 'Dev']);
  git(['config', 'commit.gpgsign', 'false']);
});
afterEach(() => {
  process.env.HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

describe('the stage pass when git cannot list its index', () => {
  it('sets a planted record aside, then drops it from the index', () => {
    const stamp = { machine: readMachineIdentity().id, root: realpathSync(root) };
    writeFileSync(join(root, 'state', '.super-agent.json'), JSON.stringify({ ...emptySuperState(), session: 'planted-session', enabled: true, bound: stamp }));
    git(['add', '-f', '--', RECORD]);
    git(['commit', '-q', '-m', 'planted']);
    expect(superStagePass(project, root)).toEqual([]);
    expect(tracked(RECORD)).toBe(false);
    expect(existsSync(join(root, 'state', '.super-agent.json'))).toBe(false);
    expect(readdirSync(join(root, 'state')).some((f) => f.startsWith('.super-agent.json.foreign-'))).toBe(true);
  });

  it('a record that is this Mac\'s own stays on disk and still leaves the index', () => {
    git(['commit', '-q', '--allow-empty', '-m', 'base']);
    const stamp = { machine: readMachineIdentity().id, root: realpathSync(root) };
    writeFileSync(join(root, 'state', '.super-agent.json'), JSON.stringify({ ...emptySuperState(), session: 'mine', enabled: true, bound: stamp }));
    git(['add', '-f', '--', RECORD]);
    superStagePass(project, root);
    expect(tracked(RECORD)).toBe(false);
    expect(existsSync(join(root, 'state', '.super-agent.json'))).toBe(true);
  });
});
