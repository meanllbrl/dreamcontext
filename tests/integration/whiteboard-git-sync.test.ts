import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateSetupConfig } from '../../src/lib/setup-config.js';
import { runBrainSync } from '../../src/lib/git-sync/sync-engine.js';
import { resolveConflicts, type MergeResult } from '../../src/lib/git-sync/semantic-merge.js';
import { createWhiteboard, mutateWhiteboard, readWhiteboard } from '../../src/lib/whiteboards/store.js';
import { bumpVersion } from '../../src/lib/whiteboards/ops.js';
import type { WhiteboardElement } from '../../src/lib/whiteboards/widgets.js';

/**
 * Whiteboard D13 end-to-end over real git, `full-repo` sync, two clones of one project and a
 * local bare origin (no network). Proves the nested `whiteboards/.gitattributes`
 * (`* merge=binary`) turns two different edits of one board into a REAL conflict — not a clean
 * line splice — that reaches the whiteboard-md element-merge handler, and covers add/add and
 * delete/modify.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function identity(cwd: string): void {
  git(cwd, ['config', 'user.email', 'e2e@dreamcontext.local']);
  git(cwd, ['config', 'user.name', 'E2E Test']);
}

function rect(id: string, index: string, x = 0): WhiteboardElement {
  return {
    id, type: 'rectangle', x, y: 0, width: 50, height: 50, angle: 0, version: 1, versionNonce: 1, index,
    isDeleted: false, groupIds: [], frameId: null, boundElements: null, updated: 1, link: null, locked: false,
  };
}

interface Spy { calls: { conflicts: string[]; result: MergeResult }[] }

function spyingResolve(spy: Spy): typeof resolveConflicts {
  return (cwd, conflicts, opts) => {
    const result = resolveConflicts(cwd, conflicts, opts);
    spy.calls.push({ conflicts, result });
    return result;
  };
}

const sync = (projectRoot: string, spy?: Spy) =>
  runBrainSync({ cwd: join(projectRoot, '_dream_context'), mode: 'auto' }, spy ? { resolveConflicts: spyingResolve(spy) } : {});

describe('e2e: whiteboard git sync (full-repo, two clones)', { timeout: 120_000 }, () => {
  const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const dirs: string[] = [];
  let a: string;
  let b: string;

  beforeAll(async () => {
    process.env.GITHUB_TOKEN = 'e2e-dummy-token';
    const bare = mkdtempSync(join(tmpdir(), 'dc-wb-sync-bare-'));
    execFileSync('git', ['init', '--bare', bare]);
    a = mkdtempSync(join(tmpdir(), 'dc-wb-sync-a-'));
    dirs.push(bare, a);
    git(a, ['init']);
    identity(a);
    git(a, ['checkout', '-b', 'main']);
    git(a, ['remote', 'add', 'origin', bare]);
    mkdirSync(join(a, '_dream_context', 'state'), { recursive: true });
    writeFileSync(join(a, 'README.md'), '# project\n');
    updateSetupConfig(a, { brainRepo: { mode: 'full-repo', enabled: true, autoSync: true } });

    // A shared board with three elements, far apart in the file — so git's line merge WOULD
    // splice an edit of the first and an edit of the last cleanly, without the attributes.
    const ctx = join(a, '_dream_context');
    const { slug } = createWhiteboard(ctx, 'Plan');
    await mutateWhiteboard(ctx, slug, (bd) => { bd.elements.push(rect('e1', 'a0'), rect('e2', 'a1'), rect('e3', 'a2')); });
    expect((await sync(a)).action).toBe('pushed');

    const bParent = mkdtempSync(join(tmpdir(), 'dc-wb-sync-b-'));
    dirs.push(bParent);
    git(bParent, ['clone', '--branch', 'main', bare, join(bParent, 'repo')]);
    b = join(bParent, 'repo');
    identity(b);
    updateSetupConfig(b, { brainRepo: { mode: 'full-repo', enabled: true, autoSync: true } });
  });

  afterAll(() => {
    if (ORIGINAL_GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = ORIGINAL_GITHUB_TOKEN;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const boardRel = '_dream_context/whiteboards/plan/plan.excalidraw.md';

  it('the nested .gitattributes is committed and git sees merge=binary for boards', () => {
    expect(readFileSync(join(b, '_dream_context', 'whiteboards', '.gitattributes'), 'utf-8')).toBe('* merge=binary\n');
    expect(git(b, ['check-attr', 'merge', '--', boardRel])).toContain('merge: binary');
    // the lock dir never travels
    expect(git(b, ['ls-files', '_dream_context/whiteboards'])).not.toContain('.locks');
  });

  it('different edits of one board on two clones conflict for real, reach the whiteboard-md handler, and both survive', async () => {
    const move = (id: string, x: number) => (bd: { elements: WhiteboardElement[] }) => {
      const i = bd.elements.findIndex((e) => e.id === id);
      bd.elements[i] = bumpVersion({ ...bd.elements[i], x });
    };
    await mutateWhiteboard(join(a, '_dream_context'), 'plan', move('e1', 111));
    expect((await sync(a)).action).toBe('pushed');

    await mutateWhiteboard(join(b, '_dream_context'), 'plan', move('e3', 333));
    await mutateWhiteboard(join(b, '_dream_context'), 'plan', (bd) => { bd.elements.push(rect('fromB', 'a3', 900)); });
    const spy: Spy = { calls: [] };
    const res = await sync(b, spy);
    expect(res.action).toBe('pushed');

    // A real conflict (not a clean splice) reached the handler and was resolved by the CLI.
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].conflicts).toContain(boardRel);
    expect(spy.calls[0].result.resolved).toContain(boardRel);
    expect(spy.calls[0].result.deferredToAgent).toEqual([]);

    const els = readWhiteboard(join(b, '_dream_context'), 'plan').board.elements;
    const x = (id: string) => els.find((e) => e.id === id)!.x;
    expect([x('e1'), x('e3'), x('fromB')]).toEqual([111, 333, 900]);
    expect(readFileSync(join(b, boardRel), 'utf-8')).not.toMatch(/^<<<<<<<|^>>>>>>>/m);

    // A pulls the merge back and converges on the same bytes.
    expect((await sync(a)).action).toBe('pushed');
    expect(readFileSync(join(a, boardRel), 'utf-8')).toBe(readFileSync(join(b, boardRel), 'utf-8'));
  });

  it('add/add: both machines create "Günlük" independently — the merge is the union', async () => {
    const ca = createWhiteboard(join(a, '_dream_context'), 'Günlük');
    const cb = createWhiteboard(join(b, '_dream_context'), 'Günlük');
    expect(ca.slug).toBe('gunluk');
    expect(cb.slug).toBe('gunluk');
    await mutateWhiteboard(join(a, '_dream_context'), 'gunluk', (bd) => { bd.elements.push(rect('ga', 'a0')); });
    await mutateWhiteboard(join(b, '_dream_context'), 'gunluk', (bd) => { bd.elements.push(rect('gb', 'a0')); });
    expect((await sync(a)).action).toBe('pushed');
    const spy: Spy = { calls: [] };
    expect((await sync(b, spy)).action).toBe('pushed');
    const rel = '_dream_context/whiteboards/gunluk/gunluk.excalidraw.md';
    expect(spy.calls[0].conflicts).toContain(rel);
    const board = readWhiteboard(join(b, '_dream_context'), 'gunluk').board;
    expect(board.elements.map((e) => e.id)).toEqual(['ga', 'gb']);
    expect(board.frontmatter.name).toBe('Günlük');
    expect((await sync(a)).action).toBe('pushed');
  });

  it('delete/modify: one machine deletes a board the other edited — the surviving copy wins', async () => {
    rmSync(join(a, '_dream_context', 'whiteboards', 'plan'), { recursive: true });
    expect((await sync(a)).action).toBe('pushed');
    await mutateWhiteboard(join(b, '_dream_context'), 'plan', (bd) => { bd.elements.push(rect('late', 'a9')); });
    const spy: Spy = { calls: [] };
    expect((await sync(b, spy)).action).toBe('pushed');
    expect(spy.calls[0].conflicts).toContain(boardRel);
    expect(spy.calls[0].result.resolved).toContain(boardRel);
    expect(existsSync(join(b, boardRel))).toBe(true);
    expect(readWhiteboard(join(b, '_dream_context'), 'plan').board.elements.some((e) => e.id === 'late')).toBe(true);
  });
});
