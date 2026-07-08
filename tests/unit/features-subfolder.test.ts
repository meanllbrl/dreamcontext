import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  featureSlug,
  featureSlugFromRoot,
  featureProduct,
  featureProductFromRelPath,
  featuresDir,
} from '../../src/lib/features-path.js';
import { buildCorpus } from '../../src/lib/recall.js';
import { featuresAreZero } from '../../src/lib/initializer-detect.js';
import { findUnreleasedFeatures } from '../../src/lib/release-discovery.js';
import { backPopulateFeatures } from '../../src/lib/release-backpopulate.js';
import { buildGraph } from '../../src/lib/graph.js';
import { moveKnowledgeFile } from '../../src/lib/knowledge-move.js';
import { readFrontmatter } from '../../src/lib/frontmatter.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────
//
// Features are typed knowledge under knowledge/features/. These tests prove the
// read-side consumers recurse into topical/product subfolders and emit
// folder-qualified slugs/paths (never a basename that collides across products).

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dc-featsub-'));
  mkdirSync(join(root, 'knowledge', 'features'), { recursive: true });
  return root;
}

function writeFeature(
  root: string,
  relSlug: string,
  fm: Record<string, string> = {},
): string {
  const full = join(featuresDir(root), `${relSlug}.md`);
  mkdirSync(full.replace(/\/[^/]+$/, ''), { recursive: true });
  const front = Object.entries({
    id: `feat_${relSlug.replace(/[^a-z0-9]/gi, '')}`,
    type: 'feature',
    name: relSlug.split('/').pop() as string,
    status: 'active',
    released_version: 'null',
    ...fm,
  })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  writeFileSync(full, `---\n${front}\n---\n\n## Why\n\nbecause.\n`, 'utf-8');
  return full;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('features subfolders', () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  describe('featureSlug', () => {
    it('returns the basename for a flat feature', () => {
      const f = writeFeature(root, 'global-search');
      expect(featureSlug(featuresDir(root), f)).toBe('global-search');
      expect(featureSlugFromRoot(root, f)).toBe('global-search');
    });

    it('keeps the folder prefix for a nested feature', () => {
      const f = writeFeature(root, 'lina/checkout-flow');
      expect(featureSlug(featuresDir(root), f)).toBe('lina/checkout-flow');
    });

    it('keeps a multi-level folder prefix', () => {
      const f = writeFeature(root, 'lina/growth/onboarding');
      expect(featureSlugFromRoot(root, f)).toBe('lina/growth/onboarding');
    });
  });

  describe('featureProduct (single source of truth — folder-derived)', () => {
    it('is the top-level folder for a nested feature', () => {
      const f = writeFeature(root, 'lina/checkout-flow');
      expect(featureProduct(featuresDir(root), f)).toBe('lina');
    });

    it('is the TOP-level folder for a deeply nested feature (deeper = intra-product)', () => {
      const f = writeFeature(root, 'lina/growth/onboarding');
      expect(featureProduct(featuresDir(root), f)).toBe('lina');
    });

    it('is undefined for a flat (unscoped) feature', () => {
      const f = writeFeature(root, 'global-search');
      expect(featureProduct(featuresDir(root), f)).toBeUndefined();
    });
  });

  describe('featureProductFromRelPath', () => {
    it('derives the product from a nested feature relPath', () => {
      expect(featureProductFromRelPath('knowledge/features/lina/checkout.md')).toBe('lina');
      expect(featureProductFromRelPath('knowledge/features/memoryos/deep/x.md')).toBe('memoryos');
    });

    it('is undefined for a flat feature relPath', () => {
      expect(featureProductFromRelPath('knowledge/features/checkout.md')).toBeUndefined();
    });

    it('is undefined for a non-feature path', () => {
      expect(featureProductFromRelPath('knowledge/lina/checkout.md')).toBeUndefined();
    });
  });

  describe('recall corpus product facet (path-derived, never frontmatter)', () => {
    it('sets product from the folder for a nested feature and ignores a conflicting frontmatter field', () => {
      // Even a (hand-added, discouraged) frontmatter product must not win — the
      // path is the only source, so this can never diverge.
      writeFeature(root, 'lina/checkout-flow', { product: 'memoryos' });
      writeFeature(root, 'global-search');
      mkdirSync(join(root, 'state'), { recursive: true });

      const corpus = buildCorpus(root, { types: ['feature'] });
      const nested = corpus.find((d) => d.slug === 'checkout-flow' && d.relPath.includes('lina/'));
      const flat = corpus.find((d) => d.slug === 'global-search');

      expect(nested?.product).toBe('lina');   // folder wins, not the frontmatter 'memoryos'
      expect(flat?.product).toBeUndefined();   // flat feature is unscoped
    });
  });

  describe('featuresAreZero', () => {
    it('is true for an empty features dir', () => {
      expect(featuresAreZero(root)).toBe(true);
    });

    it('is true when the features dir does not exist', () => {
      rmSync(join(root, 'knowledge', 'features'), { recursive: true, force: true });
      expect(featuresAreZero(root)).toBe(true);
    });

    it('is false when the only feature lives in a product subfolder', () => {
      writeFeature(root, 'lina/checkout-flow');
      expect(featuresAreZero(root)).toBe(false);
    });

    it('is false for a flat feature', () => {
      writeFeature(root, 'global-search');
      expect(featuresAreZero(root)).toBe(false);
    });
  });

  describe('findUnreleasedFeatures (recurses + qualified slug)', () => {
    it('discovers nested features with their folder-qualified slug', () => {
      writeFeature(root, 'global-search');
      writeFeature(root, 'lina/checkout-flow');
      writeFeature(root, 'memoryos/checkout-flow');

      const found = findUnreleasedFeatures(root).map((f) => f.slug).sort();
      expect(found).toEqual([
        'global-search',
        'lina/checkout-flow',
        'memoryos/checkout-flow',
      ]);
    });

    it('skips already-released nested features', () => {
      writeFeature(root, 'lina/shipped', { released_version: 'v1.0.0' });
      writeFeature(root, 'lina/pending');
      const found = findUnreleasedFeatures(root).map((f) => f.slug);
      expect(found).toEqual(['lina/pending']);
    });
  });

  describe('backPopulateFeatures (recurses)', () => {
    it('stamps released_version on a nested feature by id', () => {
      const file = writeFeature(root, 'lina/checkout-flow', { id: 'feat_nested1' });
      backPopulateFeatures(root, ['feat_nested1'], 'v2.0.0');
      const { data } = readFrontmatter<Record<string, unknown>>(file);
      expect(data.released_version).toBe('v2.0.0');
    });
  });

  describe('buildGraph (recurses + qualified node)', () => {
    it('emits nested features as nodes with a folder-qualified path and label', () => {
      writeFeature(root, 'lina/checkout-flow', { id: 'feat_gnest' });
      const graph = buildGraph(root);
      const node = graph.nodes.find((n) => n.id === 'feat_gnest');
      expect(node).toBeDefined();
      expect(node!.group).toBe('feature');
      expect(node!.label).toBe('lina/checkout-flow');
      expect(node!.path).toBe('knowledge/features/lina/checkout-flow.md');
    });
  });

  describe('feature move (via the knowledge-move engine, features/ scoped)', () => {
    it('moves a flat feature into a product subfolder', () => {
      writeFeature(root, 'checkout-flow');
      const r = moveKnowledgeFile(root, 'features/checkout-flow', 'features/lina');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.newPath).toBe('knowledge/features/lina/checkout-flow.md');
      expect(existsSync(join(featuresDir(root), 'checkout-flow.md'))).toBe(false);
      expect(existsSync(join(featuresDir(root), 'lina', 'checkout-flow.md'))).toBe(true);
    });

    it('moves a nested feature back to the features root', () => {
      writeFeature(root, 'lina/onboarding');
      const r = moveKnowledgeFile(root, 'features/lina/onboarding', 'features');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.newPath).toBe('knowledge/features/onboarding.md');
      expect(existsSync(join(featuresDir(root), 'onboarding.md'))).toBe(true);
    });

    it('rewrites inbound [[wikilinks]] across the features move', () => {
      writeFeature(root, 'checkout-flow');
      const linker = join(root, 'knowledge', 'linker.md');
      writeFileSync(
        linker,
        ['---', 'name: linker', '---', '', 'See [[features/checkout-flow]].'].join('\n'),
        'utf-8',
      );
      const r = moveKnowledgeFile(root, 'features/checkout-flow', 'features/lina');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const after = readFrontmatter<Record<string, unknown>>(linker);
      expect(after.content).toContain('[[features/lina/checkout-flow]]');
      expect(after.content).not.toContain('[[features/checkout-flow]]');
    });
  });
});
