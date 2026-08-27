import { join } from 'node:path';
import { buildCorpus, bm25Search, docKey } from '../src/lib/recall.js';
import { loadGold } from '../eval/harness.js';

const root = process.cwd() + '/_dream_context';
const corpus = buildCorpus(root);
const gold = loadGold(join(process.cwd(), 'eval/gold.jsonl'));

for (const q of gold) {
  const hits = bm25Search(q.query, corpus, 10);
  const targets = new Set([...q.expected, ...(q.alt ?? [])]);
  let rank: number | null = null;
  for (let i = 0; i < hits.length; i++) {
    if (targets.has(docKey(hits[i].doc))) { rank = i + 1; break; }
  }
  if (rank === 1) continue; // only show non-perfect
  console.log(`\n[${q.id}] (${q.category}/${q.lang}) rank=${rank ?? 'MISS'}  "${q.query}"`);
  console.log(`  want: ${[...targets].join(', ')}`);
  hits.slice(0, 3).forEach((h, i) =>
    console.log(`  ${i + 1}. ${docKey(h.doc)}  (rank=${h.rankScore.toFixed(2)} raw=${h.score.toFixed(2)})`));
}
