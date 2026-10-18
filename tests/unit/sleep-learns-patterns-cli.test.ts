/**
 * C7 in the sleep round itself (plan r3 § W3 test 13): `sleep start` reads this
 * sleep's sessions into the owner-corrections ledger and reports the recurring
 * groups (a count in `--json`, the fenced block for sleep-product), and
 * `sleep done` lists what was learned this sleep.
 *
 * Migrations, the task backend and the digest GC are stubbed so the round runs
 * against a scratch vault in-process (the same seams sleep-done-hygiene uses).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';

vi.mock('../../src/lib/migration-runner.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/migration-runner.js')>('../../src/lib/migration-runner.js');
  return { ...actual, runMigrations: vi.fn(() => ({ applied: [], pendingAgentTasks: [] })) };
});
vi.mock('../../src/lib/session-digest.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/session-digest.js')>('../../src/lib/session-digest.js');
  return { ...actual, scanDigests: vi.fn(() => []), runDigestGc: vi.fn(() => 0) };
});
vi.mock('../../src/lib/task-backend/index.js', () => ({
  getTaskBackend: vi.fn(() => ({
    name: 'local',
    get: vi.fn(async () => null),
    create: vi.fn(async () => ({})),
    updateFields: vi.fn(async () => ({})),
    addChangelog: vi.fn(async () => undefined),
    sync: vi.fn(async () => ({
      pushed: 0, created: 0, pulled: 0, failedPushes: [], conflicts: [],
      errors: [], warnings: [], watermark: null, reconciled: 0, noop: true,
    })),
  })),
}));

const { registerSleepCommand } = await import('../../src/cli/commands/sleep.js');
const { learnRule, openGroups } = await import('../../src/lib/learned-patterns.js');
const { readCorrections } = await import('../../src/lib/owner-corrections.js');

const FIX = join(__dirname, '..', 'fixtures', 'owner-corrections');
let projectRoot: string;
let ctx: string;
let prevCwd: string;
let logSpy: ReturnType<typeof vi.spyOn>;

async function sleep(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerSleepCommand(program);
  await program.parseAsync(['sleep', ...args], { from: 'user' });
}

function logged(): string[] {
  return logSpy.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  const raw = join(tmpdir(), `dc-learn-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  ctx = join(projectRoot, '_dream_context');
  mkdirSync(join(ctx, 'state'), { recursive: true });
  mkdirSync(join(ctx, 'knowledge', 'patterns'), { recursive: true });
  const stopped = '2026-10-15T00:00:00.000Z';
  writeFileSync(join(ctx, 'state', '.sleep.json'), JSON.stringify({
    debt: 4,
    sessions: ['s1', 's2', 's3'].map((n) => ({
      session_id: `${n}-larkspur`, transcript_path: join(FIX, `${n}.jsonl`), stopped_at: stopped,
      last_assistant_message: null, change_count: 0, tool_count: 0, score: 1, task_slugs: [],
    })),
    bookmarks: [],
  }, null, 2));
  prevCwd = process.cwd();
  process.chdir(projectRoot);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  process.chdir(prevCwd);
  logSpy.mockRestore();
  process.exitCode = undefined;
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('the sleep round carries the recurring owner corrections', () => {
  it('sleep start --json reads this sleep\'s sessions and reports the group count and the fenced block', async () => {
    await sleep('start', '--json');
    const out = JSON.parse(logged().filter((l) => l.trim().startsWith('{')).pop()!) as {
      recurringCorrections: number; recurringCorrectionsBrief: string; epoch: string;
    };
    expect(out.recurringCorrections).toBe(1);
    expect(out.recurringCorrectionsBrief).toMatch(/^--- RECURRING OWNER CORRECTIONS [0-9a-f]{8} ---/);
    expect(out.recurringCorrectionsBrief).toMatch(/--- END OF RECURRING OWNER CORRECTIONS [0-9a-f]{8} ---/);
    expect(readCorrections(ctx).map((i) => i.session).sort()).toEqual(['s1-larkspur', 's2-larkspur']);
    expect(readFileSync(join(ctx, '.gitignore'), 'utf-8')).toContain('state/.owner-corrections.json');
  });

  it('sleep done lists what was learned this sleep', async () => {
    await sleep('start', '--json');
    const g = openGroups(ctx)[0];
    learnRule(ctx, { pattern: 'named-exports', title: 'Named exports only', rule: 'Always use named exports, never default exports.', cites: g.ids });
    logSpy.mockClear();
    await sleep('done', 'Consolidated', 'the', 'round');
    const text = logged().join('\n');
    expect(text).toContain('Learned this sleep (1)');
    expect(text).toContain('Named exports only');
    expect(text).toContain('named-exports');
  });

  it('a failing ignore skips the ledger write with a warning and the sleep still starts', async () => {
    mkdirSync(join(ctx, '.gitignore'));
    await sleep('start');
    const text = logged().join('\n');
    expect(text).toContain('Owner corrections: not recorded this sleep');
    expect(text).toContain('Consolidation epoch set');
    expect(readCorrections(ctx)).toEqual([]);
  });
});
