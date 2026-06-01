import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCorpus, docKey } from '../../src/lib/recall.js';
import { loadGold, evaluate, formatReport } from '../../eval/harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../_dream_context');
const goldPath = process.env.GOLD_PATH ?? join(here, '../../eval/gold.jsonl');

describe('recall-eval harness', () => {
  const corpus = buildCorpus(root);
  const gold = loadGold(goldPath);
  const report = evaluate(corpus, gold);

  // Surface the numbers in test output.
  // eslint-disable-next-line no-console
  console.log('\n' + formatReport(report) + '\n');

  it('every gold expected[0] resolves to a real docKey in the corpus', () => {
    const present = new Set(corpus.map(docKey));
    const missing = gold
      .map((q) => q.expected[0])
      .filter((key) => !present.has(key));
    expect(missing).toEqual([]);
  });

  it('produces a report over a non-empty gold set with valid metrics', () => {
    expect(report.overall.n).toBeGreaterThan(0);
    expect(report.overall.recall3).toBeGreaterThanOrEqual(0);
  });
});
