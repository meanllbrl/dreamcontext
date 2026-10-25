// Recall evaluation runner — measures only; it never tunes and never changes engine code.
//
// Every engine function (buildCorpus, bm25Search, hybridSearch, haikuRecall, …) is loaded from
// --engine-root (default `.`), so one runner measures the working tree and a pristine
// `git archive` (e.g. ~/.dreamcontext/eval-frozen/engines/0ba4c25a) alike. The engine sha is
// recorded in every run, and `--engine-root .` first proves the loader reproduces the in-tree
// BM25 ranking exactly.
//
// Usage:
//   npx tsx scripts/recall-eval.ts --split train|legacy|heldout|reserve (--mode raw|hybrid-e5|haiku
//        | --tier local|cloud-index|cloud | --dense-only local-e5) [--engine-root <dir>]
//        [--corpus-root <_dream_context>] [--gold a.jsonl,b.jsonl] [--now frozen|@<dir>|ISO]
//        [--rerank-model rerank-2.5|rerank-2.5-lite|none] [--inject-k 5] [--build-index]
//        [--out <file>] [--label <name>] [--ledger "<reason>"] [--unseal]
//
// held-out / reserve are SEALED: they need --ledger "<reason>" (one line is appended to
// eval/gold-v2/HELDOUT-LEDGER.md), the result file lands under the sealed dir, and stdout shows
// only that a run was recorded — aggregates print only with --unseal (T10 only).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bm25Search, docKey } from '../src/lib/recall.js';
import {
  frozenDir,
  SNAPSHOT_ID,
  assertNotSpawned,
  assertUnder,
  evaluateSearch,
  formatLangTable,
  loadEngine,
  loadGold,
  loadNow,
  sealedDir,
  type Engine,
  type ExtendedReport,
  type GoldQuery,
  type SearchFn,
} from '../eval/harness.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

export type Split = 'train' | 'legacy' | 'heldout' | 'reserve' | 'custom';
export type EvalMode = 'raw' | 'hybrid-e5' | 'haiku';
export type EvalTier = 'local' | 'cloud-index' | 'cloud';
const RERANK_MODELS = ['rerank-2.5', 'rerank-2.5-lite'] as const;

export interface RecallEvalArgs {
  split: Split;
  gold: string[] | null;
  mode: EvalMode | null;
  tier: EvalTier | null;
  denseOnly: string | null;
  engineRoot: string;
  corpusRoot: string | null;
  now: string | null;
  rerankModel: string | null; // 'voyageai/rerank-2.5' | 'voyageai/rerank-2.5-lite' | null (= none)
  injectK: number;
  buildIndex: boolean;
  out: string | null;
  label: string | null;
  ledger: string | null;
  unseal: boolean;
  help: boolean;
}

export const USAGE = `recall-eval — measure a recall engine on a gold set (measures only; never tunes)

  --split train|legacy|heldout|reserve   which gold (heldout/reserve are SEALED)
  --gold a.jsonl,b.jsonl                 explicit gold files instead of --split
  --mode raw|hybrid-e5|haiku             engine mode            } exactly one of
  --tier local|cloud-index|cloud         tiered hybrid search   } --mode, --tier
  --dense-only local-e5                  dense channel only     } or --dense-only
  --engine-root <dir>                    engine tree to measure (default .)
  --corpus-root <_dream_context>         default: the frozen ${SNAPSHOT_ID} snapshot
  --now frozen|@<dir>|<ISO>              pinned clock (default: now.txt next to the corpus root)
  --rerank-model rerank-2.5|rerank-2.5-lite|none
  --inject-k <n>                         hits the hook prints (default 5; use 3 for B0 as shipped)
  --build-index                          warm the e5 index before measuring (hybrid-e5 / local)
  --out <file> --label <name>            output file / run label
  --ledger "<reason>"                    REQUIRED for sealed splits (appended to HELDOUT-LEDGER.md)
  --unseal                               print aggregates of a sealed run (final validation only)
  --help
`;

