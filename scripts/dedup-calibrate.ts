// Dedup threshold calibration — measures the cosine-similarity distribution the
// sleep-time semantic dedup (src/lib/embeddings/dedup.ts) sees on the REAL
// knowledge+feature corpus, so the MERGE / REVIEW thresholds are set from data,
// not a guess. E5 similarities compress into a narrow high band, so the right
// thresholds are corpus-specific.
//
// CRUCIAL: a sleep candidate at CREATE time is SHORT (title + description + a
// first section), while existing docs are LONG (many chunks). Because a doc's
// similarity is the MAX over chunk pairs, a short candidate systematically scores
// LOWER than full-doc-vs-full-doc — so thresholds calibrated on full-doc pairs are
// too high for the real use case. We therefore calibrate with SHORT candidates.
//
// A doc's frontmatter `description` is a human-written, freshly-worded summary of
// the same topic — the best available proxy for "a sleep agent writing a short doc
// about this topic" (semantically same topic, NOT verbatim, so its similarity is
// realistic, not the ~0.99 of copied text). Two bands:
//   • SAME-TOPIC (recall): each doc's `title + description` → sim to its OWN body.
//     The REVIEW threshold must sit at/below this so genuine same-topic docs are
//     caught.
//   • OTHER (false-positive risk): the same short candidate → its nearest OTHER
//     doc. REVIEW should sit ABOVE most of these so novel docs aren't all flagged.
//
// Usage: npx tsx scripts/dedup-calibrate.ts
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCorpus, docKey, type CorpusDoc } from '../src/lib/recall.js';
import { chunkDoc } from '../src/lib/embeddings/chunker.js';
import { refreshEmbeddings } from '../src/lib/embeddings/store.js';
import { embedPassages } from '../src/lib/embeddings/embedder.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(HERE, '..');
const ROOT = join(PROJECT, '_dream_context');

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}
function stats(label: string, xs: number[]): void {
  const s = [...xs].sort((a, b) => a - b);
  console.log(`  ${label}:  min ${pct(s, 0).toFixed(3)}  p10 ${pct(s, 10).toFixed(3)}  p25 ${pct(s, 25).toFixed(3)}  p50 ${pct(s, 50).toFixed(3)}  p75 ${pct(s, 75).toFixed(3)}  p90 ${pct(s, 90).toFixed(3)}  max ${pct(s, 100).toFixed(3)}`);
}

async function main(): Promise<void> {
  const corpus = buildCorpus(ROOT, { types: ['knowledge', 'feature'] });
  console.log(`Corpus: ${corpus.length} knowledge+feature docs\n`);

  const refreshed = await refreshEmbeddings(ROOT, corpus, undefined, { additive: true, force: true });
  if (refreshed === null) { console.error('Embedding model unavailable.'); process.exit(1); }
  const index = refreshed.index;

  const vecsByDoc = new Map<string, Float32Array[]>();
  for (const c of index.chunks) {
    const arr = vecsByDoc.get(c.docKey) ?? [];
    arr.push(c.vector);
    vecsByDoc.set(c.docKey, arr);
  }

  const dot = (a: Float32Array, b: Float32Array): number => {
    let s = 0; const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
  };
  const maxSim = (as: Float32Array[], bs: Float32Array[]): number => {
    let best = -Infinity;
    for (const a of as) for (const b of bs) { const d = dot(a, b); if (d > best) best = d; }
    return best;
  };

  // Short candidates: title + description (freshly-worded same-topic proxy).
  const withDesc = corpus.filter((d) => (d.description ?? '').trim().length >= 40);
  console.log(`Short-candidate probes: ${withDesc.length} docs have a usable description\n`);

  const sameTopic: number[] = [];   // short candidate → its OWN body
  const otherRisk: number[] = [];   // short candidate → nearest OTHER doc
  const misfires: { key: string; other: string; self: number; otherSim: number }[] = [];

  for (const d of withDesc) {
    const key = docKey(d);
    const candChunks = chunkDoc(d.title, '', d.description);      // title+desc only → short
    if (candChunks.length === 0) continue;
    const cand = await embedPassages(candChunks.map((c) => c.text));
    if (cand === null) continue;

    const self = maxSim(cand, vecsByDoc.get(key) ?? []);
    sameTopic.push(self);

    let bestOther = -Infinity; let bestOtherKey = '';
    for (const [k, vs] of vecsByDoc) {
      if (k === key) continue;
      const s = maxSim(cand, vs);
      if (s > bestOther) { bestOther = s; bestOtherKey = k; }
    }
    otherRisk.push(bestOther);
    // A "misfire" for MERGE purposes: the nearest OTHER doc is closer than the
    // candidate's own doc — pure noise for absolute thresholding.
    if (bestOther >= self) misfires.push({ key, other: bestOtherKey, self, otherSim: bestOther });
  }

  console.log('── Short-candidate similarity bands (the REAL sleep-create shape) ──');
  stats('SAME-TOPIC (cand → own body)   ', sameTopic);
  stats('OTHER     (cand → nearest other)', otherRisk);

  const st = [...sameTopic].sort((a, b) => a - b);
  const ot = [...otherRisk].sort((a, b) => a - b);
  console.log('\n── Threshold guidance ──');
  console.log(`  REVIEW should sit ≤ p25 of SAME-TOPIC (${pct(st, 25).toFixed(3)}) to catch most genuine same-topic docs,`);
  console.log(`         and ≥ p75 of OTHER (${pct(ot, 75).toFixed(3)}) to avoid flagging most novel docs.`);
  console.log(`  Overlap zone: [${pct(ot, 75).toFixed(3)} .. ${pct(st, 25).toFixed(3)}] — E5 cannot cleanly separate here (agent judges).`);
  console.log(`  MERGE (auto) should sit ABOVE p90 of OTHER (${pct(ot, 90).toFixed(3)}) so only unambiguous near-dupes auto-merge.`);
  console.log(`\n  ${misfires.length}/${sameTopic.length} short candidates had a nearer OTHER doc than their own`);
  console.log(`  → absolute MERGE is only safe well above the OTHER band; the REVIEW→agent path handles the overlap.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
