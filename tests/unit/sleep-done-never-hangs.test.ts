import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

/**
 * `sleep done` recorded the debt, then never exited and printed nothing (13 Nov 2026):
 * it awaited a GitHub task sync pacing a few hundred tasks under the rate limit, an
 * agent's command timeout killed it after 30 minutes, and `| tail` had held every
 * line. Brain sync (synchronous git under multi-minute ceilings) could hold it the
 * same way. Both now run in ONE detached child, brain sync first; `sleep done` waits
 * for the brain sync's report at most until the budget, and every in-process step
 * that waits on something outside the process shares that budget.
 */

vi.mock('../../src/lib/task-backend/index.js', () => ({ getTaskBackend: vi.fn() }));
vi.mock('../../src/lib/sleep-cycle-tools.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/sleep-cycle-tools.js')>()),
  spawnPostSleepSync: vi.fn(),
}));

import { getTaskBackend } from '../../src/lib/task-backend/index.js';
import { registerSleepCommand, readSleepState } from '../../src/cli/commands/sleep.js';
import {
  BRAIN_SYNC_DONE_MARK,
  POST_SLEEP_SYNC_LOG_REL,
  readBrainSyncSection,
  readPostSleepSyncFindings,
  runBounded,
  spawnPostSleepSync,
  waitForBrainSync,
} from '../../src/lib/sleep-cycle-tools.js';

const never = <T>() => new Promise<T>(() => { /* never settles: a hung network call */ });

function fakeBackend(overrides: Record<string, unknown> = {}) {
  return {
    name: 'github',
    get: vi.fn(async () => null),
    create: vi.fn(async () => ({})),
    updateFields: vi.fn(async () => ({})),
    addChangelog: vi.fn(async () => undefined),
    sync: vi.fn(() => never()),
    ...overrides,
  };
}

async function runSleep(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerSleepCommand(program);
  await program.parseAsync(['sleep', ...args], { from: 'user' });
}

