import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Any spawn from probeFolder would be a bug (git on a Mac without the developer tools
// opens Apple's install dialog). Record every child_process call and assert none happen.
const spawned: string[] = [];
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  const rec = (name: string) => (...args: unknown[]) => { spawned.push(`${name} ${String(args[0])}`); throw new Error('spawn forbidden in probeFolder'); };
  return { ...real, execFileSync: rec('execFileSync'), execFile: rec('execFile'), spawn: rec('spawn'), spawnSync: rec('spawnSync'), execSync: rec('execSync') };
});

const { probeFolder, findGitDir } = await import('../../src/lib/onboarding/folder.js');
const { detectDocSources } = await import('../../src/lib/initializer-detect.js');

let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dc-folder-')); spawned.length = 0; });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('probeFolder', () => {
  it('reports a plain folder: empty, writable, no brain, no git, stack null, zero spawns', () => {
    const dir = join(root, 'empty');
    mkdirSync(dir);
    const s = probeFolder(dir);
    expect(s).toMatchObject({ exists: true, isDirectory: true, isSymlink: false, empty: true, writable: true, brain: 'missing', isGitRepo: false, stack: null });
    expect(s.docs).toEqual({ count: 0, folders: [] });
    expect(spawned).toEqual([]);
  });

  it('refuses a symlinked folder without reading it', () => {
    const real = join(root, 'real');
    mkdirSync(real);
    writeFileSync(join(real, 'a.md'), '# a');
    const link = join(root, 'link');
    symlinkSync(real, link);
    const s = probeFolder(link);
    expect(s).toMatchObject({ exists: true, isSymlink: true, isDirectory: false, docs: { count: 0, folders: [] } });
  });

  it('finds .git in a parent folder, counts a .git file, ignores a symlinked .git', () => {
    const repo = join(root, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'packages', 'app'), { recursive: true });
    expect(probeFolder(join(repo, 'packages', 'app')).isGitRepo).toBe(true);

    const wt = join(root, 'worktree');
    mkdirSync(wt);
    writeFileSync(join(wt, '.git'), 'gitdir: /elsewhere\n');
    expect(findGitDir(wt)).toBe(join(wt, '.git'));

    const fake = join(root, 'fake');
    mkdirSync(fake);
    symlinkSync(join(repo, '.git'), join(fake, '.git'));
    expect(findGitDir(fake)).toBeNull();
    expect(spawned).toEqual([]);
  });

  it('keeps a Turkish name in NFC whatever form it arrives in', () => {
    const nfc = 'Öğretmen Notları';
    mkdirSync(join(root, nfc));
    const s = probeFolder(join(root, nfc.normalize('NFD')));
    expect(s.name).toBe(nfc);
    expect(s.name).toBe(s.name.normalize('NFC'));
    expect(s.exists).toBe(true);
  });

  it('a missing path is reported, not thrown', () => {
    expect(probeFolder(join(root, 'nope'))).toMatchObject({ exists: false, isDirectory: false });
  });
});

describe('detectDocSources', () => {
  it('counts documents, names the folders holding them, skips deps/.git/brain and links', () => {
    const dir = join(root, 'proj');
    mkdirSync(join(dir, 'docs', 'adr'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    mkdirSync(join(dir, '_dream_context'), { recursive: true });
    for (const f of ['a.md', 'b.md', 'c.txt']) writeFileSync(join(dir, 'docs', f), 'x');
    writeFileSync(join(dir, 'docs', 'adr', '001.md'), 'x');
    writeFileSync(join(dir, 'README.md'), 'x');
    writeFileSync(join(dir, 'index.ts'), 'x');
    writeFileSync(join(dir, 'node_modules', 'x', 'r.md'), 'x');
    writeFileSync(join(dir, '_dream_context', 'k.md'), 'x');
    const outside = join(root, 'outside');
    mkdirSync(outside);
    for (let i = 0; i < 5; i++) writeFileSync(join(outside, `${i}.md`), 'x');
    symlinkSync(outside, join(dir, 'linked'));
    symlinkSync(join(outside, '0.md'), join(dir, 'linked.md'));

    const s = detectDocSources(dir);
    expect(s.count).toBe(5);
    expect(s.folders).toEqual(['docs', '.', 'docs/adr']);
  });

  it('respects maxDepth and limit, and refuses a symlinked root', () => {
    const dir = join(root, 'deep');
    mkdirSync(join(dir, 'a', 'b', 'c'), { recursive: true });
    writeFileSync(join(dir, 'a', 'b', 'c', 'x.md'), 'x');
    expect(detectDocSources(dir, { maxDepth: 2 }).count).toBe(0);
    expect(detectDocSources(dir, { maxDepth: 3 }).count).toBe(1);
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, `${i}.md`), 'x');
    expect(detectDocSources(dir, { limit: 7 }).count).toBe(7);
    const link = join(root, 'deeplink');
    symlinkSync(dir, link);
    expect(detectDocSources(link)).toEqual({ count: 0, folders: [] });
    expect(readdirSync(dir).length).toBeGreaterThan(0);
  });
});
