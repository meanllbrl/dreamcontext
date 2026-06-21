import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mergeKnowledgeFiles } from '../../src/lib/knowledge-merge.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dc-kmerge-'));
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  return root;
}

function writeMd(root: string, relPath: string, content: string): string {
  const full = join(root, relPath);
  mkdirSync(full.replace(/\/[^/]+$/, ''), { recursive: true });
  writeFileSync(full, content, 'utf-8');
  return full;
}

function read(root: string, relPath: string): string {
  return readFileSync(join(root, relPath), 'utf-8');
}

const KNOWLEDGE = (name: string, tags: string[] = [], body = 'body text') =>
  [
    '---',
    `name: ${name}`,
    'description: x',
    `tags: [${tags.map((t) => `"${t}"`).join(', ')}]`,
    '---',
    '',
    body,
  ].join('\n');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('knowledge-merge', () => {
  let root: string;

  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('appends src body to dst under the merged-from marker', () => {
    writeMd(root, 'knowledge/alpha.md', KNOWLEDGE('alpha', ['a'], 'Alpha body'));
    writeMd(root, 'knowledge/beta.md', KNOWLEDGE('beta', ['b'], 'Beta body'));

    const r = mergeKnowledgeFiles(root, 'alpha', 'beta');

    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const dstContent = read(root, 'knowledge/beta.md');
    expect(dstContent).toContain('<!-- merged-from: alpha -->');
    expect(dstContent).toContain('Alpha body');
    // Destination original body preserved
    expect(dstContent).toContain('Beta body');
    expect(r.contentMerged).toBe(true);
  });

  it('unions tags from src into dst (deduped, dst order preserved)', () => {
    writeMd(root, 'knowledge/src-file.md', KNOWLEDGE('src-file', ['a', 'c', 'd'], 'src'));
    writeMd(root, 'knowledge/dst-file.md', KNOWLEDGE('dst-file', ['a', 'b'], 'dst'));

    const r = mergeKnowledgeFiles(root, 'src-file', 'dst-file');
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 'a' is already in dst; 'c' and 'd' are new
    expect(r.tagsAdded).toEqual(['c', 'd']);

    const dstContent = read(root, 'knowledge/dst-file.md');
    // All four tags present
    expect(dstContent).toContain('a');
    expect(dstContent).toContain('b');
    expect(dstContent).toContain('c');
    expect(dstContent).toContain('d');
  });

  it('repoints inbound [[src]] wikilinks in a third file to [[dst]]', () => {
    writeMd(root, 'knowledge/source.md', KNOWLEDGE('source', [], 'Source content'));
    writeMd(root, 'knowledge/dest.md', KNOWLEDGE('dest', [], 'Dest content'));
    writeMd(root, 'knowledge/third.md', [
      '---', 'name: third', '---', '',
      'Links: [[source]] and [[source|alias]] and [[source#anchor]].',
    ].join('\n'));

    const r = mergeKnowledgeFiles(root, 'source', 'dest');
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.wikilinksRewritten.length).toBe(1);

    const thirdContent = read(root, 'knowledge/third.md');
    expect(thirdContent).toContain('[[dest]]');
    expect(thirdContent).toContain('[[dest|alias]]');
    expect(thirdContent).toContain('[[dest#anchor]]');
    expect(thirdContent).not.toContain('[[source]]');
  });

  it('deletes the src file after merging', () => {
    writeMd(root, 'knowledge/gone.md', KNOWLEDGE('gone', [], 'Gone body'));
    writeMd(root, 'knowledge/kept.md', KNOWLEDGE('kept', [], 'Kept body'));

    const r = mergeKnowledgeFiles(root, 'gone', 'kept');
    expect(r.ok).toBe(true);

    expect(existsSync(join(root, 'knowledge/gone.md'))).toBe(false);
  });

  it('retains the dst file with merged content', () => {
    writeMd(root, 'knowledge/src.md', KNOWLEDGE('src', [], 'Src body'));
    writeMd(root, 'knowledge/dst.md', KNOWLEDGE('dst', [], 'Dst body'));

    const r = mergeKnowledgeFiles(root, 'src', 'dst');
    expect(r.ok).toBe(true);

    expect(existsSync(join(root, 'knowledge/dst.md'))).toBe(true);
    const dstContent = read(root, 'knowledge/dst.md');
    expect(dstContent).toContain('Dst body');
    expect(dstContent).toContain('Src body');
  });

  it('is idempotent: running merge twice does not double-append body', () => {
    writeMd(root, 'knowledge/s.md', KNOWLEDGE('s', [], 'S body'));
    writeMd(root, 'knowledge/d.md', KNOWLEDGE('d', [], 'D body'));

    // First merge succeeds
    const r1 = mergeKnowledgeFiles(root, 's', 'd');
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.contentMerged).toBe(true);

    // Re-create src to simulate a crash before deletion
    writeMd(root, 'knowledge/s.md', KNOWLEDGE('s', [], 'S body'));

    // Second merge: marker already present, no double-append
    const r2 = mergeKnowledgeFiles(root, 's', 'd');
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.contentMerged).toBe(false);

    const dstContent = read(root, 'knowledge/d.md');
    const markerCount = (dstContent.match(/<!-- merged-from: s -->/g) ?? []).length;
    expect(markerCount).toBe(1);
  });

  it('idempotency: pre-existing marker skips content append', () => {
    // Simulate a state where dst already has the marker (crash after dst write but before src delete)
    const marker = '<!-- merged-from: pre-src -->';
    writeMd(root, 'knowledge/pre-src.md', KNOWLEDGE('pre-src', [], 'Pre-src body'));
    writeMd(root, 'knowledge/pre-dst.md', [
      '---', 'name: pre-dst', '---', '',
      'Dst body.',
      '',
      marker,
      '',
      'Pre-src body',
    ].join('\n'));

    const r = mergeKnowledgeFiles(root, 'pre-src', 'pre-dst');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contentMerged).toBe(false);

    const dstContent = read(root, 'knowledge/pre-dst.md');
    const markerCount = (dstContent.match(/<!-- merged-from: pre-src -->/g) ?? []).length;
    expect(markerCount).toBe(1);
    // src deleted
    expect(existsSync(join(root, 'knowledge/pre-src.md'))).toBe(false);
  });

  it('returns ok:false with code unsafe-slug for a dangerous src slug', () => {
    const r = mergeKnowledgeFiles(root, '../../../etc/passwd', 'dst');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('unsafe-slug');
  });

  it('returns ok:false with code unsafe-slug for a dangerous dst slug', () => {
    writeMd(root, 'knowledge/legit.md', KNOWLEDGE('legit', [], 'legit'));
    const r = mergeKnowledgeFiles(root, 'legit', '../../escape');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('unsafe-slug');
  });

  it('returns ok:false with code src-not-found when src does not exist', () => {
    writeMd(root, 'knowledge/dst-only.md', KNOWLEDGE('dst-only', [], 'dst'));
    const r = mergeKnowledgeFiles(root, 'no-such-file', 'dst-only');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('src-not-found');
  });

  it('returns ok:false with code dst-not-found when dst does not exist', () => {
    writeMd(root, 'knowledge/src-only.md', KNOWLEDGE('src-only', [], 'src'));
    const r = mergeKnowledgeFiles(root, 'src-only', 'no-such-dst');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('dst-not-found');
  });

  it('returns ok:false with code same-file when src and dst are the same', () => {
    writeMd(root, 'knowledge/same.md', KNOWLEDGE('same', [], 'same'));
    const r = mergeKnowledgeFiles(root, 'same', 'same');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('same-file');
  });

  it('does not rewrite wikilinks inside fenced code blocks', () => {
    writeMd(root, 'knowledge/rewrite-src.md', KNOWLEDGE('rewrite-src', [], 'src content'));
    writeMd(root, 'knowledge/rewrite-dst.md', KNOWLEDGE('rewrite-dst', [], 'dst content'));
    writeMd(root, 'knowledge/watcher.md', [
      '---', 'name: watcher', '---', '',
      'Live link [[rewrite-src]].',
      '',
      '```md',
      'Example: [[rewrite-src]] stays literal.',
      '```',
      '',
      'Tail [[rewrite-src]].',
    ].join('\n'));

    const r = mergeKnowledgeFiles(root, 'rewrite-src', 'rewrite-dst');
    expect(r.ok).toBe(true);

    const watcherContent = read(root, 'knowledge/watcher.md');
    // Live links rewritten
    expect(watcherContent).toContain('Live link [[rewrite-dst]].');
    expect(watcherContent).toContain('Tail [[rewrite-dst]].');
    // Fenced link preserved
    expect(watcherContent).toContain('Example: [[rewrite-src]] stays literal.');
  });

  it('returns result with srcPath and dstPath relative to contextRoot', () => {
    writeMd(root, 'knowledge/p.md', KNOWLEDGE('p', [], 'p'));
    writeMd(root, 'knowledge/q.md', KNOWLEDGE('q', [], 'q'));

    const r = mergeKnowledgeFiles(root, 'p', 'q');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.srcPath).toBe('knowledge/p.md');
    expect(r.dstPath).toBe('knowledge/q.md');
    expect(r.srcSlug).toBe('p');
    expect(r.dstSlug).toBe('q');
  });

  it('supports subfolder slugs (e.g. patterns/foo → patterns/bar)', () => {
    writeMd(root, 'knowledge/patterns/foo.md', KNOWLEDGE('foo', ['tag1'], 'Foo body'));
    writeMd(root, 'knowledge/patterns/bar.md', KNOWLEDGE('bar', ['tag2'], 'Bar body'));

    const r = mergeKnowledgeFiles(root, 'patterns/foo', 'patterns/bar');
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(existsSync(join(root, 'knowledge/patterns/foo.md'))).toBe(false);
    const dstContent = read(root, 'knowledge/patterns/bar.md');
    expect(dstContent).toContain('<!-- merged-from: patterns/foo -->');
    expect(dstContent).toContain('Foo body');
    expect(r.srcPath).toBe('knowledge/patterns/foo.md');
    expect(r.dstPath).toBe('knowledge/patterns/bar.md');
  });
});
