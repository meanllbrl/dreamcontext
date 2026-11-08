import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __resetProjectCatchUp,
  acquireProjectUpdatesLock,
  defaultCatchUpCli,
  devOrCachedCli,
  diskBusyReason,
  gitOperationInProgress,
  OPEN_TOOL_MAX_MS,
  projectUpdatesLockPath,
  readProjectUpdatesRecord,
  releaseProjectUpdatesLock,
  runProjectCatchUp,
  SESSION_QUIET_MS,
  type CatchUpDeps,
} from '../../src/lib/project-catch-up.js';
import { readSetupConfig, updateSetupConfig } from '../../src/lib/setup-config.js';
import { catchUpDisabledReason, startProjectCatchUpJob } from '../../src/server/project-catch-up-job.js';

let home: string;
const CLI = { entry: '/fake/cli.js', version: '0.40.0' };

function project(name: string, setupVersion: string | null, platform = true): { name: string; path: string } {
  const path = join(home, name);
  mkdirSync(join(path, '_dream_context', 'state'), { recursive: true });
  if (platform) {
    mkdirSync(join(path, '.claude', 'skills', 'dreamcontext'), { recursive: true });
    writeFileSync(join(path, '.claude', 'skills', 'dreamcontext', 'SKILL.md'), 'x');
  }
  if (setupVersion) updateSetupConfig(path, { setupVersion });
  return { name, path };
}

/** The real update's contract: it stamps the project, or it fails and leaves it behind. */
const stamps = vi.fn(async (path: string) => { updateSetupConfig(path, { setupVersion: CLI.version }); });

