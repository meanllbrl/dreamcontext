import { readFileSync } from 'node:fs';
import { bm25Search, docKey, type CorpusDoc, type RecallHit } from '../src/lib/recall.js';

/**
 * A single labelled recall query.
 * - `expected`: docKeys (`type/slug`) that count as a correct hit.
 * - `alt`: additional acceptable docKeys (synonymous / equally-valid targets).
 * - `category`: bucket for per-category aggregation (e.g. "feature", "decision").
 * - `lang`: language of the query (e.g. "en", "tr") — reporting only.
 */
export interface GoldQuery {
  id: string;
  query: string;
  expected: string[];
  alt?: string[];
  category: string;
  lang: string;
}

/**
 * Parse a JSONL gold file into GoldQuery[]. Blank lines are skipped.
 * Each non-blank line must be a JSON object matching GoldQuery.
 */
export function loadGold(path: string): GoldQuery[] {
  const raw = readFileSync(path, 'utf-8');
  const out: GoldQuery[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    out.push(JSON.parse(trimmed) as GoldQuery);
  }
  return out;
}

interface Metrics {
  recall1: number;
  recall3: number;
  mrr: number;
  n: number;
}

export interface EvalReport {
  overall: { recall1: number; recall3: number; mrr: number; n: number };
  byCategory: Record<string, { recall1: number; recall3: number; mrr: number; n: number }>;
  perQuery: Array<{ id: string; category: string; rank: number | null; hit1: boolean; hit3: boolean }>;
}

/**
 * bm25Search returns RecallHit[] where each hit carries a `.doc` field. Some
 * callers/shapes expose the doc fields directly on the hit; accept either so the
 * harness is robust to the exact return shape.
 */
function hitDoc(hit: RecallHit | CorpusDoc): CorpusDoc {
  if (hit && typeof hit === 'object' && 'doc' in hit && (hit as RecallHit).doc) {
    return (hit as RecallHit).doc;
  }
  return hit as CorpusDoc;
}

/**
 * Evaluate a gold set against a corpus using bm25Search.
 *
 * For each query we take the top-10 hits and find the 1-based rank of the first
 * hit whose docKey is in the query's accepted targets (`expected` ∪ `alt`).
 * recall@1 / recall@3 are reported as percentages (0–100); MRR is 0–1.
 */
export function evaluate(
  corpus: CorpusDoc[],
  gold: GoldQuery[],
  searchOpts: Parameters<typeof bm25Search>[3] = {},
): EvalReport {
  const perQuery: EvalReport['perQuery'] = [];

  // Accumulators keyed by category, plus a synthetic "overall" bucket.
  const acc = new Map<string, { hit1: number; hit3: number; rr: number; n: number }>();
  const bump = (key: string, hit1: boolean, hit3: boolean, rr: number): void => {
    const cur = acc.get(key) ?? { hit1: 0, hit3: 0, rr: 0, n: 0 };
    cur.hit1 += hit1 ? 1 : 0;
    cur.hit3 += hit3 ? 1 : 0;
    cur.rr += rr;
    cur.n += 1;
    acc.set(key, cur);
  };

  for (const q of gold) {
    const hits = bm25Search(q.query, corpus, 10, searchOpts);
    const targets = new Set([...q.expected, ...(q.alt ?? [])]);

    let rank: number | null = null;
    for (let i = 0; i < hits.length; i++) {
      if (targets.has(docKey(hitDoc(hits[i])))) {
        rank = i + 1;
        break;
      }
    }

    const hit1 = rank === 1;
    const hit3 = rank !== null && rank <= 3;
    const rr = rank ? 1 / rank : 0;

    perQuery.push({ id: q.id, category: q.category, rank, hit1, hit3 });
    bump('__overall__', hit1, hit3, rr);
    bump(q.category, hit1, hit3, rr);
  }

  const toMetrics = (a: { hit1: number; hit3: number; rr: number; n: number }): Metrics => ({
    recall1: a.n ? (a.hit1 / a.n) * 100 : 0,
    recall3: a.n ? (a.hit3 / a.n) * 100 : 0,
    mrr: a.n ? a.rr / a.n : 0,
    n: a.n,
  });

  const overallAcc = acc.get('__overall__') ?? { hit1: 0, hit3: 0, rr: 0, n: 0 };
  const overall = toMetrics(overallAcc);

  const byCategory: EvalReport['byCategory'] = {};
  for (const [key, a] of acc) {
    if (key === '__overall__') continue;
    byCategory[key] = toMetrics(a);
  }

  return { overall, byCategory, perQuery };
}

/**
 * Event-loop-friendly twin of {@link evaluate}: byte-identical computation and
 * result, but it `await`s a macrotask every `yieldEvery` queries. A heavy stress
 * run (a 200-doc capture flood × the full gold set is tens of seconds of purely
 * synchronous BM25) would otherwise block its vitest worker's event loop long
 * enough to starve the reporter heartbeat and trip vitest's "Timeout calling
 * onTaskUpdate" RPC guard — failing the run even though every assertion passed.
 * The yields change nothing about the numbers; they only let the worker breathe.
 */