export function parseArgs(argv: string[]): RecallEvalArgs {
  const value = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    if (i < 0) return null;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  const gold = value('--gold');
  const splitArg = value('--split');
  if (gold && splitArg) throw new Error('give --split OR --gold, not both');
  const split: Split = gold ? 'custom' : ((splitArg ?? 'train') as Split);
  if (!['train', 'legacy', 'heldout', 'reserve', 'custom'].includes(split)) {
    throw new Error(`--split must be train, legacy, heldout or reserve (got ${splitArg})`);
  }

  const mode = value('--mode') as EvalMode | null;
  if (mode && !['raw', 'hybrid-e5', 'haiku'].includes(mode)) throw new Error(`--mode must be raw, hybrid-e5 or haiku (got ${mode})`);
  const tier = value('--tier') as EvalTier | null;
  if (tier && !['local', 'cloud-index', 'cloud'].includes(tier)) throw new Error(`--tier must be local, cloud-index or cloud (got ${tier})`);
  const denseOnly = value('--dense-only');
  if (denseOnly && denseOnly !== 'local-e5') throw new Error(`--dense-only supports local-e5 only (got ${denseOnly})`);
  if (!has('--help') && [mode, tier, denseOnly].filter(Boolean).length !== 1) {
    throw new Error('give exactly one of --mode, --tier, --dense-only');
  }

  const rm = value('--rerank-model');
  if (rm && rm !== 'none' && !(RERANK_MODELS as readonly string[]).includes(rm)) {
    throw new Error(`--rerank-model must be rerank-2.5, rerank-2.5-lite or none (got ${rm})`);
  }
  if (rm && rm !== 'none' && tier !== 'cloud') throw new Error('--rerank-model applies to --tier cloud only');

  const injectK = Number(value('--inject-k') ?? 5);
  if (!Number.isInteger(injectK) || injectK < 1 || injectK > 10) throw new Error('--inject-k must be an integer 1–10');

  return {
    split,
    gold: gold ? gold.split(',').map((p) => resolve(p.trim())).filter(Boolean) : null,
    mode,
    tier,
    denseOnly,
    engineRoot: resolve(value('--engine-root') ?? '.'),
    corpusRoot: value('--corpus-root') ? resolve(value('--corpus-root')!) : null,
    now: value('--now'),
    rerankModel: rm && rm !== 'none' ? `voyageai/${rm}` : null,
    injectK,
    buildIndex: has('--build-index'),
    out: value('--out') ? resolve(value('--out')!) : null,
    label: value('--label'),
    ledger: value('--ledger'),
    unseal: has('--unseal'),
    help: has('--help'),
  };
}

export interface RunDeps {
  /** Injectable home (tests): where the frozen dir and the sealed dir live. */
  home?: string;
  /** Repo whose eval/ files (gold-v2, ledger, runs) are used. Default: this checkout. */
  repoRoot?: string;
  /** Wall-clock stamp for ledger lines / file names. */
  today?: () => string;
  /** Replace the engine loader (tests): the engine whose hybridSearch the tier runs call. */
  engineOverride?: (engineRoot: string) => Promise<Engine>;
  /** Replace the search function (tests). */
  searchOverride?: (engine: Engine, corpus: ReturnType<Engine['buildCorpus']>) => SearchFn;
}

export interface RunResult {
  label: string;
  split: Split;
  sealed: boolean;
  outFile: string | null;
  json: Record<string, unknown>;
  report: ExtendedReport;
}

function goldFilesFor(args: RecallEvalArgs, repo: string, home?: string): string[] {
  if (args.gold) return args.gold;
  switch (args.split) {
    case 'train': return [join(repo, 'eval', 'gold-v2', 'train.jsonl')];
    case 'legacy': return [join(repo, 'eval', 'gold.jsonl'), join(repo, 'eval', 'gold-heldout.jsonl')];
    case 'heldout': return [join(sealedDir(home), 'heldout.jsonl')];
    case 'reserve': return [join(sealedDir(home), 'reserve.jsonl')];
    default: throw new Error('no gold selected');
  }
}

function isUnderSealed(path: string, home?: string): boolean {
  try { assertUnder(sealedDir(home), path, 'gold'); return true; } catch { return false; }
}

/**
 * The loader must hand back the SAME ranking as the statically imported in-tree engine when the
 * engine root is this checkout. Compared on the raw top-10 keys of every gold query.
 */
export function selfCheck(engine: Engine, corpus: ReturnType<Engine['buildCorpus']>, gold: GoldQuery[], now: Date): void {
  for (const q of gold) {
    const viaLoader = engine.bm25Search(q.query, corpus, 10, { now }).map((h) => engine.docKey(h.doc));
    const inTree = bm25Search(q.query, corpus, 10, { now }).map((h) => docKey(h.doc));
    if (JSON.stringify(viaLoader) !== JSON.stringify(inTree)) {
      throw new Error(`engine self-check failed on ${q.id}: the loaded engine does not reproduce the in-tree ranking`);
    }
  }
}