describe('sleep done never hangs after recording the debt', () => {
  let projectRoot: string;
  let ctx: string;
  let log: string;
  let origCwd: string;
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];
  const out = () => spies.slice(0, 3).flatMap((s) => s.mock.calls.map((c) => String(c[0]))).join('\n');

  beforeEach(() => {
    const raw = join(tmpdir(), `sleep-never-hangs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(raw, '_dream_context', 'state'), { recursive: true });
    projectRoot = realpathSync(raw);
    ctx = join(projectRoot, '_dream_context');
    log = join(ctx, POST_SLEEP_SYNC_LOG_REL);
    writeFileSync(join(ctx, 'state', '.sleep.json'), JSON.stringify({ debt: 65, sessions: [], bookmarks: [] }));
    origCwd = process.cwd();
    process.chdir(projectRoot);
    spies.length = 0;
    spies.push(
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    );
    vi.mocked(getTaskBackend).mockReset();
    // The fake child never finishes on its own: whatever a test writes to the log is what it "printed".
    vi.mocked(spawnPostSleepSync).mockReset().mockImplementation(() => ({ logPath: log, running: () => true }));
  });

  afterEach(() => {
    process.chdir(origCwd);
    for (const s of spies) s.mockRestore();
    delete process.env.DREAMCONTEXT_SLEEP_DONE_BUDGET_MS;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const brainSyncOn = () => writeFileSync(join(ctx, 'state', '.config.json'),
    JSON.stringify({ platforms: [], brainRepo: { mode: 'full-repo', enabled: true, autoSync: true } }));

  it('a task backend whose sync never returns no longer holds it open: the sync runs in the background child', async () => {
    const backend = fakeBackend();
    vi.mocked(getTaskBackend).mockReturnValue(backend as never);

    await runSleep(['done', 'Consolidated']); // hung here before the fix

    expect(readSleepState(ctx).debt).toBe(0);
    expect(backend.sync).not.toHaveBeenCalled();
    expect(spawnPostSleepSync).toHaveBeenCalledWith(projectRoot, ctx);
    expect(out()).toContain('Consolidation complete');
    expect(out()).toContain(`Task sync (github) runs in the background; its report: _dream_context/${POST_SLEEP_SYNC_LOG_REL}`);
    expect(out()).toMatch(/Phases \(\d+ms\):.*sync/);
  }, 10_000);

  it('no remote backend and no brain sync: nothing is started', async () => {
    vi.mocked(getTaskBackend).mockReturnValue(fakeBackend({ name: 'local' }) as never);
    await runSleep(['done', 'Consolidated']);
    expect(spawnPostSleepSync).not.toHaveBeenCalled();
  });

  it('a brain sync that finishes within the budget has its report printed here', async () => {
    brainSyncOn();
    vi.mocked(getTaskBackend).mockReturnValue(fakeBackend({ name: 'local' }) as never);
    vi.mocked(spawnPostSleepSync).mockImplementation(() => {
      mkdirSync(join(ctx, 'tmp', 'sleep'), { recursive: true });
      writeFileSync(log, `ℹ Post-sleep sync started x\n✓ Brain sync: committed 3 file(s)\n${BRAIN_SYNC_DONE_MARK}\n`);
      return { logPath: log, running: () => true };
    });

    await runSleep(['done', 'Consolidated']);

    expect(out()).toContain('✓ Brain sync: committed 3 file(s)');
    expect(out()).not.toContain('Post-sleep sync started');
    expect(out()).not.toContain('still running');
  });

  it('a brain sync past the budget is named as skipped, keeps running in the background, and sleep done returns', async () => {
    process.env.DREAMCONTEXT_SLEEP_DONE_BUDGET_MS = '300';
    brainSyncOn();
    vi.mocked(getTaskBackend).mockReturnValue(fakeBackend() as never);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      await runSleep(['done', 'Consolidated']); // a hung git fetch held it here before the fix
      expect(readSleepState(ctx).debt).toBe(0);
      expect(out()).toContain(`Brain sync: still running after the 300ms budget, so sleep done went on without it; it finishes in the background (its report: _dream_context/${POST_SLEEP_SYNC_LOG_REL}).`);
      expect(out()).toContain('runs in the background after brain sync');
      expect(out()).toContain('sleep done finished; skipped because they ran past the budget: Brain sync.');
      // The child is detached: nothing in-process is left pending, so no forced exit.
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  }, 10_000);

  it('a background run that dies before brain sync finishes says so and claims no task sync', async () => {
    brainSyncOn();
    vi.mocked(getTaskBackend).mockReturnValue(fakeBackend() as never);
    vi.mocked(spawnPostSleepSync).mockImplementation(() => ({ logPath: log, running: () => false }));

    await runSleep(['done', 'Consolidated']);

    expect(out()).toContain('Post-sleep sync: the background run stopped before brain sync finished');
    expect(out()).not.toContain('runs in the background');
    expect(out()).toMatch(/Phases \(\d+ms\):.*sync \d+ms · embeddings/); // the steps after it still ran
  });

  it('the previous background run\'s refusal stays loud at the next sleep done', async () => {
    vi.mocked(getTaskBackend).mockReturnValue(fakeBackend() as never);
    mkdirSync(join(ctx, 'tmp', 'sleep'), { recursive: true });
    writeFileSync(log, [
      'ℹ Post-sleep sync started 2026-11-13T20:11:56.000Z',
      '⚠ Brain sync: skipped — git ls-remote timed out after 120s (ETIMEDOUT)',
      BRAIN_SYNC_DONE_MARK,
      '  task sync (pull): 10/100 (10%)',
      '\u001b[33m⚠\u001b[39m Task sync stopped: GitHub no longer accepts your GitHub sign-in, so the board is stale (nothing queued yet).',
    ].join('\n'));

    await runSleep(['done', 'Consolidated']);

    expect(out()).toContain('Last background sync: Task sync stopped: GitHub no longer accepts your GitHub sign-in');
    // A brain sync that failed after the last sleep done stopped waiting is shown too.
    expect(out()).toContain('Last background sync: Brain sync: skipped — git ls-remote timed out after 120s');
    expect(out()).not.toContain('Last background sync: task sync (pull)');
  });

  it('an in-process step past the budget is named as skipped and the command exits', async () => {
    process.env.DREAMCONTEXT_SLEEP_DONE_BUDGET_MS = '300';
    // The curator trigger asks the task backend; a backend call that never answers.
    mkdirSync(join(ctx, 'knowledge'), { recursive: true });
    const tags = Array.from({ length: 60 }, (_, i) => `orphan-tag-${i}`);
    writeFileSync(join(ctx, 'knowledge', 'tagged.md'), `---\nname: Tagged\ntags: [${tags.join(', ')}]\n---\n\nBody.\n`);
    vi.mocked(getTaskBackend).mockReturnValue(fakeBackend({ name: 'local', get: vi.fn(() => never()) }) as never);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      await runSleep(['done', 'Consolidated']);
      expect(readSleepState(ctx).debt).toBe(0);
      expect(out()).toContain('Curator trigger: still running after the 300ms budget, so sleep done went on without it.');
      expect(out()).toContain('sleep done finished; skipped because they ran past the budget: Curator trigger.');
      expect(out()).toMatch(/Phases \(\d+ms\)/);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      exit.mockRestore();
    }
  }, 10_000);

  it('a fast run never calls process.exit', async () => {
    vi.mocked(getTaskBackend).mockReturnValue(fakeBackend({ name: 'local' }) as never);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      await runSleep(['done', 'Consolidated']);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });
});

describe('the bound and the background child helpers', () => {
  let dir: string;
  beforeEach(() => {
    dir = join(realpathSync(tmpdir()), `sdnh-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dir, 'tmp', 'sleep'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('runBounded: the value in time, done:false past the bound without an unhandled rejection', async () => {
    expect(await runBounded(async () => 7, 1000)).toEqual({ done: true, value: 7 });
    const late = runBounded(() => new Promise<number>((_r, reject) => setTimeout(() => reject(new Error('late')), 50)), 5);
    expect(await late).toEqual({ done: false });
    await new Promise((r) => setTimeout(r, 80)); // the abandoned rejection lands here, swallowed
    await expect(runBounded(async () => { throw new Error('boom'); }, 1000)).rejects.toThrow('boom');
  });

  it('waitForBrainSync: done on the mark, exited when the child died without it, timeout at the deadline', async () => {
    const log = join(dir, POST_SLEEP_SYNC_LOG_REL);
    expect(await waitForBrainSync(log, Date.now() + 5000, () => false, 5)).toBe('exited');
    expect(await waitForBrainSync(log, Date.now() + 40, () => true, 5)).toBe('timeout');
    writeFileSync(log, `x\n${BRAIN_SYNC_DONE_MARK}\n`);
    expect(await waitForBrainSync(log, Date.now() + 5000, () => true, 5)).toBe('done');
  });

  it('reads the brain part for printing and every warning of the report as findings, ANSI stripped', () => {
    const log = join(dir, POST_SLEEP_SYNC_LOG_REL);
    expect(readPostSleepSyncFindings(dir)).toEqual([]);
    writeFileSync(log, `ℹ Post-sleep sync started x\n⚠ Brain sync: skipped — offline\n${BRAIN_SYNC_DONE_MARK}\n\u001b[31m✗\u001b[39m Task sync INCOMPLETE: 2 task(s)\n⚠   push one: 500\nℹ Task sync: pushed 3, pulled 1.\n`);
    expect(readBrainSyncSection(log)).toEqual(['⚠ Brain sync: skipped — offline']);
    expect(readPostSleepSyncFindings(dir)).toEqual(['⚠ Brain sync: skipped — offline', '✗ Task sync INCOMPLETE: 2 task(s)', '⚠   push one: 500']);
  });

  it('spawnPostSleepSync launches `sleep sync-after` without the tab identity, writing to the log', async () => {
    const real = (await vi.importActual<typeof import('../../src/lib/sleep-cycle-tools.js')>('../../src/lib/sleep-cycle-tools.js')).spawnPostSleepSync;
    process.env.CLAUDE_CODE_SESSION_ID = 'abc';
    const launch = vi.fn(() => () => true);
    try {
      const child = real('/p', '/p/_dream_context', launch, '/cli.js');
      expect(child?.logPath).toBe(join('/p/_dream_context', POST_SLEEP_SYNC_LOG_REL));
      expect(child?.running()).toBe(true);
      const [cli, cwd, env, logPath] = launch.mock.calls[0] as unknown as [string, string, NodeJS.ProcessEnv, string];
      expect([cli, cwd, logPath]).toEqual(['/cli.js', '/p', child?.logPath]);
      expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
      expect(real('/p', '/p/_dream_context', launch, '')).toBeNull();
    } finally {
      delete process.env.CLAUDE_CODE_SESSION_ID;
    }
  });
});
