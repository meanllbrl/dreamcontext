// Embedding A/B: BM25-only vs hybrid (RRF) vs dense-only on the FROZEN gold
// sets — the prove-it-or-kill-it gate for the embedding layer
// (knowledge/decisions/decision-embedding-layer.md).
//
// Same corpus discipline as recall-ab.ts: capture docs and in-flight tracking
// noise filtered out (`stableCorpus`), the clock pinned with --now, so two runs
// over the same files rank identically (v3 measurement-discipline lesson). For a
// real measurement point --root at a FROZEN copy of the brain, not the live one.
//
// Usage:
//   npx tsx scripts/embed-ab.ts                       # gold.jsonl (train) on this repo's brain
//   npx tsx scripts/embed-ab.ts --heldout             # gold-heldout.jsonl
//   npx tsx scripts/embed-ab.ts --misses hybrid       # per-query miss diff for a mode
//   npx tsx scripts/embed-ab.ts --root <ctx> --gold <a.jsonl> --gold <b.jsonl> \
//       --modes bm25,hybrid --now frozen --json out.json
//
// Flags:
//   --root <ctx>        context root to evaluate (default: this repo's _dream_context)
//   --gold <path>       gold set; repeatable (default: gold.jsonl, or gold-heldout.jsonl with --heldout)
//   --modes <csv>       subset of bm25,hybrid,dense (default: all three). Only hybrid/dense need the
//                       embedding model + index; a bm25-only run never loads them.
//   --now <iso|frozen>  pin the clock (`frozen` reads eval-frozen/now.txt); forwarded to the search
//   --json <out>        aggregates + per-query RANKS (no query text) — safe for the repo
//   --per-query <out>   per-query detail with query text and top-5 keys; must be under eval-frozen/runs/
//   --dump-topk <out>   top-10 keys + rankScore + score + snippet per query; must be under eval-frozen/runs/
//   --build-timing      buildCorpus p50 over 10 runs (utility flag, see below)
//   --checksum <out>    sha256 manifest of every corpus file, excluding .embeddings/.recall-cache (utility flag)
//   --sweep [--rrf]     fusion-weight sweep (tune on train only)
//   --w <val>           override the BM25 weight for the hybrid mode
//
// --build-timing / --checksum are utilities: with no --gold/--heldout/--sweep/--misses they run and exit
// without evaluating any gold set.
//
// Latency is the post-warm-up mean/p50/p90 (one untimed query per mode is discarded — see evaluateSearch).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCorpus, bm25Search, docKey, type CorpusDoc, type RecallHit } from '../src/lib/recall.js';
import { hybridSearch, denseSearch } from '../src/lib/embeddings/hybrid.js';
import { refreshEmbeddings } from '../src/lib/embeddings/store.js';
import {
  FROZEN_RUNS_DIR,
  assertUnder,
  evaluateSearch,
  formatComparison,
  loadGold,
  loadNow,
  stableCorpus,
  type ExtendedReport,
  type GoldQuery,
  type SearchFn,
} from '../eval/harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(HERE, '..');

const argv = process.argv.slice(2);
const has = (flag: string): boolean => argv.includes(flag);
const values = (flag: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === flag && argv[i + 1] !== undefined) out.push(argv[i + 1]);
  return out;
};
const value = (flag: string): string | undefined => values(flag)[0];

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

const ROOT = resolve(value('--root') ?? join(PROJECT, '_dream_context'));
const now = loadNow(value('--now'));

// Per-query material (query text, top hits) is what held-out isolation protects:
// it may only ever be written under the frozen runs dir, outside the repo.
function frozenRunsPath(flag: string): string | null {
  const path = value(flag);
  if (!path) return null;
  try {
    return assertUnder(FROZEN_RUNS_DIR, path, flag);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
}
const perQueryPath = frozenRunsPath('--per-query');
const dumpTopkPath = frozenRunsPath('--dump-topk');
const jsonPath = value('--json') ? resolve(value('--json')!) : null;

const MODE_NAMES = ['bm25', 'hybrid', 'dense'] as const;
type ModeName = typeof MODE_NAMES[number];
const modeNames: ModeName[] = (value('--modes') ?? MODE_NAMES.join(','))
  .split(',')
  .map((m) => m.trim())
  .filter((m): m is ModeName => (MODE_NAMES as readonly string[]).includes(m));
if (modeNames.length === 0) {
  console.error(`--modes must list at least one of: ${MODE_NAMES.join(', ')}`);
  process.exit(2);
}

const meta: Record<string, unknown> = { root: ROOT, now: now.toISOString(), modes: modeNames };

// ── Utilities: corpus build timing and the frozen-corpus checksum ────────────

const EXCLUDED_DIRS = new Set(['.embeddings', '.recall-cache', '.git']);
const EXCLUDED_FILES = new Set(['.DS_Store']);

function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) yield* walkFiles(join(dir, entry.name));
    } else if (entry.isFile() && !EXCLUDED_FILES.has(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

if (has('--checksum')) {
  const out = resolve(value('--checksum') ?? '');
  const lines = [...walkFiles(ROOT)]
    .map((f) => `${createHash('sha256').update(readFileSync(f)).digest('hex')}  ${relative(ROOT, f)}`)
    .sort((a, b) => a.split('  ')[1].localeCompare(b.split('  ')[1]));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lines.join('\n') + '\n');
  meta.checksum = { file: out, files: lines.length, digest: createHash('sha256').update(lines.join('\n')).digest('hex') };
  console.log(`checksum: ${lines.length} files → ${out}`);
}

if (has('--build-timing')) {
  const RUNS = 10;
  const times: number[] = [];
  let docs = 0;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    docs = buildCorpus(ROOT).length;
    times.push(performance.now() - t0);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)];
  meta.buildCorpus = { runs: RUNS, docs, p50Ms: Math.round(p50) };
  console.log(`buildCorpus: p50 ${Math.round(p50)}ms over ${RUNS} runs (${docs} docs)`);
}

