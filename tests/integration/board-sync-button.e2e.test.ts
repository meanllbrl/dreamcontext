import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateSetupConfig } from '../../src/lib/setup-config.js';
import { runBrainSync } from '../../src/lib/git-sync/sync-engine.js';
import { createWhiteboard, mutateWhiteboard, readWhiteboard, trashWhiteboard } from '../../src/lib/whiteboards/store.js';
import type { WhiteboardElement } from '../../src/lib/whiteboards/widgets.js';

/**
 * The board's Sync button (owner, 2026-11-18): it runs the normal brain sync, and a team merge
 * that waits for sleep (/dream-sync) no longer holds the boards back. Two clones of one project
 * and a local bare origin, real git, no network.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function identity(cwd: string, who: string): void {
  git(cwd, ['config', 'user.email', `${who}@dreamcontext.local`]);
  git(cwd, ['config', 'user.name', who]);
}

function rect(id: string, index: string, x = 0): WhiteboardElement {
  return {
    id, type: 'rectangle', x, y: 0, width: 50, height: 50, angle: 0, version: 1, versionNonce: 1, index,
    isDeleted: false, groupIds: [], frameId: null, boundElements: null, updated: 1, link: null, locked: false,
  };
}

/** What the button sends: a foreground auto sync. */
const press = (root: string) => runBrainSync({ cwd: join(root, '_dream_context'), mode: 'auto', foreground: true });
const ids = (root: string, slug: string) => readWhiteboard(join(root, '_dream_context'), slug).board.elements
  .filter((e) => !e.isDeleted).map((e) => e.id).sort();
const add = (root: string, slug: string, ...els: WhiteboardElement[]) =>
  mutateWhiteboard(join(root, '_dream_context'), slug, (bd) => { bd.elements.push(...els); });

