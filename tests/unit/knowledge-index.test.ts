import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildKnowledgeIndex } from '../../src/lib/knowledge-index.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ac-kidx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeKnowledge(dir: string, slug: string, frontmatter: string, body: string): void {
  writeFileSync(join(dir, 'knowledge', `${slug}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

describe('buildKnowledgeIndex', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, 'knowledge'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when knowledge directory does not exist', () => {
    const other = makeTmpDir();
    const entries = buildKnowledgeIndex(other);
    expect(entries).toEqual([]);
    rmSync(other, { recursive: true, force: true });
  });

  it('returns empty array when knowledge directory is empty', () => {
    const entries = buildKnowledgeIndex(tmpDir);
    expect(entries).toEqual([]);
  });

  it('returns correct entries for knowledge files with full frontmatter', () => {
    writeKnowledge(tmpDir, 'auth-system',
      'id: k1\nname: Auth System\ndescription: JWT-based auth flow\ntags:\n  - auth\n  - security\npinned: false\ndate: "2026-02-24"',
      'Detailed auth content.',
    );
    const entries = buildKnowledgeIndex(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      slug: 'auth-system',
      name: 'Auth System',
      description: 'JWT-based auth flow',
      tags: ['auth', 'security'],
      date: '2026-02-24',
      pinned: false,
      content: 'Detailed auth content.',
    });
    expect(entries[0].pinnedPreviewLines).toBeUndefined();
    expect(entries[0].pinnedPreviewAll).toBeUndefined();
  });

  it('reads pinned_preview_lines override from frontmatter', () => {
    writeKnowledge(tmpDir, 'capped',
      'name: Capped\npinned: true\npinned_preview_lines: 100',
      'Body.',
    );
    const entries = buildKnowledgeIndex(tmpDir);
    expect(entries[0].pinnedPreviewLines).toBe(100);
    expect(entries[0].pinnedPreviewAll).toBeUndefined();
  });

  it('reads pinned_preview: all opt-out from frontmatter', () => {
    writeKnowledge(tmpDir, 'fullpin',
      'name: Full\npinned: true\npinned_preview: all',
      'Body.',
    );
    const entries = buildKnowledgeIndex(tmpDir);
    expect(entries[0].pinnedPreviewAll).toBe(true);
    expect(entries[0].pinnedPreviewLines).toBeUndefined();
  });

  it('ignores invalid pinned_preview_lines values', () => {
    writeKnowledge(tmpDir, 'bad',
      'name: Bad\npinned: true\npinned_preview_lines: "not-a-number"',
      'Body.',
    );
    const entries = buildKnowledgeIndex(tmpDir);
    expect(entries[0].pinnedPreviewLines).toBeUndefined();
  });

  it('handles files with missing frontmatter fields gracefully', () => {
    writeKnowledge(tmpDir, 'minimal', 'id: k2', 'Some content.');
    const entries = buildKnowledgeIndex(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].slug).toBe('minimal');
    expect(entries[0].name).toBe('minimal'); // falls back to slug
    expect(entries[0].description).toBe('');
    expect(entries[0].tags).toEqual([]);
    expect(entries[0].pinned).toBe(false);
  });

  it('correctly identifies pinned files', () => {
    writeKnowledge(tmpDir, 'pinned-file',
      'name: Pinned\ndescription: Important\npinned: true',
      'Pinned content.',
    );
    const entries = buildKnowledgeIndex(tmpDir);
    expect(entries[0].pinned).toBe(true);
  });

  it('defaults pinned to false when field is missing', () => {
    writeKnowledge(tmpDir, 'no-pinned',
      'name: No Pinned Field\ndescription: Test',
      'Content.',
    );
    const entries = buildKnowledgeIndex(tmpDir);
    expect(entries[0].pinned).toBe(false);
  });

  it('sorts pinned files first, then alphabetical', () => {
    writeKnowledge(tmpDir, 'zebra', 'name: Zebra\npinned: false', 'Z content.');
    writeKnowledge(tmpDir, 'alpha', 'name: Alpha\npinned: false', 'A content.');
    writeKnowledge(tmpDir, 'middle', 'name: Middle\npinned: true', 'M content.');

    const entries = buildKnowledgeIndex(tmpDir);
    expect(entries.map(e => e.slug)).toEqual(['middle', 'alpha', 'zebra']);
  });

  it('includes body content in each entry', () => {
    writeKnowledge(tmpDir, 'with-body',
      'name: With Body\ndescription: Has content',
      '## Section\n\nRich body content here.',
    );
    const entries = buildKnowledgeIndex(tmpDir);
    expect(entries[0].content).toContain('Rich body content here.');
  });

  it('skips non-.md files', () => {
    writeFileSync(join(tmpDir, 'knowledge', 'notes.txt'), 'plain text');
    writeKnowledge(tmpDir, 'real', 'name: Real', 'Content.');
    const entries = buildKnowledgeIndex(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].slug).toBe('real');
  });
});
