import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCorpus, docKey } from '../../src/lib/recall.js';
import { loadGold, evaluate, formatReport } from '../../eval/harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../_dream_context');
const evalDir = join(here, '../../eval');
const goldPath = process.env.GOLD_PATH ?? join(evalDir, 'gold.jsonl');

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

// ─── Gold integrity: no silently-stale targets ──────────────────────────────
// A gold file that points at a doc that no longer exists makes a query
// unwinnable and quietly drags recall down (h009/h019/h021 went stale this way).
// Every `expected` AND `alt` of every gold file is resolved against a corpus.
//
//   - RECALL_EVAL_ROOT set (G1/G2, against a FROZEN brain): strict — a missing
//     target fails the test.
//   - unset (a developer's live brain, which sleep keeps changing): the same
//     check only warns, so an unrelated brain edit can't redden `npm test`.
//   - RECALL_EVAL_GOLD=<csv of gold paths> replaces the default file set
//     (every eval/gold*.jsonl in the repo) — how the held-out and h-f sets,
//     which live outside the repo, are verified against their own root.
//   - eval/gold-quarantine.json lists known-dead targets that are parked on
//     purpose: [{ id, key, since, reason }] — skipped by the check.

interface QuarantineEntry { id: string; key: string; since: string; reason: string }

describe('gold integrity', () => {
  const strictRoot = process.env.RECALL_EVAL_ROOT;
  const files = process.env.RECALL_EVAL_GOLD
    ? process.env.RECALL_EVAL_GOLD.split(',').map((p) => p.trim()).filter(Boolean)
    : readdirSync(evalDir).filter((f) => /^gold.*\.jsonl$/.test(f)).sort().map((f) => join(evalDir, f));

  const quarantinePath = join(evalDir, 'gold-quarantine.json');
  const quarantine: QuarantineEntry[] = existsSync(quarantinePath)
    ? JSON.parse(readFileSync(quarantinePath, 'utf-8'))
    : [];
  const parked = new Set(quarantine.map((e) => `${e.id}|${e.key}`));

  const present = new Set(buildCorpus(strictRoot ?? root).map(docKey));

  it('quarantine entries are complete', () => {
    for (const e of quarantine) {
      expect(typeof e.id).toBe('string');
      expect(typeof e.key).toBe('string');
      expect(e.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.reason.length).toBeGreaterThan(0);
    }
  });

  it('gold ids are unique within each file', () => {
    for (const file of files) {
      const ids = loadGold(file).map((q) => q.id);
      expect(ids.filter((id, i) => ids.indexOf(id) !== i), file).toEqual([]);
    }
  });

  it('every expected and alt target of every gold file resolves to a real docKey', () => {
    const missing: string[] = [];
    for (const file of files) {
      for (const q of loadGold(file)) {
        for (const [kind, keys] of [['expected', q.expected], ['alt', q.alt ?? []]] as const) {
          for (const key of keys) {
            if (!present.has(key) && !parked.has(`${q.id}|${key}`)) {
              missing.push(`${file.split('/').pop()} ${q.id} ${kind} ${key}`);
            }
          }
        }
      }
    }
    if (strictRoot) {
      expect(missing).toEqual([]);
    } else if (missing.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`gold integrity (live brain, not enforced) — ${missing.length} stale target(s):\n  ${missing.join('\n  ')}`);
    }
  });
});
