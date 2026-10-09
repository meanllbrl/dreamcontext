// Corpus-stable A/B runner for recall engine tuning.
// The live corpus mutates while you work (session digests, bookmarks, the very
// task file tracking this work). For a fair engine A/B, evaluate on a FROZEN
// corpus: capture docs and in-flight tracking noise filtered out (`stableCorpus`),
// the clock pinned, and --root pointed at a frozen copy of the brain.
//
// Usage:
//   npx tsx scripts/recall-ab.ts [gold.jsonl] [--link] [--misses]
//       [--root <ctx>] [--now <iso|frozen>]
import { join, resolve } from 'node:path';
import { bm25Search, docKey } from '../src/lib/recall.js';
import { loadGold, evaluate, formatReport, loadNow, stableCorpus } from '../eval/harness.js';

const argv = process.argv.slice(2);
const value = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const ROOT = resolve(value('--root') ?? join(process.cwd(), '_dream_context'));
const now = loadNow(value('--now'));

const corpus = stableCorpus(ROOT);
// First positional arg (not a flag, not a flag's value) is the gold path.
const flagValues = new Set(['--root', '--now'].map((f) => value(f)).filter((v): v is string => v !== undefined));
const goldArg = argv.find((a) => !a.startsWith('--') && !flagValues.has(a));
const goldPath = goldArg ?? join(process.cwd(), 'eval/gold.jsonl');
const gold = loadGold(goldPath);
const searchOpts = { now, ...(argv.includes('--link') ? { linkAware: true } : {}) };
const report = evaluate(corpus, gold, searchOpts);
console.log(`corpus: ${corpus.length} docs (stable) · gold: ${goldPath.split('/').pop()}${searchOpts.linkAware ? ' · linkAware' : ''} · root: ${ROOT} · now: ${now.toISOString()}`);
console.log(formatReport(report));

if (argv.includes('--misses')) {
  for (const q of gold) {
    const hits = bm25Search(q.query, corpus, 10, searchOpts);
    const targets = new Set([...q.expected, ...(q.alt ?? [])]);
    let rank: number | null = null;
    for (let i = 0; i < hits.length; i++) {
      if (targets.has(docKey(hits[i].doc))) { rank = i + 1; break; }
    }
    if (rank === 1) continue;
    console.log(`\n[${q.id}] (${q.category}/${q.lang}) rank=${rank ?? 'MISS'}  "${q.query}"`);
    console.log(`  want: ${[...targets].join(', ')}`);
    hits.slice(0, 3).forEach((h, i) =>
      console.log(`  ${i + 1}. ${docKey(h.doc)}  (rank=${h.rankScore.toFixed(2)} raw=${h.score.toFixed(2)})`));
  }
}
