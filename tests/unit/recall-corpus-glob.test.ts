import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildCorpus } from '../../src/lib/recall.js';

// ── B1 regression: recursive `**/*.md` glob + `product` field ────────────────
// loadMarkdownDocs uses fg.sync('**/*.md', …) so knowledge/ docs nested under
// products/<name>/ are now indexed, and productFromRelPath derives the product.

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ac-corpus-glob-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMd(path: string, frontmatter: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `---\n${frontmatter}\n---\n\n${body}\n`);
}

describe('buildCorpus B1: recursive knowledge glob + product field', () => {
  let root: string;
  let knowledge: string;

  beforeEach(() => {
    root = makeTmpDir();
    knowledge = join(root, 'knowledge');
    mkdirSync(knowledge, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('indexes both a top-level doc and a nested products/<name>/ doc', () => {
    writeMd(join(knowledge, 'a.md'), 'title: A', 'Top level doc about alpha.');
    writeMd(
      join(knowledge, 'products', 'widgets', 'deep.md'),
      'title: Deep',
      'Nested doc about widget internals.',
    );

    const docs = buildCorpus(root, { types: ['knowledge'] });
    const slugs = docs.map((d) => d.slug).sort();
    expect(slugs).toEqual(['a', 'deep']);
  });

  it('sets product === "widgets" on the nested doc and leaves top-level product undefined', () => {
    writeMd(join(knowledge, 'a.md'), 'title: A', 'Top level doc.');
    writeMd(
      join(knowledge, 'products', 'widgets', 'deep.md'),
      'title: Deep',
      'Nested doc.',
    );

    const docs = buildCorpus(root, { types: ['knowledge'] });

    const deep = docs.find((d) => d.slug === 'deep');
    expect(deep).toBeDefined();
    expect(deep!.product).toBe('widgets');
    // relPath is anchored to the context root (used by productFromRelPath).
    expect(deep!.relPath).toBe(join('knowledge', 'products', 'widgets', 'deep.md'));

    const a = docs.find((d) => d.slug === 'a');
    expect(a).toBeDefined();
    expect(a!.product).toBeUndefined();
  });

  it('derives product from the directory directly under knowledge/products/', () => {
    writeMd(
      join(knowledge, 'products', 'gadgets', 'spec', 'x.md'),
      'title: X',
      'Doc two levels under the product dir.',
    );

    const docs = buildCorpus(root, { types: ['knowledge'] });
    const x = docs.find((d) => d.slug === 'x');
    expect(x).toBeDefined();
    // product is the FIRST segment after knowledge/products/, regardless of depth.
    expect(x!.product).toBe('gadgets');
  });
});
