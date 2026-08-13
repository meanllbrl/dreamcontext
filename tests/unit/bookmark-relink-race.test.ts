import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';

/**
 * `bookmark relink` resolves its task through the backend — a NETWORK round-trip
 * on the ClickUp / GitHub backends — and `.sleep.json` has no lock while several
 * processes append to it (the Stop hook, a parallel session's `bookmark add`,
 * `sleep done`). If the command read that file BEFORE the round-trip and wrote
 * the snapshot back afterwards, every bookmark that landed in the gap would be
 * silently erased by a command whose entire job is repairing a lost link.
 *
 * The backend is mocked so the gap is deterministic: `get()` writes a competing
 * bookmark from "another process" and only then resolves. Anything the relink
 * drops here, it would drop in production.
 */
vi.mock('../../src/lib/task-backend/index.js', () => ({
  getTaskBackend: vi.fn(),
}));

import { getTaskBackend } from '../../src/lib/task-backend/index.js';
import { registerBookmarkCommand } from '../../src/cli/commands/bookmark.js';
import { readSleepState, writeSleepState } from '../../src/cli/commands/sleep.js';

function makeTmpProject(): string {
  const dir = join(tmpdir(), `bm-race-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, '_dream_context', 'state'), { recursive: true });
  return realpathSync(dir);
}

async function runBookmark(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerBookmarkCommand(program);
  await program.parseAsync(['bookmark', ...args], { from: 'user' });
}

describe('bookmark relink — concurrent .sleep.json writers', () => {
  let projectRoot: string;
  let contextRoot: string;
  let origCwd: string;

  beforeEach(() => {
    projectRoot = makeTmpProject();
    contextRoot = join(projectRoot, '_dream_context');
    origCwd = process.cwd();
    process.chdir(projectRoot);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.DREAMCONTEXT_BOOKMARK_HINT = '0';

    writeFileSync(
      join(contextRoot, 'state', '.sleep.json'),
      JSON.stringify({
        debt: 0,
        sessions: [],
        bookmarks: [
          {
            id: 'bm_target',
            message: 'the unaddressed one',
            salience: 2,
            created_at: '2026-08-11T10:00:00.000Z',
            session_id: null,
            task_slug: null,
          },
        ],
        triggers: [],
        knowledge_access: {},
        dashboard_changes: [],
        compaction_log: [],
      }),
    );
  });

  afterEach(() => {
    process.chdir(origCwd);
    vi.restoreAllMocks();
    delete process.env.DREAMCONTEXT_BOOKMARK_HINT;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /** Simulates another process appending a bookmark, as the Stop hook does. */
  function otherProcessAddsBookmark(): void {
    const state = readSleepState(contextRoot);
    state.bookmarks.unshift({
      id: 'bm_concurrent',
      message: 'written by another session mid-relink',
      salience: 3,
      created_at: '2026-08-11T10:00:05.000Z',
      session_id: 'sess-other',
      task_slug: 'fix-auth',
    });
    writeSleepState(contextRoot, state);
  }

  it('does not clobber a bookmark written while the task lookup was in flight', async () => {
    vi.mocked(getTaskBackend).mockReturnValue({
      // The slow, networked half of the command — the concurrent write lands here.
      get: vi.fn(async (slug: string) => {
        otherProcessAddsBookmark();
        return slug === 'fix-auth' ? { slug: 'fix-auth' } : null;
      }),
      resolveSlug: vi.fn(async () => ({ kind: 'none' })),
    } as never);

    await runBookmark(['relink', 'bm_target', '--task', 'fix-auth']);

    const after = readSleepState(contextRoot).bookmarks;
    // The repair happened…
    expect(after.find((b) => b.id === 'bm_target')?.task_slug).toBe('fix-auth');
    // …and the ★★★ bookmark from the other session is still there.
    expect(after.find((b) => b.id === 'bm_concurrent')).toBeDefined();
    expect(after).toHaveLength(2);
  });

  it('reports the truth instead of a false success when the bookmark was consolidated away', async () => {
    vi.mocked(getTaskBackend).mockReturnValue({
      get: vi.fn(async () => {
        // `sleep done` clears pre-epoch bookmarks while the lookup is in flight.
        const state = readSleepState(contextRoot);
        state.bookmarks = [];
        writeSleepState(contextRoot, state);
        return { slug: 'fix-auth' };
      }),
      resolveSlug: vi.fn(async () => ({ kind: 'none' })),
    } as never);

    await runBookmark(['relink', 'bm_target', '--task', 'fix-auth']);

    const errText = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join('\n');
    expect(errText).toContain('is gone');
    const logText = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join('\n');
    expect(logText).not.toContain('Relinked');
    // Nothing resurrected: the cleared file stays cleared.
    expect(readSleepState(contextRoot).bookmarks).toHaveLength(0);
  });

  it('rejects an empty --task instead of prefix-matching the whole vault', async () => {
    const backend = {
      get: vi.fn(async () => null),
      resolveSlug: vi.fn(async () => ({ kind: 'ambiguous', candidates: ['a', 'b'] })),
    };
    vi.mocked(getTaskBackend).mockReturnValue(backend as never);

    await runBookmark(['relink', 'bm_target', '--task', '   ']);

    expect(backend.get).not.toHaveBeenCalled();
    expect(backend.resolveSlug).not.toHaveBeenCalled();
    expect(readSleepState(contextRoot).bookmarks[0].task_slug).toBeNull();
  });

  it('caps a runaway "did you mean" list instead of printing the whole vault', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `task-${i}`);
    vi.mocked(getTaskBackend).mockReturnValue({
      get: vi.fn(async () => null),
      resolveSlug: vi.fn(async () => ({ kind: 'ambiguous', candidates: many })),
    } as never);

    await runBookmark(['relink', 'bm_target', '--task', 't']);

    const errText = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join('\n');
    expect(errText).toContain('+32 more');
    expect(errText).not.toContain('task-39');
  });
});
