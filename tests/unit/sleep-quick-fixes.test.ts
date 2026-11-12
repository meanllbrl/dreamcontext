import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

/**
 * The overnight sleep quick fixes (audit SL-6, SL-7, SL-9, SL-10, SL-11, SL-12):
 * a completed curator task is reopened instead of colliding, automation output
 * counts as consumed only when sleep-product ran, a refused task-backend token is
 * not retried and says how stale the remote is, `sleep done` prints its phase
 * timings, and `sleep start` runs the taxonomy pass and prints the dispatch table.
 */

vi.mock('../../src/lib/task-backend/index.js', () => ({
  getTaskBackend: vi.fn(),
}));

import { getTaskBackend } from '../../src/lib/task-backend/index.js';
import { registerSleepCommand, readSleepState } from '../../src/cli/commands/sleep.js';
import { planCuratorTask, CURATOR_TASK_SLUG, ORPHAN_TAG_CURATOR_THRESHOLD } from '../../src/lib/sleep-flags.js';
import { nextOutputsBoundary, outputsBoundary } from '../../src/lib/sleep-consolidation.js';
import {
  agentModelAlias,
  createPhaseTimer,
  isSyncAuthFailure,
  isTokenRefused,
  readTaskQueueDepth,
  renderStaleRemoteLine,
  specialistDispatchTable,
  spawnEmbeddingRefresh,
} from '../../src/lib/sleep-cycle-tools.js';
import { isFixExcluded } from '../../src/cli/commands/taxonomy.js';
import { DEFAULT_STATUSES } from '../../src/lib/task-status.js';

const OVER = ORPHAN_TAG_CURATOR_THRESHOLD;

