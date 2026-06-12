import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  rewriteWikilinks,
  rewriteFileContent,
} from '../../src/lib/wikilink-rewrite.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dc-wikilink-'));
}

function writeMd(root: string, relPath: string, content: string): string {
  const dir = join(root, relPath.replace(/\/[^/]+$/, ''));
  mkdirSync(dir, { recursive: true });
  const p = join(root, relPath);
  writeFileSync(p, content, 'utf-8');
  return p;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('wikilink-rewrite', () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('rewrites [[foo]], [[foo|alias]], [[foo#anchor]] on slug move; lists changed files', () => {
    writeMd(root, 'knowledge/linker.md', [
      '---',
      'name: linker',
      '---',
      '',
      'See [[old-slug]] for details.',
      'Also [[old-slug|My Link]] and [[old-slug#section]] and [[old-slug#section|Named]].',
    ].join('\n'));

    const changed = rewriteWikilinks(root, [
      { from: 'old-slug', to: 'new-slug' },
    ]);

    expect(changed.length).toBeGreaterThanOrEqual(1);
    const content = readFileSync(join(root, 'knowledge', 'linker.md'), 'utf-8');
    expect(content).toContain('[[new-slug]]');
    expect(content).toContain('[[new-slug|My Link]]');
    expect(content).toContain('[[new-slug#section]]');
    expect(content).toContain('[[new-slug#section|Named]]');
    // old slug must be gone
    expect(content).not.toContain('[[old-slug]]');
    expect(content).not.toContain('[[old-slug|');
    expect(content).not.toContain('[[old-slug#');
  });

  it('does NOT rewrite inside fenced code blocks', () => {
    writeMd(root, 'knowledge/doc.md', [
      '---',
      'name: doc',
      '---',
      '',
      'Normal text [[old-slug]] here.',
      '',
      '```bash',
      'echo [[old-slug]]',
      '```',
      '',
      'After fence [[old-slug]] again.',
    ].join('\n'));

    rewriteWikilinks(root, [{ from: 'old-slug', to: 'new-slug' }]);

    const content = readFileSync(join(root, 'knowledge', 'doc.md'), 'utf-8');
    // Rewrites outside fence
    expect(content).toContain('Normal text [[new-slug]] here.');
    // Does NOT rewrite inside fence
    expect(content).toContain('echo [[old-slug]]');
    // Rewrites after fence
    expect(content).toContain('After fence [[new-slug]] again.');
  });

  it('returns empty array when no remaps match', () => {
    writeMd(root, 'knowledge/doc.md', '---\nname: doc\n---\n\nNo wikilinks here.\n');
    const changed = rewriteWikilinks(root, [{ from: 'missing', to: 'other' }]);
    expect(changed).toHaveLength(0);
  });

  it('rewriteFileContent handles empty remapMap', () => {
    const content = 'See [[foo]] here.';
    expect(rewriteFileContent(content, new Map())).toBe(content);
  });

  it('rewriteFileContent preserves unchanged content byte-for-byte', () => {
    const content = '# Title\n\nSee [[unrelated]] here.\n';
    const map = new Map([['other', 'new']]);
    expect(rewriteFileContent(content, map)).toBe(content);
  });

  it('rewriteFileContent handles multiple remaps in one file', () => {
    const content = '[[a]] and [[b]] and [[c]].';
    const map = new Map([['a', 'x'], ['b', 'y']]);
    const result = rewriteFileContent(content, map);
    expect(result).toBe('[[x]] and [[y]] and [[c]].');
  });

  it('a language-tagged line inside a fenced block does NOT close it (wikilinks stay fenced)', () => {
    const content = [
      '```',
      '[[old]] inside fence',
      '```ts',                 // info-string line INSIDE the block — NOT a closer
      '[[old]] still inside',
      '```',                   // the real (bare) closing fence
      '',
      '[[old]] outside',       // only THIS one should be rewritten
    ].join('\n');
    const result = rewriteFileContent(content, new Map([['old', 'new']]));
    expect(result).toContain('[[old]] inside fence');   // fenced — untouched
    expect(result).toContain('[[old]] still inside');   // fenced — untouched (the bug rewrote this)
    expect(result).toContain('[[new]] outside');        // non-fenced — rewritten
    expect(result).not.toContain('[[new]] still inside');
  });
});
