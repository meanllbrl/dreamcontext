// Model experiment (T6): does a better embedding model, or a cross-encoder reranker,
// beat the shipped e5-small hybrid on the FROZEN corpora?  Pure experiment — it imports
// the production fusion pieces read-only and changes nothing under src/.
//
// Everything model-specific lives HERE (prefixes, pooling, dtype, dimensions, cache dir):
// the production embedder is hard-wired to e5-small, and that abstraction is only ported
// for a winner (T10).
//
// Discipline (same as scripts/embed-ab.ts):
//   - the corpus is the FROZEN root (read-only here: this script never writes into it), the
//     clock is pinned with --now, and gold is TRAIN ONLY (a held-out path is refused);
//   - latency is the mean AFTER one discarded warm-up query (evaluateSearch warmup = 1);
//   - per-query material (ranks with ids, query text) is written only under
//     ~/.dreamcontext/eval-frozen/runs/t6/; the repo file gets AGGREGATES only.
//
// Index = the production chunker (chunkDoc) over stableCorpus(root), minus the doc types the
// dense channel excludes anyway (DENSE_EXCLUDED_TYPES: changelog) — identical retrieval, fewer
// chunks to embed. Vectors are stored per candidate in a resumable append-only file so a long
// build can be cut into foreground-sized slices (--budget-sec).
//
// Modes (one per invocation):
//   --precheck   --candidate <id>                           load the model, sanity-probe it, time it
//   --build-index --candidate <id> --corpus dc|hf --root <ctx> [--budget-sec 400] [--limit N]
//   --eval       --candidate <id> --corpus dc|hf --root <ctx> --gold <train.jsonl>… --now frozen
//                [--dense-only]
//   --sweep      --candidate <id> --corpus dc|hf --root <ctx> --gold <train.jsonl>… --now frozen   fusion re-sweep (winner only)
//   --bench      --candidate <id> --root <ctx> --gold <train.jsonl>   controlled index-throughput + query-embed latency
//   --precheck-reranker --reranker <id>
//   --rerank     --reranker <id> --corpus dc|hf --root <ctx> --gold <train.jsonl>… --now frozen
//   --aggregate  [--out eval/runs/2026-10-07-models.json]    merge every result into the repo file
//
// Candidates: e5-small-q8 (control) · embeddinggemma-q8 · embeddinggemma-q4 · granite-97m-q8
// Rerankers:  mmarco-mminilm-qint8 · mmarco-mminilm-fp32 · bge-reranker-v2-m3-q8 (only on promise)
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, truncateSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { bm25Search, docKey, type CorpusDoc, type RecallHit } from '../src/lib/recall.js';
import { chunkDoc } from '../src/lib/embeddings/chunker.js';
import {
  ADAPTIVE_PIN_MARGIN,
  ADAPTIVE_RAW_CUTOFF,
  ADAPTIVE_RELATIVE_LAMBDA,
  ADAPTIVE_RRF_BM25_WEIGHT,
  DENSE_EXCLUDED_TYPES,
  RRF_K,
  denseRank,
  relativeFuse,
  rrfFuse,
  type DenseHit,
} from '../src/lib/embeddings/hybrid.js';
import type { DenseIndex, IndexedChunk } from '../src/lib/embeddings/store.js';
import {
  FROZEN_DIR,
  FROZEN_RUNS_DIR,
  assertUnder,
  evaluateSearch,
  loadGold,
  loadNow,
  stableCorpus,
  type ExtendedMetrics,
  type ExtendedReport,
  type GoldQuery,
  type SearchFn,
} from '../eval/harness.js';

// ─── Paths ───────────────────────────────────────────────────────────────────

const T6_RUNS = join(FROZEN_RUNS_DIR, 't6');
const RESULTS_DIR = join(T6_RUNS, 'results');
const INDEX_DIR = join(FROZEN_DIR, 't6-index');
const MODEL_DIR = join(FROZEN_DIR, 't6-models');
const PROD_MODEL_DIR = join(homedir(), '.dreamcontext', 'models');
const HERE = dirname(new URL(import.meta.url).pathname);
const PROJECT = join(HERE, '..');
const DEFAULT_OUT = join(PROJECT, 'eval', 'runs', '2026-10-07-models.json');

// ─── Candidate registry (script-local — nothing here is production config) ───

type Pooling = 'mean' | 'cls' | 'sentence_embedding';

interface Candidate {
  id: string;
  repo: string;
  /** Where transformers.js looks for / stores the files. e5 reads the production cache (never written). */
  cacheDir: string;
  /** e5 is already on disk: forbid any network access for it. */
  localOnly: boolean;
  dtype: 'q8' | 'q4' | 'fp32';
  pooling: Pooling;
  queryPrefix: string;
  docPrefix: string;
  maxTokens: number;
  dims: number;
  license: string;
  notes: string;
  /** Static-embedding models (no transformer): run the ONNX graph directly, tokenizer from a bare tokenizer.json. */
  staticOnnxFile?: string;
}

const MAX_TOKENS = 512; // the e5 limit; every candidate is capped the same so the model is the only variable

const CANDIDATES: Record<string, Candidate> = {
  'e5-small-q8': {
    id: 'e5-small-q8', repo: 'Xenova/multilingual-e5-small', cacheDir: PROD_MODEL_DIR, localOnly: true,
    dtype: 'q8', pooling: 'mean', queryPrefix: 'query: ', docPrefix: 'passage: ', maxTokens: MAX_TOKENS, dims: 384,
    license: 'MIT (intfloat/multilingual-e5-small)',
    notes: 'shipped model; the control',
  },
  'embeddinggemma-q8': {
    id: 'embeddinggemma-q8', repo: 'onnx-community/embeddinggemma-300m-ONNX', cacheDir: MODEL_DIR, localOnly: false,
    dtype: 'q8', pooling: 'sentence_embedding',
    queryPrefix: 'task: search result | query: ', docPrefix: 'title: none | text: ',
    maxTokens: MAX_TOKENS, dims: 768,
    license: 'Gemma Terms of Use (https://ai.google.dev/gemma/terms) — NOT OSI-open: use restrictions + flow-down to downstream users',
    notes: 'MRL-truncatable (512/256/128); activations do not support fp16; ~294 MB q8',
  },
  'embeddinggemma-q4': {
    id: 'embeddinggemma-q4', repo: 'onnx-community/embeddinggemma-300m-ONNX', cacheDir: MODEL_DIR, localOnly: false,
    dtype: 'q4', pooling: 'sentence_embedding',
    queryPrefix: 'task: search result | query: ', docPrefix: 'title: none | text: ',
    maxTokens: MAX_TOKENS, dims: 768,
    license: 'Gemma Terms of Use (https://ai.google.dev/gemma/terms) — NOT OSI-open: use restrictions + flow-down to downstream users',
    notes: 'MRL-truncatable (512/256/128); ~187 MB q4',
  },
  'granite-97m-q8': {
    id: 'granite-97m-q8', repo: 'onnx-community/granite-embedding-97m-multilingual-r2-ONNX', cacheDir: MODEL_DIR, localOnly: false,
    dtype: 'q8', pooling: 'cls', queryPrefix: '', docPrefix: '', maxTokens: MAX_TOKENS, dims: 384,
    license: 'Apache-2.0 (ibm-granite/granite-embedding-97m-multilingual-r2)',
    notes: 'ModernBERT, CLS pooling, no prompts; ~93 MB q8; Turkish listed among its languages',
  },
  'static-mrl-multilingual-int8': {
    id: 'static-mrl-multilingual-int8', repo: 'sentence-transformers/static-similarity-mrl-multilingual-v1', cacheDir: MODEL_DIR, localOnly: true,
    dtype: 'q8', pooling: 'sentence_embedding', queryPrefix: '', docPrefix: '', maxTokens: MAX_TOKENS, dims: 1024,
    license: 'Apache-2.0 (sentence-transformers/static-similarity-mrl-multilingual-v1)',
    notes: 'STATIC embeddings (token lookup + mean, no attention) — the speed tier; int8 ONNX ~108 MB; trained for similarity, not retrieval',
    staticOnnxFile: 'onnx/model_int8.onnx',
  },
};

interface Reranker {
  id: string;
  repo: string;
  cacheDir: string;
  dtype: 'q8' | 'fp32' | 'int8';
  /** transformers.js builds the file name `onnx/<model_file_name><dtype suffix>.onnx`. */
  modelFileName?: string;
  maxTokens: number;
  license: string;
  notes: string;
}

