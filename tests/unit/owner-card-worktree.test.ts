/**
 * K5 (sahip-karti-yerinde criterion 5, the pure part): a card runs and writes in its child's
 * working folder. `cardWorkingRoot` did not exist at 6fece93a (a run's cwd was the project root,
 * never the child's worktree). Real git repos and a real `git worktree add`, a fake HOME.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardRootRefused, cardWorkingRoot } from '../../src/server/session-worktree.js';

const SESSION = '11111111-2222-4333-8444-555555555555';
const PLAIN = '99999999-2222-4333-8444-555555555555';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdio: 'ignore' });
}

let scratch: string;
let home: string;
let projectRoot: string;
let contextRoot: string;
let realHome: string | undefined;

function registerChild(wt: string): void {
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  writeFileSync(join(contextRoot, 'state', '.super-agent.json'), JSON.stringify({
    v: 1, session: null, enabled: true,
    children: { [SESSION]: { sessionId: SESSION, brief: 'b', adopted: false, startedAt: 1, worktree: wt, branch: 'super/x' } },
  }), 'utf-8');
}

async function refusal(p: Promise<string>): Promise<string> {
  try { await p; return 'ok'; } catch (e) { return e instanceof CardRootRefused ? e.code : String(e); }
}

beforeEach(() => {
  realHome = process.env.HOME;
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'owner-card-wt-')));
  home = join(scratch, 'home');
  process.env.HOME = home;
  projectRoot = join(scratch, 'project');
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  writeFileSync(join(projectRoot, 'README.md'), 'hi\n', 'utf-8');
  execFileSync('git', ['init', '-q', projectRoot]);
  git(projectRoot, 'add', '.');
  git(projectRoot, 'commit', '-qm', 'init');
  mkdirSync(join(home, '.claude-worktrees'), { recursive: true });
});
afterEach(() => {
  process.env.HOME = realHome;
  rmSync(scratch, { recursive: true, force: true });
});

describe('cardWorkingRoot', () => {
  it('a worktree child runs in its worktree', async () => {
    const wt = join(home, '.claude-worktrees', 'child-one');
    git(projectRoot, 'worktree', 'add', '-q', '-b', 'super/x', wt);
    registerChild(wt);
    expect(await cardWorkingRoot(contextRoot, projectRoot, SESSION, { home })).toBe(realpathSync(wt));
  });
  it('a child with no worktree uses the project root', async () => {
    expect(await cardWorkingRoot(contextRoot, projectRoot, PLAIN, { home })).toBe(realpathSync(projectRoot));
  });
  it('a symlinked worktree is refused, never swapped for the project root', async () => {
    const elsewhere = join(scratch, 'elsewhere');
    git(projectRoot, 'worktree', 'add', '-q', '-b', 'super/z', elsewhere);
    const link = join(home, '.claude-worktrees', 'child-link');
    symlinkSync(elsewhere, link);
    registerChild(link);
    expect(await refusal(cardWorkingRoot(contextRoot, projectRoot, SESSION, { home }))).toBe('symlink');
  });
  it('a checkout of another repository is refused', async () => {
    const foreign = join(scratch, 'foreign');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'f'), 'x');
    execFileSync('git', ['init', '-q', foreign]);
    git(foreign, 'add', '.');
    git(foreign, 'commit', '-qm', 'i');
    const fwt = join(home, '.claude-worktrees', 'foreign-child');
    git(foreign, 'worktree', 'add', '-q', '-b', 'super/f', fwt);
    registerChild(fwt);
    expect(await refusal(cardWorkingRoot(contextRoot, projectRoot, SESSION, { home }))).not.toBe('ok');
  });
  it('a governed checkout that is not one of this repository\'s worktrees (a linked repo) is refused', async () => {
    const wt = join(home, '.claude-worktrees', 'child-one');
    git(projectRoot, 'worktree', 'add', '-q', '-b', 'super/x', wt);
    registerChild(wt);
    // As if `git worktree list` of the project did not name it (another repository's checkout).
    expect(await refusal(cardWorkingRoot(contextRoot, projectRoot, SESSION, { home, listWorktrees: async () => [projectRoot] }))).toBe('not_same_repo');
    expect(await refusal(cardWorkingRoot(contextRoot, projectRoot, SESSION, { home, listWorktrees: async () => { throw new Error('git'); } }))).toBe('git_failed');
  });
  it('a recorded worktree that is gone is refused', async () => {
    registerChild(join(home, '.claude-worktrees', 'gone'));
    expect(await refusal(cardWorkingRoot(contextRoot, projectRoot, SESSION, { home }))).toBe('missing');
  });
});