const goldFlagged = has('--gold') || has('--heldout') || has('--sweep') || has('--misses');
if ((has('--checksum') || has('--build-timing')) && !goldFlagged) {
  if (jsonPath) writeJson(jsonPath, { meta });
  process.exit(0);
}

// ── Gold sets, corpus, index ─────────────────────────────────────────────────

const goldPaths = values('--gold').length > 0
  ? values('--gold').map((p) => resolve(p))
  : [join(PROJECT, 'eval', has('--heldout') ? 'gold-heldout.jsonl' : 'gold.jsonl')];
const goldSets: Array<{ name: string; path: string; gold: GoldQuery[] }> = [];
for (const path of goldPaths) {
  let name = basename(path);
  for (let n = 2; goldSets.some((s) => s.name === name); n++) name = `${basename(path)}#${n}`;
  goldSets.push({ name, path, gold: loadGold(path) });
}

const corpus: CorpusDoc[] = stableCorpus(ROOT);

// Warm the embedding cache once, up front, so per-query latency measures
// SEARCH cost (as production would see it), not one-off indexing cost. A
// bm25-only run skips it entirely — no model load, no index write.
let indexLine = 'index: not used (bm25 only)';
if (modeNames.includes('hybrid') || modeNames.includes('dense')) {
  const tIndex = performance.now();
  const refreshed = await refreshEmbeddings(ROOT, corpus);
  if (refreshed === null) {
    console.error('Embedding model unavailable — cannot run hybrid/dense. (Use --modes bm25 for a lexical-only run.)');
    process.exit(1);
  }
  const indexMs = Math.round(performance.now() - tIndex);
  meta.index = { chunks: refreshed.index.chunks.length, refreshMs: indexMs, embedded: refreshed.stats.embedded, reused: refreshed.stats.reused };
  indexLine = `index: ${refreshed.index.chunks.length} chunks · refresh ${indexMs}ms (embedded ${refreshed.stats.embedded}, reused ${refreshed.stats.reused})`;
}
meta.corpusDocs = corpus.length;

// --sweep: tune the convex BM25 weight in the RRF combination on this gold set.
// Constraint first (exact-term/field-match r@1 must hold BM25's level), then
// overall r@1/MRR. Tune on train ONLY; validate the chosen weight on held-out.
if (has('--sweep')) {
  const rrfMode = has('--rrf');
  const weights = rrfMode
    ? [0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9] // w_bm25 for rrf
    : [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5]; // λ (dense) for relative
  for (const set of goldSets) {
    const base = await evaluateSearch(async (q, k) => bm25Search(q, corpus, k, { now }), set.gold);
    console.log(`\n${set.name} — bm25 baseline: r@1 ${base.overall.recall1.toFixed(1)} · r@3 ${base.overall.recall3.toFixed(1)} · MRR ${base.overall.mrr.toFixed(3)} · exact r@1 ${base.byCategory['exact-term']?.recall1.toFixed(1)}`);
    console.log(`${rrfMode ? 'w_bm25' : 'λdense'} | r@1  | r@3  | r@5  | MRR   | exact r@1 | field r@1 | tr r@3 | recency r@1`);
    for (const w of weights) {
      const rep = await evaluateSearch(
        (q, k) => hybridSearch(q, corpus, ROOT, k, { now, ...(rrfMode ? { fusion: 'rrf' as const, bm25Weight: w } : { denseWeight: w }) }),
        set.gold,
      );
      const o = rep.overall;
      console.log([
        w.toFixed(2).padStart(6),
        o.recall1.toFixed(1).padStart(4),
        o.recall3.toFixed(1).padStart(4),
        o.recall5.toFixed(1).padStart(4),
        o.mrr.toFixed(3).padStart(5),
        (rep.byCategory['exact-term']?.recall1 ?? 0).toFixed(1).padStart(9),
        (rep.byCategory['field-match']?.recall1 ?? 0).toFixed(1).padStart(9),
        (rep.byCategory.turkish?.recall3 ?? 0).toFixed(1).padStart(6),
        (rep.byCategory.recency?.recall1 ?? 0).toFixed(1).padStart(11),
      ].join(' | '));
    }
  }
  process.exit(0);
}

