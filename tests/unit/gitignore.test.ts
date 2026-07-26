import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureGitignoreEntries, removeGitignoreEntries, gitignoreCovers } from '../../src/lib/gitignore.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dc-gitignore-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('removeGitignoreEntries', () => {
  it('returns [] and creates nothing when .gitignore does not exist', () => {
    expect(removeGitignoreEntries(dir, ['foo/*.json'])).toEqual([]);
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
  });

  it('removes only exact-match lines, leaving comments and unrelated lines untouched', () => {
    writeFileSync(
      join(dir, '.gitignore'),
      ['# a comment mentioning foo/*.json', 'node_modules/', 'foo/*.json', 'bar/*.lock', ''].join('\n'),
      'utf-8',
    );

    const removed = removeGitignoreEntries(dir, ['foo/*.json']);
    expect(removed).toEqual(['foo/*.json']);

    const after = readFileSync(join(dir, '.gitignore'), 'utf-8');
    const afterLines = after.split('\n');
    expect(afterLines).toContain('# a comment mentioning foo/*.json');
    expect(afterLines).toContain('node_modules/');
    expect(afterLines).toContain('bar/*.lock');
    expect(afterLines).not.toContain('foo/*.json');
  });

  it('never removes a comment line even when its text matches a requested entry', () => {
    // Entries never carry a leading '#', so a comment can only "match" here if
    // the comparison ignored the '#' — assert it doesn't.
    writeFileSync(join(dir, '.gitignore'), '# foo/*.json\nfoo/*.json\n', 'utf-8');
    const removed = removeGitignoreEntries(dir, ['foo/*.json']);
    expect(removed).toEqual(['foo/*.json']);
    const after = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(after).toContain('# foo/*.json');
    expect(after.split('\n')).not.toContain('foo/*.json');
  });

  it('returns [] and never rewrites the file when none of the entries are present', () => {
    const original = 'node_modules/\ndist/\n';
    writeFileSync(join(dir, '.gitignore'), original, 'utf-8');
    expect(removeGitignoreEntries(dir, ['nonexistent/*.json'])).toEqual([]);
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toBe(original);
  });

  it('removes multiple entries in one call and reports each once', () => {
    writeFileSync(join(dir, '.gitignore'), 'a.json\nb.json\nc.json\n', 'utf-8');
    const removed = removeGitignoreEntries(dir, ['a.json', 'c.json']);
    expect([...removed].sort()).toEqual(['a.json', 'c.json']);
    const after = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(after.split('\n').filter(Boolean)).toEqual(['b.json']);
  });

  it('preserves the file\'s trailing-newline convention', () => {
    writeFileSync(join(dir, '.gitignore'), 'a.json\nb.json\n', 'utf-8');
    removeGitignoreEntries(dir, ['b.json']);
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toBe('a.json\n');

    writeFileSync(join(dir, '.gitignore'), 'x.json\ny.json', 'utf-8'); // no trailing newline
    removeGitignoreEntries(dir, ['y.json']);
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toBe('x.json');
  });

  it('is the exact inverse of ensureGitignoreEntries for entries it added', () => {
    const added = ensureGitignoreEntries(dir, ['x/*.tmp', 'y/*.tmp'], { comment: 'scratch' });
    expect(added).toEqual(['x/*.tmp', 'y/*.tmp']);
    expect(gitignoreCovers(dir, ['x/*.tmp', 'y/*.tmp'])).toBe(true);

    const removed = removeGitignoreEntries(dir, ['x/*.tmp', 'y/*.tmp']);
    expect([...removed].sort()).toEqual(['x/*.tmp', 'y/*.tmp']);
    expect(gitignoreCovers(dir, ['x/*.tmp', 'y/*.tmp'])).toBe(false);
    // removeGitignoreEntries never touches comments — the header survives.
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toContain('# scratch');
  });

  it('throws when .gitignore exists but is not a regular file, mirroring ensureGitignoreEntries', () => {
    mkdirSync(join(dir, '.gitignore'));
    expect(() => removeGitignoreEntries(dir, ['foo/*.json'])).toThrow(/not a regular file/);
  });
});