const deps = (vaults: { name: string; path: string }[], extra: CatchUpDeps = {}): CatchUpDeps => ({
  home,
  cli: () => CLI,
  vaults: () => vaults,
  busy: () => null,
  runUpdate: stamps,
  ...extra,
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'catch-up-'));
  __resetProjectCatchUp();
  stamps.mockClear();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('runProjectCatchUp', () => {
  it('updates every behind project and leaves a current one alone', async () => {
    const old = project('old', '0.39.0');
    const missed = project('missed-two-versions', '0.20.0');
    const current = project('current', '0.40.0');
    const newer = project('newer', '0.41.0');
    const r = await runProjectCatchUp(deps([old, missed, current, newer]));
    expect(r.updated).toEqual(['old', 'missed-two-versions']);
    expect(stamps.mock.calls.map((c) => c[0])).toEqual([old.path, missed.path]);
    expect(readSetupConfig(newer.path)?.setupVersion).toBe('0.41.0');
    expect(readProjectUpdatesRecord(home)?.issues).toEqual({});
  });

  it('does no work and takes no lock when everything is current', async () => {
    const r = await runProjectCatchUp(deps([project('a', '0.40.0')]));
    expect(r).toMatchObject({ ran: false, message: 'Nothing to update.' });
    expect(stamps).not.toHaveBeenCalled();
    expect(readProjectUpdatesRecord(home)).toBeNull();
  });

  it('refreshes the Codex and Antigravity kits for every project, current or not', async () => {
    const refreshKits = vi.fn();
    const a = project('a', '0.40.0');
    const b = project('b', '0.39.0');
    await runProjectCatchUp(deps([a, b], { refreshKits }));
    expect(refreshKits).toHaveBeenCalledWith('0.40.0', [{ path: a.path, version: '0.40.0' }, { path: b.path, version: '0.39.0' }]);
    __resetProjectCatchUp();
    refreshKits.mockImplementation(() => { throw new Error('kit broke'); });
    const r = await runProjectCatchUp(deps([a], { refreshKits }));
    expect(r.message).toBe('Nothing to update.');
  });

  it('keeps going past a failure, records it, retries only at the next process start', async () => {
    const bad = project('bad', '0.39.0');
    const good = project('good', '0.39.0');
    const runUpdate = vi.fn(async (path: string) => {
      if (path === bad.path) throw new Error('boom');
      updateSetupConfig(path, { setupVersion: CLI.version });
    });
    const r = await runProjectCatchUp(deps([bad, good], { runUpdate }));
    expect(r.failed).toEqual(['bad']);
    expect(r.updated).toEqual(['good']);
    expect(readProjectUpdatesRecord(home)?.issues[bad.path]).toMatchObject({ state: 'failed', reason: 'boom', target: '0.40.0' });

    // Same process, next tick: nothing is retried and the error is still on record.
    runUpdate.mockClear();
    await runProjectCatchUp(deps([bad, good], { runUpdate }));
    expect(runUpdate).not.toHaveBeenCalled();
    expect(readProjectUpdatesRecord(home)?.issues[bad.path]?.state).toBe('failed');

    // Next start: tried again, and a success ends the record.
    __resetProjectCatchUp();
    await runProjectCatchUp(deps([bad, good]));
    expect(stamps).toHaveBeenCalledTimes(1);
    expect(readProjectUpdatesRecord(home)?.issues).toEqual({});
  });

  it('calls a zero-exit run that left the project behind a failure', async () => {
    const pinned = project('pinned', '0.39.0');
    const r = await runProjectCatchUp(deps([pinned], { runUpdate: async () => {} }));
    expect(r.failed).toEqual(['pinned']);
    expect(readProjectUpdatesRecord(home)?.issues[pinned.path]?.reason).toContain('migration');
  });

  it('never reports a folder that is gone, and drops its old record', async () => {
    const gone = project('gone', '0.39.0');
    const fine = project('fine', '0.39.0');
    await runProjectCatchUp(deps([gone, fine], { runUpdate: async (p) => { if (p === gone.path) throw new Error('x'); updateSetupConfig(p, { setupVersion: CLI.version }); } }));
    expect(readProjectUpdatesRecord(home)?.issues[gone.path]).toBeDefined();
    rmSync(gone.path, { recursive: true });
    const r = await runProjectCatchUp(deps([gone, fine]));
    expect(r.failed).toEqual([]);
    expect(stamps).not.toHaveBeenCalled();
    expect(readProjectUpdatesRecord(home)?.issues).toEqual({});
  });

  it('skips a project with no platform without spawning, and says so', async () => {
    const bare = project('bare', '0.39.0', false);
    const r = await runProjectCatchUp(deps([bare]));
    expect(r.skipped).toEqual(['bare']);
    expect(stamps).not.toHaveBeenCalled();
    expect(readProjectUpdatesRecord(home)?.issues[bare.path]?.state).toBe('skipped');
  });

  it('waits for a busy project, then does it on the next check', async () => {
    const a = project('a', '0.39.0');
    const b = project('b', '0.39.0');
    const first = await runProjectCatchUp(deps([a, b], { busy: (_p, name) => (name === 'a' ? 'an agent session is working' : null) }));
    expect(first).toMatchObject({ deferred: ['a'], updated: ['b'] });
    expect(readProjectUpdatesRecord(home)?.issues[a.path]?.state).toBe('deferred');
    const second = await runProjectCatchUp(deps([a, b]));
    expect(second.updated).toEqual(['a']);
    expect(readProjectUpdatesRecord(home)?.issues).toEqual({});
  });

  it('stands back while another process holds the lock', async () => {
    const a = project('a', '0.39.0');
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(projectUpdatesLockPath(home), JSON.stringify({ pid: process.pid, at: Date.now() }));
    const r = await runProjectCatchUp(deps([a]));
    expect(r).toMatchObject({ ran: false, message: 'Another run is updating projects.' });
    expect(stamps).not.toHaveBeenCalled();
  });

  it('reclaims a lock left by a dead process and releases its own', async () => {
    const a = project('a', '0.39.0');
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(projectUpdatesLockPath(home), JSON.stringify({ pid: 999_999_9, at: Date.now() }));
    const r = await runProjectCatchUp(deps([a]));
    expect(r.updated).toEqual(['a']);
    expect(existsSync(projectUpdatesLockPath(home))).toBe(false);
  });

  it('joins a run already in flight instead of starting a second', async () => {
    const a = project('a', '0.39.0');
    const d = deps([a]);
    const [x, y] = await Promise.all([runProjectCatchUp(d), runProjectCatchUp(d)]);
    expect(x).toBe(y);
    expect(stamps).toHaveBeenCalledTimes(1);
  });

  it('stops between projects when an upgrade starts mid-run', async () => {
    let calls = 0;
    const r = await runProjectCatchUp(deps([project('a', '0.39.0'), project('b', '0.39.0')], { blocked: () => calls++ > 1 }));
    expect(r.updated).toEqual(['a']);
  });

  it('stands back while an upgrade is changing the CLI', async () => {
    const r = await runProjectCatchUp(deps([project('a', '0.39.0')], { blocked: () => true }));
    expect(r.ran).toBe(false);
    expect(stamps).not.toHaveBeenCalled();
  });

  it('never runs on an unreadable version', async () => {
    const r = await runProjectCatchUp(deps([project('a', '0.39.0')], { cli: () => ({ entry: 'x', version: '0.0.0' }) }));
    expect(r.ran).toBe(false);
    expect(stamps).not.toHaveBeenCalled();
  });
});