// --w <val>: override the BM25 weight for the hybrid mode in this run.
const wOverride = value('--w') !== undefined ? Number(value('--w')) : undefined;

const MODES: Record<ModeName, SearchFn> = {
  bm25: async (q, k) => bm25Search(q, corpus, k, { now }),
  hybrid: (q, k) => hybridSearch(q, corpus, ROOT, k, { now, ...(wOverride !== undefined ? { bm25Weight: wOverride } : {}) }),
  dense: (q, k) => denseSearch(q, corpus, ROOT, k),
};

type Hit = RecallHit | CorpusDoc;
const docOf = (h: Hit): CorpusDoc => ('doc' in h && h.doc ? h.doc : (h as CorpusDoc));
const needTop = perQueryPath !== null || dumpTopkPath !== null;

/** Remember each query's hit list (last call wins) so per-query output needs no second search. */
function capturing(fn: SearchFn, sink: Map<string, Hit[]>): SearchFn {
  return async (q, k) => {
    const hits = await fn(q, k);
    sink.set(q, hits);
    return hits;
  };
}

const allReports: Record<string, { n: number; modes: Record<string, ExtendedReport> }> = {};
const perQueryOut: Record<string, Record<string, unknown[]>> = {};
const topkOut: Record<string, Record<string, Record<string, unknown[]>>> = {};

for (const set of goldSets) {
  const reports: Record<string, ExtendedReport> = {};
  perQueryOut[set.name] = {};
  topkOut[set.name] = {};
  for (const name of modeNames) {
    const sink = new Map<string, Hit[]>();
    reports[name] = await evaluateSearch(needTop ? capturing(MODES[name], sink) : MODES[name], set.gold);
    if (needTop) {
      const byId = new Map(set.gold.map((g) => [g.id, g]));
      perQueryOut[set.name][name] = reports[name].perQuery.map((p) => {
        const g = byId.get(p.id)!;
        return {
          id: p.id, category: p.category, lang: p.lang, rank: p.rank,
          query: g.query, expected: g.expected, alt: g.alt ?? [],
          top5: (sink.get(g.query) ?? []).slice(0, 5).map((h) => docKey(docOf(h))),
        };
      });
      topkOut[set.name][name] = Object.fromEntries(set.gold.map((g) => [
        g.id,
        (sink.get(g.query) ?? []).slice(0, 10).map((h) => ({
          key: docKey(docOf(h)),
          rankScore: 'rankScore' in h ? h.rankScore : null,
          score: 'score' in h ? h.score : null,
          snippet: 'snippet' in h ? h.snippet : null,
        })),
      ]));
    }
  }
  allReports[set.name] = { n: set.gold.length, modes: reports };

  console.log(`\ncorpus: ${corpus.length} docs (stable) · gold: ${set.name} (${set.gold.length}q) · root: ${ROOT} · now: ${now.toISOString()}`);
  console.log(indexLine);
  console.log(formatComparison(reports));

  // Per-query diff: where do the modes disagree?
  const missMode = (() => {
    const i = argv.indexOf('--misses');
    return i >= 0 ? (argv[i + 1] ?? 'hybrid') : null;
  })() as ModeName | null;
  if (missMode && reports[missMode] && reports.bm25) {
    const bm25ByQ = new Map(reports.bm25.perQuery.map((p) => [p.id, p.rank]));
    console.log(`\n## per-query: ${missMode} vs bm25 (only differences)`);
    for (const p of reports[missMode].perQuery) {
      const before = bm25ByQ.get(p.id) ?? null;
      if (before === p.rank) continue;
      const q = set.gold.find((g) => g.id === p.id);
      const arrow = `bm25 rank=${before ?? 'MISS'} → ${missMode} rank=${p.rank ?? 'MISS'}`;
      console.log(`\n[${p.id}] (${p.category}/${p.lang}) ${arrow}\n  "${q?.query}"`);
      if (q) {
        const targets = new Set([...q.expected, ...(q.alt ?? [])]);
        const hits = await MODES[missMode](q.query, 5);
        hits.forEach((h, i) => {
          const key = docKey(docOf(h));
          console.log(`  ${i + 1}. ${targets.has(key) ? '✓' : ' '} ${key}`);
        });
      }
    }
  }
}

// ── Machine-readable output ──────────────────────────────────────────────────
// --json carries aggregates and per-query RANKS only (no query text, no hit
// lists): it may live in the repo. Anything richer goes to eval-frozen/runs/.
meta.goldFiles = goldSets.map((s) => s.path);
if (jsonPath) writeJson(jsonPath, { meta, sets: allReports });
if (perQueryPath) writeJson(perQueryPath, { meta, sets: perQueryOut });
if (dumpTopkPath) writeJson(dumpTopkPath, { meta, sets: topkOut });
