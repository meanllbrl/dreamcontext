import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

// Real pure planner (session-digest.js) is spied-not-replaced so the AC9a
// protected-set UNION this task owns (finalState survivors ∪ pre-consolidation
// pending sessions) is observable via the mock's call arguments, while the
// planner's own boundary behavior stays covered by session-digest-gc.test.ts
// (T6's file, not this one).
vi.mock('../../src/lib/session-digest.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/session-digest.js')>(
    '../../src/lib/session-digest.js',
  );
  return {
    ...actual,
    scanDigests: vi.fn(() => []),
    planDigestGc: vi.fn(actual.planDigestGc),
    runDigestGc: vi.fn(() => 0),
  };
});

// The task backend is mocked so AC6 (escalation priority bump + curator task
// create/refresh) is deterministic and doesn't require materializing real
// task markdown files — each test installs its own fake via mockReturnValue.
vi.mock('../../src/lib/task-backend/index.js', () => ({
  getTaskBackend: vi.fn(),
}));

import { getTaskBackend } from '../../src/lib/task-backend/index.js';
import { planDigestGc } from '../../src/lib/session-digest.js';
import { registerSleepCommand } from '../../src/cli/commands/sleep.js';
import { readSleepFlags } from '../../src/lib/sleep-flags.js';
import { readSleepHistory } from '../../src/cli/commands/sleep.js';

interface FakeBackend {
  name: string;
  get: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  updateFields: ReturnType<typeof vi.fn>;
  addChangelog: ReturnType<typeof vi.fn>;
  sync: ReturnType<typeof vi.fn>;
}

function makeFakeBackend(overrides: Partial<FakeBackend> = {}): FakeBackend {
  return {
    name: 'local',
    get: vi.fn(async () => null),
    create: vi.fn(async () => ({})),
    updateFields: vi.fn(async () => ({})),
    addChangelog: vi.fn(async () => undefined),
    sync: vi.fn(async () => ({
      pushed: 0, created: 0, pulled: 0, failedPushes: [], conflicts: [],
      errors: [], warnings: [], watermark: null, reconciled: 0, noop: true,
    })),
    ...overrides,
  };
}