export async function evaluateAsync(
  corpus: CorpusDoc[],
  gold: GoldQuery[],
  searchOpts: Parameters<typeof bm25Search>[3] = {},
  yieldEvery = 4,
): Promise<EvalReport> {
  const perQuery: EvalReport['perQuery'] = [];
  const acc = new Map<string, { hit1: number; hit3: number; rr: number; n: number }>();
  const bump = (key: string, hit1: boolean, hit3: boolean, rr: number): void => {
    const cur = acc.get(key) ?? { hit1: 0, hit3: 0, rr: 0, n: 0 };
    cur.hit1 += hit1 ? 1 : 0;
    cur.hit3 += hit3 ? 1 : 0;
    cur.rr += rr;
    cur.n += 1;
    acc.set(key, cur);
  };

  let i = 0;
  for (const q of gold) {
    if (i++ % yieldEvery === 0) await new Promise<void>((r) => setImmediate(r));
    const hits = bm25Search(q.query, corpus, 10, searchOpts);
    const targets = new Set([...q.expected, ...(q.alt ?? [])]);

    let rank: number | null = null;
    for (let k = 0; k < hits.length; k++) {
      if (targets.has(docKey(hitDoc(hits[k])))) {
        rank = k + 1;
        break;
      }
    }

    const hit1 = rank === 1;
    const hit3 = rank !== null && rank <= 3;
    const rr = rank ? 1 / rank : 0;

    perQuery.push({ id: q.id, category: q.category, rank, hit1, hit3 });
    bump('__overall__', hit1, hit3, rr);
    bump(q.category, hit1, hit3, rr);
  }

  const toMetrics = (a: { hit1: number; hit3: number; rr: number; n: number }): Metrics => ({
    recall1: a.n ? (a.hit1 / a.n) * 100 : 0,
    recall3: a.n ? (a.hit3 / a.n) * 100 : 0,
    mrr: a.n ? a.rr / a.n : 0,
    n: a.n,
  });

  const overallAcc = acc.get('__overall__') ?? { hit1: 0, hit3: 0, rr: 0, n: 0 };
  const overall = toMetrics(overallAcc);

  const byCategory: EvalReport['byCategory'] = {};
  for (const [key, a] of acc) {
    if (key === '__overall__') continue;
    byCategory[key] = toMetrics(a);
  }

  return { overall, byCategory, perQuery };
}

// ─── Mode-generic A/B evaluation (embedding experiment) ─────────────────────

/** Any ranked search over the corpus: BM25-only, dense-only, or hybrid RRF. */
export type SearchFn = (query: string, topK: number) => Promise<Array<RecallHit | CorpusDoc>>;

export interface ExtendedMetrics {
  recall1: number;  // %
  recall3: number;  // %
  recall5: number;  // %
  mrr: number;      // 0–1
  ndcg10: number;   // 0–1 (binary relevance, first accepted target)
  n: number;
}

export interface ExtendedReport {
  overall: ExtendedMetrics;
  byCategory: Record<string, ExtendedMetrics>;
  perQuery: Array<{ id: string; category: string; lang: string; rank: number | null }>;
  latency: { meanMs: number; p50Ms: number; p90Ms: number };
}

/**
 * Evaluate a gold set against ANY search function (the A/B core). Takes the
 * top-10 per query; rank = first hit whose docKey is in expected ∪ alt.
 * nDCG@10 uses binary relevance with a single accepted target — the gold sets
 * label "any of these docs answers the query", not a graded full ranking — so
 * per-query nDCG@10 = 1/log2(rank+1) for rank ≤ 10, else 0.
 */
export async function evaluateSearch(
  search: SearchFn,
  gold: GoldQuery[],
): Promise<ExtendedReport> {
  const perQuery: ExtendedReport['perQuery'] = [];
  const times: number[] = [];

  interface Acc { hit1: number; hit3: number; hit5: number; rr: number; ndcg: number; n: number }
  const acc = new Map<string, Acc>();
  const bump = (key: string, rank: number | null): void => {
    const cur = acc.get(key) ?? { hit1: 0, hit3: 0, hit5: 0, rr: 0, ndcg: 0, n: 0 };
    if (rank !== null) {
      if (rank === 1) cur.hit1++;
      if (rank <= 3) cur.hit3++;
      if (rank <= 5) cur.hit5++;
      cur.rr += 1 / rank;
      if (rank <= 10) cur.ndcg += 1 / Math.log2(rank + 1);
    }
    cur.n++;
    acc.set(key, cur);
  };

  for (const q of gold) {
    const t0 = performance.now();
    const hits = await search(q.query, 10);
    times.push(performance.now() - t0);

    const targets = new Set([...q.expected, ...(q.alt ?? [])]);
    let rank: number | null = null;
    for (let i = 0; i < hits.length; i++) {
      if (targets.has(docKey(hitDoc(hits[i])))) {
        rank = i + 1;
        break;
      }
    }
    perQuery.push({ id: q.id, category: q.category, lang: q.lang, rank });
    bump('__overall__', rank);
    bump(q.category, rank);
  }

  const toMetrics = (a: Acc): ExtendedMetrics => ({
    recall1: a.n ? (a.hit1 / a.n) * 100 : 0,
    recall3: a.n ? (a.hit3 / a.n) * 100 : 0,
    recall5: a.n ? (a.hit5 / a.n) * 100 : 0,
    mrr: a.n ? a.rr / a.n : 0,
    ndcg10: a.n ? a.ndcg / a.n : 0,
    n: a.n,
  });

  const byCategory: ExtendedReport['byCategory'] = {};
  for (const [key, a] of acc) {
    if (key === '__overall__') continue;
    byCategory[key] = toMetrics(a);
  }

  const sorted = [...times].sort((a, b) => a - b);
  const overallAcc = acc.get('__overall__') ?? { hit1: 0, hit3: 0, hit5: 0, rr: 0, ndcg: 0, n: 0 };
  return {
    overall: toMetrics(overallAcc),
    byCategory,
    perQuery,
    latency: {
      meanMs: times.length ? times.reduce((s, t) => s + t, 0) / times.length : 0,
      p50Ms: sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : 0,
      p90Ms: sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : 0,
    },
  };
}