const RERANKERS: Record<string, Reranker> = {
  'mmarco-mminilm-qint8': {
    id: 'mmarco-mminilm-qint8', repo: 'cross-encoder/mmarco-mMiniLMv2-L12-H384-v1', cacheDir: MODEL_DIR,
    dtype: 'fp32', modelFileName: 'model_qint8_arm64', maxTokens: MAX_TOKENS,
    license: 'Apache-2.0', notes: 'multilingual MS-MARCO cross-encoder (mMARCO translations: ar zh nl fr de hi id it ja pt ru es vi — NO Turkish, so Turkish is zero-shot via the XLM-R backbone); arm64 int8 export ~113 MB',
  },
  'mmarco-mminilm-fp32': {
    id: 'mmarco-mminilm-fp32', repo: 'cross-encoder/mmarco-mMiniLMv2-L12-H384-v1', cacheDir: MODEL_DIR,
    dtype: 'fp32', maxTokens: MAX_TOKENS,
    license: 'Apache-2.0', notes: 'same weights, fp32 (~449 MB) — accuracy reference for the int8 export',
  },
  'gte-multilingual-reranker-int8': {
    id: 'gte-multilingual-reranker-int8', repo: 'onnx-community/gte-multilingual-reranker-base', cacheDir: MODEL_DIR,
    dtype: 'int8', maxTokens: MAX_TOKENS,
    license: 'Apache-2.0 upstream (Alibaba-NLP/gte-multilingual-reranker-base)',
    notes: '306M params, 70+ languages incl. Turkish; int8 ONNX ~341 MB',
  },
  'bge-reranker-v2-m3-q8': {
    id: 'bge-reranker-v2-m3-q8', repo: 'onnx-community/bge-reranker-v2-m3-ONNX', cacheDir: MODEL_DIR,
    dtype: 'q8', maxTokens: MAX_TOKENS,
    license: 'Apache-2.0 upstream (BAAI/bge-reranker-v2-m3); the ONNX mirror card carries no license tag',
    notes: 'XLM-R-large class (~568M params), q8 ~544 MB — offline-only, for the record',
  },
};

// ─── CLI ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const has = (flag: string): boolean => argv.includes(flag);
const values = (flag: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === flag && argv[i + 1] !== undefined) out.push(argv[i + 1]);
  return out;
};
const value = (flag: string): string | undefined => values(flag)[0];
const fail = (msg: string): never => { console.error(msg); process.exit(2); };

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}
const round = (n: number, d = 3): number => Math.round(n * 10 ** d) / 10 ** d;
const now = (): number => performance.now();

function candidateOf(id: string | undefined): Candidate {
  const c = id ? CANDIDATES[id] : undefined;
  return c ?? fail(`--candidate must be one of: ${Object.keys(CANDIDATES).join(', ')}`);
}
function rerankerOf(id: string | undefined): Reranker {
  const r = id ? RERANKERS[id] : undefined;
  return r ?? fail(`--reranker must be one of: ${Object.keys(RERANKERS).join(', ')}`);
}

/** Train gold only: a held-out file (or anything under the frozen gold dir) is refused outright. */
function assertTrainGold(path: string): string {
  const abs = resolve(path);
  if (/held/i.test(abs) || abs.startsWith(join(FROZEN_DIR, 'gold'))) {
    return fail(`refusing ${abs}: T6 screens on TRAIN gold only`);
  }
  return abs;
}

const KNOWN_SET_NAMES: Record<string, string> = {
  'gold.jsonl': 'dc-v1-train',
  'gold-2026-10.train.jsonl': 'dc-26-train',
  'recall-gold.train.jsonl': 'hf-train',
};
const setNameOf = (path: string): string => KNOWN_SET_NAMES[basename(path)] ?? basename(path);

// ─── transformers.js plumbing ────────────────────────────────────────────────

interface TfTensor { data: ArrayLike<number | bigint>; dims: number[] }
type TfModel = (inputs: unknown) => Promise<Record<string, TfTensor>>;
type TfTokenizer = (texts: string | string[], opts?: Record<string, unknown>) => Record<string, TfTensor>;
type TfModule = typeof import('@huggingface/transformers');

async function loadTf(cacheDir: string, localOnly: boolean): Promise<TfModule> {
  const tf = await import('@huggingface/transformers');
  tf.env.cacheDir = cacheDir;
  tf.env.allowRemoteModels = !localOnly;
  return tf;
}

function l2normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

interface LoadTimings { importMs: number; tokenizerMs: number; modelMs: number; firstInferenceMs: number; coldLoadMs: number }

