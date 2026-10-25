/**
 * AI Team v2 C1: who moved a task's status (C1-13, AC-C1-9), the brain a task step finds from
 * its worktree (C1-7), the task worktree made once and reused (C1-6), and a dead holder's lock
 * reclaimed whatever its age (C1-4).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cliStatusAuthor, parseStatusHistory, statusChangeEntry,
} from '../../src/lib/task-history.js';
import { DEFAULT_STATUSES } from '../../src/lib/task-status.js';
import { resolveContextRoot } from '../../src/lib/context-path.js';
import { registerProject } from '../../src/lib/automations/registry.js';
import { attachChildWorktree } from '../../src/lib/super/worktrees.js';
import { reclaimDeadHolderLock } from '../../src/lib/file-lock.js';
import { LocalTaskBackend } from '../../src/lib/task-backend/local.js';
import { updateSetupConfig } from '../../src/lib/setup-config.js';
import { setLinkedRepoPath } from '../../src/lib/linked-repos.js';

const ORIGINAL_HOME = process.env.HOME;
/** The shipped set plus a declared cancelled-kind status (projects declare one in overrides/task.md). */
const WITH_CANCELLED = [...DEFAULT_STATUSES, { key: 'cancelled', label: 'Cancelled', kind: 'cancelled', order: 90 } as (typeof DEFAULT_STATUSES)[number]];
const ENV_KEYS = ['DREAMCONTEXT_CONTEXT_ROOT', 'DREAMCONTEXT_TASK_WORKTREE'] as const;
let scratch: string;
let home: string;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dc-c1-ws-')));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-c1-ws-home-')));
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = ORIGINAL_HOME;
  for (const k of ENV_KEYS) delete process.env[k];
  rmSync(scratch, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('provenance (C1-13)', () => {
  it.each([
    ['in_review', { kind: 'agent', slug: 'scout' }, 'Status → in_review (by agent:scout)'],
    ['in_progress', { kind: 'reviewer', slug: 'checker' }, 'Status → in_progress (by reviewer:checker)'],
    ['completed', { kind: 'owner' }, 'Completed (by owner)'],
    ['cancelled', { kind: 'claude' }, 'Cancelled (by claude)'],
    ['todo', { kind: 'sleep' }, 'Status → todo (by sleep)'],
  ] as const)('%s by %o', (to, who, heading) => {
    const entry = statusChangeEntry(to, who, WITH_CANCELLED, 'Why it moved.', '2026-10-25');
    expect(entry).toBe(`### 2026-10-25 - ${heading}\n- Why it moved.`);
    expect(parseStatusHistory(entry)).toEqual([{ date: '2026-10-25', to, by: heading.match(/\(by (.+)\)/)![1], reason: 'Why it moved.' }]);
  });

  it('reads older headings with no author', () => {
    expect(parseStatusHistory('### 2026-10-01 - Status → in_progress\n### 2026-10-02 - Completed\n- done')).toEqual([
      { date: '2026-10-01', to: 'in_progress', by: null, reason: null },
      { date: '2026-10-02', to: 'completed', by: null, reason: 'done' },
    ]);
  });

  it('the CLI names its caller from its environment', () => {
    expect(cliStatusAuthor({})).toEqual({ kind: 'owner' });
    expect(cliStatusAuthor({ CLAUDECODE: '1' })).toEqual({ kind: 'claude' });
    expect(cliStatusAuthor({ DREAMCONTEXT_AUTOMATION_RUN: 'x', DREAMCONTEXT_AUTOMATION_SLUG: 'scout' })).toEqual({ kind: 'agent', slug: 'scout' });
    expect(cliStatusAuthor({ DREAMCONTEXT_SLEEP_EVAL: '1', CLAUDECODE: '1' })).toEqual({ kind: 'sleep' });
  });

  it('complete() carries its author into the heading', async () => {
    const ctx = join(scratch, '_dream_context');
    mkdirSync(join(ctx, 'state'), { recursive: true });
    writeFileSync(join(ctx, 'state', 'a.md'), '---\nid: t1\nname: A\nstatus: in_review\n---\n\n## Changelog\n');
    const backend = new LocalTaskBackend(join(ctx, 'state'));
    await backend.complete('a', 'Shipped.', { by: 'owner' });
    const t = await backend.get('a');
    expect(parseStatusHistory(t!.changelog)[0]).toMatchObject({ to: 'completed', by: 'owner' });
  });
});

describe('the brain from a task worktree (C1-7, AC-C1-5)', () => {
  function brain(at: string): string {
    mkdirSync(join(at, '_dream_context', 'state'), { recursive: true });
    return join(at, '_dream_context');
  }

  it('a worktree with no brain of its own resolves to the env brain of a registered project', () => {
    const project = join(scratch, 'project');
    const live = brain(project);
    registerProject(project, home);
    const wt = join(scratch, 'wt');
    mkdirSync(join(wt, 'src'), { recursive: true });
    process.env.DREAMCONTEXT_CONTEXT_ROOT = live;
    process.env.DREAMCONTEXT_TASK_WORKTREE = wt;
    expect(resolveContextRoot(join(wt, 'src'))).toBe(live);
  });

  it('a worktree carrying the brain\'s checked-out copy still resolves to the live brain, never the copy', () => {
    const project = join(scratch, 'project');
    const live = brain(project);
    registerProject(project, home);
    const wt = join(scratch, 'wt');
    brain(wt);
    process.env.DREAMCONTEXT_CONTEXT_ROOT = live;
    process.env.DREAMCONTEXT_TASK_WORKTREE = wt;
    expect(resolveContextRoot(wt)).toBe(live);
  });

  it('a cwd outside the worktree (a test fixture vault) keeps its own brain', () => {
    const project = join(scratch, 'project');
    const live = brain(project);
    registerProject(project, home);
    const fixture = join(scratch, 'fixture');
    const fixtureBrain = brain(fixture);
    process.env.DREAMCONTEXT_CONTEXT_ROOT = live;
    process.env.DREAMCONTEXT_TASK_WORKTREE = join(scratch, 'wt');
    mkdirSync(join(scratch, 'wt'), { recursive: true });
    expect(resolveContextRoot(fixture)).toBe(fixtureBrain);
  });

  it('an env root whose project the scheduler does not know is ignored', () => {
    const live = brain(join(scratch, 'unregistered'));
    const wt = join(scratch, 'wt');
    mkdirSync(wt, { recursive: true });
    process.env.DREAMCONTEXT_CONTEXT_ROOT = live;
    process.env.DREAMCONTEXT_TASK_WORKTREE = wt;
    expect(resolveContextRoot(wt)).toBeNull();
  });

  it('a different brain found by the walk (not the worktree\'s own copy) wins over the env', () => {
    const project = join(scratch, 'project');
    const live = brain(project);
    registerProject(project, home);
    const outer = join(scratch, 'outer');
    const outerBrain = brain(outer);
    const wt = join(outer, 'wt');
    mkdirSync(wt, { recursive: true });
    process.env.DREAMCONTEXT_CONTEXT_ROOT = live;
    process.env.DREAMCONTEXT_TASK_WORKTREE = wt;
    expect(resolveContextRoot(wt)).toBe(outerBrain);
  });
});

describe('the task worktree (C1-6, AC-C1-5)', () => {
  function linkedRepo(): { project: string; repo: string } {
    const project = join(scratch, 'project');
    mkdirSync(join(project, '_dream_context'), { recursive: true });
    const repo = join(scratch, 'code');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.test', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init']);
    updateSetupConfig(project, { linkedRepos: [{ name: 'code', gitRemoteUrl: 'https://github.com/example/code.git' }] });
    setLinkedRepoPath('https://github.com/example/code.git', repo, home);
    return { project, repo };
  }

  it('made once, reused while listed, re-attached without -b when only the branch is left', async () => {
    const { project, repo } = linkedRepo();
    const first = await attachChildWorktree({ projectRoot: project, repo: 'code', slug: 'task-0a1b2c3d', home });
    expect(first).toMatchObject({ branch: 'super/task-0a1b2c3d', created: true });
    expect(first.base).toMatch(/^[0-9a-f]{40}$/);
    const again = await attachChildWorktree({ projectRoot: project, repo: 'code', slug: 'task-0a1b2c3d', home });
    expect(again).toMatchObject({ path: first.path, created: false, base: null });
    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', first.path]);
    expect(existsSync(first.path)).toBe(false);
    const back = await attachChildWorktree({ projectRoot: project, repo: 'code', slug: 'task-0a1b2c3d', home });
    expect(back).toMatchObject({ path: first.path, created: false });
    expect(execFileSync('git', ['-C', back.path, 'rev-parse', '--abbrev-ref', 'HEAD']).toString().trim()).toBe('super/task-0a1b2c3d');
  });
});

