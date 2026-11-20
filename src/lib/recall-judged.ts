/**
 * Per-message recall, the measured "combined setting" (owner, 16 Nov: "Tamam bunu da uygula"):
 *
 *   1. Candidates, free, on this Mac: BM25 + a dense ranking (local e5; the cloud index when the vault
 *      opted into a cloud tier), the union of each one's top 25 over the turn, plus each one's top 10
 *      over the turn and the owner's previous turn.
 *   2. Passage: per candidate, the section the dense search ranks best (e5 first), else the words' best.
 *   3. Judge: ONE Haiku call reads the previous turn, the turn, every candidate with its "needed when"
 *      lines, and writes a reason per pick; must (2) and confident (1) picks are delivered.
 *   4. A judge that fails or passes {@link JUDGE_TIMEOUT_MS} never blocks: the caller falls back.
 *
 * Files already delivered into this session's context are not delivered again, and are not shown to the
 * judge; when the turn's strongest candidates are all files the context already holds or the judge
 * already passed over, the judge is not called at all (owner, 16 Nov: "her birinde tekrar tekrar aynı
 * şey yüklensin istemem").
 *
 * Measured on super/hafiza-uc-ayar (scripts/memory-eval/free-path/settings.ts, list u25p10, e5 passage,
 * confidence prompt, deliver >= 1): 34-35/57 owner must files, 79-81% precision, silent 7-8/9.
 */
import type { RecallTier } from './recall-cloud-config.js';
import { bm25Search, docKey, type CorpusDoc } from './recall.js';
import { chunkDoc, type Chunk } from './embeddings/chunker.js';
import { pickBestChunkLexical } from './embeddings/egress-rules.js';
import { embedQuery } from './embeddings/embedder.js';
import { DENSE_EXCLUDED_TYPES, HOOK_MAX_INLINE_EMBED, cloudTierReady, localReady } from './embeddings/hybrid.js';
import { isNanoDownloaded, nanoEmbedQuery } from './embeddings/nano.js';
import { refreshEmbeddings, type DenseIndex } from './embeddings/store.js';
import { loadVectorIndex } from './embeddings/vector-store.js';
import {
  DELIVER_MIN, JUDGE_TIMEOUT_MS, decide, pickPrompt, runJudge,
  type JudgeCandidate, type JudgeDecision, type PickLevel, type RunJudgeOpts, type WhenLinesOf,
} from './recall-judge.js';

/** The shortlist rule, as measured (u25p10). */
export const LIST_MAIN = 25;
export const LIST_PREV = 10;
/** A channel's top this many over the turn (and over turn + previous) are the "strong" candidates of the skip rule. */
export const STRONG_PER_CHANNEL = 3;
/** The passage the judge reads is cut here (the prompt cuts it again at 500). */
const PASSAGE_CHARS = 600;
/** BM25 depth before the pattern filter (as the eval ranked). */
const BM25_DEPTH = 450;

export type DenseChannel = 'e5' | 'voyage' | 'none';

export interface ShortlistOpts {
  /** The vault's prompt tier: a cloud tier ranks the dense channel from the cloud index when it is ready. */
  tier?: RecallTier;
  home?: string;
  now?: Date;
  /** Leaves a file out of the candidates (the eval's turn-time rule; the hook passes none). */
  exclude?: (doc: CorpusDoc) => boolean;
}

export interface Shortlist {
  /** Candidate keys in judge order: dense turn top 25, BM25 turn top 25, dense prev top 10, BM25 prev top 10. */
  keys: string[];
  /** Strong candidates (each channel's top 3, turn and turn + previous). */
  strong: string[];
  channel: DenseChannel;
  /** Best dense chunk per key (e5 when available), for the passage. */
  seq: Map<string, number>;
  ms: number;
}

/** Best-section similarity per doc over one dense index. */
function denseSims(index: DenseIndex | null, qv: Float32Array | null): Map<string, { sim: number; seq: number }> {
  const best = new Map<string, { sim: number; seq: number }>();
  if (!index || !qv || qv.length !== index.dims) return best;
  for (const c of index.chunks) {
    let dot = 0;
    const v = c.vector;
    for (let i = 0; i < v.length; i++) dot += v[i] * qv[i];
    const cur = best.get(c.docKey);
    if (!cur || dot > cur.sim) best.set(c.docKey, { sim: dot, seq: c.seq });
  }
  return best;
}

/** Patterns arrive through their own block; never a recall candidate. */
function isPattern(doc: CorpusDoc): boolean {
  return doc.relPath.replace(/\\/g, '/').startsWith('knowledge/patterns/');
}

/**
 * The candidates of one turn. Free: no network (a cloud tier's query runs on the local nano model), no
 * download, no full index build (an e5 refresh embeds at most {@link HOOK_MAX_INLINE_EMBED} chunks).
 */