interface Embedder {
  cand: Candidate;
  timings: LoadTimings;
  embedDocs(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

async function loadStaticEmbedder(cand: Candidate): Promise<Embedder> {
  const t0 = now();
  const tf = await loadTf(cand.cacheDir, true);
  const ort = await import('onnxruntime-node');
  const importMs = now() - t0;
  const dir = join(cand.cacheDir, cand.repo);
  const t1 = now();
  const tokJson = JSON.parse(readFileSync(join(dir, 'tokenizer.json'), 'utf-8'));
  const tokenizer = new tf.PreTrainedTokenizer(tokJson, {}) as unknown as TfTokenizer;
  const tokenizerMs = now() - t1;
  const t2 = now();
  const session = await ort.InferenceSession.create(join(dir, cand.staticOnnxFile!));
  const modelMs = now() - t2;
  const embedTexts = async (texts: string[]): Promise<Float32Array[]> => {
    // One text per run: a static model costs microseconds per text, so padding/batching buys nothing.
    const rows: Float32Array[] = [];
    for (const text of texts) {
      const ids = (tokenizer as unknown as { encode: (t: string) => number[] }).encode(text).slice(0, cand.maxTokens);
      const n = Math.max(ids.length, 1);
      const idT = new ort.Tensor('int64', BigInt64Array.from((ids.length ? ids : [0]).map(BigInt)), [1, n]);
      const maskT = new ort.Tensor('int64', new BigInt64Array(n).fill(1n), [1, n]);
      const out = await session.run({ input_ids: idT, attention_mask: maskT });
      const t = out.sentence_embedding as unknown as TfTensor;
      const d = t.dims[t.dims.length - 1];
      const row = new Float32Array(d);
      for (let j = 0; j < d; j++) row[j] = Number(t.data[j]);
      rows.push(l2normalize(row));
    }
    return rows;
  };
  const t3 = now();
  await embedTexts(['warm up the model']);
  const firstInferenceMs = now() - t3;
  return {
    cand,
    timings: { importMs, tokenizerMs, modelMs, firstInferenceMs, coldLoadMs: importMs + tokenizerMs + modelMs + firstInferenceMs },
    embedDocs: (texts) => embedTexts(texts.map((t) => `${cand.docPrefix}${t}`)),
    embedQuery: async (text) => (await embedTexts([`${cand.queryPrefix}${text}`]))[0],
  };
}

async function loadEmbedder(cand: Candidate): Promise<Embedder> {
  if (cand.staticOnnxFile) return loadStaticEmbedder(cand);
  const t0 = now();
  const tf = await loadTf(cand.cacheDir, cand.localOnly);
  const importMs = now() - t0;

  const t1 = now();
  const tokenizer = (await tf.AutoTokenizer.from_pretrained(cand.repo)) as unknown as TfTokenizer;
  const tokenizerMs = now() - t1;

  const t2 = now();
  const model = (await tf.AutoModel.from_pretrained(cand.repo, { dtype: cand.dtype })) as unknown as TfModel;
  const modelMs = now() - t2;

  const embedTexts = async (texts: string[]): Promise<Float32Array[]> => {
    const inputs = tokenizer(texts, { padding: true, truncation: true, max_length: cand.maxTokens });
    const out = await model(inputs);
    const rows: Float32Array[] = [];
    if (cand.pooling === 'sentence_embedding') {
      const t = out.sentence_embedding ?? fail(`${cand.id}: model has no sentence_embedding output (${Object.keys(out).join(',')})`);
      const d = t.dims[t.dims.length - 1];
      for (let b = 0; b < texts.length; b++) {
        const row = new Float32Array(d);
        for (let j = 0; j < d; j++) row[j] = Number(t.data[b * d + j]);
        rows.push(l2normalize(row));
      }
      return rows;
    }
    const h = out.last_hidden_state ?? fail(`${cand.id}: model has no last_hidden_state output (${Object.keys(out).join(',')})`);
    const [B, T, H] = h.dims;
    const mask = inputs.attention_mask.data;
    for (let b = 0; b < B; b++) {
      const row = new Float32Array(H);
      if (cand.pooling === 'cls') {
        for (let j = 0; j < H; j++) row[j] = Number(h.data[b * T * H + j]);
      } else {
        let count = 0;
        for (let t = 0; t < T; t++) {
          if (Number(mask[b * T + t]) === 0) continue;
          count++;
          const base = (b * T + t) * H;
          for (let j = 0; j < H; j++) row[j] += Number(h.data[base + j]);
        }
        const c = count || 1;
        for (let j = 0; j < H; j++) row[j] /= c;
      }
      rows.push(l2normalize(row));
    }
    return rows;
  };

  const t3 = now();
  await embedTexts([`${cand.queryPrefix}warm up the model`]);
  const firstInferenceMs = now() - t3;

  return {
    cand,
    timings: { importMs, tokenizerMs, modelMs, firstInferenceMs, coldLoadMs: importMs + tokenizerMs + modelMs + firstInferenceMs },
    embedDocs: (texts) => embedTexts(texts.map((t) => `${cand.docPrefix}${t}`)),
    embedQuery: async (text) => (await embedTexts([`${cand.queryPrefix}${text}`]))[0],
  };
}

// ─── Index store (resumable, append-only) ────────────────────────────────────

const BATCH = 16; // = production BATCH_SIZE (embedder.ts)

interface ChunkSet {
  /** hash → chunk text, unique, for the docs that enter the dense channel. */
  texts: Map<string, string>;
  /** docKey → chunk hashes in seq order. */
  byDoc: Map<string, string[]>;
  docs: number;
  excludedDocs: number;
}

function buildChunkSet(corpus: CorpusDoc[]): ChunkSet {
  const banned = DENSE_EXCLUDED_TYPES.map((t) => `${t}/`);
  const texts = new Map<string, string>();
  const byDoc = new Map<string, string[]>();
  let excludedDocs = 0;
  for (const doc of corpus) {
    const key = docKey(doc);
    if (banned.some((p) => key.startsWith(p))) { excludedDocs++; continue; }
    const hashes: string[] = [];
    for (const c of chunkDoc(doc.title, doc.body, doc.description)) {
      if (!texts.has(c.hash)) texts.set(c.hash, c.text);
      hashes.push(c.hash);
    }
    byDoc.set(key, hashes);
  }
  return { texts, byDoc, docs: byDoc.size, excludedDocs };
}

interface SliceMeta { startedAt: string; rows: number; embedMs: number; loadMs: number; wallMs: number }
interface IndexMeta {
  candidate: string; corpus: string; dims: number; chunksTotal: number; rows: number;
  embedMsTotal: number; slices: SliceMeta[]; complete: boolean; limited: number | null;
  docsIndexed: number; excludedDocs: number;
}

function indexPaths(cand: Candidate, corpus: string, limited: number | null) {
  const dir = join(INDEX_DIR, cand.id, limited ? `${corpus}-limit${limited}` : corpus);
  return { dir, vectors: join(dir, 'vectors.f32'), hashes: join(dir, 'hashes.txt'), meta: join(dir, 'meta.json') };
}

/** Rows present in BOTH files (a kill between the two appends leaves one longer — trim it). */
function consistentRows(p: ReturnType<typeof indexPaths>, dims: number): string[] {
  if (!existsSync(p.hashes) || !existsSync(p.vectors)) return [];
  const hashes = readFileSync(p.hashes, 'utf-8').split('\n').filter(Boolean);
  const vecRows = Math.floor(statSync(p.vectors).size / (4 * dims));
  const rows = Math.min(hashes.length, vecRows);
  if (statSync(p.vectors).size !== rows * 4 * dims) truncateSync(p.vectors, rows * 4 * dims);
  if (hashes.length !== rows) writeFileSync(p.hashes, hashes.slice(0, rows).join('\n') + (rows ? '\n' : ''));
  return hashes.slice(0, rows);
}

async function buildIndex(cand: Candidate, corpusName: string, root: string, budgetMs: number, limit: number | null): Promise<void> {
  const corpus = stableCorpus(root);
  const set = buildChunkSet(corpus);
  const p = indexPaths(cand, corpusName, limit);
  mkdirSync(p.dir, { recursive: true });

  const done = new Set(consistentRows(p, cand.dims));
  // Longest first: batches then hold similar lengths (little padding). A --limit sample takes every
  // k-th chunk of that ordering so it is length-representative rather than all-short or all-long.
  let order = [...set.texts.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  if (limit) {
    const stride = Math.max(1, Math.floor(order.length / limit));
    order = order.filter((_, i) => i % stride === 0).slice(0, limit);
  }
  const chunksTotal = order.length;
  const pending = order.filter(([h]) => !done.has(h));

  const prior: IndexMeta | null = existsSync(p.meta) ? JSON.parse(readFileSync(p.meta, 'utf-8')) as IndexMeta : null;
  const meta: IndexMeta = prior ?? {
    candidate: cand.id, corpus: corpusName, dims: cand.dims, chunksTotal, rows: 0, embedMsTotal: 0, slices: [],
    complete: false, limited: limit, docsIndexed: set.docs, excludedDocs: set.excludedDocs,
  };
  meta.chunksTotal = chunksTotal;

  console.log(`[${cand.id}/${corpusName}] chunks ${chunksTotal} · done ${done.size} · pending ${pending.length} · docs ${set.docs} (+${set.excludedDocs} changelog docs skipped)`);
  if (pending.length === 0) {
    meta.rows = done.size; meta.complete = true;
    writeJson(p.meta, meta);
    return;
  }

  const wall0 = now();
  const loadStart = now();
  const embedder = await loadEmbedder(cand);
  const loadMs = now() - loadStart;
  console.log(`model loaded in ${Math.round(loadMs)}ms (cold ${Math.round(embedder.timings.coldLoadMs)}ms incl. first inference)`);

  let embedMs = 0;
  let rows = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    if (now() - wall0 > budgetMs) break;
    const batch = pending.slice(i, i + BATCH);
    const t = now();
    const vecs = await embedder.embedDocs(batch.map(([, text]) => text));
    embedMs += now() - t;
    const buf = Buffer.alloc(vecs.length * cand.dims * 4);
    vecs.forEach((v, k) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).copy(buf, k * cand.dims * 4));
    appendFileSync(p.vectors, buf);
    appendFileSync(p.hashes, batch.map(([h]) => h).join('\n') + '\n');
    rows += batch.length;
    if ((i / BATCH) % 10 === 9) {
      console.log(`  ${done.size + rows}/${chunksTotal} chunks · ${Math.round(embedMs / rows)} ms/chunk`);
    }
  }

  meta.rows = done.size + rows;
  meta.embedMsTotal += embedMs;
  meta.slices.push({ startedAt: new Date().toISOString(), rows, embedMs: Math.round(embedMs), loadMs: Math.round(loadMs), wallMs: Math.round(now() - wall0) });
  meta.complete = meta.rows >= chunksTotal;
  writeJson(p.meta, meta);
  console.log(`slice: +${rows} chunks in ${Math.round(embedMs)}ms (${rows ? Math.round(embedMs / rows) : 0} ms/chunk) · ${meta.rows}/${chunksTotal} · complete=${meta.complete}`);
}

/**
 * Controlled throughput benchmark — run for every candidate back to back, ideally on a quiet machine
 * (the load average is recorded at both ends so contention shows in the result). Index builds are cut
 * into slices over hours, so their wall time reflects whatever else the machine was doing; this is the
 * like-for-like comparison. The sample is every k-th chunk in HASH order (length-unbiased, deterministic),
 * embedded in production order (unsorted batches of 16) after one discarded warm-up batch.
 */
async function bench(cand: Candidate, root: string, goldPath: string): Promise<void> {
  const { loadavg } = await import('node:os');
  const set = buildChunkSet(stableCorpus(root));
  const sorted = [...set.texts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const stride = Math.max(1, Math.floor(sorted.length / (BATCH * 11)));
  const sample = sorted.filter((_, i) => i % stride === 0).slice(0, BATCH * 11);
  const load0 = loadavg()[0];

  const embedder = await loadEmbedder(cand);
  await embedder.embedDocs(sample.slice(0, BATCH).map(([, t]) => t)); // warm-up batch, discarded
  const batchMs: number[] = [];
  for (let i = BATCH; i < sample.length; i += BATCH) {
    const t = now();
    await embedder.embedDocs(sample.slice(i, i + BATCH).map(([, t2]) => t2));
    batchMs.push(now() - t);
  }
  const timed = sample.length - BATCH;
  const words = sample.slice(BATCH).reduce((s, [, t]) => s + (t.match(/\S+/g) ?? []).length, 0);

  const queries = loadGold(goldPath).slice(0, 21).map((g) => g.query);
  await embedder.embedQuery(queries[0]); // discarded warm-up
  const qMs: number[] = [];
  for (const q of queries.slice(1)) { const t = now(); await embedder.embedQuery(q); qMs.push(now() - t); }
  qMs.sort((a, b) => a - b);

  const total = batchMs.reduce((s, x) => s + x, 0);
  const result = {
    kind: 'bench', candidate: cand.id, root,
    index: { chunksTimed: timed, meanWordsPerChunk: Math.round(words / timed), msPerChunk: round(total / timed, 1), chunksPerSec: round(timed / (total / 1000), 2) },
    queryEmbedMs: { n: qMs.length, mean: round(qMs.reduce((s, x) => s + x, 0) / qMs.length, 1), p50: round(qMs[Math.floor(qMs.length * 0.5)], 1), p90: round(qMs[Math.floor(qMs.length * 0.9)], 1) },
    coldLoadMs: Math.round(embedder.timings.coldLoadMs),
    loadAvg1m: { start: round(load0, 2), end: round(loadavg()[0], 2) },
    at: new Date().toISOString(),
  };
  console.log(JSON.stringify(result, null, 2));
  writeJson(join(T6_RUNS, `bench.${cand.id}.json`), result);
}

interface LoadedIndex { dense: DenseIndex; meta: IndexMeta; set: ChunkSet; vectorOf: Map<string, Float32Array> }

function loadIndex(cand: Candidate, corpusName: string, corpus: CorpusDoc[]): LoadedIndex {
  const p = indexPaths(cand, corpusName, null);
  if (!existsSync(p.meta)) fail(`no index for ${cand.id}/${corpusName} — run --build-index first`);
  const meta = JSON.parse(readFileSync(p.meta, 'utf-8')) as IndexMeta;
  if (!meta.complete) fail(`index ${cand.id}/${corpusName} is incomplete (${meta.rows}/${meta.chunksTotal}) — keep running --build-index`);
  const hashes = readFileSync(p.hashes, 'utf-8').split('\n').filter(Boolean);
  const raw = readFileSync(p.vectors);
  const all = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const vectorOf = new Map<string, Float32Array>();
  hashes.forEach((h, i) => vectorOf.set(h, all.subarray(i * cand.dims, (i + 1) * cand.dims)));

  const set = buildChunkSet(corpus);
  const chunks: IndexedChunk[] = [];
  for (const [key, hs] of set.byDoc) {
    hs.forEach((h, seq) => {
      const vector = vectorOf.get(h);
      if (vector) chunks.push({ docKey: key, seq, hash: h, vector });
    });
  }
  return { dense: { chunks, dims: cand.dims }, meta, set, vectorOf };
}

/** MRL truncation: keep the first `d` dims and renormalise (Matryoshka). */
function truncateIndex(index: DenseIndex, d: number): DenseIndex {
  return {
    dims: d,
    chunks: index.chunks.map((c) => ({ ...c, vector: l2normalize(Float32Array.from(c.vector.subarray(0, d))) })),
  };
}

// ─── Search (a faithful port of hybridSearch's adaptive fusion, over candidate vectors) ──

/** Mirrors `const POOL = 50` in hybrid.ts (not exported there). */
const POOL = 50;

interface FusionParams { cutoff: number; rrfBm25Weight: number; lambda: number; pinMargin: number }
const PROD_FUSION: FusionParams = {
  cutoff: ADAPTIVE_RAW_CUTOFF,
  rrfBm25Weight: ADAPTIVE_RRF_BM25_WEIGHT,
  lambda: ADAPTIVE_RELATIVE_LAMBDA,
  pinMargin: ADAPTIVE_PIN_MARGIN,
};

function fuseAdaptive(bm25Hits: RecallHit[], denseHits: DenseHit[], byKey: Map<string, CorpusDoc>, p: FusionParams): RecallHit[] {
  const topRaw = Math.max(0, ...bm25Hits.map((h) => h.score));
  let fused: Map<string, number>;
  let pinKey: string | null = null;
  if (topRaw < p.cutoff) {
    fused = rrfFuse(
      [bm25Hits.map((h) => docKey(h.doc)), denseHits.map((h) => h.docKey)],
      RRF_K,
      [p.rrfBm25Weight, 1 - p.rrfBm25Weight],
    );
    if (
      p.pinMargin > 0 && bm25Hits.length >= 2 && bm25Hits[1].rankScore > 0
      && bm25Hits[0].rankScore / bm25Hits[1].rankScore >= p.pinMargin
    ) pinKey = docKey(bm25Hits[0].doc);
  } else {
    fused = relativeFuse(
      new Map(bm25Hits.map((h) => [docKey(h.doc), h.rankScore])),
      new Map(denseHits.map((h) => [h.docKey, h.sim])),
      p.lambda,
    );
  }
  const bm25ByKey = new Map(bm25Hits.map((h) => [docKey(h.doc), h]));
  const out: RecallHit[] = [];
  for (const [key, rankScore] of fused) {
    const hit = bm25ByKey.get(key);
    if (hit) { out.push({ ...hit, rankScore }); continue; }
    const doc = byKey.get(key);
    if (doc) out.push({ doc, score: 0, rankScore, snippet: '' });
  }
  out.sort((a, b) => b.rankScore - a.rankScore);
  if (pinKey !== null) {
    const i = out.findIndex((h) => docKey(h.doc) === pinKey);
    if (i > 0) { const [pinned] = out.splice(i, 1); out.unshift(pinned); }
  }
  return out;
}

interface SearchCtx { corpus: CorpusDoc[]; byKey: Map<string, CorpusDoc>; dense: DenseIndex; embedder: Embedder; now: Date }

function denseHitsToRecall(hits: DenseHit[], byKey: Map<string, CorpusDoc>): RecallHit[] {
  const out: RecallHit[] = [];
  for (const h of hits) {
    const doc = byKey.get(h.docKey);
    if (doc) out.push({ doc, score: 0, rankScore: h.sim, snippet: '' });
  }
  return out;
}

function denseSearchFn(ctx: SearchCtx): SearchFn {
  return async (q, k) => {
    const qv = await ctx.embedder.embedQuery(q);
    return denseHitsToRecall(denseRank(qv, ctx.dense, k * 2), ctx.byKey).slice(0, k);
  };
}

function hybridSearchFn(ctx: SearchCtx, p: FusionParams = PROD_FUSION): SearchFn {
  return async (q, k) => {
    const bm25Hits = bm25Search(q, ctx.corpus, POOL, { now: ctx.now });
    const qv = await ctx.embedder.embedQuery(q);
    return fuseAdaptive(bm25Hits, denseRank(qv, ctx.dense, POOL), ctx.byKey, p).slice(0, k);
  };
}

// ─── Metrics helpers (same formulas as evaluateSearch, for pooled / per-language views) ──

type PerQuery = ExtendedReport['perQuery'];

function metricsOf(rows: PerQuery): ExtendedMetrics {
  let h1 = 0, h3 = 0, h5 = 0, rr = 0, nd = 0;
  for (const r of rows) {
    if (r.rank === null) continue;
    if (r.rank === 1) h1++;
    if (r.rank <= 3) h3++;
    if (r.rank <= 5) h5++;
    rr += 1 / r.rank;
    if (r.rank <= 10) nd += 1 / Math.log2(r.rank + 1);
  }
  const n = rows.length;
  return {
    recall1: n ? (h1 / n) * 100 : 0, recall3: n ? (h3 / n) * 100 : 0, recall5: n ? (h5 / n) * 100 : 0,
    mrr: n ? rr / n : 0, ndcg10: n ? nd / n : 0, n,
  };
}

function groupBy(rows: PerQuery, key: (r: PerQuery[number]) => string): Record<string, ExtendedMetrics> {
  const groups = new Map<string, PerQuery>();
  for (const r of rows) {
    const k = key(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return Object.fromEntries([...groups].map(([k, g]) => [k, metricsOf(g)]));
}

const fmt = (m: ExtendedMetrics): string => `r@1 ${m.recall1.toFixed(1)} r@3 ${m.recall3.toFixed(1)} r@5 ${m.recall5.toFixed(1)} MRR ${m.mrr.toFixed(3)} n=${m.n}`;

// ─── Result files ────────────────────────────────────────────────────────────

interface ModeResult { report: ExtendedReport }
interface SetResult { n: number; modes: Record<string, ModeResult> }
interface EvalResult {
  kind: 'eval';
  candidate: string; corpus: string; root: string; now: string;
  index: Pick<IndexMeta, 'rows' | 'dims' | 'chunksTotal' | 'embedMsTotal' | 'docsIndexed' | 'excludedDocs'> & { slices: number; msPerChunk: number };
  load: LoadTimings;
  sets: Record<string, SetResult>;
}

const resultPath = (kind: string, id: string, corpus: string): string => join(RESULTS_DIR, `${kind}.${id}.${corpus}.json`);

// ─── Modes ───────────────────────────────────────────────────────────────────

const PRECHECK_QUERY = 'Which planet is known as the Red Planet?';
const PRECHECK_DOCS = [
  "Venus is often called Earth's twin because of its similar size and proximity.",
  "Mars, known for its reddish appearance, is often referred to as the Red Planet.",
  'Jupiter, the largest planet in our solar system, has a prominent red spot.',
  'Saturn, famous for its rings, is sometimes mistaken for the Red Planet.',
];
const PRECHECK_TR_QUERY = 'Kızıl gezegen olarak bilinen gezegen hangisidir?';
const PRECHECK_TR_DOCS = [
  'Venüs, boyutu ve Dünya’ya yakınlığı nedeniyle sık sık Dünya’nın ikizi olarak anılır.',
  'Mars, kırmızımsı görünümüyle Kızıl Gezegen olarak bilinir.',
  'Jüpiter, güneş sistemimizdeki en büyük gezegendir ve belirgin bir kırmızı lekeye sahiptir.',
  'Satürn, halkalarıyla ünlüdür.',
];
const dot = (a: Float32Array, b: Float32Array): number => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

async function precheck(cand: Candidate): Promise<void> {
  const embedder = await loadEmbedder(cand);
  const probe = async (q: string, docs: string[]) => {
    const [qv] = [await embedder.embedQuery(q)];
    const dv = await embedder.embedDocs(docs);
    return dv.map((d) => round(dot(qv, d), 4));
  };
  const en = await probe(PRECHECK_QUERY, PRECHECK_DOCS);
  const tr = await probe(PRECHECK_TR_QUERY, PRECHECK_TR_DOCS);
  const xl = await probe(PRECHECK_TR_QUERY, PRECHECK_DOCS); // Turkish query over English docs
  const top = (s: number[]): number => s.indexOf(Math.max(...s));
  const vec = await embedder.embedQuery(PRECHECK_QUERY);
  const norm = Math.sqrt(dot(vec, vec));

  // Warm single-query latency (the dense query path's model cost), after one discarded call.
  await embedder.embedQuery('latency warm-up');
  const times: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t = now();
    await embedder.embedQuery(`${PRECHECK_QUERY} ${i}`);
    times.push(now() - t);
  }
  // A representative doc batch (16 chunks of ~300 words) for the index-throughput estimate.
  const para = 'The recall engine fuses lexical and dense rankings so a query about sleep consolidation finds the canonical document. '.repeat(20);
  const batchTimes: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t = now();
    await embedder.embedDocs(Array.from({ length: BATCH }, (_, k) => `${para} ${i}-${k}`));
    batchTimes.push(now() - t);
  }

  const result = {
    kind: 'precheck', candidate: cand.id, repo: cand.repo, dtype: cand.dtype, pooling: cand.pooling,
    dims: { expected: cand.dims, actual: vec.length, ok: vec.length === cand.dims },
    norm: round(norm, 4), finite: Array.from(vec).every(Number.isFinite),
    probes: {
      en: { scores: en, top1IsMars: top(en) === 1 },
      tr: { scores: tr, top1IsMars: top(tr) === 1 },
      crossLingualTrToEn: { scores: xl, top1IsMars: top(xl) === 1 },
    },
    load: Object.fromEntries(Object.entries(embedder.timings).map(([k, v]) => [k, Math.round(v)])),
    warmQueryEmbedMs: { mean: round(times.reduce((s, t) => s + t, 0) / times.length, 1), p50: round([...times].sort((a, b) => a - b)[5], 1) },
    docBatch16x300w: { meanMs: round(batchTimes.reduce((s, t) => s + t, 0) / batchTimes.length, 0), msPerChunk: round(batchTimes.reduce((s, t) => s + t, 0) / batchTimes.length / BATCH, 1) },
    license: cand.license, notes: cand.notes,
  };
  console.log(JSON.stringify(result, null, 2));
  writeJson(join(T6_RUNS, `precheck.${cand.id}.json`), result);
}

async function runEval(cand: Candidate): Promise<void> {
  const corpusName = value('--corpus') ?? fail('--corpus dc|hf is required');
  const root = resolve(value('--root') ?? fail('--root <frozen context root> is required'));
  const goldPaths = values('--gold').map(assertTrainGold);
  if (goldPaths.length === 0) fail('--gold <train.jsonl> is required (repeatable)');
  const pinned = loadNow(value('--now') ?? 'frozen');

  const corpus = stableCorpus(root);
  const byKey = new Map(corpus.map((d) => [docKey(d), d]));
  const idx = loadIndex(cand, corpusName, corpus);
  const embedder = await loadEmbedder(cand);
  const ctx: SearchCtx = { corpus, byKey, dense: idx.dense, embedder, now: pinned };

  // Query-vector cache for the untimed variant passes (MRL truncations, fusion sweep).
  const qvCache = new Map<string, Float32Array>();
  const qv = async (q: string): Promise<Float32Array> => {
    let v = qvCache.get(q);
    if (!v) { v = await embedder.embedQuery(q); qvCache.set(q, v); }
    return v;
  };

  const sets: Record<string, SetResult> = {};
  for (const path of goldPaths) {
    const name = setNameOf(path);
    const gold = loadGold(path);
    const modes: Record<string, ModeResult> = {};

    // bm25 needs no model: it is the cross-check that corpus + clock match G1.
    modes.bm25 = { report: await evaluateSearch(async (q, k) => bm25Search(q, corpus, k, { now: pinned }), gold) };
    modes.dense = { report: await evaluateSearch(denseSearchFn(ctx), gold) };
    if (!has('--dense-only')) modes.hybrid = { report: await evaluateSearch(hybridSearchFn(ctx), gold) };

    if (cand.id.startsWith('embeddinggemma')) {
      for (const d of [512, 256, 128]) {
        const truncated = truncateIndex(idx.dense, d);
        const search: SearchFn = async (q, k) => {
          const v = l2normalize(Float32Array.from((await qv(q)).subarray(0, d)));
          return denseHitsToRecall(denseRank(v, truncated, k * 2), byKey).slice(0, k);
        };
        modes[`dense-mrl${d}`] = { report: await evaluateSearch(search, gold) };
      }
    }
    sets[name] = { n: gold.length, modes };

    console.log(`\n${name} (${gold.length}q) — ${cand.id} on ${corpusName}`);
    for (const [m, r] of Object.entries(modes)) {
      console.log(`  ${m.padEnd(12)} ${fmt(r.report.overall)} · mean ${r.report.latency.meanMs.toFixed(1)}ms p50 ${r.report.latency.p50Ms.toFixed(1)} p90 ${r.report.latency.p90Ms.toFixed(1)}`);
    }
  }

  const result: EvalResult = {
    kind: 'eval', candidate: cand.id, corpus: corpusName, root, now: pinned.toISOString(),
    index: {
      rows: idx.meta.rows, dims: idx.meta.dims, chunksTotal: idx.meta.chunksTotal, embedMsTotal: Math.round(idx.meta.embedMsTotal),
      docsIndexed: idx.meta.docsIndexed, excludedDocs: idx.meta.excludedDocs, slices: idx.meta.slices.length,
      msPerChunk: round(idx.meta.embedMsTotal / Math.max(1, idx.meta.rows), 1),
    },
    load: embedder.timings,
    sets,
  };
  writeJson(resultPath('eval', cand.id, corpusName), result);
  console.log(`\nwrote ${resultPath('eval', cand.id, corpusName)}`);
}

// ─── Fusion re-sweep (for a dense-only winner; TRAIN gold, informational for T10) ─────────────
//
// The production fusion constants were tuned around e5's weak dense channel (they lean on BM25).
// A stronger model may want more dense weight. Writes its own file so the latency numbers in the
// eval result are never overwritten by a noisier re-run. T10 does the binding tuning (<= 3 rounds).

interface SweepRow { params: FusionParams; mrr: number; r1: number; r3: number; r5: number; exactR1: number; fieldR1: number; trR1: number; trR3: number }
interface SweepResult {
  kind: 'sweep'; candidate: string; corpus: string; now: string; n: number;
  reference: { bm25: Omit<SweepRow, 'params'>; dense: Omit<SweepRow, 'params'>; prod: SweepRow };
  rows: SweepRow[];
}

function sweepMetrics(rows: PerQuery): Omit<SweepRow, 'params'> {
  const o = metricsOf(rows);
  const cat = groupBy(rows, (r) => r.category);
  return {
    mrr: round(o.mrr), r1: round(o.recall1, 1), r3: round(o.recall3, 1), r5: round(o.recall5, 1),
    exactR1: round(cat['exact-term']?.recall1 ?? 0, 1), fieldR1: round(cat['field-match']?.recall1 ?? 0, 1),
    trR1: round(cat.turkish?.recall1 ?? 0, 1), trR3: round(cat.turkish?.recall3 ?? 0, 1),
  };
}

async function runSweep(cand: Candidate): Promise<void> {
  const corpusName = value('--corpus') ?? fail('--corpus dc|hf is required');
  const root = resolve(value('--root') ?? fail('--root <frozen context root> is required'));
  const goldPaths = values('--gold').map(assertTrainGold);
  if (goldPaths.length === 0) fail('--gold <train.jsonl> is required (repeatable)');
  const pinned = loadNow(value('--now') ?? 'frozen');

  const corpus = stableCorpus(root);
  const byKey = new Map(corpus.map((d) => [docKey(d), d]));
  const idx = loadIndex(cand, corpusName, corpus);
  const embedder = await loadEmbedder(cand);

  const gold = goldPaths.flatMap((p) => loadGold(p).map((g) => ({ ...g, id: `${setNameOf(p)}:${g.id}` })));
  const bm25Cache = new Map<string, RecallHit[]>();
  const denseCache = new Map<string, DenseHit[]>();
  for (const g of gold) {
    if (!bm25Cache.has(g.query)) bm25Cache.set(g.query, bm25Search(g.query, corpus, POOL, { now: pinned }));
    if (!denseCache.has(g.query)) denseCache.set(g.query, denseRank(await embedder.embedQuery(g.query), idx.dense, POOL));
  }
  const rankOf = (keys: string[], g: GoldQuery): number | null => {
    const targets = new Set([...g.expected, ...(g.alt ?? [])]);
    for (let i = 0; i < Math.min(10, keys.length); i++) if (targets.has(keys[i])) return i + 1;
    return null;
  };
  const rowsFor = (keysOf: (g: GoldQuery) => string[]): PerQuery => gold.map((g) => ({ id: g.id, category: g.category, lang: g.lang, rank: rankOf(keysOf(g), g) }));

  const rows: SweepRow[] = [];
  for (const cutoff of [12, 18, 24, 36]) for (const rrfBm25Weight of [0.3, 0.4, 0.5, 0.6, 0.7]) for (const lambda of [0.1, 0.2, 0.3, 0.4, 0.5]) for (const pinMargin of [0, 1.35, 1.6]) {
    const params: FusionParams = { cutoff, rrfBm25Weight, lambda, pinMargin };
    rows.push({ params, ...sweepMetrics(rowsFor((g) => fuseAdaptive(bm25Cache.get(g.query)!, denseCache.get(g.query)!, byKey, params).map((h) => docKey(h.doc)))) });
  }
  rows.sort((a, b) => b.mrr - a.mrr);
  const result: SweepResult = {
    kind: 'sweep', candidate: cand.id, corpus: corpusName, now: pinned.toISOString(), n: gold.length,
    reference: {
      bm25: sweepMetrics(rowsFor((g) => bm25Cache.get(g.query)!.map((h) => docKey(h.doc)))),
      dense: sweepMetrics(rowsFor((g) => denseCache.get(g.query)!.map((h) => h.docKey))),
      prod: { params: PROD_FUSION, ...sweepMetrics(rowsFor((g) => fuseAdaptive(bm25Cache.get(g.query)!, denseCache.get(g.query)!, byKey, PROD_FUSION).map((h) => docKey(h.doc)))) },
    },
    rows,
  };
  writeJson(resultPath('sweep', cand.id, corpusName), result);
  console.log(`${cand.id}/${corpusName} (${gold.length}q) — ${rows.length} fusion settings`);
  console.log(`  bm25 MRR ${result.reference.bm25.mrr} · dense MRR ${result.reference.dense.mrr} · production fusion MRR ${result.reference.prod.mrr}`);
  rows.slice(0, 5).forEach((r) => console.log(`  ${JSON.stringify(r.params)} MRR ${r.mrr} r@1 ${r.r1} r@3 ${r.r3} exact r@1 ${r.exactR1} field r@1 ${r.fieldR1} TR r@1 ${r.trR1} r@3 ${r.trR3}`));
}

// ─── Reranker screening ──────────────────────────────────────────────────────

interface RerankerRuntime {
  def: Reranker;
  timings: { importMs: number; tokenizerMs: number; modelMs: number; coldLoadMs: number };
  scoreBatch(query: string, passages: string[]): Promise<number[]>;
}

async function loadReranker(def: Reranker): Promise<RerankerRuntime> {
  const t0 = now();
  const tf = await loadTf(def.cacheDir, false);
  const importMs = now() - t0;
  const t1 = now();
  const tokenizer = (await tf.AutoTokenizer.from_pretrained(def.repo)) as unknown as TfTokenizer;
  const tokenizerMs = now() - t1;
  const t2 = now();
  const model = (await tf.AutoModelForSequenceClassification.from_pretrained(def.repo, {
    dtype: def.dtype, ...(def.modelFileName ? { model_file_name: def.modelFileName } : {}),
  })) as unknown as TfModel;
  const modelMs = now() - t2;
  const scoreBatch = async (query: string, passages: string[]): Promise<number[]> => {
    const maxLen = Number(value('--passage-tokens') ?? def.maxTokens);
    const inputs = tokenizer(passages.map(() => query), { text_pair: passages, padding: true, truncation: true, max_length: maxLen });
    const out = await model(inputs);
    const logits = out.logits ?? fail(`${def.id}: no logits output (${Object.keys(out).join(',')})`);
    const labels = logits.dims[logits.dims.length - 1];
    return passages.map((_, i) => Number(logits.data[i * labels]));
  };
  const t3 = now();
  await scoreBatch('warm', ['up']);
  const firstMs = now() - t3;
  return { def, timings: { importMs, tokenizerMs, modelMs, coldLoadMs: importMs + tokenizerMs + modelMs + firstMs }, scoreBatch };
}

async function precheckReranker(def: Reranker): Promise<void> {
  const rr = await loadReranker(def);
  const check = async (q: string, good: string, bad: string[]) => {
    const s = await rr.scoreBatch(q, [good, ...bad]);
    return { scores: s.map((x) => round(x, 3)), goodIsTop: s[0] === Math.max(...s) };
  };
  const en = await check(PRECHECK_QUERY, PRECHECK_DOCS[1], [PRECHECK_DOCS[0], PRECHECK_DOCS[2], PRECHECK_DOCS[3]]);
  const tr = await check(PRECHECK_TR_QUERY, PRECHECK_TR_DOCS[1], [PRECHECK_TR_DOCS[0], PRECHECK_TR_DOCS[2], PRECHECK_TR_DOCS[3]]);
  const crossLingual = await check(PRECHECK_TR_QUERY, PRECHECK_DOCS[1], [PRECHECK_DOCS[0], PRECHECK_DOCS[2], PRECHECK_DOCS[3]]);
  const para = 'The recall engine fuses lexical and dense rankings so a query about sleep consolidation finds the canonical document. '.repeat(20);
  const batch = Array.from({ length: 20 }, (_, i) => `${para} ${i}`);
  await rr.scoreBatch(PRECHECK_QUERY, batch);
  const times: number[] = [];
  for (let i = 0; i < 3; i++) { const t = now(); await rr.scoreBatch(PRECHECK_QUERY, batch); times.push(now() - t); }
  const result = {
    kind: 'precheck-reranker', reranker: def.id, repo: def.repo, dtype: def.dtype, modelFileName: def.modelFileName ?? null,
    probes: { en, tr, crossLingualTrToEn: crossLingual },
    load: Object.fromEntries(Object.entries(rr.timings).map(([k, v]) => [k, Math.round(v)])),
    top20x300wMs: round(times.reduce((s, t) => s + t, 0) / times.length, 0),
    license: def.license, notes: def.notes,
  };
  console.log(JSON.stringify(result, null, 2));
  writeJson(join(T6_RUNS, `precheck.${def.id}.json`), result);
}

async function runRerank(def: Reranker): Promise<void> {
  const corpusName = value('--corpus') ?? fail('--corpus dc|hf is required');
  const root = resolve(value('--root') ?? fail('--root <frozen context root> is required'));
  const goldPaths = values('--gold').map(assertTrainGold);
  if (goldPaths.length === 0) fail('--gold <train.jsonl> is required (repeatable)');
  const pinned = loadNow(value('--now') ?? 'frozen');
  // Experiment knobs: which embedder builds the candidate list, how many it hands the cross-encoder,
  // and how long each passage may be (the cross-encoder's cost is pairs × tokens).
  const control = CANDIDATES[value('--candidate') ?? 'e5-small-q8'] ?? fail('unknown --candidate');
  const TOP_N = Number(value('--top') ?? 20);

  const corpus = stableCorpus(root);
  const byKey = new Map(corpus.map((d) => [docKey(d), d]));
  const idx = loadIndex(control, corpusName, corpus);
  const embedder = await loadEmbedder(control);
  const reranker = await loadReranker(def);
  const ctx: SearchCtx = { corpus, byKey, dense: idx.dense, embedder, now: pinned };

  // Passage per candidate doc = its chunk closest to the query under the dense model (the text a
  // hook would show); docs outside the dense channel (changelog) fall back to their first chunk.
  const chunksOf = new Map<string, Array<{ hash: string; text: string }>>();
  const passageFor = (key: string, qvec: Float32Array): string => {
    const doc = byKey.get(key)!;
    let list = chunksOf.get(key);
    if (!list) { list = chunkDoc(doc.title, doc.body, doc.description).map((c) => ({ hash: c.hash, text: c.text })); chunksOf.set(key, list); }
    if (list.length === 0) return `${doc.title}\n${doc.description}`;
    let best = list[0].text, bestSim = -Infinity;
    for (const c of list) {
      const v = idx.vectorOf.get(c.hash);
      const s = v ? dot(qvec, v) : -Infinity;
      if (s > bestSim) { bestSim = s; best = c.text; }
    }
    return best;
  };

  // One cross-encoder pass per query, shared by the rerank-only and rerank-blend views (their
  // cost is identical); the first call per query is the only one timed.
  const scored = new Map<string, { hits: RecallHit[]; scores: number[] }>();
  const timesMs: number[] = [];
  const scoreTop = async (q: string): Promise<{ hits: RecallHit[]; scores: number[] }> => {
    const memo = scored.get(q);
    if (memo) return memo;
    const bm25Hits = bm25Search(q, corpus, POOL, { now: pinned });
    const qvec = await embedder.embedQuery(q);
    const hits = fuseAdaptive(bm25Hits, denseRank(qvec, idx.dense, POOL), byKey, PROD_FUSION).slice(0, TOP_N);
    const passages = hits.map((h) => passageFor(docKey(h.doc), qvec));
    const t = now();
    const scores = await reranker.scoreBatch(q, passages);
    timesMs.push(now() - t);
    const entry = { hits, scores };
    scored.set(q, entry);
    return entry;
  };

  const results: Record<string, { n: number; modes: Record<string, { report: ExtendedReport }> }> = {};
  for (const path of goldPaths) {
    const name = setNameOf(path);
    const gold = loadGold(path);
    const baseSearch = hybridSearchFn(ctx);
    const rerankSearch = (blend: boolean): SearchFn => async (q, k) => {
      const top = await scoreTop(q);
      const byCe = top.hits.map((h, i) => ({ h, ce: top.scores[i], hybridRank: i + 1 }));
      const ceOrder = [...byCe].sort((a, b) => b.ce - a.ce);
      if (!blend) return ceOrder.map((x) => x.h).slice(0, k);
      const ceRank = new Map(ceOrder.map((x, i) => [docKey(x.h.doc), i + 1]));
      return [...byCe]
        .map((x) => ({ h: x.h, s: 0.5 / (RRF_K + x.hybridRank) + 0.5 / (RRF_K + (ceRank.get(docKey(x.h.doc)) ?? TOP_N)) }))
        .sort((a, b) => b.s - a.s).map((x) => x.h).slice(0, k);
    };
    const modes: Record<string, { report: ExtendedReport }> = {
      hybrid: { report: await evaluateSearch(baseSearch, gold) },
      'rerank-only': { report: await evaluateSearch(rerankSearch(false), gold) },
      'rerank-blend': { report: await evaluateSearch(rerankSearch(true), gold) },
    };
    results[name] = { n: gold.length, modes };
    console.log(`\n${name} (${gold.length}q) — ${def.id} on ${corpusName}`);
    for (const [m, r] of Object.entries(modes)) console.log(`  ${m.padEnd(13)} ${fmt(r.report.overall)} · mean ${r.report.latency.meanMs.toFixed(1)}ms`);
  }
  // timesMs has one entry per distinct query (the first-ever call is the cold one — dropped).
  const warm = timesMs.slice(1);
  const out = {
    kind: 'rerank', reranker: def.id, corpus: corpusName, now: pinned.toISOString(), topN: TOP_N,
    load: Object.fromEntries(Object.entries(reranker.timings).map(([k, v]) => [k, Math.round(v)])),
    rerankMsPerQuery: { mean: round(warm.reduce((s, t) => s + t, 0) / Math.max(1, warm.length), 1), p90: round([...warm].sort((a, b) => a - b)[Math.floor(warm.length * 0.9)] ?? 0, 1), calls: warm.length },
    sets: results,
  };
  writeJson(resultPath('rerank', def.id, corpusName), out);
  console.log(`\nrerank per query (${TOP_N} pairs): mean ${out.rerankMsPerQuery.mean}ms p90 ${out.rerankMsPerQuery.p90}ms · wrote ${resultPath('rerank', def.id, corpusName)}`);
}

// ─── Aggregate → eval/runs/2026-10-07-models.json (aggregates only) ──────────

const GATE_N = 8; // categories gated only when pooled n >= 8 (plan criterion 2c)
const NOISE_QUERIES = 1; // measured: the e5 control differs from production by +-1 query per set

function pooled(res: EvalResult | undefined, mode: string): PerQuery {
  if (!res) return [];
  return Object.entries(res.sets).flatMap(([setName, s]) => (s.modes[mode]?.report.perQuery ?? []).map((r) => ({ ...r, id: `${setName}:${r.id}` })));
}

interface Verdict {
  overall: ExtendedMetrics; byCategory: Record<string, ExtendedMetrics>; byLang: Record<string, ExtendedMetrics>;
}
function view(rows: PerQuery): Verdict {
  return { overall: metricsOf(rows), byCategory: groupBy(rows, (r) => r.category), byLang: groupBy(rows, (r) => r.lang) };
}
const roundM = (m: ExtendedMetrics): Record<string, number> => ({ r1: round(m.recall1, 1), r3: round(m.recall3, 1), r5: round(m.recall5, 1), mrr: round(m.mrr), ndcg10: round(m.ndcg10), n: m.n });
const roundV = (v: Verdict) => ({
  overall: roundM(v.overall),
  byCategory: Object.fromEntries(Object.entries(v.byCategory).sort().map(([k, m]) => [k, roundM(m)])),
  byLang: Object.fromEntries(Object.entries(v.byLang).sort().map(([k, m]) => [k, roundM(m)])),
});

/** Candidate vs control on the same pooled queries: deltas, gated-category regressions, flip counts. */
function compare(cand: PerQuery, control: PerQuery) {
  const c = view(cand), k = view(control);
  const ctrlRank = new Map(control.map((r) => [r.id, r.rank]));
  let improved = 0, regressed = 0;
  const flipsByCategory: Record<string, { improved: number; regressed: number }> = {};
  for (const r of cand) {
    const before = ctrlRank.get(r.id) ?? null;
    const b = before ?? 99, a = r.rank ?? 99;
    const bucket = (x: number): number => (x === 1 ? 1 : x <= 3 ? 3 : 99);
    if (bucket(a) === bucket(b)) continue;
    const slot = (flipsByCategory[r.category] ??= { improved: 0, regressed: 0 });
    if (bucket(a) < bucket(b)) { improved++; slot.improved++; } else { regressed++; slot.regressed++; }
  }
  const gated = Object.keys(k.byCategory).filter((cat) => (k.byCategory[cat]?.n ?? 0) >= GATE_N);
  const regressions = gated
    .map((cat) => {
      const kc = k.byCategory[cat], cc = c.byCategory[cat];
      const lost = (metric: 'recall1' | 'recall3'): number => Math.round(((kc[metric] - (cc?.[metric] ?? 0)) / 100) * kc.n);
      return {
        category: cat, n: kc.n,
        r1: round((cc?.recall1 ?? 0) - kc.recall1, 1),
        r3: round((cc?.recall3 ?? 0) - kc.recall3, 1),
        queriesLostR1: lost('recall1'), queriesLostR3: lost('recall3'),
      };
    })
    .filter((x) => x.r1 < 0 || x.r3 < 0);
  // The control reproduces production within +-1 query per set (q8 activation quantisation depends on
  // batch composition), so a dip of ONE query in a category is inside the measurement noise floor.
  const regressionsBeyondNoise = regressions.filter((x) => x.queriesLostR1 >= NOISE_QUERIES + 1 || x.queriesLostR3 >= NOISE_QUERIES + 1);
  const tr = (v: Verdict) => v.byCategory.turkish ?? { recall1: 0, recall3: 0, mrr: 0, ndcg10: 0, recall5: 0, n: 0 };
  return {
    deltaVsControl: {
      mrr: round(c.overall.mrr - k.overall.mrr), r1: round(c.overall.recall1 - k.overall.recall1, 1),
      r3: round(c.overall.recall3 - k.overall.recall3, 1), r5: round(c.overall.recall5 - k.overall.recall5, 1),
      turkishR1: round(tr(c).recall1 - tr(k).recall1, 1), turkishR3: round(tr(c).recall3 - tr(k).recall3, 1),
    },
    gatedCategoryRegressions: regressions,
    gatedRegressionsBeyondNoise: regressionsBeyondNoise,
    queryFlips: { improved, regressed, byCategory: flipsByCategory },
  };
}

/**
 * Cross-corpus view of the fusion re-sweep: a setting "passes" when, on EVERY swept corpus, hybrid is at
 * least BM25 on overall r@1/r@3/r@5 and on exact-term r@1, field-match r@1 and Turkish r@1/r@3 (the plan's
 * non-inferiority shape). Passing settings are ranked by n-weighted pooled MRR. Informational for T10.
 */
function mergeSweeps(list: SweepResult[]) {
  if (list.length === 0) return undefined;
  const keyOf = (p: FusionParams): string => `${p.cutoff}|${p.rrfBm25Weight}|${p.lambda}|${p.pinMargin}`;
  const totalN = list.reduce((s, x) => s + x.n, 0);
  const byKey = new Map<string, { params: FusionParams; mrr: number; passes: boolean; perCorpus: Record<string, SweepRow> }>();
  for (const sw of list) {
    for (const row of sw.rows) {
      const k = keyOf(row.params);
      const cur = byKey.get(k) ?? { params: row.params, mrr: 0, passes: true, perCorpus: {} };
      const b = sw.reference.bm25;
      const ok = row.r1 >= b.r1 && row.r3 >= b.r3 && row.r5 >= b.r5 && row.exactR1 >= b.exactR1 && row.fieldR1 >= b.fieldR1 && row.trR1 >= b.trR1 && row.trR3 >= b.trR3;
      cur.mrr += (row.mrr * sw.n) / totalN;
      cur.passes = cur.passes && ok;
      cur.perCorpus[sw.corpus] = row;
      byKey.set(k, cur);
    }
  }
  const all = [...byKey.values()].map((x) => ({ ...x, mrr: round(x.mrr) })).sort((a, b) => b.mrr - a.mrr);
  const prod = byKey.get(keyOf(PROD_FUSION));
  return {
    corpora: list.map((s) => s.corpus), queries: totalN, settings: all.length,
    reference: Object.fromEntries(list.map((s) => [s.corpus, s.reference])),
    productionFusion: prod ? { pooledMrr: round(prod.mrr), passesBm25NonInferiority: prod.passes } : null,
    passingCount: all.filter((x) => x.passes).length,
    bestPassing: all.filter((x) => x.passes).slice(0, 5),
    bestUnconstrained: all.slice(0, 3),
  };
}

function aggregate(): void {
  const files = existsSync(RESULTS_DIR) ? readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.json')) : [];
  const evals = new Map<string, EvalResult>();
  const sweeps = new Map<string, SweepResult>();
  const reranks: any[] = [];
  for (const f of files) {
    const data = JSON.parse(readFileSync(join(RESULTS_DIR, f), 'utf-8'));
    if (data.kind === 'eval') evals.set(`${data.candidate}|${data.corpus}`, data as EvalResult);
    else if (data.kind === 'sweep') sweeps.set(`${data.candidate}|${data.corpus}`, data as SweepResult);
    else if (data.kind === 'rerank') reranks.push(data);
  }
  const prechecks: Record<string, unknown> = {};
  if (existsSync(T6_RUNS)) for (const f of readdirSync(T6_RUNS).filter((x) => x.startsWith('precheck.'))) {
    const d = JSON.parse(readFileSync(join(T6_RUNS, f), 'utf-8')) as { candidate?: string; reranker?: string };
    prechecks[d.candidate ?? d.reranker ?? f] = d;
  }
  const benches: Record<string, unknown> = {};
  if (existsSync(T6_RUNS)) for (const f of readdirSync(T6_RUNS).filter((x) => x.startsWith('bench.'))) {
    const d = JSON.parse(readFileSync(join(T6_RUNS, f), 'utf-8')) as { candidate: string };
    benches[d.candidate] = d;
  }

  const corpora = ['dc', 'hf'];
  const candidates: Record<string, unknown> = {};
  for (const id of Object.keys(CANDIDATES)) {
    const cand = CANDIDATES[id];
    const perCorpus: Record<string, unknown> = {};
    for (const corpus of corpora) {
      const res = evals.get(`${id}|${corpus}`);
      const ctrl = evals.get(`e5-small-q8|${corpus}`);
      if (!res) continue;
      const modes = Object.keys(Object.values(res.sets)[0]?.modes ?? {});
      const entry: Record<string, unknown> = {
        index: res.index,
        load: res.load,
        sets: Object.fromEntries(Object.entries(res.sets).map(([s, v]) => [s, { n: v.n }])),
      };
      for (const m of modes) {
        const rows = pooled(res, m);
        const lat = Object.values(res.sets).map((s) => s.modes[m]?.report.latency).filter(Boolean) as ExtendedReport['latency'][];
        // MRL variants reuse cached query vectors after the first pass, so their latency is not a measurement.
        const reportLatency = lat.length > 0 && !m.startsWith('dense-mrl');
        entry[m] = {
          ...roundV(view(rows)),
          ...(reportLatency ? { latencyMs: { mean: round(lat.reduce((s, l) => s + l.meanMs, 0) / lat.length, 1), p50: round(lat.reduce((s, l) => s + l.p50Ms, 0) / lat.length, 1), p90: round(lat.reduce((s, l) => s + l.p90Ms, 0) / lat.length, 1) } } : {}),
          ...(id !== 'e5-small-q8' && (m === 'dense' || m === 'hybrid' || m.startsWith('dense-mrl')) && ctrl
            ? { vsControl: compare(rows, pooled(ctrl, m.startsWith('dense-mrl') ? 'dense' : m)) } : {}),
          // The ship gate compares hybrid with BM25 (the G1 baseline, reproduced here exactly), not with e5-hybrid.
          ...(m === 'hybrid' ? { vsBm25: compare(rows, pooled(res, 'bm25')) } : {}),
        };
      }
      perCorpus[corpus] = entry;
    }

    // Dense-only screening rule (T6's own — the plan leaves the threshold to the experiment):
    // a WIN needs, on EVERY corpus it was measured on, pooled MRR >= +0.02 over the e5 control,
    // no gated category (pooled n >= 8) losing MORE than one query at r@1 or r@3 (one query is the
    // control's own noise floor; every raw dip is still listed), and Turkish r@1/r@3 not lower.
    // This only decides what earns an hf build and a fusion re-sweep — shipping is T10's call.
    let denseWinner: boolean | null = null;
    const reasons: string[] = [];
    if (id !== 'e5-small-q8') {
      const measured = corpora.filter((c) => (perCorpus[c] as any)?.dense);
      if (measured.length > 0) {
        denseWinner = true;
        for (const c of measured) {
          const v = (perCorpus[c] as any).dense.vsControl;
          if (v.deltaVsControl.mrr < 0.02) { denseWinner = false; reasons.push(`${c}: dense MRR ${v.deltaVsControl.mrr >= 0 ? '+' : ''}${v.deltaVsControl.mrr} < +0.02`); }
          if (v.gatedRegressionsBeyondNoise.length) { denseWinner = false; reasons.push(`${c}: gated category regression beyond 1 query: ${v.gatedRegressionsBeyondNoise.map((x: any) => x.category).join(',')}`); }
          if (v.gatedCategoryRegressions.length && !v.gatedRegressionsBeyondNoise.length) reasons.push(`${c}: one-query dips (inside noise): ${v.gatedCategoryRegressions.map((x: any) => x.category).join(',')}`);
          if (v.deltaVsControl.turkishR1 < 0 || v.deltaVsControl.turkishR3 < 0) { denseWinner = false; reasons.push(`${c}: Turkish dense r@1/r@3 below control`); }
        }
        if (measured.length < corpora.length) reasons.push(`measured on ${measured.join(',')} only`);
      }
    }
    candidates[id] = {
      fusionResweep: mergeSweeps(corpora.map((c) => sweeps.get(`${id}|${c}`)).filter((s): s is SweepResult => s !== undefined)),
      repo: cand.repo, dtype: cand.dtype, pooling: cand.pooling, dims: cand.dims, license: cand.license, notes: cand.notes,
      precheck: prechecks[id] ?? null, bench: benches[id] ?? null, perCorpus, ...(denseWinner !== null ? { denseOnlyWinner: denseWinner, denseVerdictReasons: reasons } : {}),
    };
  }

  const rerankers = reranks.map((r) => {
    const perSet = (mode: string) => Object.entries(r.sets as Record<string, any>).flatMap(([s, v]) => (v.modes[mode]?.report.perQuery ?? []).map((q: any) => ({ ...q, id: `${s}:${q.id}` })));
    const base = perSet('hybrid');
    return {
      reranker: r.reranker, corpus: r.corpus, topN: r.topN, load: r.load, rerankMsPerQuery: r.rerankMsPerQuery,
      hybridBaseline: roundV(view(base)),
      'rerank-only': { ...roundV(view(perSet('rerank-only'))), vsHybrid: compare(perSet('rerank-only'), base) },
      'rerank-blend': { ...roundV(view(perSet('rerank-blend'))), vsHybrid: compare(perSet('rerank-blend'), base) },
    };
  });

  writeJson(resolve(value('--out') ?? DEFAULT_OUT), {
    meta: {
      task: 'T6 model experiment', note: 'aggregates only (no query text, no per-query ranks); per-query output lives under ~/.dreamcontext/eval-frozen/runs/t6/',
      generatedAt: new Date().toISOString(), gold: 'TRAIN only (dc-v1-train + dc-26-train pooled as "dc"; hf-train as "hf")',
      pooling: 'per corpus: dc = dc-v1-train + dc-26-train, hf = hf-train; categories gated at pooled n >= 8',
      screeningRule: 'dense-only winner = on every measured corpus: pooled MRR >= control + 0.02, no gated category (pooled n >= 8) losing more than 1 query at r@1/r@3 vs the control (1 query = measured noise floor), Turkish r@1/r@3 >= control',
      noiseFloor: 'the e5 control reproduces production vectors at mean cosine 0.9996 (min 0.997) and G1 ranks within +-1 query per set; bm25 is reproduced exactly',
      indexNote: 'indexes skip DENSE_EXCLUDED_TYPES docs (changelog) — retrieval-identical, fewer chunks than a production refresh; index time is the sum of embedding batch time (length-sorted batches of 16), excluding per-slice model load',
      latencyNote: 'dense/hybrid latency = embed query + rank over an in-memory index, post warm-up mean/p50/p90; NOT comparable to embed-ab hybrid latency (which also pays a per-query cache refresh)',
      maxTokens: MAX_TOKENS,
    },
    candidates,
    rerankers,
  });
  console.log(`wrote ${resolve(value('--out') ?? DEFAULT_OUT)}`);
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

mkdirSync(RESULTS_DIR, { recursive: true });
assertUnder(FROZEN_RUNS_DIR, T6_RUNS, 'T6 output');

if (has('--precheck')) await precheck(candidateOf(value('--candidate')));
else if (has('--precheck-reranker')) await precheckReranker(rerankerOf(value('--reranker')));
else if (has('--build-index')) {
  const limit = value('--limit') ? Number(value('--limit')) : null;
  await buildIndex(
    candidateOf(value('--candidate')),
    value('--corpus') ?? fail('--corpus dc|hf is required'),
    resolve(value('--root') ?? fail('--root <frozen context root> is required')),
    Number(value('--budget-sec') ?? 400) * 1000,
    limit,
  );
} else if (has('--bench')) {
  await bench(
    candidateOf(value('--candidate')),
    resolve(value('--root') ?? fail('--root <frozen context root> is required')),
    assertTrainGold(value('--gold') ?? fail('--gold <train.jsonl> is required')),
  );
} else if (has('--sweep')) await runSweep(candidateOf(value('--candidate')));
else if (has('--eval')) await runEval(candidateOf(value('--candidate')));
else if (has('--rerank')) await runRerank(rerankerOf(value('--reranker')));
else if (has('--aggregate')) aggregate();
else fail('give one of: --precheck --precheck-reranker --build-index --eval --rerank --aggregate (see the header comment)');