describe('reclaimDeadHolderLock (C1-4)', () => {
  it('removes a fresh lock whose holder is dead; never a live holder\'s', () => {
    const lock = join(scratch, '.x.lock');
    writeFileSync(lock, JSON.stringify({ pid: 4_999_999, at: Date.now() }));
    expect(reclaimDeadHolderLock(lock, () => { const e = new Error('x') as NodeJS.ErrnoException; e.code = 'ESRCH'; throw e; })).toBe(true);
    expect(existsSync(lock)).toBe(false);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: 0 }));
    expect(reclaimDeadHolderLock(lock)).toBe(false);
    expect(existsSync(lock)).toBe(true);
  });
});

describe('the agent\'s git config runs nothing in the host (end review, owner decision 2026-10-25)', () => {
  function poisonedRepo(): { project: string; repo: string; marker: string } {
    const project = join(scratch, 'project');
    mkdirSync(join(project, '_dream_context'), { recursive: true });
    const repo = join(scratch, 'code');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, '.gitattributes'), '*.txt filter=x\n');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.test', '-c', 'user.name=T', 'commit', '-q', '-m', 'init']);
    const marker = join(scratch, 'ran-a-filter');
    const script = join(scratch, 'filter.sh');
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\ncat\n`);
    execFileSync('chmod', ['+x', script]);
    for (const k of ['clean', 'smudge']) execFileSync('git', ['-C', repo, 'config', `filter.x.${k}`, script]);
    updateSetupConfig(project, { linkedRepos: [{ name: 'code', gitRemoteUrl: 'https://github.com/example/code.git' }] });
    setLinkedRepoPath('https://github.com/example/code.git', repo, home);
    return { project, repo, marker };
  }

  it('the review digest runs no clean filter, and still changes with the content', async () => {
    const { workspaceDigest } = await import('../../src/lib/agents/task-host.js');
    const { repo, marker } = poisonedRepo();
    const view = { raw: {} } as never;
    const meta = { workspace: 'code', doer: 'scout' } as never;
    const before = workspaceDigest(scratch, view, meta, repo);
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    const after = workspaceDigest(scratch, view, meta, repo);
    expect(after).not.toBe(before);
    expect(existsSync(marker)).toBe(false);
  });

  it('a task worktree is filled raw: no filter runs (plain, includeIf on the task branch, a name with "="), bytes, modes and links as stored', async () => {
    const { rawCheckout, rawCheckoutDone } = await import('../../src/lib/agents/raw-checkout.js');
    const { project, repo, marker } = poisonedRepo();
    // The two bypasses the overrides missed: a driver only visible on the task branch, a name -c cannot express.
    const inc = join(scratch, 'inc.cfg');
    writeFileSync(inc, `[filter "y"]\n\tsmudge = ${join(scratch, 'filter.sh')}\n`);
    execFileSync('git', ['-C', repo, 'config', 'includeIf.onbranch:super/**.path', inc]);
    execFileSync('git', ['-C', repo, 'config', 'filter.a=b.smudge', join(scratch, 'filter.sh')]);
    writeFileSync(join(repo, '.gitattributes'), '*.txt filter=x\n*.y filter=y\n*.dat filter=a=b\n');
    mkdirSync(join(repo, 'bin', 'deep'), { recursive: true });
    writeFileSync(join(repo, 'b.y'), 'why\n');
    writeFileSync(join(repo, 'c.dat'), 'dat\n');
    writeFileSync(join(repo, 'bin', 'deep', 'run.sh'), '#!/bin/sh\necho hi\n');
    execFileSync('chmod', ['+x', join(repo, 'bin', 'deep', 'run.sh')]);
    symlinkSync('bin/deep/run.sh', join(repo, 'link'));
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.test', '-c', 'user.name=T', '-c', 'filter.x.clean=cat', '-c', 'filter.y.clean=cat', '-c', 'filter.a=b.clean=cat', 'commit', '-q', '-m', 'more']);
    rmSync(marker, { force: true });

    const made = await attachChildWorktree({ projectRoot: project, repo: 'code', slug: 'task-1234abcd', home });
    expect(made.added).toBe(true);
    expect(rawCheckoutDone(made.path)).toBe(false);
    await rawCheckout(made.path);
    expect(existsSync(marker)).toBe(false);
    expect(rawCheckoutDone(made.path)).toBe(true);
    expect(readFileSync(join(made.path, 'a.txt'), 'utf-8')).toBe('one\n');
    expect(readFileSync(join(made.path, 'b.y'), 'utf-8')).toBe('why\n');
    expect(lstatSync(join(made.path, 'bin', 'deep', 'run.sh')).mode & 0o111).not.toBe(0);
    expect(readlinkSync(join(made.path, 'link'))).toBe('bin/deep/run.sh');
    // The index is the commit's: every tracked path, the same blob ids.
    const lsTree = execFileSync('git', ['-C', made.path, 'ls-tree', '-r', 'HEAD']).toString().split('\n').filter(Boolean).map((l) => l.split(/\s+/)[2]).sort();
    const lsIndex = execFileSync('git', ['-C', made.path, 'ls-files', '-s']).toString().split('\n').filter(Boolean).map((l) => l.split(/\s+/)[1]).sort();
    expect(lsIndex).toEqual(lsTree);

    // Removed, then re-attached to the branch the agent wrote: added again with no checkout, filled raw again.
    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', made.path]);
    const back = await attachChildWorktree({ projectRoot: project, repo: 'code', slug: 'task-1234abcd', home });
    expect(back).toMatchObject({ added: true, created: false });
    await rawCheckout(back.path);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(back.path, 'c.dat'), 'utf-8')).toBe('dat\n');
  });

  /** A blob:none clone whose promisor remote's uploadpack (plain, and only on the task branch) touches a marker. */
  function partialClone(): { project: string; repo: string; marker: string } {
    const project = join(scratch, 'project');
    mkdirSync(join(project, '_dream_context'), { recursive: true });
    const src = join(scratch, 'src');
    execFileSync('git', ['init', '-q', '-b', 'main', src]);
    writeFileSync(join(src, 'a.txt'), 'one\n');
    execFileSync('git', ['-C', src, 'add', '-A']);
    execFileSync('git', ['-C', src, '-c', 'user.email=t@example.test', '-c', 'user.name=T', 'commit', '-q', '-m', 'init']);
    const bare = join(scratch, 'bare.git');
    execFileSync('git', ['clone', '-q', '--bare', src, bare]);
    execFileSync('git', ['-C', bare, 'config', 'uploadpack.allowFilter', 'true']);
    const repo = join(scratch, 'code');
    execFileSync('git', ['clone', '-q', '--no-checkout', '--filter=blob:none', `file://${bare}`, repo]);
    // A transport the agent could plant, plain and only on the task branch.
    const marker = join(scratch, 'ran-a-transport');
    const pack = join(scratch, 'pack.sh');
    writeFileSync(pack, `#!/bin/sh\ntouch ${marker}\nexec git-upload-pack "$@"\n`);
    execFileSync('chmod', ['+x', pack]);
    execFileSync('git', ['-C', repo, 'config', 'remote.origin.uploadpack', pack]);
    const inc = join(scratch, 'inc.cfg');
    writeFileSync(inc, `[remote "origin"]\n\tuploadpack = ${pack}\n`);
    execFileSync('git', ['-C', repo, 'config', 'includeIf.onbranch:super/**.path', inc]);
    updateSetupConfig(project, { linkedRepos: [{ name: 'code', gitRemoteUrl: 'https://github.com/example/code.git' }] });
    setLinkedRepoPath('https://github.com/example/code.git', repo, home);
    return { project, repo, marker };
  }

  it('a partial clone fetches nothing through the config\'s transport: the fill refuses the missing object', async () => {
    const { rawCheckout, rawCheckoutDone } = await import('../../src/lib/agents/raw-checkout.js');
    const { project, marker } = partialClone();
    const made = await attachChildWorktree({ projectRoot: project, repo: 'code', slug: 'task-5a5a5a5a', home });
    expect(made.added).toBe(true);
    await expect(rawCheckout(made.path)).rejects.toThrow(/not in this clone/);
    expect(existsSync(marker)).toBe(false);
    expect(rawCheckoutDone(made.path)).toBe(false);
  });

  it('re-attaching a task branch the agent pointed at a missing object fetches nothing', async () => {
    const { project, repo, marker } = partialClone();
    const made = await attachChildWorktree({ projectRoot: project, repo: 'code', slug: 'task-8d8d8d8d', home });
    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', made.path]);
    writeFileSync(join(repo, '.git', 'refs', 'heads', 'super', 'task-8d8d8d8d'), `${'de'.repeat(20)}\n`);
    await attachChildWorktree({ projectRoot: project, repo: 'code', slug: 'task-8d8d8d8d', home }).catch(() => null);
    expect(existsSync(marker)).toBe(false);
  });

  it('a refill replaces a hard link at a tracked path, never writes through it', async () => {
    const { rawCheckout } = await import('../../src/lib/agents/raw-checkout.js');
    const { project } = poisonedRepo();
    const made = await attachChildWorktree({ projectRoot: project, repo: 'code', slug: 'task-6b6b6b6b', home });
    await rawCheckout(made.path);
    // A crash before the marker: the next step refills a worktree the agent could have shaped.
    const gitDir = execFileSync('git', ['-C', made.path, 'rev-parse', '--absolute-git-dir']).toString().trim();
    rmSync(join(gitDir, 'dreamcontext-raw-checkout'));
    const outside = join(scratch, 'outside.txt');
    writeFileSync(outside, 'keep me\n', { mode: 0o600 });
    rmSync(join(made.path, 'a.txt'));
    execFileSync('ln', [outside, join(made.path, 'a.txt')]);
    await rawCheckout(made.path);
    expect(readFileSync(outside, 'utf-8')).toBe('keep me\n');
    expect(lstatSync(outside).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(made.path, 'a.txt'), 'utf-8')).toBe('one\n');
    expect(lstatSync(join(made.path, 'a.txt')).nlink).toBe(1);
  });

  it('a large tree fills byte for byte, blobs crossing every read boundary', async () => {
    const { rawCheckout } = await import('../../src/lib/agents/raw-checkout.js');
    const project = join(scratch, 'project');
    mkdirSync(join(project, '_dream_context'), { recursive: true });
    const repo = join(scratch, 'code');
    mkdirSync(join(repo, 'many'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    const expected = new Map<string, Buffer>();
    // Odd sizes, an empty file, shared content, and one blob far larger than a pipe read.
    for (let i = 0; i < 400; i++) expected.set(`many/f${i}.bin`, Buffer.alloc((i * 7919) % 70_001, i % 251));
    expected.set('empty', Buffer.alloc(0));
    expected.set('same-a', Buffer.from('same\n'));
    expected.set('same-b', Buffer.from('same\n'));
    const big = Buffer.alloc(6 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
    expected.set('big.bin', big);
    for (const [rel, bytes] of expected) writeFileSync(join(repo, rel), bytes);
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.test', '-c', 'user.name=T', 'commit', '-q', '-m', 'big']);
    updateSetupConfig(project, { linkedRepos: [{ name: 'code', gitRemoteUrl: 'https://github.com/example/code.git' }] });
    setLinkedRepoPath('https://github.com/example/code.git', repo, home);

    const made = await attachChildWorktree({ projectRoot: project, repo: 'code', slug: 'task-7c7c7c7c', home });
    await rawCheckout(made.path);
    for (const [rel, bytes] of expected) expect(readFileSync(join(made.path, rel)).equals(bytes), rel).toBe(true);
    expect(execFileSync('git', ['-C', made.path, 'status', '--porcelain']).toString()).toBe('');
  }, 60_000);

  it('one large blob streams straight to its file, in seconds', async () => {
    const { rawCheckout } = await import('../../src/lib/agents/raw-checkout.js');
    const project = join(scratch, 'project');
    mkdirSync(join(project, '_dream_context'), { recursive: true });
    const repo = join(scratch, 'code');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    const big = Buffer.alloc(80 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4) big.writeUInt32LE((i * 2654435761) >>> 0, i);
    writeFileSync(join(repo, 'weights.bin'), big);
    writeFileSync(join(repo, 'copy.bin'), big);
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.test', '-c', 'user.name=T', 'commit', '-q', '-m', 'big']);
    updateSetupConfig(project, { linkedRepos: [{ name: 'code', gitRemoteUrl: 'https://github.com/example/code.git' }] });
    setLinkedRepoPath('https://github.com/example/code.git', repo, home);

    const made = await attachChildWorktree({ projectRoot: project, repo: 'code', slug: 'task-9e9e9e9e', home });
    const t0 = Date.now();
    await rawCheckout(made.path);
    // Re-copying the blob on every pipe chunk takes minutes at this size; streaming takes seconds.
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(readFileSync(join(made.path, 'weights.bin')).equals(big)).toBe(true);
    expect(readFileSync(join(made.path, 'copy.bin')).equals(big)).toBe(true);
  }, 120_000);
});