export async function judgeShortlist(query: string, prev: string | null, corpus: CorpusDoc[], root: string, o: ShortlistOpts = {}): Promise<Shortlist> {
  const t0 = Date.now();
  const byKey = new Map(corpus.map((d) => [docKey(d), d]));
  const ok = (d: CorpusDoc | undefined): d is CorpusDoc => !!d && !isPattern(d) && !(o.exclude?.(d) ?? false);
  const q2 = prev && prev.trim() ? `${query}\n${prev}` : null;
  const now = o.now ?? new Date();

  const words = (q: string): string[] => bm25Search(q, corpus, BM25_DEPTH, { now, collapseFamilies: true })
    .filter((h) => ok(h.doc)).map((h) => docKey(h.doc));
  const bm25 = words(query);
  const bm25p = q2 ? words(q2) : [];

  // The dense channel: the cloud index when the vault's tier can answer locally, else e5.
  const excluded = new Set(DENSE_EXCLUDED_TYPES);
  const ranked = (sims: Map<string, { sim: number; seq: number }>): string[] => [...sims]
    .filter(([k]) => { const d = byKey.get(k); return ok(d) && !excluded.has(d.type); })
    .sort((a, b) => b[1].sim - a[1].sim).map(([k]) => k);
  let channel: DenseChannel = 'none';
  let dense: string[] = [];
  let densep: string[] = [];
  const seq = new Map<string, number>();
  let e5Index: DenseIndex | null = null;
  let e5Sims: Map<string, { sim: number; seq: number }> | null = null;
  if (localReady(root)) {
    const [refreshed, qv] = await Promise.all([
      refreshEmbeddings(root, corpus, undefined, { additive: true, waitForLock: false, maxInlineEmbed: HOOK_MAX_INLINE_EMBED }).catch(() => null),
      embedQuery(query).catch(() => null),
    ]);
    if (refreshed && refreshed.index.chunks.length && qv) { e5Index = refreshed.index; e5Sims = denseSims(e5Index, qv); }
  }
  const tier = o.tier ?? 'local';
  if (tier !== 'local' && cloudTierReady(tier, root, false, o.home) && isNanoDownloaded(o.home)) {
    const index = loadVectorIndex(root, 'voyage-4');
    const qv = index ? await nanoEmbedQuery(query, { home: o.home }).catch(() => null) : null;
    if (index && qv) {
      const sims = denseSims(index, qv);
      dense = ranked(sims);
      for (const [k, s] of sims) seq.set(k, s.seq);
      if (q2) {
        const qv2 = await nanoEmbedQuery(q2, { home: o.home }).catch(() => null);
        if (qv2) densep = ranked(denseSims(index, qv2));
      }
      channel = 'voyage';
    }
  }
  if (channel === 'none' && e5Index && e5Sims) {
    dense = ranked(e5Sims);
    if (q2) {
      const qv2 = await embedQuery(q2).catch(() => null);
      if (qv2) densep = ranked(denseSims(e5Index, qv2));
    }
    channel = 'e5';
  }
  // The passage: e5's best chunk when it has one (measured: as good as voyage's), else the channel's.
  if (e5Sims) for (const [k, s] of e5Sims) seq.set(k, s.seq);

  const keys = [...new Set([...dense.slice(0, LIST_MAIN), ...bm25.slice(0, LIST_MAIN), ...densep.slice(0, LIST_PREV), ...bm25p.slice(0, LIST_PREV)])];
  const strong = [...new Set([dense, bm25, densep, bm25p].flatMap((l) => l.slice(0, STRONG_PER_CHANNEL)))];
  return { keys, strong, channel, seq, ms: Date.now() - t0 };
}

/** The section of `doc` the judge reads: the chunk at `seq` when given, else the query's best word match. */
export function passageOf(doc: CorpusDoc, query: string, seq: number | null): { heading: string; text: string } {
  const chunks: Chunk[] = chunkDoc(doc.title, doc.body, doc.description);
  const chunk = (seq !== null ? chunks.find((c) => c.seq === seq) : undefined) ?? pickBestChunkLexical(chunks, query);
  let text = chunk?.text ?? doc.body;
  if (doc.title && text.startsWith(doc.title)) text = text.slice(doc.title.length).replace(/^[\s:—-]+/, '');
  const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l.length > 8) ?? '';
  const at = firstLine ? doc.body.indexOf(firstLine) : -1;
  const path: string[] = [];
  if (at >= 0) {
    for (const line of doc.body.slice(0, at).split('\n')) {
      const m = /^(#{1,6})\s+(.*)$/.exec(line.trim());
      if (!m) continue;
      path.length = Math.min(path.length, m[1].length - 1);
      path[m[1].length - 1] = m[2].trim();
    }
  }
  return { heading: path.filter(Boolean).join(' > '), text: text.replace(/\s+/g, ' ').trim().slice(0, PASSAGE_CHARS) };
}

