import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCorpus, bm25Search } from '../../src/lib/recall.js';
import { createInsight } from '../../src/lib/lab/store.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-lab-recall-'));
  mkdirSync(join(root, 'core'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('insight recall — AC14', () => {
  it('"insight" is part of buildCorpus defaults (no --types filter needed)', () => {
    createInsight(root, {
      slug: 'wau',
      title: 'Weekly Active Users',
      description: 'Distinct users who performed a core action in the last 7 days — the primary engagement signal.',
    });
    const corpus = buildCorpus(root);
    const insightDocs = corpus.filter((d) => d.type === 'insight');
    expect(insightDocs).toHaveLength(1);
    expect(insightDocs[0].slug).toBe('wau');
  });

  it('a memory recall for a meaning phrase surfaces the insight when scoped --types insight', () => {
    createInsight(root, {
      slug: 'wau',
      title: 'Weekly Active Users',
      description: 'Distinct users who performed a core action in the last 7 days — the primary engagement signal.',
    });
    const corpus = buildCorpus(root, { types: ['insight'] });
    expect(corpus).toHaveLength(1);
    const hits = bm25Search('weekly active users engagement signal', corpus);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].doc.slug).toBe('wau');
  });
});
