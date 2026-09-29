import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getLibraryBlock,
  listLibraryBlocks,
  parseLibraryInputs,
  parseSafeFrontmatter,
  saveLibraryBlock,
  validateLibraryBlock,
} from '../../src/lib/lab/block-library.js';
import { LabError, MAX_HTML_BYTES } from '../../src/lib/lab/types.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dc-lab-blocks-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const dir = () => join(root, 'lab', 'blocks');

describe('block library store', () => {
  it('saves lab/blocks/<slug>.md (frontmatter title/description/inputs, body = HTML) and reads it back', () => {
    const saved = saveLibraryBlock(root, 'cohort-grid', {
      title: 'Cohort grid',
      description: 'Retention by week',
      inputs: [{ name: 'cohorts', kind: 'table' }, { name: 'total', kind: null }],
      html: '<div class="dc-card" id="grid"></div>',
    });
    const text = readFileSync(join(dir(), 'cohort-grid.md'), 'utf-8');
    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toContain('<div class="dc-card" id="grid"></div>');
    const got = getLibraryBlock(root, 'cohort-grid')!;
    expect(got).toEqual(saved);
    expect(got.inputs).toEqual([{ name: 'cohorts', kind: 'table' }, { name: 'total', kind: null }]);
    expect(listLibraryBlocks(root).map((b) => b.slug)).toEqual(['cohort-grid']);
    expect(readdirSync(dir()).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('rev-checks saves: null = must not exist, stale rev refused', () => {
    const a = saveLibraryBlock(root, 'x', { title: 'X', html: '<p>1</p>' }, null);
    expect(() => saveLibraryBlock(root, 'x', { title: 'X', html: '<p>2</p>' }, null)).toThrow(LabError);
    saveLibraryBlock(root, 'x', { title: 'X', html: '<p>2</p>' }, a.rev);
    expect(() => saveLibraryBlock(root, 'x', { title: 'X', html: '<p>3</p>' }, a.rev)).toThrow(/changed elsewhere/);
    expect(getLibraryBlock(root, 'x')!.html).toBe('<p>2</p>');
  });

  it('strict validation names each problem with a fix', () => {
    const problems = validateLibraryBlock('Bad Slug', {
      title: '',
      html: 'x'.repeat(MAX_HTML_BYTES + 1),
      inputs: [{ name: '1bad', kind: null }, { name: 'ok', kind: 'table' }, { name: 'ok', kind: 'table' }, { name: 'k', kind: 'nope' as never }],
    });
    expect(problems.length).toBe(6);
    expect(problems.every((p) => p.includes('fix:'))).toBe(true);
    expect(() => saveLibraryBlock(root, '../evil', { title: 'x', html: '<p></p>' })).toThrow(LabError);
    expect(existsSync(join(root, 'lab'))).toBe(false);
  });

  it('lenient inputs: bad names and duplicates dropped, unknown kind -> null, bare strings accepted', () => {
    expect(parseLibraryInputs([{ name: 'a', kind: 'series' }, 'b', { name: 'a' }, { name: '../x' }, { name: 'c', kind: 'weird' }, 5]))
      .toEqual([{ name: 'a', kind: 'series' }, { name: 'b', kind: null }, { name: 'c', kind: null }]);
    expect(parseLibraryInputs('nope')).toEqual([]);
  });

  it('refuses symlinked entries on read and never writes through a symlink', () => {
    mkdirSync(dir(), { recursive: true });
    const outside = join(root, 'outside.md');
    writeFileSync(outside, '---\ntitle: Outside\n---\n<p>secret</p>\n');
    symlinkSync(outside, join(dir(), 'linked.md'));
    expect(getLibraryBlock(root, 'linked')).toBeNull();
    expect(listLibraryBlocks(root)).toEqual([]);
    expect(() => saveLibraryBlock(root, 'linked', { title: 'X', html: '<p>overwrite</p>' })).toThrow(/symlink/);
    expect(readFileSync(outside, 'utf-8')).toContain('secret');
  });

  it('refuses a lab/blocks/ directory that is a symlink out of the vault', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'dc-lab-blocks-elsewhere-'));
    try {
      writeFileSync(join(elsewhere, 'x.md'), '---\ntitle: X\n---\n<p></p>\n');
      mkdirSync(join(root, 'lab'), { recursive: true });
      symlinkSync(elsewhere, dir());
      expect(getLibraryBlock(root, 'x')).toBeNull();
      expect(() => saveLibraryBlock(root, 'y', { title: 'Y', html: '<p></p>' })).toThrow(/outside the vault/);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('safe frontmatter', () => {
  it('parses YAML with the safe engine and refuses any tagged fence without evaluating it', () => {
    expect(parseSafeFrontmatter('---\ntitle: A\n---\nbody').data).toEqual({ title: 'A' });
    const g = globalThis as Record<string, unknown>;
    g.__libPwned = 0;
    for (const fence of ['---js', '---javascript', '---JavaScript', '--- js', '---coffee', '---constructor', '---__proto__']) {
      expect(() => parseSafeFrontmatter(`${fence}\n{title: (globalThis.__libPwned = 1, "x")}\n---\n`)).toThrow();
    }
    expect(g.__libPwned).toBe(0);
    expect(() => parseSafeFrontmatter('---\ntitle: !!js/function "function(){}"\n---\n')).toThrow();
    expect(() => parseSafeFrontmatter('---\n- a\n- b\n---\n')).toThrow(/mapping/);
  });

  it('a ---js library entry reads as absent and runs nothing', () => {
    mkdirSync(dir(), { recursive: true });
    const g = globalThis as Record<string, unknown>;
    g.__libPwned2 = 0;
    writeFileSync(join(dir(), 'evil.md'), '---js\n{title: (globalThis.__libPwned2 = 1, "x")}\n---\n<p></p>\n');
    expect(getLibraryBlock(root, 'evil')).toBeNull();
    expect(g.__libPwned2).toBe(0);
  });
});