describe('the lock', () => {
  it('is exclusive until released', () => {
    expect(acquireProjectUpdatesLock(home)).toBe(true);
    expect(acquireProjectUpdatesLock(home)).toBe(false);
    releaseProjectUpdatesLock(home);
    expect(acquireProjectUpdatesLock(home)).toBe(true);
    releaseProjectUpdatesLock(home);
  });
});

describe('what makes a project wait', () => {
  it('a half-done merge or rebase, not a dirty tree', () => {
    const { path } = project('repo', '0.39.0');
    mkdirSync(join(path, '.git'));
    expect(gitOperationInProgress(path)).toBe(false);
    writeFileSync(join(path, '.git', 'MERGE_HEAD'), 'abc');
    expect(gitOperationInProgress(path)).toBe(true);
    expect(diskBusyReason(path, Date.now(), home)).toBe('a git operation is in progress');
  });

  it('a live sleep lock, not one left stale by a crash', () => {
    const { path } = project('sleepy', '0.39.0');
    const state = join(path, '_dream_context', 'state', '.sleep.json');
    writeFileSync(state, JSON.stringify({ sleep_started_at: new Date().toISOString() }));
    expect(diskBusyReason(path, Date.now(), home)).toBe('a sleep is running');
    writeFileSync(state, JSON.stringify({ sleep_started_at: new Date(Date.now() - 3 * 864e5).toISOString() }));
    expect(diskBusyReason(path, Date.now(), home)).toBeNull();
  });

  it('follows a worktree gitdir file', () => {
    const { path } = project('wt', '0.39.0');
    const gitDir = join(home, 'real-git');
    mkdirSync(join(gitDir, 'rebase-merge'), { recursive: true });
    writeFileSync(join(path, '.git'), `gitdir: ${gitDir}\n`);
    expect(gitOperationInProgress(path)).toBe(true);
  });

  it('a transcript written just now, not one quiet for longer than the window', () => {
    const { path } = project('live', '0.39.0');
    const dir = join(home, '.claude', 'projects', path.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '11111111-1111-4111-8111-111111111111.jsonl'), `{"cwd":${JSON.stringify(path)}}\n`);
    const now = Date.now();
    expect(diskBusyReason(path, now, home)).toBe('an agent session is working');
    expect(diskBusyReason(path, now + SESSION_QUIET_MS + 1000, home)).toBeNull();
  });
});

describe('a turn with a long tool call', () => {
  const frames = (...f: unknown[]) => f.map((x) => JSON.stringify(x)).join('\n') + '\n';
  const use = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1' }] } };
  const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } };

  function session(body: string): string {
    const { path } = project('long', '0.39.0');
    const dir = join(home, '.claude', 'projects', path.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '22222222-2222-4222-8222-222222222222.jsonl'), `{"cwd":${JSON.stringify(path)}}\n${body}`);
    return path;
  }

  it('is busy past the quiet window while its tool is open, up to the bound', () => {
    const path = session(frames(use));
    const now = Date.now();
    expect(diskBusyReason(path, now + SESSION_QUIET_MS + 1000, home)).toBe('an agent session is working');
    expect(diskBusyReason(path, now + OPEN_TOOL_MAX_MS + 1000, home)).toBeNull();
  });

  it('is free once the tool answered', () => {
    const path = session(frames(use, result));
    expect(diskBusyReason(path, Date.now() + SESSION_QUIET_MS + 1000, home)).toBeNull();
  });
});

