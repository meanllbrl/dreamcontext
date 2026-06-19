import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { moveKnowledgeFile } from '../../src/lib/knowledge-move.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dc-kmove-'));
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

const KNOWLEDGE = (name: string, body = 'body') =>
  ['---', `name: ${name}`, 'description: x', '---', '', body].join('\n');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('knowledge-move', () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('moves a flat file into a topical subfolder and reports new slug/path', () => {
    writeMd(root, 'knowledge/fitness-blueprint.md', KNOWLEDGE('fitness-blueprint'));

    const r = moveKnowledgeFile(root, 'fitness-blueprint', 'fitness');

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.oldSlug).toBe('fitness-blueprint');
    expect(r.newSlug).toBe('fitness/fitness-blueprint');
    expect(r.oldPath).toBe('knowledge/fitness-blueprint.md');
    expect(r.newPath).toBe('knowledge/fitness/fitness-blueprint.md');
    expect(existsSync(join(root, 'knowledge/fitness-blueprint.md'))).toBe(false);
    expect(existsSync(join(root, 'knowledge/fitness/fitness-blueprint.md'))).toBe(true);
  });

  it('rewrites inbound [[wikilinks]] (target, alias, anchor) to the new slug', () => {
    writeMd(root, 'knowledge/fitness-blueprint.md', KNOWLEDGE('fitness-blueprint'));
    writeMd(root, 'knowledge/linker.md', [
      '---', 'name: linker', '---', '',
      'See [[fitness-blueprint]].',
      'Also [[fitness-blueprint|The Plan]] and [[fitness-blueprint#intro]].',
    ].join('\n'));

    const r = moveKnowledgeFile(root, 'fitness-blueprint', 'fitness');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.wikilinksRewritten.length).toBe(1);

    const linker = read(root, 'knowledge/linker.md');
    expect(linker).toContain('[[fitness/fitness-blueprint]]');
    expect(linker).toContain('[[fitness/fitness-blueprint|The Plan]]');
    expect(linker).toContain('[[fitness/fitness-blueprint#intro]]');
    expect(linker).not.toContain('[[fitness-blueprint]]');
  });

  it('accepts nested destination folders', () => {
    writeMd(root, 'knowledge/lina-spec.md', KNOWLEDGE('lina-spec'));
    const r = moveKnowledgeFile(root, 'lina-spec', 'lina/specs');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.newSlug).toBe('lina/specs/lina-spec');
    expect(existsSync(join(root, 'knowledge/lina/specs/lina-spec.md'))).toBe(true);
  });

  it('tolerates a slug passed with a trailing .md', () => {
    writeMd(root, 'knowledge/memoryos-arch.md', KNOWLEDGE('memoryos-arch'));
    const r = moveKnowledgeFile(root, 'memoryos-arch.md', 'memoryos');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.newSlug).toBe('memoryos/memoryos-arch');
  });

  it('re-folders an already-foldered file by basename', () => {
    writeMd(root, 'knowledge/products/lina.md', KNOWLEDGE('lina'));
    const r = moveKnowledgeFile(root, 'products/lina', 'lina');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.newSlug).toBe('lina/lina');
    expect(existsSync(join(root, 'knowledge/lina/lina.md'))).toBe(true);
    expect(existsSync(join(root, 'knowledge/products/lina.md'))).toBe(false);
  });

  it('fails when the source file does not exist', () => {
    const r = moveKnowledgeFile(root, 'ghost', 'fitness');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('not-found');
  });

  it('fails (already-there) when the file is already in the target folder', () => {
    writeMd(root, 'knowledge/fitness/blueprint.md', KNOWLEDGE('blueprint'));
    const r = moveKnowledgeFile(root, 'fitness/blueprint', 'fitness');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('already-there');
  });

  it('never clobbers an existing destination file', () => {
    writeMd(root, 'knowledge/dup.md', KNOWLEDGE('dup', 'SOURCE'));
    writeMd(root, 'knowledge/fitness/dup.md', KNOWLEDGE('dup', 'EXISTING'));
    const r = moveKnowledgeFile(root, 'dup', 'fitness');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('dest-exists');
    // The existing destination is untouched and the source still exists.
    expect(read(root, 'knowledge/fitness/dup.md')).toContain('EXISTING');
    expect(existsSync(join(root, 'knowledge/dup.md'))).toBe(true);
  });

  it('rejects path-traversal in the destination folder', () => {
    writeMd(root, 'knowledge/escape.md', KNOWLEDGE('escape'));
    const r = moveKnowledgeFile(root, 'escape', '../../etc');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('unsafe-folder');
    // File stays put — nothing escaped knowledge/.
    expect(existsSync(join(root, 'knowledge/escape.md'))).toBe(true);
  });

  it('rejects path-traversal in the slug', () => {
    const r = moveKnowledgeFile(root, '../../../secret', 'fitness');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('unsafe-slug');
  });

  it('does not rewrite a different slug that shares a prefix with the moved one', () => {
    writeMd(root, 'knowledge/foo.md', KNOWLEDGE('foo'));
    writeMd(root, 'knowledge/foo-bar.md', KNOWLEDGE('foo-bar'));
    writeMd(root, 'knowledge/linker.md', [
      '---', 'name: linker', '---', '',
      'Move target [[foo]]. Sibling [[foo-bar]] must stay.',
    ].join('\n'));

    const r = moveKnowledgeFile(root, 'foo', 'grp');
    expect(r.ok).toBe(true);

    const linker = read(root, 'knowledge/linker.md');
    expect(linker).toContain('[[grp/foo]]');
    expect(linker).toContain('[[foo-bar]]');      // exact-match remap, not prefix
    expect(linker).not.toContain('[[grp/foo-bar]]');
  });

  it('is idempotent on the crash-recovery path (links already point to the new slug, file still flat)', () => {
    // Simulate a crash AFTER the wikilink rewrite but BEFORE the rename:
    // links already target the new slug, the source file is still at the old path.
    writeMd(root, 'knowledge/topic.md', KNOWLEDGE('topic'));
    writeMd(root, 'knowledge/linker.md', [
      '---', 'name: linker', '---', '',
      'Already-rewritten [[group/topic]] link.',
    ].join('\n'));

    const r = moveKnowledgeFile(root, 'topic', 'group');
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Move completes; the already-correct link is NOT double-rewritten.
    expect(existsSync(join(root, 'knowledge/topic.md'))).toBe(false);
    expect(existsSync(join(root, 'knowledge/group/topic.md'))).toBe(true);
    const linker = read(root, 'knowledge/linker.md');
    expect(linker).toContain('Already-rewritten [[group/topic]] link.');
    expect(linker).not.toContain('[[group/group/topic]]');
    // No [[topic]] existed, so nothing needed rewriting this run.
    expect(r.wikilinksRewritten).toHaveLength(0);
  });

  it('does not corrupt wikilinks living inside fenced code blocks', () => {
    writeMd(root, 'knowledge/topic.md', KNOWLEDGE('topic'));
    writeMd(root, 'knowledge/doc.md', [
      '---', 'name: doc', '---', '',
      'Live link [[topic]].',
      '',
      '```md',
      'Example: [[topic]] stays literal.',
      '```',
      '',
      'Tail [[topic]].',
    ].join('\n'));

    const r = moveKnowledgeFile(root, 'topic', 'group');
    expect(r.ok).toBe(true);

    // Exact: live links rewritten, fenced link stays literal, and the blank
    // lines around the fence are preserved (no byte loss at fence boundary).
    expect(read(root, 'knowledge/doc.md')).toBe([
      '---', 'name: doc', '---', '',
      'Live link [[group/topic]].',
      '',
      '```md',
      'Example: [[topic]] stays literal.',
      '```',
      '',
      'Tail [[group/topic]].',
    ].join('\n'));
  });
});
