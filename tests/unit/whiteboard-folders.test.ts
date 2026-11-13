import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWhiteboard, listWhiteboards, renameWhiteboardGroup, setWhiteboardGroup } from '../../src/lib/whiteboards/store.js';
import { parseGroupInput, readGroup } from '../../src/lib/whiteboards/validate.js';
import { readGroupOrder, renameInGroupOrder, writeGroupOrder } from '../../src/lib/whiteboards/group-order.js';
import { WhiteboardValidationError } from '../../src/lib/whiteboards/errors.js';
import { createProgram } from '../../src/cli/program.js';

/**
 * Board folders, two levels deep (owner, 2026-11-13): a group is "Folder" or "Folder/Sub-folder".
 * Scratch context roots only; nothing reaches the real brain.
 */
let project: string;
let root: string;
let home: string;
let cwd: string;

beforeEach(() => {
  cwd = process.cwd();
  project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-folders-')));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-folders-home-')));
  vi.stubEnv('HOME', home);
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
  process.chdir(project);
});
afterEach(() => {
  process.chdir(cwd);
  vi.unstubAllEnvs();
  rmSync(project, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const groupOf = (slug: string) => listWhiteboards(root).find((b) => b.slug === slug)?.group ?? null;
const make = (name: string, group?: string) => createWhiteboard(root, name, '', { group, by: 'owner' }).slug;

describe('a folder path', () => {
  it('is one or two names; spaces around the slash are trimmed; a third level or an empty part is refused', () => {
    expect(parseGroupInput('Pazarlama')).toBe('Pazarlama');
    expect(parseGroupInput(' Pazarlama / Reklamlar ')).toBe('Pazarlama/Reklamlar');
    for (const bad of ['a/b/c', '/a', 'a/', 'a//b', 'a／b']) expect(() => parseGroupInput(bad)).toThrow(WhiteboardValidationError);
    // Read leniently: a three-level hand edit reads as no folder, never throws.
    expect(readGroup('a/b/c')).toBeNull();
    expect(readGroup('Pazarlama/Reklamlar')).toBe('Pazarlama/Reklamlar');
  });

  it('an old board without a folder and an old one-level group read unchanged', () => {
    const loose = make('Loose');
    const old = make('Old', 'Tilki');
    expect(groupOf(loose)).toBeNull();
    expect(groupOf(old)).toBe('Tilki');
  });

  it('adopts the existing spelling level by level', async () => {
    make('A', 'Pazarlama/Reklamlar');
    const b = make('B');
    await setWhiteboardGroup(root, b, 'PAZARLAMA/reklamlar', { by: 'owner' });
    expect(groupOf(b)).toBe('Pazarlama/Reklamlar');
    const c = make('C');
    await setWhiteboardGroup(root, c, 'pazarlama/Funnel', { by: 'owner' });
    expect(groupOf(c)).toBe('Pazarlama/Funnel');
  });
});

describe('renameWhiteboardGroup on folders', () => {
  it('renaming a folder carries its sub-folders', async () => {
    const top = make('Top', 'Pazarlama');
    const sub = make('Sub', 'Pazarlama/Reklamlar');
    const other = make('Other', 'Ürün');
    const out = await renameWhiteboardGroup(root, 'Pazarlama', 'Marketing', { by: 'owner' });
    expect(out.moved.sort()).toEqual([sub, top].sort());
    expect(groupOf(top)).toBe('Marketing');
    expect(groupOf(sub)).toBe('Marketing/Reklamlar');
    expect(groupOf(other)).toBe('Ürün');
  });

  it('a folder without sub-folders can become a sub-folder; one with sub-folders cannot, and nothing moves', async () => {
    const f = make('F', 'Funnel');
    await renameWhiteboardGroup(root, 'Funnel', 'Pazarlama/Funnel', { by: 'owner' });
    expect(groupOf(f)).toBe('Pazarlama/Funnel');
    const s = make('S', 'Ürün/Ekranlar');
    await expect(renameWhiteboardGroup(root, 'Ürün', 'Pazarlama/Ürün', { by: 'owner' })).rejects.toThrow(/two levels/);
    expect(groupOf(s)).toBe('Ürün/Ekranlar');
    await expect(renameWhiteboardGroup(root, 'Pazarlama', 'Pazarlama/X', { by: 'owner' })).rejects.toThrow(/sub-folders|itself/);
  });

  it('a sub-folder can move to the top', async () => {
    const r = make('R', 'Pazarlama/Reklamlar');
    await renameWhiteboardGroup(root, 'Pazarlama/Reklamlar', 'Reklamlar', { by: 'owner' });
    expect(groupOf(r)).toBe('Reklamlar');
  });

  it('deleting a sub-folder moves its boards into the parent; no board is deleted', async () => {
    const r = make('R', 'Pazarlama/Reklamlar');
    const top = make('Top', 'Pazarlama');
    await renameWhiteboardGroup(root, 'Pazarlama/Reklamlar', null, { by: 'owner' });
    expect(groupOf(r)).toBe('Pazarlama');
    expect(groupOf(top)).toBe('Pazarlama');
    expect(listWhiteboards(root)).toHaveLength(2);
  });

  it('deleting a folder takes its boards out and lifts its sub-folders to the top (merging by spelling)', async () => {
    make('Keep', 'Funnel');
    const top = make('Top', 'Pazarlama');
    const sub = make('Sub', 'Pazarlama/Reklamlar');
    const dup = make('Dup', 'Pazarlama/funnel');
    await renameWhiteboardGroup(root, 'Pazarlama', null, { by: 'owner' });
    expect(groupOf(top)).toBeNull();
    expect(groupOf(sub)).toBe('Reklamlar');
    expect(groupOf(dup)).toBe('Funnel');
  });
});

describe('the folder order follows a renamed or deleted folder', () => {
  it('sub-folder entries follow their parent, and a deleted parent lifts them', async () => {
    await writeGroupOrder(root, ['Ürün', 'Pazarlama', 'Pazarlama/Funnel', 'Pazarlama/Reklamlar']);
    await renameInGroupOrder(root, 'Pazarlama', 'Marketing');
    expect(readGroupOrder(root)).toEqual(['Ürün', 'Marketing', 'Marketing/Funnel', 'Marketing/Reklamlar']);
    await renameInGroupOrder(root, 'Marketing', null);
    expect(readGroupOrder(root)).toEqual(['Ürün', 'Funnel', 'Reklamlar']);
    await renameInGroupOrder(root, 'Funnel', 'ürün');
    expect(readGroupOrder(root)).toEqual(['Ürün', 'Reklamlar']);
  });
});

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
  try {
    await createProgram().parseAsync(argv, { from: 'user' });
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  // eslint-disable-next-line no-control-regex
  return { code, out: out.join('\n').replace(/\u001b\[[0-9;]*m/g, '') };
}

describe('the CLI', () => {
  it('list prints a sub-folder right under its folder, whatever the slugs sort to', async () => {
    make('Ads', 'Pazarlama/Zeta');
    make('Bee', 'Pazarlama/Alfa');
    make('Plan', 'Pazarlama');
    const out = (await run(['whiteboard', 'list'])).out;
    const at = (s: string) => out.indexOf(s);
    expect(at('Pazarlama:')).toBeGreaterThanOrEqual(0);
    expect(at('Pazarlama:')).toBeLessThan(at('Pazarlama/Alfa:'));
    expect(at('Pazarlama/Alfa:')).toBeLessThan(at('Pazarlama/Zeta:'));
    expect(at('Plan')).toBeLessThan(at('Pazarlama/Alfa:'));
  });

  it('deleting a sub-folder typed in another case keeps the folder\'s spelling', async () => {
    // Agent-placed, so the CLI (an agent's hand) may move them.
    createWhiteboard(root, 'Ads', '', { group: 'Pazarlama/Reklamlar', by: 'agent' });
    createWhiteboard(root, 'Plan', '', { group: 'Pazarlama', by: 'agent' });
    expect((await run(['whiteboard', 'folder', 'delete', 'pazarlama/reklamlar'])).code).toBe(0);
    expect(groupOf('ads')).toBe('Pazarlama');
    // Also when the parent holds nothing else: the sub-folder's own boards vote for its spelling.
    createWhiteboard(root, 'Solo', '', { group: 'Ürün/Ekranlar', by: 'agent' });
    expect((await run(['whiteboard', 'folder', 'delete', 'ürün/ekranlar'])).code).toBe(0);
    expect(groupOf('solo')).toBe('Ürün');
  });

  it('create --folder, move --folder/--out, list --folder, folder delete', async () => {
    expect((await run(['whiteboard', 'create', 'Meta', '--folder', 'Pazarlama/Reklamlar'])).code).toBe(0);
    expect(groupOf('meta')).toBe('Pazarlama/Reklamlar');
    make('Plan', 'Pazarlama');
    make('Road', 'Ürün');
    make('Loose');
    expect((await run(['whiteboard', 'move', 'loose', '--folder', 'pazarlama'])).code).toBe(0);
    expect(groupOf('loose')).toBe('Pazarlama');
    const listed = JSON.parse((await run(['whiteboard', 'list', '--folder', 'Pazarlama', '--json'])).out);
    expect(listed.map((b: { slug: string }) => b.slug).sort()).toEqual(['loose', 'meta', 'plan']);
    const plain = (await run(['whiteboard', 'list'])).out;
    expect(plain).toMatch(/Pazarlama:[\s\S]*Pazarlama\/Reklamlar:[\s\S]*Meta[\s\S]*Ürün:/);
    expect((await run(['whiteboard', 'move', 'loose', '--out'])).code).toBe(0);
    expect(groupOf('loose')).toBeNull();
    expect((await run(['whiteboard', 'move', 'loose'])).code).toBe(1);
    expect((await run(['whiteboard', 'folder', 'delete', 'Pazarlama/Reklamlar'])).code).toBe(0);
    expect(groupOf('meta')).toBe('Pazarlama');
    expect((await run(['whiteboard', 'create', 'Deep', '--folder', 'a/b/c'])).code).toBe(1);
  });
});
