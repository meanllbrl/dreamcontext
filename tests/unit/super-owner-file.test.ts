/**
 * Which card a project file makes when the owner names it (`ownerFileTarget`, AC5): the right kind
 * for the agent's `open`, or a refusal code the window words itself. The real path decides, so a
 * symlink cannot walk out of the project.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownerFileTarget } from '../../src/lib/super/owner-file.js';

let dir: string;
let root: string;
let outside: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'super-owner-file-')));
  root = join(dir, 'pocket-ledger');
  outside = join(dir, 'elsewhere');
  mkdirSync(join(root, 'docs', 'media'), { recursive: true });
  mkdirSync(outside);
  for (const f of ['docs/a.html', 'docs/b.htm', 'docs/c.pdf', 'docs/media/d.png', 'docs/media/e.mov', 'docs/f.md', 'docs/g.excalidraw.md', 'docs/h.txt', 'docs/with space.html', 'docs/narrow space.html', 'docs/with space.pdf']) {
    writeFileSync(join(root, f), 'x');
  }
  writeFileSync(join(outside, 'secret.html'), 'x');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('ownerFileTarget', () => {
  it.each([
    ['docs/a.html', 'web'], ['docs/b.htm', 'web'], ['docs/c.pdf', 'pdf'], ['docs/media/d.png', 'image'],
    ['docs/media/e.mov', 'video'], ['docs/g.excalidraw.md', 'board'], ['docs/with space.pdf', 'pdf'],
  ])('%s opens as %s, relative or absolute', (rel, kind) => {
    expect(ownerFileTarget(root, rel)).toEqual({ kind, ref: rel });
    expect(ownerFileTarget(root, join(root, rel))).toEqual({ kind, ref: rel });
  });

  it('a symlink inside the project answers with the real path', () => {
    symlinkSync(join(root, 'docs', 'a.html'), join(root, 'link.html'));
    expect(ownerFileTarget(root, 'link.html')).toEqual({ kind: 'web', ref: 'docs/a.html' });
  });

  it('a project reached through a symlink still resolves inside itself', () => {
    const alias = join(dir, 'alias');
    symlinkSync(root, alias);
    expect(ownerFileTarget(alias, join(root, 'docs', 'c.pdf'))).toEqual({ kind: 'pdf', ref: 'docs/c.pdf' });
  });

  it('refuses what is not a card, each with its own code', () => {
    expect(ownerFileTarget(root, 'docs/f.md')).toEqual({ error: 'unsupported_file' });
    expect(ownerFileTarget(root, 'docs/h.txt')).toEqual({ error: 'unsupported_file' });
    expect(ownerFileTarget(root, 'docs/with space.html')).toEqual({ error: 'file_name_space' });
    expect(ownerFileTarget(root, 'docs/narrow space.html')).toEqual({ error: 'file_name_space' });
    expect(ownerFileTarget(root, 'docs')).toEqual({ error: 'not_a_file' });
    expect(ownerFileTarget(root, '.')).toEqual({ error: 'not_a_file' });
    expect(ownerFileTarget(root, 'docs/none.html')).toEqual({ error: 'unknown_file' });
  });

  it('a path outside the project is refused, however it gets there', () => {
    expect(ownerFileTarget(root, join(outside, 'secret.html'))).toEqual({ error: 'outside_project' });
    expect(ownerFileTarget(root, '../elsewhere/secret.html')).toEqual({ error: 'outside_project' });
    symlinkSync(join(outside, 'secret.html'), join(root, 'out.html'));
    expect(ownerFileTarget(root, 'out.html')).toEqual({ error: 'outside_project' });
    symlinkSync(outside, join(root, 'outdir'));
    expect(ownerFileTarget(root, 'outdir/secret.html')).toEqual({ error: 'outside_project' });
  });

  it('a path that cannot be read is unknown, never a throw', () => {
    expect(ownerFileTarget(root, 'docs/a\0.html')).toEqual({ error: 'unknown_file' });
    expect(ownerFileTarget(root, 'docs/a.html/nested.html')).toEqual({ error: 'unknown_file' });
    expect(ownerFileTarget(root, `${'x'.repeat(5000)}.html`)).toEqual({ error: 'unknown_file' });
    symlinkSync(join(root, 'loop'), join(root, 'loop'));
    expect(ownerFileTarget(root, 'loop')).toEqual({ error: 'unknown_file' });
    expect(ownerFileTarget(join(dir, 'no-project'), 'x.html')).toEqual({ error: 'unknown_file' });
  });
});