/**
 * A cloud-tier measurement is only valid if every query actually ran the tier it names. A query
 * that fell back (timeout, breaker, no index, ...) silently measured e5 or BM25 instead, so the
 * run is refused rather than recorded. `querySource: 'none'` with `fallback: 'bm25_confident'` is the
 * dense gate skipping a query BM25 was already sure of: not a fallback. With no rerank model
 * requested, `rerank_not_consented` is the intended state of a `cloud` run, not a failure.
 */
export interface TierGuard { calls: number; offending: number; reasons: Map<string, number> }

function newTierGuard(): TierGuard {
  return { calls: 0, offending: 0, reasons: new Map() };
}

function offenceOf(t: RecallTimingLike, tier: 'cloud' | 'cloud-index', rerankRequested: boolean): string | null {
  const wanted = tier === 'cloud' ? 'api' : 'nano';
  if (t.fallback === 'rerank_not_consented' && !rerankRequested && t.querySource === wanted) return null;
  if (t.fallback === 'bm25_confident' && t.querySource === 'none') return null;
  if (t.fallback !== 'none') return `fallback=${t.fallback} source=${t.querySource}`;
  if (t.querySource !== wanted && t.querySource !== 'none') return `source=${t.querySource}`;
  return null;
}

interface RecallTimingLike { querySource: string; fallback: string }

/** Throws when any query of a cloud-tier run did not run its tier; names the count and the reasons. */
export function assertTierHonoured(guard: TierGuard, tier: EvalTier): void {
  if (guard.offending === 0) return;
  const why = [...guard.reasons].map(([r, n]) => `${r} x${n}`).join(', ');
  throw new Error(`tier ${tier}: ${guard.offending} of ${guard.calls} queries did not run the tier (${why}); the run is refused and nothing is recorded`);
}

async function buildSearch(
  args: RecallEvalArgs,
  engine: Engine,
  corpus: ReturnType<Engine['buildCorpus']>,
  root: string,
  now: Date,
  guard: TierGuard,
  home?: string,
): Promise<SearchFn> {
  if (args.mode === 'raw') return async (q, k) => engine.bm25Search(q, corpus, k, { now });
  if (args.mode === 'haiku') {
    // haikuRecall has no `now` option: its BM25 prepass uses the wall clock (documented B0 exception).
    const { haikuRecall } = await engine.extractor();
    return async (q) => {
      const r = haikuRecall(q, root);
      return r === 'skip' || r === null ? [] : r;
    };
  }
  const hybrid = await engine.hybrid();
  if (args.denseOnly) return (q, k) => hybrid.denseSearch(q, corpus, root, k);
  if (args.buildIndex) {
    const store = await engine.store();
    const t0 = performance.now();
    const res = await store.refreshEmbeddings(root, corpus);
    if (res === null) throw new Error('embedding model unavailable — cannot build the e5 index');
    console.error(`index: ${res.index.chunks.length} chunks, embedded ${res.stats.embedded} in ${Math.round(performance.now() - t0)} ms`);
  }
  // hybrid-e5 and tier runs share the engine's hybridSearch; a tier (and the eval-only rerank
  // model) is passed as options, which an engine without cloud tiers simply ignores. Cloud tiers
  // only ever run on a frozen root, where the engine honours evalConsent.
  const extra: Record<string, unknown> = {};
  if (args.tier && args.tier !== 'local') {
    assertUnder(frozenDir(home), root, '--corpus-root (cloud tiers run on a frozen root only)');
    extra.tier = args.tier;
    extra.evalConsent = true;
    if (args.rerankModel) extra.rerankModel = args.rerankModel;
  } else if (args.tier) {
    extra.tier = 'local';
  }
  const guarded = args.tier === 'cloud' || args.tier === 'cloud-index' ? args.tier : null;
  return (q, k) => {
    const timing = { tier: extra.tier, querySource: 'none', fallback: 'none' };
    const opts = { now, ...extra, ...(guarded ? { timing } : {}) } as Parameters<typeof hybrid.hybridSearch>[4];
    return hybrid.hybridSearch(q, corpus, root, k, opts).then((hits) => {
      if (guarded) {
        guard.calls++;
        const why = offenceOf(timing, guarded, args.rerankModel !== null);
        if (why !== null) { guard.offending++; guard.reasons.set(why, (guard.reasons.get(why) ?? 0) + 1); }
      }
      return hits;
    });
  };
}

