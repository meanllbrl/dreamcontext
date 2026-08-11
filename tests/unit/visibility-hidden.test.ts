import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildKnowledgeIndex } from '../../src/lib/knowledge-index.js';
import { buildCorpus } from '../../src/lib/recall.js';
import { computeDigest } from '../../src/lib/federation-digest.js';

// ── `visibility: false` ─────────────────────────────────────────────────────
// The author's escape hatch: the file stays on disk and stays on the dashboard,
// but leaves every AGENT surface. Two choke points enforce it —
// buildKnowledgeIndex (index/snapshot/graph) and loadMarkdownDocs (the whole
// recall corpus, which also feeds embeddings, taxonomy, sleep and the peer
// digest). Both are covered here, plus the leak-critical federation path.

function makeRoot(prefix: string): string {
  const root = join(
    tmpdir(),
    `dc-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    '_dream_context',
  );
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  return root;
}

function writeMd(path: string, frontmatter: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `---\n${frontmatter}\n---\n\n${body}\n`, 'utf-8');
}

describe('visibility: false — knowledge index', () => {
  let root: string;

  beforeEach(() => { root = makeRoot('vis-index'); });
  afterEach(() => { rmSync(join(root, '..'), { recursive: true, force: true }); });

  it('drops a hidden file from the default index and keeps the visible one', () => {
    writeMd(join(root, 'knowledge', 'public.md'), 'name: Public', 'Shared content.');
    writeMd(join(root, 'knowledge', 'secret.md'), 'name: Secret\nvisibility: false', 'Private content.');

    const entries = buildKnowledgeIndex(root);
    expect(entries.map((e) => e.slug)).toEqual(['public']);
  });

  it('hides a file even when it is pinned — the opt-out wins over the pin', () => {
    writeMd(join(root, 'knowledge', 'secret.md'), 'name: Secret\npinned: true\nvisibility: false', 'Private.');
    expect(buildKnowledgeIndex(root)).toEqual([]);
  });

  it('keeps the file listed under includeHidden and flags it (the dashboard path)', () => {
    writeMd(join(root, 'knowledge', 'public.md'), 'name: Public', 'Shared content.');
    writeMd(join(root, 'knowledge', 'secret.md'), 'name: Secret\nvisibility: false', 'Private content.');

    const entries = buildKnowledgeIndex(root, { includeHidden: true });
    expect(entries.map((e) => e.slug)).toEqual(['public', 'secret']);
    expect(entries.find((e) => e.slug === 'secret')?.hidden).toBe(true);
    // A visible file never carries the flag — the badge must not render for it.
    expect(entries.find((e) => e.slug === 'public')?.hidden).toBeUndefined();
  });

  it('indexes as normal unless the opt-out is explicit', () => {
    writeMd(join(root, 'knowledge', 'a.md'), 'name: A', 'No visibility field.');
    writeMd(join(root, 'knowledge', 'b.md'), 'name: B\nvisibility: true', 'Explicitly visible.');
    writeMd(join(root, 'knowledge', 'c.md'), 'name: C\nvisibility: public', 'Explicitly public.');

    expect(buildKnowledgeIndex(root).map((e) => e.slug)).toEqual(['a', 'b', 'c']);
  });

  it('accepts the quoted and human forms of the opt-out', () => {
    writeMd(join(root, 'knowledge', 'q.md'), 'name: Q\nvisibility: "false"', 'Quoted false.');
    writeMd(join(root, 'knowledge', 'p.md'), 'name: P\nvisibility: private', 'Private synonym.');
    writeMd(join(root, 'knowledge', 'h.md'), 'name: H\nvisibility: Hidden', 'Hidden synonym, mixed case.');

    expect(buildKnowledgeIndex(root)).toEqual([]);
  });
});

describe('visibility: false — recall corpus', () => {
  let root: string;

  beforeEach(() => { root = makeRoot('vis-corpus'); });
  afterEach(() => { rmSync(join(root, '..'), { recursive: true, force: true }); });

  it('drops a hidden knowledge doc from the corpus', () => {
    writeMd(join(root, 'knowledge', 'public.md'), 'name: Public', 'Observability tracing pipeline.');
    writeMd(join(root, 'knowledge', 'secret.md'), 'name: Secret\nvisibility: false', 'Observability tracing pipeline.');

    const docs = buildCorpus(root, { types: ['knowledge'] });
    expect(docs.map((d) => d.slug)).toEqual(['public']);
  });

  it('applies to any frontmatter doc type, not just knowledge (task here)', () => {
    writeMd(join(root, 'state', 'open-work.md'), 'name: Open work\nstatus: in_progress', 'Task body.');
    writeMd(join(root, 'state', 'quiet-work.md'), 'name: Quiet work\nstatus: in_progress\nvisibility: false', 'Task body.');

    const docs = buildCorpus(root, { types: ['task'] });
    expect(docs.map((d) => d.slug)).toEqual(['open-work']);
  });

  it('drops a hidden doc nested in a context folder', () => {
    writeMd(join(root, 'knowledge', 'products', 'widgets', 'deep.md'), 'name: Deep\nvisibility: false', 'Nested private doc.');
    expect(buildCorpus(root, { types: ['knowledge'] })).toEqual([]);
  });
});

describe('visibility: false — federation digest', () => {
  let sender: string;

  beforeEach(() => { sender = makeRoot('vis-digest'); });
  afterEach(() => { rmSync(join(sender, '..'), { recursive: true, force: true }); });

  it('never pushes a hidden doc to a peer', () => {
    const profile = { terms: ['observability', 'tracing'], query: 'observability tracing' };
    writeMd(join(sender, 'knowledge', 'shared.md'), 'name: shared\ntype: knowledge', 'observability tracing pipeline we share');
    writeMd(join(sender, 'knowledge', 'private.md'), 'name: private\ntype: knowledge\nvisibility: false', 'observability tracing pipeline we keep');

    const entries = computeDigest(sender, 'sender', profile, null, 10);
    expect(entries.some((e) => e.title === 'shared')).toBe(true);
    expect(entries.some((e) => e.title === 'private')).toBe(false);
  });
});
