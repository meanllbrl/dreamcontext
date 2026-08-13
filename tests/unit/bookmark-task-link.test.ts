import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import {
  rankOpenTasks,
  readActiveTaskSlug,
  resolveBookmarkId,
  shortDate,
  unlinkedBookmarkHint,
} from '../../src/lib/bookmark-task-link.js';
import { registerBookmarkCommand } from '../../src/cli/commands/bookmark.js';
import { readSleepState } from '../../src/cli/commands/sleep.js';

function makeTmpProject(): string {
  const dir = join(tmpdir(), `bm-link-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, '_dream_context', 'state'), { recursive: true });
  return realpathSync(dir);
}

function contextRoot(projectRoot: string): string {
  return join(projectRoot, '_dream_context');
}

function writeTask(
  projectRoot: string,
  slug: string,
  fields: { status?: string; updated_at?: string; name?: string } = {},
): void {
  const fm = [
    '---',
    `name: ${fields.name ?? slug}`,
    `status: ${fields.status ?? 'in_progress'}`,
    'priority: medium',
    `created_at: ${fields.updated_at ?? '2026-08-01'}`,
    `updated_at: ${fields.updated_at ?? '2026-08-01'}`,
    '---',
    '',
    '## Why',
    '',
    'Because.',
    '',
  ].join('\n');
  writeFileSync(join(contextRoot(projectRoot), 'state', `${slug}.md`), fm);
}

async function runBookmark(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerBookmarkCommand(program);
  await program.parseAsync(['bookmark', ...args], { from: 'user' });
}

describe('bookmark-task-link — pure helpers', () => {
  it('ranks in_progress first, then most recently updated', () => {
    const ranked = rankOpenTasks([
      { name: 'old-todo', status: 'todo', updated_at: '2026-08-09' },
      { name: 'stale-progress', status: 'in_progress', updated_at: '2026-07-01' },
      { name: 'fresh-todo', status: 'todo', updated_at: '2026-08-10' },
      { name: 'fresh-progress', status: 'in_progress', updated_at: '2026-08-11' },
    ]);
    expect(ranked.map((t) => t.name)).toEqual(['fresh-progress', 'stale-progress', 'fresh-todo']);
  });

  it('drops completed tasks and honors the limit', () => {
    const ranked = rankOpenTasks(
      [
        { name: 'done', status: 'completed', updated_at: '2026-08-11' },
        { name: 'a', status: 'todo', updated_at: '2026-08-10' },
        { name: 'b', status: 'todo', updated_at: '2026-08-09' },
      ],
      1,
    );
    expect(ranked.map((t) => t.name)).toEqual(['a']);
  });

  it('renders a YAML-parsed Date as one short day, and still sorts by it', () => {
    // Exactly what gray-matter/js-yaml hands back for an unquoted
    // `updated_at: 2026-08-11` — a Date anchored at UTC midnight.
    const jsDate = String(new Date('2026-08-11T00:00:00.000Z'));
    expect(shortDate(jsDate)).toBe('2026-08-11');
    expect(shortDate("2026-08-09")).toBe('2026-08-09');
    expect(shortDate('-')).toBe('-');

    const ranked = rankOpenTasks([
      { name: 'older', status: 'todo', updated_at: '2026-08-09' },
      { name: 'newer', status: 'todo', updated_at: jsDate },
    ]);
    expect(ranked.map((t) => t.name)).toEqual(['newer', 'older']);

    const text = unlinkedBookmarkHint({
      bookmarkId: 'bm_x',
      candidates: ranked,
      openCount: 2,
    }).join('\n');
    expect(text).toContain('2026-08-11');
    expect(text).not.toContain('GMT');
  });

  it('says nothing when there is no open task to point at', () => {
    expect(unlinkedBookmarkHint({ bookmarkId: 'bm_x', candidates: [], openCount: 0 })).toEqual([]);
  });

  it('names the candidates, the overflow count, and the repair command', () => {
    const lines = unlinkedBookmarkHint({
      bookmarkId: 'bm_abc123',
      candidates: [{ name: 'fix-auth', status: 'in_progress', updated_at: '2026-08-11' }],
      openCount: 4,
    });
    const text = lines.join('\n');
    expect(text).toContain('4 open tasks');
    expect(text).toContain('fix-auth');
    expect(text).toContain('… 3 more');
    expect(text).toContain('bookmark relink bm_abc123 --task <slug>');
  });

  it('resolves a bookmark id by exact match or unique prefix, and flags ambiguity', () => {
    const ids = ['bm_abc123', 'bm_abc999', 'bm_zzz'];
    expect(resolveBookmarkId(ids, 'bm_zzz')).toEqual({ kind: 'match', id: 'bm_zzz' });
    expect(resolveBookmarkId(ids, 'bm_abc1')).toEqual({ kind: 'match', id: 'bm_abc123' });
    expect(resolveBookmarkId(ids, 'bm_abc')).toEqual({
      kind: 'ambiguous',
      candidates: ['bm_abc123', 'bm_abc999'],
    });
    expect(resolveBookmarkId(ids, 'nope')).toEqual({ kind: 'none' });
  });
});

describe('readActiveTaskSlug', () => {
  let projectRoot: string;

  beforeEach(() => { projectRoot = makeTmpProject(); });
  afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); });

  it('returns null when the override file is absent', () => {
    expect(readActiveTaskSlug(contextRoot(projectRoot))).toBeNull();
  });

  it('returns the slug when the override names an existing task', () => {
    writeTask(projectRoot, 'fix-auth');
    writeFileSync(join(contextRoot(projectRoot), 'state', '.active-task'), 'fix-auth\n');
    expect(readActiveTaskSlug(contextRoot(projectRoot))).toBe('fix-auth');
  });

  it('returns null for a stale override whose task file is gone', () => {
    writeFileSync(join(contextRoot(projectRoot), 'state', '.active-task'), 'deleted-task');
    expect(readActiveTaskSlug(contextRoot(projectRoot))).toBeNull();
  });

  it('rejects a traversal payload instead of resolving it', () => {
    writeFileSync(join(contextRoot(projectRoot), 'state', '.active-task'), '../../etc/passwd');
    expect(readActiveTaskSlug(contextRoot(projectRoot))).toBeNull();
  });
});

describe('bookmark add — task link', () => {
  let projectRoot: string;
  let origCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectRoot = makeTmpProject();
    origCwd = process.cwd();
    process.chdir(projectRoot);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    delete process.env.DREAMCONTEXT_BOOKMARK_HINT;
  });

  afterEach(() => {
    process.chdir(origCwd);
    logSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const stdout = (): string => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
  const stderr = (): string => errSpy.mock.calls.map((c) => String(c[0])).join('\n');
  const bookmarks = () => readSleepState(contextRoot(projectRoot)).bookmarks;

  it('warns on stderr, naming the open tasks, when --task is omitted', async () => {
    writeTask(projectRoot, 'fix-auth', { status: 'in_progress', updated_at: '2026-08-11' });
    writeTask(projectRoot, 'ship-tabs', { status: 'todo', updated_at: '2026-08-10' });

    await runBookmark(['add', 'bir karar', '-s', '2']);

    // The bookmark still lands — the advisory never blocks.
    expect(bookmarks()).toHaveLength(1);
    expect(bookmarks()[0].task_slug).toBeNull();

    expect(stderr()).toContain('no task link');
    expect(stderr()).toContain('fix-auth');
    expect(stderr()).toContain('ship-tabs');
    expect(stderr()).toContain(`bookmark relink ${bookmarks()[0].id} --task <slug>`);
    // Advisory belongs on stderr; stdout stays the plain success line.
    expect(stdout()).not.toContain('relink');
  });

  it('stays silent when there is no open task to link to', async () => {
    writeTask(projectRoot, 'done-work', { status: 'completed' });

    await runBookmark(['add', 'bir karar']);

    expect(bookmarks()).toHaveLength(1);
    expect(stderr()).toBe('');
  });

  it('is silenced by DREAMCONTEXT_BOOKMARK_HINT=0', async () => {
    writeTask(projectRoot, 'fix-auth');
    process.env.DREAMCONTEXT_BOOKMARK_HINT = '0';

    await runBookmark(['add', 'bir karar']);

    expect(stderr()).toBe('');
    delete process.env.DREAMCONTEXT_BOOKMARK_HINT;
  });

  it('links implicitly via .active-task and says so', async () => {
    writeTask(projectRoot, 'fix-auth');
    writeTask(projectRoot, 'ship-tabs', { status: 'todo' });
    writeFileSync(join(contextRoot(projectRoot), 'state', '.active-task'), 'fix-auth');

    await runBookmark(['add', 'bir karar']);

    expect(bookmarks()[0].task_slug).toBe('fix-auth');
    expect(stdout()).toContain('via .active-task');
    expect(stderr()).toBe('');
  });

  it('prefers an explicit --task over .active-task', async () => {
    writeTask(projectRoot, 'fix-auth');
    writeTask(projectRoot, 'ship-tabs', { status: 'todo' });
    writeFileSync(join(contextRoot(projectRoot), 'state', '.active-task'), 'fix-auth');

    await runBookmark(['add', 'bir karar', '--task', 'ship-tabs']);

    expect(bookmarks()[0].task_slug).toBe('ship-tabs');
    expect(stdout()).not.toContain('via .active-task');
  });

  it('keeps an unknown --task value but warns with the real task slugs', async () => {
    writeTask(projectRoot, 'fix-auth');

    await runBookmark(['add', 'bir karar', '--task', 'typo-slug']);

    expect(bookmarks()[0].task_slug).toBe('typo-slug');
    expect(stderr()).toContain('matches no task');
    expect(stderr()).toContain('fix-auth');
  });

  it('resolves a --task name/prefix to the real slug, like every other task verb', async () => {
    writeTask(projectRoot, 'fix-auth-bug');

    await runBookmark(['add', 'bir karar', '--task', 'Fix auth bug']);

    expect(bookmarks()[0].task_slug).toBe('fix-auth-bug');
  });

  it('leaves the explicit happy path untouched — no warning, no extra output', async () => {
    writeTask(projectRoot, 'fix-auth');

    await runBookmark(['add', 'bir karar', '-s', '3', '--task', 'fix-auth']);

    expect(bookmarks()[0]).toMatchObject({ task_slug: 'fix-auth', salience: 3 });
    expect(stderr()).toBe('');
    expect(stdout()).toContain('(task: fix-auth)');
  });
});

describe('bookmark relink', () => {
  let projectRoot: string;
  let origCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectRoot = makeTmpProject();
    origCwd = process.cwd();
    process.chdir(projectRoot);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.DREAMCONTEXT_BOOKMARK_HINT = '0';
  });

  afterEach(() => {
    process.chdir(origCwd);
    logSpy.mockRestore();
    errSpy.mockRestore();
    delete process.env.DREAMCONTEXT_BOOKMARK_HINT;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const bookmarks = () => readSleepState(contextRoot(projectRoot)).bookmarks;

  it('repairs an unaddressed bookmark in place, keeping its message and id', async () => {
    writeTask(projectRoot, 'fix-auth');
    await runBookmark(['add', 'bir karar']);
    const before = bookmarks()[0];
    expect(before.task_slug).toBeNull();

    await runBookmark(['relink', before.id, '--task', 'fix-auth']);

    const after = bookmarks()[0];
    expect(after).toMatchObject({ id: before.id, message: 'bir karar', task_slug: 'fix-auth' });
    expect(bookmarks()).toHaveLength(1);
  });

  it('accepts a unique id prefix', async () => {
    writeTask(projectRoot, 'fix-auth');
    await runBookmark(['add', 'bir karar']);
    const id = bookmarks()[0].id;

    await runBookmark(['relink', id.slice(0, 7), '--task', 'fix-auth']);

    expect(bookmarks()[0].task_slug).toBe('fix-auth');
  });

  it('refuses an unknown task instead of writing another dead link', async () => {
    writeTask(projectRoot, 'fix-auth');
    await runBookmark(['add', 'bir karar']);
    const id = bookmarks()[0].id;

    await runBookmark(['relink', id, '--task', 'no-such-task']);

    expect(bookmarks()[0].task_slug).toBeNull();
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('Task not found');
  });

  it('refuses an unknown bookmark id', async () => {
    writeTask(projectRoot, 'fix-auth');

    await runBookmark(['relink', 'bm_nope', '--task', 'fix-auth']);

    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('No bookmark with id');
  });

  it('re-points a bookmark that was linked to the wrong task', async () => {
    writeTask(projectRoot, 'fix-auth');
    writeTask(projectRoot, 'ship-tabs', { status: 'todo' });
    await runBookmark(['add', 'bir karar', '--task', 'fix-auth']);
    const id = bookmarks()[0].id;

    await runBookmark(['relink', id, '--task', 'ship-tabs']);

    expect(bookmarks()[0].task_slug).toBe('ship-tabs');
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('fix-auth → ship-tabs');
  });
});
