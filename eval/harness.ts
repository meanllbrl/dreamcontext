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
export function evaluate(corpus: CorpusDoc[], gold: GoldQuery[]): EvalReport {
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
    const hits = bm25Search(q.query, corpus, 10);
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