/**
 * Side-by-side table for N mode reports over the same gold set: one block per
 * metric, one row per category, one column per mode. Made for the BM25 vs
 * hybrid vs dense A/B readout.
 */
export function formatComparison(reports: Record<string, ExtendedReport>): string {
  const modes = Object.keys(reports);
  const cats = ['overall', ...Object.keys(reports[modes[0]].byCategory).sort()];
  const metric = (r: ExtendedReport, cat: string): ExtendedMetrics =>
    cat === 'overall' ? r.overall : r.byCategory[cat];

  const catWidth = Math.max(8, ...cats.map((c) => c.length));
  const colWidth = Math.max(8, ...modes.map((m) => m.length));
  const lines: string[] = [];

  const metricDefs: Array<{ label: string; get: (m: ExtendedMetrics) => string }> = [
    { label: 'recall@1 %', get: (m) => m.recall1.toFixed(1) },
    { label: 'recall@3 %', get: (m) => m.recall3.toFixed(1) },
    { label: 'recall@5 %', get: (m) => m.recall5.toFixed(1) },
    { label: 'MRR', get: (m) => m.mrr.toFixed(3) },
    { label: 'nDCG@10', get: (m) => m.ndcg10.toFixed(3) },
  ];

  for (const def of metricDefs) {
    lines.push('', `## ${def.label}`);
    lines.push([''.padEnd(catWidth), ...modes.map((m) => m.padStart(colWidth)), '    n'].join(' | '));
    lines.push([('-').repeat(catWidth), ...modes.map(() => '-'.repeat(colWidth)), '-----'].join('-+-'));
    for (const cat of cats) {
      const n = metric(reports[modes[0]], cat).n;
      lines.push([
        cat.padEnd(catWidth),
        ...modes.map((m) => def.get(metric(reports[m], cat)).padStart(colWidth)),
        String(n).padStart(5),
      ].join(' | '));
    }
  }

  lines.push('', '## latency (per query)');
  lines.push([''.padEnd(10), ...modes.map((m) => m.padStart(colWidth))].join(' | '));
  for (const stat of ['meanMs', 'p50Ms', 'p90Ms'] as const) {
    lines.push([
      stat.padEnd(10),
      ...modes.map((m) => reports[m].latency[stat].toFixed(1).padStart(colWidth)),
    ].join(' | '));
  }
  return lines.join('\n');
}

/**
 * Render an EvalReport as a clean fixed-width ASCII table: an overall row plus
 * one row per category. recall@1 / recall@3 are %, MRR is 0–1, all rounded to
 * 1 decimal. Categories are listed alphabetically for stable output.
 */
export function formatReport(report: EvalReport): string {
  const f1 = (v: number): string => v.toFixed(1);

  const rows: Array<[string, Metrics]> = [['overall', report.overall]];
  for (const cat of Object.keys(report.byCategory).sort()) {
    rows.push([cat, report.byCategory[cat]]);
  }

  const catWidth = Math.max(8, ...rows.map(([name]) => name.length));
  const cols = [
    { label: 'category', width: catWidth, align: 'left' as const },
    { label: 'recall@1%', width: 9, align: 'right' as const },
    { label: 'recall@3%', width: 9, align: 'right' as const },
    { label: 'MRR', width: 6, align: 'right' as const },
    { label: 'n', width: 5, align: 'right' as const },
  ];

  const pad = (text: string, width: number, align: 'left' | 'right'): string =>
    align === 'left' ? text.padEnd(width) : text.padStart(width);

  const line = (cells: string[]): string =>
    cells.map((c, i) => pad(c, cols[i].width, cols[i].align)).join(' | ');

  const sep = cols.map((c) => '-'.repeat(c.width)).join('-+-');

  const lines: string[] = [];
  lines.push(line(cols.map((c) => c.label)));
  lines.push(sep);
  for (const [name, m] of rows) {
    lines.push(line([name, f1(m.recall1), f1(m.recall3), m.mrr.toFixed(3), String(m.n)]));
  }
  return lines.join('\n');
}