function makeTmpProject(): string {
  const dir = join(tmpdir(), `sleep-done-hygiene-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, '_dream_context', 'state'), { recursive: true });
  return realpathSync(dir);
}

function sleepJsonPath(projectRoot: string): string {
  return join(projectRoot, '_dream_context', 'state', '.sleep.json');
}

function sleepFlagsJsonPath(projectRoot: string): string {
  return join(projectRoot, '_dream_context', 'state', '.sleep-flags.json');
}

function writeSleepJson(projectRoot: string, state: Record<string, unknown>): void {
  writeFileSync(sleepJsonPath(projectRoot), JSON.stringify(state, null, 2));
}

async function runSleepDone(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerSleepCommand(program);
  await program.parseAsync(['sleep', 'done', ...args], { from: 'user' });
}

describe('sleep done — hygiene (AC5/AC6/AC7/AC9a wiring)', () => {
  let projectRoot: string;
  let origCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectRoot = makeTmpProject();
    origCwd = process.cwd();
    process.chdir(projectRoot);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(getTaskBackend).mockReset();
    vi.mocked(planDigestGc).mockClear();
  });

  afterEach(() => {
    process.chdir(origCwd);
    logSpy.mockRestore();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function loggedText(): string {
    return logSpy.mock.calls.map((c) => String(c[0])).join('\n');
  }

  it('does not swallow the summary when --flag precedes it (variadic-option regression fix)', async () => {
    writeSleepJson(projectRoot, { debt: 0, sessions: [], bookmarks: [] });
    vi.mocked(getTaskBackend).mockReturnValue(makeFakeBackend() as never);

    await runSleepDone(['--flag', 'first-time::Seen once', 'Consolidated', 'the', 'things']);

    const history = readSleepHistory(join(projectRoot, '_dream_context'));
    expect(history[0].summary).toBe('Consolidated the things');

    const flags = readSleepFlags(join(projectRoot, '_dream_context'));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ key: 'first-time', label: 'Seen once', consecutive_cycles: 1 });
  });

  it('escalates at the 3rd consecutive cycle: prints an ask and bumps the linked task priority', async () => {
    const t0 = '2026-07-01T00:00:00.000Z';
    writeFileSync(
      sleepFlagsJsonPath(projectRoot),
      JSON.stringify([
        { key: 'chronic', label: 'Chronic issue', task_slug: 'demo-task', first_seen: t0, last_seen: t0, consecutive_cycles: 2 },
      ]),
    );
    writeSleepJson(projectRoot, { debt: 0, sessions: [], bookmarks: [] });

    const backend = makeFakeBackend({
      get: vi.fn(async (slug: string) => (slug === 'demo-task' ? { slug: 'demo-task', priority: 'medium', status: 'todo' } : null)),
    });
    vi.mocked(getTaskBackend).mockReturnValue(backend as never);

    await runSleepDone(['--flag', 'chronic::Chronic issue::demo-task', 'Consolidated', 'work']);

    expect(loggedText()).toContain('has recurred 3 consecutive cycles');
    expect(loggedText()).toContain('demo-task');
    expect(backend.updateFields).toHaveBeenCalledWith('demo-task', { priority: 'high' });

    const flags = readSleepFlags(join(projectRoot, '_dream_context'));
    expect(flags.find((f) => f.key === 'chronic')?.consecutive_cycles).toBe(3);
  });

  it('digest GC protected set is the UNION of post-consolidation survivors and pre-consolidation pending sessions', async () => {
    const epoch = '2026-07-10T12:00:00.000Z';
    writeSleepJson(projectRoot, {
      debt: 5,
      sleep_started_at: epoch,
      sessions: [
        // Pending (score === null), stopped_at null → DROPPED by applyConsolidation
        // (stopped_at===null sessions are always dropped) — the union's pending
        // half is the ONLY thing that can still protect its digest.
        { session_id: 's-pending', transcript_path: null, stopped_at: null, last_assistant_message: null, change_count: null, tool_count: null, score: null, task_slugs: [] },
        // Post-epoch survivor — kept by applyConsolidation, so it's protected via
        // the finalState half of the union.
        { session_id: 's-survivor', transcript_path: null, stopped_at: '2026-07-10T12:00:01.000Z', last_assistant_message: null, change_count: 1, tool_count: 1, score: 3, task_slugs: [] },
        // Pre-epoch, already-scored — consolidated away and NOT pending: must be
        // ABSENT from the protected set.
        { session_id: 's-consolidated', transcript_path: null, stopped_at: '2026-07-10T11:59:59.000Z', last_assistant_message: null, change_count: 1, tool_count: 1, score: 2, task_slugs: [] },
      ],
      bookmarks: [],
    });
    vi.mocked(getTaskBackend).mockReturnValue(makeFakeBackend() as never);

    await runSleepDone(['Consolidated', 'a', 'cycle']);

    expect(planDigestGc).toHaveBeenCalledTimes(1);
    const protectedIds = planDigestGc.mock.calls[0][1] as Set<string>;
    expect(protectedIds.has('s-pending')).toBe(true);
    expect(protectedIds.has('s-survivor')).toBe(true);
    expect(protectedIds.has('s-consolidated')).toBe(false);
  });

  it('prints the dedup digest line only when there are decisions since the epoch', async () => {
    const epoch = '2026-07-10T00:00:00.000Z';
    writeSleepJson(projectRoot, { debt: 0, sleep_started_at: epoch, sessions: [], bookmarks: [] });
    mkdirSync(join(projectRoot, '_dream_context', '.embeddings'), { recursive: true });
    writeFileSync(
      join(projectRoot, '_dream_context', '.embeddings', 'dedup-log.jsonl'),
      [
        // Before the epoch — must NOT be counted (strict > epoch).
        JSON.stringify({ ts: '2026-07-09T00:00:00.000Z', title: 'old', verdict: 'create' }),
        JSON.stringify({ ts: '2026-07-10T01:00:00.000Z', title: 'a', verdict: 'merge' }),
        JSON.stringify({ ts: '2026-07-10T02:00:00.000Z', title: 'b', verdict: 'create' }),
      ].join('\n') + '\n',
    );
    vi.mocked(getTaskBackend).mockReturnValue(makeFakeBackend() as never);

    await runSleepDone(['Consolidated', 'with', 'dedup', 'activity']);

    expect(loggedText()).toContain('Semantic dedup since epoch: 1 merge / 0 review / 1 create (2 decisions).');
  });

  it('does not print a dedup digest line when the log has nothing since the epoch', async () => {
    writeSleepJson(projectRoot, { debt: 0, sessions: [], bookmarks: [] });
    vi.mocked(getTaskBackend).mockReturnValue(makeFakeBackend() as never);

    await runSleepDone(['Quiet', 'cycle']);

    expect(loggedText()).not.toContain('Semantic dedup since epoch');
  });

  it('prints a loud brain-dirty warning with a ready-to-run command and NEVER auto-commits', async () => {
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
    writeSleepJson(projectRoot, { debt: 0, sessions: [], bookmarks: [] });
    vi.mocked(getTaskBackend).mockReturnValue(makeFakeBackend() as never);

    const beforeStatus = execFileSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf-8' });
    expect(beforeStatus.trim().length).toBeGreaterThan(0); // untracked _dream_context/ files exist

    await runSleepDone(['Consolidated', 'without', 'brain', 'sync']);

    const text = loggedText();
    expect(text).toContain('uncommitted file(s) under _dream_context/');
    expect(text).toContain('git add -A -- _dream_context && git commit -m "chore(brain): consolidate');

    // The exact same files are still dirty — nothing was committed on our behalf.
    const afterStatus = execFileSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf-8' });
    expect(afterStatus).toBe(beforeStatus);
  });

  it('task-backend failures in the escalation/curator blocks are caught — sleep done still completes', async () => {
    const t0 = '2026-07-01T00:00:00.000Z';
    writeFileSync(
      sleepFlagsJsonPath(projectRoot),
      JSON.stringify([
        { key: 'chronic', label: 'Chronic issue', task_slug: 'demo-task', first_seen: t0, last_seen: t0, consecutive_cycles: 2 },
      ]),
    );
    writeSleepJson(projectRoot, { debt: 0, sessions: [], bookmarks: [] });

    const boom = () => { throw new Error('boom'); };
    const backend = makeFakeBackend({ get: vi.fn(boom), create: vi.fn(boom), updateFields: vi.fn(boom) });
    vi.mocked(getTaskBackend).mockReturnValue(backend as never);

    await expect(
      runSleepDone(['--flag', 'chronic::Chronic issue::demo-task', 'Consolidated', 'despite', 'backend', 'errors']),
    ).resolves.toBeUndefined();

    expect(loggedText()).toContain('could not bump priority for demo-task');
    expect(loggedText()).toContain('Curator trigger: skipped');

    const history = readSleepHistory(join(projectRoot, '_dream_context'));
    expect(history[0].summary).toBe('Consolidated despite backend errors');
  });

  it('curator trigger is a no-op below the orphan-tag threshold (empty corpus)', async () => {
    writeSleepJson(projectRoot, { debt: 0, sessions: [], bookmarks: [] });
    const backend = makeFakeBackend();
    vi.mocked(getTaskBackend).mockReturnValue(backend as never);

    await runSleepDone(['Consolidated', 'a', 'clean', 'corpus']);

    expect(backend.create).not.toHaveBeenCalled();
    expect(loggedText()).not.toContain('Curator task created');
  });
});
