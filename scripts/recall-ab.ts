// Corpus-stable A/B runner for recall engine tuning.
// The live corpus mutates while you work (session digests, bookmarks, the very
// task file tracking this work). For a fair engine A/B, evaluate on a FROZEN
// corpus: git-tracked docs only — no capture docs, no in-flight tracking task.
import { buildCorpus, bm25Search, docKey, type CorpusDoc } from '/Users/mehmetnuraydin/projects/dreamcontext/src/lib/recall.js';
import { loadGold, evaluate, formatReport } from '/Users/mehmetnuraydin/projects/dreamcontext/eval/harness.js';

const ROOT = '/Users/mehmetnuraydin/projects/dreamcontext/_dream_context';
// Docs that did not exist when the gold sets were authored / that are
// session-local noise. Excluded for measurement determinism.
const EXCLUDED_SLUGS = new Set(['recall-context-uplift-v07']);

export function stableCorpus(): CorpusDoc[] {
  return buildCorpus(ROOT).filter(
    (d) => !d.capture && !d.slug.startsWith('digest#') && !d.slug.startsWith('bookmark#')
      && !EXCLUDED_SLUGS.has(d.slug),
  );
}

const corpus = stableCorpus();
const goldPath = process.argv[2] ?? '/Users/mehmetnuraydin/projects/dreamcontext/eval/gold.jsonl';
const gold = loadGold(goldPath);
const searchOpts = process.argv.includes('--link') ? { linkAware: true } : {};
const report = evaluate(corpus, gold, searchOpts);
console.log(`corpus: ${corpus.length} docs (stable) · gold: ${goldPath.split('/').pop()}${searchOpts.linkAware ? ' · linkAware' : ''}`);
console.log(formatReport(report));

if (process.argv.includes('--misses')) {
  for (const q of gold) {
    const hits = bm25Search(q.query, corpus, 10);
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