/** One delivered file. */
export interface JudgedHit {
  doc: CorpusDoc;
  level: PickLevel;
  reason: string;
  section: { heading: string; text: string };
}

export type JudgedOutcome = JudgeDecision['outcome'] | 'nothing_new' | 'no_candidates';

export interface JudgedRecall {
  outcome: JudgedOutcome;
  /** Delivered files: must first, then confident, each in shortlist order. Already-delivered files never appear. */
  hits: JudgedHit[];
  /** The keys the judge was shown (empty when it was not called). */
  shown: string[];
  channel: DenseChannel;
  /** The skip rule held (with `forceJudge` the judge ran anyway). */
  wouldSkip: boolean;
  usd: number;
  searchMs: number;
  judgeMs: number;
  cause?: string;
}

export interface JudgedRecallOpts extends ShortlistOpts {
  /** Files this session's context already holds (delivered since the last reset). */
  inContext?: ReadonlySet<string>;
  /** Files the judge was already shown in this context and did not pick. */
  passedOver?: ReadonlySet<string>;
  /** The candidates' "needed when" lines. */
  whenLines?: WhenLinesOf;
  /** Epoch ms the judge must finish by; default now + {@link JUDGE_TIMEOUT_MS}. */
  deadlineAt?: number;
  /** The judge runner (tests; the Codex judge). */
  judge?: RunJudgeOpts & { run?: typeof runJudge };
  /** Run the judge even when the skip rule holds (the eval measures what a skip would lose). */
  forceJudge?: boolean;
  /** What the turn points at (team-roster.ts `recallTurn`): searched with the turn, shown to the judge as `<about>`. */
  about?: string | null;
}

/**
 * The skip rule: every strong candidate is already in this context or was already passed over by the
 * judge in it, so the judge would see nothing new where it matters. A turn with no strong candidate at
 * all is not a skip (it has no candidates either, and is reported as such).
 */
export function nothingNew(strong: readonly string[], inContext: ReadonlySet<string>, passedOver: ReadonlySet<string>): boolean {
  return strong.length > 0 && strong.every((k) => inContext.has(k) || passedOver.has(k));
}

/** Judge one turn. Never throws: a failed judge comes back as its outcome with no hits. */
export async function judgedRecall(query: string, prev: string | null, corpus: CorpusDoc[], root: string, o: JudgedRecallOpts = {}): Promise<JudgedRecall> {
  const inContext = o.inContext ?? new Set<string>();
  const passedOver = o.passedOver ?? new Set<string>();
  // The local search runs on his words, then the subject the turn points at; the judge reads them apart.
  const about = o.about && o.about.trim() ? o.about.trim() : null;
  const search = about ? (query.trim() ? `${query}\n${about}` : about) : query;
  const sl = await judgeShortlist(search, prev, corpus, root, o);
  const base = { channel: sl.channel, usd: 0, searchMs: sl.ms, judgeMs: 0 };
  const wouldSkip = nothingNew(sl.strong, inContext, passedOver);
  const keys = sl.keys.filter((k) => !inContext.has(k));
  if (keys.length === 0) return { ...base, outcome: sl.keys.length ? 'nothing_new' : 'no_candidates', hits: [], shown: [], wouldSkip: sl.keys.length > 0 };
  if (wouldSkip && !o.forceJudge) return { ...base, outcome: 'nothing_new', hits: [], shown: [], wouldSkip };

  const byKey = new Map(corpus.map((d) => [docKey(d), d]));
  const cands: JudgeCandidate[] = [];
  for (const k of keys) {
    const doc = byKey.get(k);
    if (!doc) continue;
    cands.push({ key: k, relPath: doc.relPath, title: doc.title, description: doc.description ?? '', section: passageOf(doc, search, sl.seq.get(k) ?? null) });
  }
  const prompt = pickPrompt({ text: query, prev, about }, cands, o.whenLines ?? (() => null));
  const d = await decide(prompt, cands, o.deadlineAt ?? Date.now() + JUDGE_TIMEOUT_MS, o.judge ?? {});
  const order = new Map(cands.map((c, i) => [c.key, i]));
  const hits: JudgedHit[] = Object.entries(d.picks)
    .filter(([, v]) => v >= DELIVER_MIN)
    .sort((a, b) => (b[1] - a[1]) || (order.get(a[0])! - order.get(b[0])!))
    .map(([k, level]) => {
      const c = cands[order.get(k)!]!;
      return { doc: byKey.get(k)!, level, reason: d.reasons[k] ?? '', section: c.section };
    });
  return { ...base, outcome: d.outcome, hits, shown: cands.map((c) => c.key), wouldSkip, usd: d.usd, judgeMs: d.ms, ...(d.cause ? { cause: d.cause } : {}) };
}