function appendLedger(repo: string, line: string): void {
  const file = join(repo, 'eval', 'gold-v2', 'HELDOUT-LEDGER.md');
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${line}\n`);
}

export async function run(args: RecallEvalArgs, deps: RunDeps = {}): Promise<RunResult> {
  const repo = deps.repoRoot ?? REPO;
  const home = deps.home;
  const date = (deps.today ?? (() => new Date().toISOString().slice(0, 10)))();

  const goldFiles = goldFilesFor(args, repo, home);
  const sealed = args.split === 'heldout' || args.split === 'reserve' || goldFiles.some((f) => isUnderSealed(f, home));
  const what = args.mode ?? (args.tier ? `tier-${args.tier}` : `dense-${args.denseOnly}`);
  const label = args.label ?? `${args.split}-${what}${args.rerankModel ? `-${args.rerankModel.split('/')[1]}` : ''}`;
  if (sealed && !args.ledger?.trim()) throw new Error(`${args.split} is sealed: --ledger "<reason>" is required`);

  const snapshot = join(frozenDir(home), SNAPSHOT_ID);
  const root = args.corpusRoot ?? join(snapshot, '_dream_context');
  if (!existsSync(root)) throw new Error(`corpus root not found: ${root}`);
  const nowArg = args.now ?? (existsSync(join(dirname(root), 'now.txt')) ? `@${dirname(root)}` : undefined);
  const now = loadNow(nowArg);
  const fpFile = join(dirname(root), 'FINGERPRINT.json');
  let corpusFingerprint: unknown = null;
  if (existsSync(fpFile)) {
    try { corpusFingerprint = (JSON.parse(readFileSync(fpFile, 'utf-8')) as { fingerprint?: unknown }).fingerprint ?? null; } catch { corpusFingerprint = null; }
  }

  const gold = goldFiles.flatMap((f) => loadGold(f));
  if (gold.length === 0) throw new Error('empty gold set');

  const engine = await (deps.engineOverride ?? loadEngine)(args.engineRoot);
  const corpus = engine.stableCorpus(root);
  if (args.engineRoot === resolve(REPO)) selfCheck(engine, corpus, gold, now);

  const guard = newTierGuard();
  const search = deps.searchOverride ? deps.searchOverride(engine, corpus) : await buildSearch(args, engine, corpus, root, now, guard, home);
  const report = await evaluateSearch(search, gold, {
    injectK: args.injectK,
    injectRule: args.mode === 'haiku' ? 'nonempty' : 'gate',
  });
  // Before any output: a refused run leaves no result file and no ledger line.
  if (args.tier) assertTierHonoured(guard, args.tier);

  const json = {
    label,
    split: args.split,
    mode: args.mode,
    tier: args.tier,
    denseOnly: args.denseOnly,
    rerankModel: args.rerankModel,
    injectK: args.injectK,
    engineSha: engine.sha,
    corpusFingerprint,
    now: now.toISOString(),
    overall: report.overall,
    byLang: report.byLang,
    byLangCategory: report.byLangCategory,
    latency: report.latency,
    perQuery: report.perQuery,
  };

  let outFile = args.out;
  if (sealed) {
    outFile = args.out ?? join(sealedDir(home), `${label}.json`);
    assertUnder(sealedDir(home), outFile, '--out (sealed runs write under the sealed dir)');
    const clean = (s: string): string => s.replace(/[|\s]+/g, ' ').trim();
    appendLedger(repo, `| ${date} | ${args.split} | ${what} | ${args.rerankModel ?? '-'} | ${engine.sha.slice(0, 8)} | ${clean(args.ledger!)} |`);
  }
  if (outFile) {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, `${JSON.stringify(json, null, 1)}\n`);
  }
  return { label, split: args.split, sealed, outFile, json, report };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  assertNotSpawned('recall-eval');
  const res = await run(args);
  if (res.sealed && !args.unseal) {
    console.log(JSON.stringify({ sealed: true, label: res.label, n: res.report.overall.n, out: res.outFile }));
    return;
  }
  console.error(formatLangTable({ [res.label]: res.report }));
  const { perQuery: _omit, ...summary } = res.json;
  void _omit;
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`recall-eval: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  });
}
