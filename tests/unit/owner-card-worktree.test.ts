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
import { enterSessionCheckout, resetSessionCheckouts } from '../../src/lib/session-cwd.js';

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
  resetSessionCheckouts();
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
    expect(await refusal(cardWorkingRoot(contextRoot, projectRoot, SESSION, { home }))).toBe('not_governed');
  });
  it('a checkout its governed repository\'s own `git worktree list` does not name is refused (not_governed)', async () => {
    const wt = join(home, '.claude-worktrees', 'child-one');
    git(projectRoot, 'worktree', 'add', '-q', '-b', 'super/x', wt);
    registerChild(wt);
    expect(await refusal(cardWorkingRoot(contextRoot, projectRoot, SESSION, { home, listWorktrees: async () => [projectRoot] }))).toBe('not_governed');
    expect(await refusal(cardWorkingRoot(contextRoot, projectRoot, SESSION, { home, listWorktrees: async () => { throw new Error('git'); } }))).toBe('git_failed');
  });
  it('a real worktree of a LINKED repository the project governs is accepted (the Super\'s decision, 11 Nov)', async () => {
    const code = join(scratch, 'code');
    mkdirSync(code);
    writeFileSync(join(code, 'c'), 'x');
    execFileSync('git', ['init', '-q', code]);
    git(code, 'add', '.');
    git(code, 'commit', '-qm', 'i');
    const url = 'https://github.com/acme/code.git';
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    writeFileSync(join(contextRoot, 'state', '.config.json'), JSON.stringify({ linkedRepos: [{ name: 'code', gitRemoteUrl: url }] }));
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'linked-repos.json'), JSON.stringify({ repos: { [url]: code } }));
    const wt = join(home, '.claude-worktrees', 'code-child');
    git(code, 'worktree', 'add', '-q', '-b', 'super/c', wt);
    registerChild(wt);
    let asked = '';
    expect(await cardWorkingRoot(contextRoot, projectRoot, SESSION, { home, listWorktrees: async (repo) => { asked = repo; return [realpathSync(code), realpathSync(wt)]; } })).toBe(realpathSync(wt));
    // Proven by THAT repository's own worktree list, never the project's.
    expect(asked).toBe(realpathSync(code));
    expect(await cardWorkingRoot(contextRoot, projectRoot, SESSION, { home })).toBe(realpathSync(wt));
  });
  it('a project and a home under a symlinked path: a child with no worktree runs in the project root, a worktree child in its worktree', async () => {
    const via = join(realpathSync(mkdtempSync(join(tmpdir(), 'owner-card-wt-link-'))), 'via');
    symlinkSync(scratch, via);
    try {
      const lHome = join(via, 'home');
      const lProject = join(via, 'project');
      const lContext = join(lProject, '_dream_context');
      expect(await cardWorkingRoot(lContext, lProject, PLAIN, { home: lHome })).toBe(realpathSync(projectRoot));
      const wt = join(lHome, '.claude-worktrees', 'child-sym');
      git(projectRoot, 'worktree', 'add', '-q', '-b', 'super/s', join(home, '.claude-worktrees', 'child-sym'));
      registerChild(wt);
      expect(await cardWorkingRoot(lContext, lProject, SESSION, { home: lHome })).toBe(realpathSync(wt));
    } finally {
      rmSync(join(via, '..'), { recursive: true, force: true });
    }
  });
  it('a session whose own checkout is the project root by REAL path (a realpath\'d transcript cwd) is the project root', async () => {
    const via = join(realpathSync(mkdtempSync(join(tmpdir(), 'owner-card-wt-link-'))), 'via');
    symlinkSync(scratch, via);
    try {
      const lProject = join(via, 'project');
      const S = '77777777-2222-4333-8444-555555555555';
      // The session "moved" into the project itself, spelled by its real path.
      expect(enterSessionCheckout(S, realpathSync(projectRoot), lProject, { home, claim: true })).toBe(true);
      expect(await cardWorkingRoot(join(lProject, '_dream_context'), lProject, S, { home })).toBe(realpathSync(projectRoot));
    } finally {
      rmSync(join(via, '..'), { recursive: true, force: true });
    }
  });
  // The folder is proven by the GOVERNED REPOSITORY, not by where it lives on disk (end review r1).
  // Real git, no injected worktree list.
  function linkCode(): string {
    const code = join(scratch, 'code');
    mkdirSync(code);
    writeFileSync(join(code, 'c'), 'x');
    execFileSync('git', ['init', '-q', code]);
    git(code, 'add', '.');
    git(code, 'commit', '-qm', 'i');
    const url = 'https://github.com/acme/code.git';
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    writeFileSync(join(contextRoot, 'state', '.config.json'), JSON.stringify({ linkedRepos: [{ name: 'code', gitRemoteUrl: url }] }));
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'linked-repos.json'), JSON.stringify({ repos: { [url]: code } }));
    return code;
  }
  it('an ordinary session working in a linked repo\'s MAIN checkout: that checkout', async () => {
    const code = linkCode();
    const S = '88888888-2222-4333-8444-555555555555';
    expect(enterSessionCheckout(S, code, projectRoot, { home, claim: true })).toBe(true);
    expect(await cardWorkingRoot(contextRoot, projectRoot, S, { home })).toBe(realpathSync(code));
  });
  it('an ordinary session in a real worktree under `<project>/.claude/worktrees/x`: that worktree', async () => {
    const wt = join(projectRoot, '.claude', 'worktrees', 'x');
    git(projectRoot, 'worktree', 'add', '-q', '-b', 'super/cw', wt);
    const S = '88888888-3333-4333-8444-555555555555';
    expect(enterSessionCheckout(S, wt, projectRoot, { home, claim: true })).toBe(true);
    expect(await cardWorkingRoot(contextRoot, projectRoot, S, { home })).toBe(realpathSync(wt));
  });
  it('a claimed SUBFOLDER of a governed checkout stands for that checkout\'s root (git toplevel)', async () => {
    // A Super record cannot name it (the store keeps only `~/.claude-worktrees/<name>`); a
    // session's claimed checkout can (a checkout directive "<repo>/packages/app").
    const wt = join(home, '.claude-worktrees', 'child-sub');
    git(projectRoot, 'worktree', 'add', '-q', '-b', 'super/sub', wt);
    mkdirSync(join(wt, 'packages', 'app'), { recursive: true });
    const S = '88888888-4444-4333-8444-555555555555';
    expect(enterSessionCheckout(S, join(wt, 'packages', 'app'), projectRoot, { home, claim: true })).toBe(true);
    expect(await cardWorkingRoot(contextRoot, projectRoot, S, { home })).toBe(realpathSync(wt));
    const inProject = join(projectRoot, 'sub');
    mkdirSync(inProject);
    const S2 = '88888888-5555-4333-8444-555555555555';
    expect(enterSessionCheckout(S2, inProject, projectRoot, { home, claim: true })).toBe(true);
    expect(await cardWorkingRoot(contextRoot, projectRoot, S2, { home })).toBe(realpathSync(projectRoot));
  });
  it('a project inside a larger repository: a chat in <project>/src is the project, never the enclosing repository', async () => {
    const mono = join(scratch, 'mono');
    const proj = join(mono, 'apps', 'x');
    mkdirSync(join(proj, '_dream_context'), { recursive: true });
    mkdirSync(join(proj, 'src'));
    writeFileSync(join(proj, 'src', 'a.ts'), 'x');
    execFileSync('git', ['init', '-q', mono]);
    git(mono, 'add', '.');
    git(mono, 'commit', '-qm', 'i');
    const S = '88888888-9999-4333-8444-555555555555';
    expect(enterSessionCheckout(S, join(proj, 'src'), proj, { home, claim: true })).toBe(true);
    expect(await cardWorkingRoot(join(proj, '_dream_context'), proj, S, { home })).toBe(realpathSync(proj));
  });
  it('a subfolder of an UNGOVERNED repository recorded as a worktree is refused (its toplevel is not governed)', async () => {
    const foreign = join(scratch, 'foreign3');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'f'), 'x');
    execFileSync('git', ['init', '-q', foreign]);
    git(foreign, 'add', '.');
    git(foreign, 'commit', '-qm', 'i');
    const fwt = join(home, '.claude-worktrees', 'foreign-sub');
    git(foreign, 'worktree', 'add', '-q', '-b', 'super/fs', fwt);
    registerChild(fwt);
    expect(await refusal(cardWorkingRoot(contextRoot, projectRoot, SESSION, { home }))).toBe('not_governed');
  });
  it('an ungoverned repository\'s worktree outside the worktree home is never the card\'s folder', async () => {
    const foreign = join(scratch, 'foreign2');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'f'), 'x');
    execFileSync('git', ['init', '-q', foreign]);
    git(foreign, 'add', '.');
    git(foreign, 'commit', '-qm', 'i');
    const fwt = join(scratch, 'foreign2-wt');
    git(foreign, 'worktree', 'add', '-q', '-b', 'super/g', fwt);
    // Neither way in can name it: the store drops a recorded worktree outside the worktree home,
    // and a session cannot claim a checkout of a repository the project does not govern. So the
    // card stays in the project root (as at the base), never in that folder.
    registerChild(fwt);
    const S = '88888888-6666-4333-8444-555555555555';
    expect(enterSessionCheckout(S, fwt, projectRoot, { home, claim: true })).toBe(false);
    expect(await cardWorkingRoot(contextRoot, projectRoot, SESSION, { home })).toBe(realpathSync(projectRoot));
    expect(await cardWorkingRoot(contextRoot, projectRoot, S, { home })).toBe(realpathSync(projectRoot));
    // Named directly as a candidate it is refused (the governed-repository proof, not the store).
    const S3 = '88888888-7777-4333-8444-555555555555';
    const fsub = join(fwt, 'x');
    mkdirSync(fsub);
    expect(enterSessionCheckout(S3, fsub, projectRoot, { home, claim: true })).toBe(false);
  });
  it('a recorded worktree that is gone is refused', async () => {
    registerChild(join(home, '.claude-worktrees', 'gone'));
    expect(await refusal(cardWorkingRoot(contextRoot, projectRoot, SESSION, { home }))).toBe('missing');
  });
});
