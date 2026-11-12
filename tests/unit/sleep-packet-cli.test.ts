import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

/**
 * The sleep packet and the cycle report through the real CLI (SL-1, SL-3, SL-4, SL-8):
 * `sleep start` writes the packet and prints the checklist, specialists record flags and asks
 * themselves and `sleep done` reads them, a cycle nobody reported in keeps its streaks, and
 * `sleep done` compacts an oversized PRD with the archive written first.
 */

vi.mock('../../src/lib/task-backend/index.js', () => ({
  getTaskBackend: vi.fn(),
}));

import { getTaskBackend } from '../../src/lib/task-backend/index.js';
import { registerSleepCommand } from '../../src/cli/commands/sleep.js';

function fakeBackend(tasks: Array<Record<string, unknown>> = []) {
  return {
    name: 'local',
    list: vi.fn(async () => tasks),
    get: vi.fn(async (slug: string) => {
      const t = tasks.find((x) => String(x.file).endsWith(`/${slug}.md`));
      return t ? { slug, ...t, acceptance_criteria: t.acceptance_criteria ?? '', changelog: t.changelog ?? '' } : null;
    }),
    create: vi.fn(async () => ({})),
    updateFields: vi.fn(async () => ({})),
    addChangelog: vi.fn(async () => undefined),
    sync: vi.fn(async () => ({ pushed: 0, created: 0, pulled: 0, failedPushes: [], conflicts: [], errors: [], warnings: [] })),
  };
}

async function runSleep(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerSleepCommand(program);
  await program.parseAsync(['sleep', ...args], { from: 'user' });
}