function fakeBackend(overrides: Record<string, unknown> = {}) {
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

async function runSleep(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerSleepCommand(program);
  await program.parseAsync(['sleep', ...args], { from: 'user' });
}

describe('planCuratorTask — a terminal chore', () => {
  it('a COMPLETED chore with orphans back is reopened, never re-created on its fixed slug', () => {
    const plan = planCuratorTask(OVER, { slug: CURATOR_TASK_SLUG, status: 'completed' });
    expect(plan.action).toBe('reopen');
    expect(plan.slug).toBe(CURATOR_TASK_SLUG);
  });

  it('a CANCELLED chore stays closed: the owner dropped it', () => {
    const statuses = [...DEFAULT_STATUSES, { key: 'cancelled', label: 'Cancelled', kind: 'cancelled' as const, order: 40 }];
    const plan = planCuratorTask(OVER, { slug: CURATOR_TASK_SLUG, status: 'cancelled' }, null, statuses);
    expect(plan.action).toBe('none');
    expect(plan.skippedCancelled).toBe(true);
  });

  it('below the threshold nothing happens, terminal or not', () => {
    expect(planCuratorTask(OVER - 1, { slug: CURATOR_TASK_SLUG, status: 'completed' }).action).toBe('none');
  });
});

describe('automation-output consumption boundary', () => {
  const prev = '2026-11-10T10:00:00.000Z';
  const epoch = '2026-11-11T09:00:00.000Z';
  const now = '2026-11-11T09:20:00.000Z';

  it('stays put when outputs were pending and sleep-product did not run', () => {
    expect(nextOutputsBoundary({ previous: prev, pendingCount: 2, productRan: false, epoch, nowISO: now })).toBe(prev);
  });

  it('moves to the epoch when sleep-product ran, or nothing was pending', () => {
    expect(nextOutputsBoundary({ previous: prev, pendingCount: 2, productRan: true, epoch, nowISO: now })).toBe(epoch);
    expect(nextOutputsBoundary({ previous: prev, pendingCount: 0, productRan: false, epoch, nowISO: now })).toBe(epoch);
  });

  it('reads its own field first, else the last consolidation', () => {
    expect(outputsBoundary({ last_consolidated_at: now, outputs_consumed_at: prev })).toBe(prev);
    expect(outputsBoundary({ last_consolidated_at: now })).toBe(now);
  });
});

describe('sleep-cycle-tools', () => {
  it('maps pinned model ids to the Agent tool alias', () => {
    expect(agentModelAlias('claude-sonnet-5')).toBe('sonnet');
    expect(agentModelAlias('claude-opus-5')).toBe('opus');
    expect(agentModelAlias(null)).toBeNull();
    expect(agentModelAlias('some-other-model')).toBeNull();
  });

  it('the phase timer laps each phase and sums them', () => {
    let t = 0;
    const timer = createPhaseTimer(() => t);
    t = 5; timer.lap('state');
    t = 12; timer.lap('sync');
    expect(timer.phases()).toEqual([{ name: 'state', ms: 5 }, { name: 'sync', ms: 7 }]);
    expect(timer.line()).toBe('Phases (12ms): state 5ms · sync 7ms');
  });

  it('recognises a refused credential and nothing else', () => {
    expect(isSyncAuthFailure('Authentication failed (401): Bad credentials')).toBe(true);
    expect(isSyncAuthFailure('push x: Authentication failed (403): {"message":"Bad credentials"}')).toBe(true);
    expect(isSyncAuthFailure('push x: Authentication failed (403): You have exceeded a secondary rate limit')).toBe(false);
    expect(isSyncAuthFailure('Authentication failed (403): Resource not accessible by integration')).toBe(false);
    expect(isSyncAuthFailure('Server error (502): POST /x')).toBe(false);
  });

  it('a token is refused only when the whole sync was: nothing moved, every error a refusal', () => {
    const auth = 'Authentication failed (401): Bad credentials';
    expect(isTokenRefused({ errors: [auth], pushed: 0, created: 0, pulled: 0 })).toBe(true);
    expect(isTokenRefused({ errors: [auth], pushed: 3, created: 0, pulled: 0 })).toBe(false);
    expect(isTokenRefused({ errors: [auth, 'Server error (502)'], pushed: 0, created: 0, pulled: 0 })).toBe(false);
    expect(isTokenRefused({ errors: [], pushed: 0, created: 0, pulled: 0 })).toBe(false);
  });

  it('the embedding refresh is launched detached with the forced, cache-only command', () => {
    const launch = vi.fn();
    expect(spawnEmbeddingRefresh('/p', launch, '/cli.js')).toBe(true);
    expect(launch).toHaveBeenCalledWith('/cli.js', '/p', expect.any(Object));
  });

  it('archives are never rewritten by taxonomy --fix', () => {
    expect(isFixExcluded('knowledge/archive/2.memory-2026-11.md')).toBe(true);
    expect(isFixExcluded('knowledge/recall.md')).toBe(false);
  });
});

describe('sleep done / sleep start in a scratch project', () => {
  let projectRoot: string;
  let ctx: string;
  let origCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const raw = join(tmpdir(), `sleep-quick-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(raw, '_dream_context', 'state'), { recursive: true });
    projectRoot = realpathSync(raw);
    ctx = join(projectRoot, '_dream_context');
    origCwd = process.cwd();
    process.chdir(projectRoot);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(getTaskBackend).mockReset();
  });

  afterEach(() => {
    process.chdir(origCwd);
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const out = () => [logSpy, warnSpy, errSpy].flatMap((s) => s.mock.calls.map((c) => String(c[0]))).join('\n');
  const writeState = (state: Record<string, unknown>) =>
    writeFileSync(join(ctx, 'state', '.sleep.json'), JSON.stringify(state, null, 2));

  function writeOrphans(): void {
    const kdir = join(ctx, 'knowledge');
    mkdirSync(kdir, { recursive: true });
    const tags = Array.from({ length: OVER + 10 }, (_, i) => `orphan-tag-${i}`);
    writeFileSync(join(kdir, 'tagged.md'), `---\nname: Tagged\ntags: [${tags.join(', ')}]\n---\n\nBody.\n`);
  }

  function writeOutput(slug: string, mtime: Date): void {
    const dir = join(ctx, 'automations', 'output', slug);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, '2026-11-11.md');
    writeFileSync(file, '# digest\n');
    utimesSync(file, mtime, mtime);
  }

  it('reopens a completed curator task instead of creating a colliding one', async () => {
    writeState({ debt: 0, sessions: [], bookmarks: [] });
    writeOrphans();
    const backend = fakeBackend({ get: vi.fn(async () => ({ slug: CURATOR_TASK_SLUG, status: 'completed' })) });
    vi.mocked(getTaskBackend).mockReturnValue(backend as never);

    await runSleep(['done', 'Consolidated']);

    expect(backend.create).not.toHaveBeenCalled();
    expect(backend.updateFields).toHaveBeenCalledWith(CURATOR_TASK_SLUG, { status: 'todo' });
    expect(String(backend.addChangelog.mock.calls[0][1])).toMatch(/reopened by sleep/);
    expect(out()).toContain(`Curator task reopened: ${CURATOR_TASK_SLUG}`);
    expect(out()).toMatch(/Phases \(\d+ms\): state \d+ms · flags/);
  });

  it('keeps pending automation output pending when sleep-product did not run', async () => {
    const prev = '2026-11-10T10:00:00.000Z';
    writeState({ debt: 0, sessions: [], bookmarks: [], last_consolidated_at: prev, sleep_started_at: '2026-11-11T09:00:00.000Z' });
    writeOutput('daily-digest', new Date('2026-11-10T20:00:00.000Z'));
    vi.mocked(getTaskBackend).mockReturnValue(fakeBackend() as never);

    await runSleep(['done', 'Consolidated']);

    expect(readSleepState(ctx).outputs_consumed_at).toBe(prev);
    expect(out()).toContain('1 automation output(s) were not consolidated this cycle');
  });

  it('marks it consumed up to the epoch with --product-ran', async () => {
    const epoch = '2026-11-11T09:00:00.000Z';
    writeState({ debt: 0, sessions: [], bookmarks: [], last_consolidated_at: '2026-11-10T10:00:00.000Z', sleep_started_at: epoch });
    writeOutput('daily-digest', new Date('2026-11-10T20:00:00.000Z'));
    vi.mocked(getTaskBackend).mockReturnValue(fakeBackend() as never);

    await runSleep(['done', '--product-ran', 'Consolidated']);

    expect(readSleepState(ctx).outputs_consumed_at).toBe(epoch);
    expect(out()).not.toContain('were not consolidated');
  });

  it('a refused token is not retried and names the queue depth and age', async () => {
    writeState({ debt: 0, sessions: [], bookmarks: [] });
    writeFileSync(join(ctx, 'state', '.tasks-queue.json'), JSON.stringify([
      { id: 'a', kind: 'push', slug: 'one', ts: Date.parse('2026-08-03T10:00:00Z') },
      { id: 'b', kind: 'push', slug: 'two', ts: Date.parse('2026-11-01T10:00:00Z') },
      { id: 'c', kind: 'create', slug: 'two', ts: Date.parse('2026-11-02T10:00:00Z') },
    ]));
    const sync = vi.fn(async () => ({
      pushed: 0, created: 0, pulled: 0, failedPushes: ['one'], conflicts: [],
      errors: ['Authentication failed (401): Bad credentials'], warnings: [], watermark: null, reconciled: 0, noop: false,
    }));
    vi.mocked(getTaskBackend).mockReturnValue(fakeBackend({ name: 'github', sync }) as never);

    await runSleep(['done', 'Consolidated']);

    expect(sync).toHaveBeenCalledTimes(1);
    expect(out()).toContain('Bad credentials');
    expect(out()).toContain('3 change(s) to 2 task(s) queued since 2026-08-03');
    expect(out()).not.toContain('retrying once');
    expect(readTaskQueueDepth(ctx)).toEqual({ ops: 3, tasks: 2, oldest: '2026-08-03' });
    expect(renderStaleRemoteLine({ ops: 0, tasks: 0, oldest: null })).toContain('nothing queued yet');
  });

  it('one task hitting a 403 rate limit is NOT a dead token: the retry and the full report stay', async () => {
    writeState({ debt: 0, sessions: [], bookmarks: [] });
    const sync = vi.fn(async () => ({
      pushed: 4, created: 0, pulled: 2, failedPushes: ['one'], conflicts: [],
      errors: ['push one: Authentication failed (403): You have exceeded a secondary rate limit'],
      warnings: [], watermark: null, reconciled: 0, noop: false,
    }));
    vi.mocked(getTaskBackend).mockReturnValue(fakeBackend({ name: 'github', sync }) as never);

    await runSleep(['done', 'Consolidated']);

    expect(sync).toHaveBeenCalledTimes(2);
    expect(out()).toContain('retrying once');
    expect(out()).toContain('Task sync INCOMPLETE');
    expect(out()).not.toContain('refused the token');
  });

  it('sleep start runs the taxonomy pass and prints the dispatch table', async () => {
    writeState({ debt: 0, sessions: [], bookmarks: [] });
    mkdirSync(join(ctx, 'knowledge', 'archive'), { recursive: true });
    const archived = `---\nname: Old\ntags: [Architecture]\n---\n\nFrozen.\n`;
    writeFileSync(join(ctx, 'knowledge', 'archive', 'old.md'), archived);
    writeFileSync(join(ctx, 'knowledge', 'live.md'), `---\nname: Live\ntags: [Architecture, made-up-orphan]\n---\n\nBody.\n`);
    mkdirSync(join(projectRoot, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(projectRoot, '.claude', 'agents', 'sleep-state.md'), '---\nname: sleep-state\nmodel: claude-haiku-5\neffort: low\n---\nbody\n');

    await runSleep(['start', '--json']);

    const json = JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.trim().startsWith('{')) ?? '{}');
    expect(json.taxonomy.created).toBe(true);
    expect(json.taxonomy.rewrites).toBe(1);
    expect(json.taxonomy.orphans).toEqual([{ tag: 'made-up-orphan', count: 1 }]);
    expect(readFileSync(join(ctx, 'knowledge', 'archive', 'old.md'), 'utf-8')).toBe(archived);
    expect(readFileSync(join(ctx, 'knowledge', 'live.md'), 'utf-8')).toMatch(/tags:\n?\s*-?\s*\[?architecture/);
    const state = json.dispatch.find((r: { name: string }) => r.name === 'sleep-state');
    expect(state).toMatchObject({ model: 'claude-haiku-5', alias: 'haiku', effort: 'low' });
    expect(json.dispatch.map((r: { name: string }) => r.name)).toContain('sleep-product');
  });

  it('the dispatch table falls back to the packaged agent files', () => {
    const rows = specialistDispatchTable(projectRoot);
    const tasks = rows.find((r) => r.name === 'sleep-tasks');
    expect(tasks?.alias).toBe('opus');
  });
});
