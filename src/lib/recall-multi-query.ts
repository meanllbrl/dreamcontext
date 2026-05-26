import { buildCorpus, bm25Search, type RecallHit } from './recall.js';
import type { ExtractedQuery } from './recall-query-extractor.js';

export function multiQueryBm25(
  queries: ExtractedQuery[],
  contextRoot: string,
  topK = 3,
): RecallHit[] {
  if (queries.length === 0) return [];

  const fullCorpus = buildCorpus(contextRoot);
  if (fullCorpus.length === 0) return [];

  const hitMap = new Map<string, RecallHit>();

  for (const query of queries) {
    const corpus = query.types
      ? fullCorpus.filter(d => query.types!.includes(d.type))
      : fullCorpus;
    const hits = bm25Search(query.q, corpus, topK * 2);
    for (const hit of hits) {
      const existing = hitMap.get(hit.doc.path);
      if (!existing || hit.score > existing.score) {
        hitMap.set(hit.doc.path, hit);
      }
    }
  }

  return Array.from(hitMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