describe('defaultCatchUpCli', () => {
  const pkg = (name: string, version: string): string => {
    const dir = join(home, name);
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dreamcontext', version }));
    writeFileSync(join(dir, 'dist', 'index.js'), '');
    return join(dir, 'dist', 'index.js');
  };

  it('reads the disk, so a new global under a running process counts', () => {
    const running = pkg('bundle', '0.36.0');
    const global = pkg('global', '0.37.0');
    expect(defaultCatchUpCli({ DREAMCONTEXT_GLOBAL_CLI: global }, running)).toEqual({ entry: global, version: '0.37.0' });
  });

  it('turns a global re-linked to a checkout into no CLI, on the check itself', () => {
    const running = pkg('installed', '0.36.0');
    const linked = pkg('checkout', '0.99.0');
    writeFileSync(join(home, 'checkout', '.git'), 'gitdir: x');
    expect(defaultCatchUpCli({ DREAMCONTEXT_GLOBAL_CLI: linked }, running)).toBeNull();
  });

  it('never pulls projects back to an older global', () => {
    const running = pkg('bundle', '0.37.0');
    const global = pkg('global', '0.36.0');
    expect(defaultCatchUpCli({ DREAMCONTEXT_GLOBAL_CLI: global }, running)).toEqual({ entry: running, version: '0.37.0' });
  });
});

describe('the job gate', () => {
  const APP = { DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_PARENT_PID: '42' };
  const cli = (where: string, git = false): string => {
    const dir = join(home, where);
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'dist', 'index.js'), '');
    if (git) writeFileSync(join(dir, '.git'), 'gitdir: x');
    return join(dir, 'dist', 'index.js');
  };

  it('runs in the app-owned server, and an installed `dashboard`', () => {
    const installed = cli('lib/node_modules/dreamcontext');
    expect(catchUpDisabledReason(APP, 42, installed)).toBeNull();
    expect(catchUpDisabledReason({}, 1, installed)).toBeNull();
  });
  it('never for a checkout or an npx cache, however it was reached', () => {
    const installed = cli('lib/node_modules/dreamcontext');
    const checkout = cli('worktree', true);
    expect(devOrCachedCli(checkout)).toBe(true);
    expect(devOrCachedCli(cli('.npm/_npx/abc/node_modules/dreamcontext'))).toBe(true);
    expect(devOrCachedCli(cli('repo/desktop/src-tauri/target/debug'))).toBe(true);
    expect(devOrCachedCli(cli('repo/desktop/src-tauri/target/release/bundle/macos/x.app/Contents/Resources'))).toBe(true);
    expect(devOrCachedCli(cli('Applications/x.app/Contents/Resources'))).toBe(false);
    expect(catchUpDisabledReason({}, 1, checkout)).toBe('not an installed CLI');
    expect(catchUpDisabledReason({ ...APP, DREAMCONTEXT_CLI: checkout }, 42, installed)).toBe('not an installed CLI');
    expect(catchUpDisabledReason({ ...APP, DREAMCONTEXT_GLOBAL_CLI: checkout }, 42, installed)).toBe('not an installed CLI');
  });
  it('never a child that inherited the app env, a test, or the off switch', () => {
    const installed = cli('lib/node_modules/dreamcontext');
    expect(catchUpDisabledReason(APP, 7, installed)).toBe('not the app-owned server');
    expect(catchUpDisabledReason({ ...APP, VITEST: '1' }, 42, installed)).toBe('test run');
    expect(catchUpDisabledReason({ ...APP, DREAMCONTEXT_AUTO_PROJECT_UPDATE: '0' }, 42, installed)).toBe('DREAMCONTEXT_AUTO_PROJECT_UPDATE=0');
  });
  it('is off in this test process: no timer starts', () => {
    expect(startProjectCatchUpJob()).toBeUndefined();
  });
});