describe('sleep packet and cycle report through the CLI', () => {
  let projectRoot: string;
  let ctx: string;
  let origCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const raw = join(tmpdir(), `sleep-packet-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(raw, '_dream_context', 'state'), { recursive: true });
    projectRoot = realpathSync(raw);
    ctx = join(projectRoot, '_dream_context');
    origCwd = process.cwd();
    process.chdir(projectRoot);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(getTaskBackend).mockReset();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.chdir(origCwd);
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(projectRoot, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  const out = () => [logSpy, warnSpy, errSpy].flatMap((s) => s.mock.calls.map((c) => String(c[0]))).join('\n');
  const writeState = (state: Record<string, unknown>) =>
    writeFileSync(join(ctx, 'state', '.sleep.json'), JSON.stringify(state, null, 2));

  it('sleep start writes packet.md + board.md and prints the checklist; the transcript\'s owner turn is in it', async () => {
    const transcript = join(projectRoot, 'sess-1.jsonl');
    writeFileSync(transcript, [
      JSON.stringify({ type: 'user', timestamp: '2026-11-11T12:00:00Z', message: { role: 'user', content: 'please make the tab title shorter' } }),
      JSON.stringify({ type: 'user', timestamp: '2026-11-11T12:01:00Z', message: { role: 'user', content: '[super events] batch=1' } }),
    ].join('\n'));
    writeState({
      debt: 30, sessions: [{ session_id: 'sess-1', transcript_path: transcript, stopped_at: '2026-11-11T13:00:00Z', last_assistant_message: 'done', change_count: 1, tool_count: 1, score: 3, task_slugs: ['a-task'] }],
      bookmarks: [], last_consolidated_at: '2026-11-10T00:00:00Z',
    });
    vi.mocked(getTaskBackend).mockReturnValue(fakeBackend([
      { name: 'a-task', description: 'A task', status: 'in_review', updated_at: '2026-11-11', file: `${ctx}/state/a-task.md`, version: '0.0.1', parent_task: null, acceptance_criteria: '- [x] it works', changelog: '### 2026-11-01 - Status → in_review' },
    ]) as never);

    await runSleep(['start', '--json']);

    const json = JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.trim().startsWith('{')) ?? '{}');
    expect(json.packet).toBe(join(ctx, 'tmp', 'sleep', 'packet.md'));
    const packet = readFileSync(join(ctx, 'tmp', 'sleep', 'packet.md'), 'utf-8');
    expect(packet).toContain('please make the tab title shorter');
    expect(packet).toContain('super events ×1');
    const board = readFileSync(join(ctx, 'tmp', 'sleep', 'board.md'), 'utf-8');
    expect(board).toContain('a-task | in_review');
    expect(board).toMatch(/Ready to close \(1\)/);
  });

  it('sleep start (human output) names the packet paths and the steps left', async () => {
    writeState({ debt: 0, sessions: [], bookmarks: [] });
    vi.mocked(getTaskBackend).mockReturnValue(fakeBackend() as never);
    await runSleep(['start']);
    expect(out()).toContain('_dream_context/tmp/sleep/packet.md');
    expect(out()).toContain('_dream_context/tmp/sleep/board.md');
    expect(out()).toContain('dreamcontext reflect');
    expect(out()).toContain('PRD compaction');
  });

  it('flags and asks recorded by the specialists reach sleep done; the report is kept as cycle.last.json', async () => {
    writeState({ debt: 10, sessions: [], bookmarks: [] });
    vi.mocked(getTaskBackend).mockReturnValue(fakeBackend() as never);

    await runSleep(['flag', 'add', 'ceiling-blocked:2.memory.md', 'memory', 'blocked', 'again', '--by', 'sleep-state']);
    await runSleep(['asks', 'set', 'criterion=2,subtask=0,task=1,unplaced=1', '--by', 'sleep-tasks']);
    await runSleep(['done', 'Consolidated']);

    const flags = JSON.parse(readFileSync(join(ctx, 'state', '.sleep-flags.json'), 'utf-8'));
    expect(flags).toEqual([expect.objectContaining({ key: 'ceiling-blocked:2.memory.md', label: 'memory blocked again', consecutive_cycles: 1 })]);
    const history = JSON.parse(readFileSync(join(ctx, 'state', '.sleep-history.json'), 'utf-8'));
    expect(history[0].summary).toContain('Owner asks: 4 → criterion 2 · subtask 0 · new task 1 · not placed 1');
    expect(existsSync(join(ctx, 'tmp', 'sleep', 'cycle.json'))).toBe(false);
    expect(existsSync(join(ctx, 'tmp', 'sleep', 'cycle.last.json'))).toBe(true);
  });

  it('a malformed asks value is refused with the format, nothing recorded', async () => {
    await runSleep(['asks', 'set', 'lots']);
    expect(process.exitCode).toBe(1);
    expect(out()).toContain('criterion=a,subtask=b,task=c,unplaced=d');
    expect(existsSync(join(ctx, 'tmp', 'sleep', 'cycle.json'))).toBe(false);
  });

  it('a cycle nobody reported in keeps the streaks as they were', async () => {
    writeState({ debt: 10, sessions: [], bookmarks: [] });
    const prev = [{ key: 'recurring-task:x', label: 'x', task_slug: null, first_seen: '2026-11-01', last_seen: '2026-11-10', consecutive_cycles: 2 }];
    writeFileSync(join(ctx, 'state', '.sleep-flags.json'), JSON.stringify(prev));
    vi.mocked(getTaskBackend).mockReturnValue(fakeBackend() as never);

    await runSleep(['done', 'Consolidated']);

    expect(JSON.parse(readFileSync(join(ctx, 'state', '.sleep-flags.json'), 'utf-8'))).toEqual(prev);
    expect(out()).toContain('No specialist reported flags this cycle: 1 flag(s) kept');
  });

  it('`flag none` makes a quiet cycle count, so an unobserved flag ends its streak', async () => {
    writeState({ debt: 10, sessions: [], bookmarks: [] });
    writeFileSync(join(ctx, 'state', '.sleep-flags.json'), JSON.stringify([{ key: 'k', label: 'k', task_slug: null, first_seen: 'a', last_seen: 'b', consecutive_cycles: 2 }]));
    vi.mocked(getTaskBackend).mockReturnValue(fakeBackend() as never);

    await runSleep(['flag', 'none', '--by', 'sleep-state']);
    await runSleep(['done', 'Consolidated']);

    expect(JSON.parse(readFileSync(join(ctx, 'state', '.sleep-flags.json'), 'utf-8'))).toEqual([]);
  });

  it('sleep done compacts a PRD over the size limit: archive first, then the PRD', async () => {
    writeState({ debt: 10, sessions: [], bookmarks: [] });
    vi.mocked(getTaskBackend).mockReturnValue(fakeBackend() as never);
    const fdir = join(ctx, 'knowledge', 'features');
    mkdirSync(fdir, { recursive: true });
    const entries = Array.from({ length: 12 }, (_, i) => {
      const d = `2025-0${(i % 9) + 1}-1${i % 10}`;
      return `### ${d} - Entry ${i}\n${'- detail line that makes this entry long enough to matter\n'.repeat(40)}\n`;
    }).join('');
    writeFileSync(join(fdir, 'big.md'), `---\nname: big\ntype: feature\n---\n\n## Why\nx\n\n## Changelog\n\n${entries}`);

    await runSleep(['done', 'Consolidated']);

    const after = readFileSync(join(fdir, 'big.md'), 'utf-8');
    expect((after.match(/^### /gm) ?? []).length).toBe(5);
    expect(out()).toMatch(/PRD compacted: big moved 7 changelog entries/);
    expect(existsSync(join(ctx, 'knowledge', 'archive', 'features'))).toBe(true);
  });
});