describe('e2e: the board Sync button (full-repo, two clones)', { timeout: 180_000 }, () => {
  const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const dirs: string[] = [];
  let a: string;
  let b: string;
  let bare: string;
  const notePath = '_dream_context/knowledge/plan-notes.md';

  beforeAll(async () => {
    process.env.GITHUB_TOKEN = 'e2e-dummy-token';
    bare = mkdtempSync(join(tmpdir(), 'dc-wb-btn-bare-'));
    execFileSync('git', ['init', '--bare', bare]);
    a = mkdtempSync(join(tmpdir(), 'dc-wb-btn-a-'));
    dirs.push(bare, a);
    git(a, ['init']);
    identity(a, 'ayse');
    git(a, ['checkout', '-b', 'main']);
    git(a, ['remote', 'add', 'origin', bare]);
    mkdirSync(join(a, '_dream_context', 'knowledge'), { recursive: true });
    writeFileSync(join(a, 'README.md'), '# project\n');
    writeFileSync(join(a, notePath), '---\nname: plan-notes\n---\n\n## Plan\n\nThe launch is on Monday.\n');
    updateSetupConfig(a, { brainRepo: { mode: 'full-repo', enabled: true, autoSync: true } });
    const ctx = join(a, '_dream_context');
    createWhiteboard(ctx, 'Roadmap');
    await add(a, 'roadmap', rect('base1', 'a0'));
    expect((await press(a)).action).toBe('pushed');

    const bParent = mkdtempSync(join(tmpdir(), 'dc-wb-btn-b-'));
    dirs.push(bParent);
    git(bParent, ['clone', '--branch', 'main', bare, join(bParent, 'repo')]);
    b = join(bParent, 'repo');
    identity(b, 'burak');
    updateSetupConfig(b, { brainRepo: { mode: 'full-repo', enabled: true, autoSync: true } });
  });

  afterAll(() => {
    if (ORIGINAL_GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = ORIGINAL_GITHUB_TOKEN;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('no conflict elsewhere: one board drawn on both sides is merged element by element, nothing lost', async () => {
    await add(a, 'roadmap', rect('a1', 'a1', 100), rect('a2', 'a2', 200), rect('a3', 'a3', 300));
    expect((await press(a)).action).toBe('pushed');
    await add(b, 'roadmap', rect('b1', 'a4', 400), rect('b2', 'a5', 500));
    const rb = await press(b);
    expect(rb.action).toBe('pushed');
    expect(rb.boards).toBeUndefined(); // the whole sync went: no separate board exchange
    expect(ids(b, 'roadmap')).toEqual(['a1', 'a2', 'a3', 'b1', 'b2', 'base1']);
    expect((await press(a)).action).toBe('pushed');
    expect(ids(a, 'roadmap')).toEqual(['a1', 'a2', 'a3', 'b1', 'b2', 'base1']);
  });

  it('a prose conflict waits for sleep while the boards still go both ways', async () => {
    // Both edit the same line of a note (a conflict only /dream-sync resolves) and both draw.
    writeFileSync(join(a, notePath), '---\nname: plan-notes\n---\n\n## Plan\n\nThe launch is on Tuesday.\n');
    await add(a, 'roadmap', rect('a4', 'a6', 600));
    createWhiteboard(join(a, '_dream_context'), 'Ideas');
    await add(a, 'ideas', rect('idea-a', 'a0'));
    expect((await press(a)).action).toBe('pushed');

    writeFileSync(join(b, notePath), '---\nname: plan-notes\n---\n\n## Plan\n\nThe launch is on Friday.\n');
    await add(b, 'roadmap', rect('b3', 'a7', 700));
    const headBefore = git(b, ['rev-parse', 'HEAD']).trim();

    const rb = await press(b);
    expect(rb.action).toBe('awaiting-agent');
    expect(rb.awaitingSleep).toBe(1);
    expect(rb.boards?.error).toBeUndefined();
    expect(rb.boards?.sent).toBeGreaterThanOrEqual(1);
    // The open merge already put the team's boards on disk (merged by the element rule), so
    // the exchange has nothing more to bring in here; it sends B's boards.
    expect(rb.boards?.received).toBe(0);
    // B holds every shape and the new board; the note still waits (the merge is left for sleep).
    expect(ids(b, 'roadmap')).toEqual(['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'base1']);
    expect(ids(b, 'ideas')).toEqual(['idea-a']);
    expect(readFileSync(join(b, notePath), 'utf-8')).toMatch(/^<<<<<<<|Friday/m);
    // HEAD is the sync's own commit of B's work; the exchange never moved it or finished the merge.
    expect(git(b, ['rev-parse', 'HEAD^']).trim()).toBe(headBefore);
    expect(git(b, ['log', '-1', '--format=%s', 'HEAD'])).not.toContain('boards sync');
    expect(existsSync(join(b, '.git', 'MERGE_HEAD'))).toBe(true);
    // The remote's newest commit carries boards only.
    const changed = git(bare, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'main']).trim().split('\n');
    expect(changed.every((p) => p.startsWith('_dream_context/whiteboards/'))).toBe(true);

    // A presses: B's shape arrives, A's note is untouched.
    const ra = await press(a);
    expect(ra.action).not.toBe('awaiting-agent');
    expect(ids(a, 'roadmap')).toEqual(['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'base1']);
    expect(readFileSync(join(a, notePath), 'utf-8')).toContain('Tuesday');
  });

  it('pressed again while the merge still waits: new shapes go out, nothing comes back twice', async () => {
    await add(b, 'roadmap', rect('b4', 'a8', 800));
    const rb = await press(b);
    expect(rb.action).toBe('already-awaiting-agent');
    expect(rb.boards?.sent).toBeGreaterThanOrEqual(1);
    await press(a);
    expect(ids(a, 'roadmap')).toContain('b4');
  });

  it('a symlinked board file on this Mac is never read or sent', async () => {
    const secret = join(tmpdir(), `dc-wb-btn-secret-${process.pid}.txt`);
    writeFileSync(secret, 'not a board');
    dirs.push(secret);
    mkdirSync(join(b, '_dream_context', 'whiteboards', 'leak'), { recursive: true });
    symlinkSync(secret, join(b, '_dream_context', 'whiteboards', 'leak', 'leak.excalidraw.md'));
    await press(b);
    expect(git(bare, ['ls-tree', '-r', '--name-only', 'main'])).not.toContain('whiteboards/leak/');
    rmSync(join(b, '_dream_context', 'whiteboards', 'leak'), { recursive: true, force: true });
  });

  it('--strict: a board with a WARN-tier secret is not sent, the same gate as the sync\'s other pushes (review r1)', async () => {
    const ctx = join(b, '_dream_context');
    createWhiteboard(ctx, 'Keys');
    await mutateWhiteboard(ctx, 'keys', (bd) => {
      bd.elements.push({
        ...rect('k1', 'a0'), type: 'text', text: 'api_key: "abcd1234efgh5678ijkl"', originalText: 'api_key: "abcd1234efgh5678ijkl"',
        fontSize: 20, fontFamily: 5, textAlign: 'left', verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: 1.25,
      } as unknown as WhiteboardElement);
    });
    const rb = await runBrainSync({ cwd: ctx, mode: 'auto', foreground: true, strict: true });
    expect(rb.action).toBe('already-awaiting-agent');
    expect(rb.boards?.sent).toBe(0);
    expect(rb.boards?.scrub?.warns.some((h) => h.rule === 'generic-secret-assignment')).toBe(true);
    expect(git(bare, ['ls-tree', '-r', '--name-only', 'main'])).not.toContain('whiteboards/keys/');
    rmSync(join(ctx, 'whiteboards', 'keys'), { recursive: true, force: true });
  });

  it('a board that came in while the merge waits and was then deleted by its author never comes back (review r1)', async () => {
    const actx = join(a, '_dream_context');
    createWhiteboard(actx, 'Scratch');
    await add(a, 'scratch', rect('s1', 'a0'));
    expect((await press(a)).action).toBe('pushed');
    const r1 = await press(b);
    expect(r1.action).toBe('already-awaiting-agent');
    expect(ids(b, 'scratch')).toEqual(['s1']);
    // Ayşe deletes it (to her board trash) and syncs.
    await trashWhiteboard(actx, 'scratch');
    expect((await press(a)).action).toBe('pushed');
    expect(git(bare, ['ls-tree', '-r', '--name-only', 'main'])).not.toContain('whiteboards/scratch/');
    // Burak presses: never sent back; it goes to his board trash, recoverable.
    const r2 = await press(b);
    expect(r2.boards?.trashed).toBe(1);
    expect(existsSync(join(b, '_dream_context', 'whiteboards', 'scratch'))).toBe(false);
    expect(git(bare, ['ls-tree', '-r', '--name-only', 'main'])).not.toContain('whiteboards/scratch/');
    await press(b);
    expect(git(bare, ['ls-tree', '-r', '--name-only', 'main'])).not.toContain('whiteboards/scratch/');
  });

  it('a board that came in on a press whose send was stopped is still agreed: its deletion never comes back (review r2)', async () => {
    const actx = join(a, '_dream_context');
    const bctx = join(b, '_dream_context');
    createWhiteboard(actx, 'Scratch Two');
    await add(a, 'scratch-two', rect('t1', 'a0'));
    expect((await press(a)).action).toBe('pushed');
    // B's own send is stopped (a WARN-tier secret under --strict) on the press that brings it in.
    createWhiteboard(bctx, 'Keys Two');
    await mutateWhiteboard(bctx, 'keys-two', (bd) => {
      bd.elements.push({
        ...rect('k2', 'a0'), type: 'text', text: 'token: "abcd1234efgh5678ijkl"', originalText: 'token: "abcd1234efgh5678ijkl"',
        fontSize: 20, fontFamily: 5, textAlign: 'left', verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: 1.25,
      } as unknown as WhiteboardElement);
    });
    const r1 = await runBrainSync({ cwd: bctx, mode: 'auto', foreground: true, strict: true });
    expect(r1.boards?.stopped).toBe('secret');
    expect(ids(b, 'scratch-two')).toEqual(['t1']);
    rmSync(join(bctx, 'whiteboards', 'keys-two'), { recursive: true, force: true });
    // Ayşe deletes it; Burak's next clean press must not send it back.
    await trashWhiteboard(actx, 'scratch-two');
    expect((await press(a)).action).toBe('pushed');
    const r2 = await press(b);
    expect(r2.boards?.trashed).toBe(1);
    expect(git(bare, ['ls-tree', '-r', '--name-only', 'main'])).not.toContain('whiteboards/scratch-two/');
  });

  it('after sleep resolves the note, the normal sync finishes with every shape on both sides', async () => {
    // /dream-sync's part: the note is reconciled and the merge continued.
    writeFileSync(join(b, notePath), '---\nname: plan-notes\n---\n\n## Plan\n\nThe launch is on Friday (Ayşe said Tuesday).\n');
    git(b, ['add', notePath]);
    const cont = await runBrainSync({ cwd: join(b, '_dream_context'), mode: 'auto', continue: true, foreground: true });
    expect(cont.action).toBe('pushed');
    expect((await press(a)).action).toBe('pushed');
    const all = ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'b4', 'base1'];
    expect(ids(a, 'roadmap')).toEqual(all);
    expect(ids(b, 'roadmap')).toEqual(all);
    expect(readFileSync(join(a, notePath), 'utf-8')).toContain('Ayşe said Tuesday');
    expect(readFileSync(join(a, '_dream_context/whiteboards/roadmap/roadmap.excalidraw.md'), 'utf-8'))
      .toBe(readFileSync(join(b, '_dream_context/whiteboards/roadmap/roadmap.excalidraw.md'), 'utf-8'));
  });
  it('the unattended 24-hour sync backs the merge out yet still brings the team\'s shapes in and sends its own', async () => {
    writeFileSync(join(a, notePath), '---\nname: plan-notes\n---\n\n## Plan\n\nThe launch is in March.\n');
    await add(a, 'roadmap', rect('a5', 'a9', 900));
    expect((await press(a)).action).toBe('pushed');
    writeFileSync(join(b, notePath), '---\nname: plan-notes\n---\n\n## Plan\n\nThe launch is in April.\n');
    await add(b, 'roadmap', rect('b5', 'aA', 1000));

    const rb = await runBrainSync({ cwd: join(b, '_dream_context'), mode: 'auto', headless: true });
    expect(rb.action).toBe('awaiting-agent');
    expect(existsSync(join(b, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(rb.boards?.received).toBe(1);
    expect(rb.boards?.sent).toBe(1);
    expect(ids(b, 'roadmap')).toContain('a5');
    expect(ids(b, 'roadmap')).toContain('b5');
    expect(readFileSync(join(b, notePath), 'utf-8')).toContain('April');
    await press(a);
    expect(ids(a, 'roadmap')).toContain('b5');
    expect(readFileSync(join(a, notePath), 'utf-8')).toContain('March');
  });
});
