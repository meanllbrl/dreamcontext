import { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildCorpus,
  bm25Search,
  docLevel,
  CORPUS_TYPES,
  type CorpusType,
  type CorpusDoc,
  type RecallHit,
} from '../../lib/recall.js';
import { hybridSearch, hybridReady } from '../../lib/embeddings/hybrid.js';
import { haikuRecall, makeClaudeExecutor } from '../../lib/recall-query-extractor.js';
import { resolveRecallMode } from '../../cli/commands/sleep.js';
import { hybridPromptRecall, toWirePromptHit } from '../../cli/commands/hook.js';
import { hybridVaultSearch, toWireQueryHit } from '../../cli/commands/memory.js';
import { minTier, resolvePromptTier, type RecallTier } from '../../lib/recall-cloud-config.js';
import { sendJson, sendError, parseJsonBody } from '../middleware.js';
import { isLoopback } from './agent-spawn-shared.js';
import { realpathSync } from 'node:fs';

// Every channel the engine can produce — derived from CORPUS_TYPES, never
// re-listed here. The previous hardcoded five silently dropped `objective`,
// `insight` and `thesis` from every dashboard surface (search, ⌘K palette, Ask)
// for weeks after the engine started indexing them: `parseTypes` filtered a
// requested `types=objective` down to nothing, which then fell back to "all
// types" — so asking for objectives specifically returned everything BUT them.
const ALL_TYPES: CorpusType[] = [...CORPUS_TYPES];

/** Serialize a recall hit to the wire shape the dashboard's `RecallHit` expects. */
function serializeHit(h: RecallHit) {
  return {
    type: h.doc.type,
    slug: h.doc.slug,
    title: h.doc.title,
    path: h.doc.relPath,
    description: h.doc.description,
    tags: h.doc.tags,
    snippet: h.snippet,
    body: h.doc.body,
    // Derived importance 1-3 (see DocLevel) — what `?level=` filters on.
    level: docLevel(h.doc),
    score: Number(h.score.toFixed(4)),
    rankScore: Number(h.rankScore.toFixed(4)),
  };
}

/** Parse the optional `types=` filter; null means "all types". */
function parseTypes(typesParam: string | null): CorpusType[] | null {
  if (!typesParam) return null;
  const requested = typesParam
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter((t): t is CorpusType => (ALL_TYPES as string[]).includes(t));
  return requested.length ? requested : null;
}

/** Parse the optional `level=` minimum-importance filter; null = no filter. */
function parseLevel(levelParam: string | null): number | null {
  if (!levelParam) return null;
  const n = Number.parseInt(levelParam, 10);
  return n === 1 || n === 2 || n === 3 ? n : null;
}

/**
 * Building the corpus walks the whole vault from disk, which is too expensive to
 * redo on every keystroke. Cache the built corpus per (contextRoot + type-set)
 * for a few seconds so a burst of debounced searches reuses one scan. The TTL is
 * short enough that edits made while the search view is open show up promptly.
 */
interface CacheEntry { corpus: CorpusDoc[]; builtAt: number }
const CORPUS_TTL_MS = 8_000;
const corpusCache = new Map<string, CacheEntry>();

function corpusFor(contextRoot: string, types: CorpusType[], minLevel: number | null): CorpusDoc[] {
  // minLevel is part of the cache key: a level-scoped corpus is a DIFFERENT
  // corpus, and sharing one entry would serve level-3-only results to an
  // unfiltered search (or vice versa) for up to the TTL.
  const key = `${contextRoot}::${[...types].sort().join(',')}::L${minLevel ?? 0}`;
  const hit = corpusCache.get(key);
  const now = Date.now();
  if (hit && now - hit.builtAt < CORPUS_TTL_MS) return hit.corpus;
  const corpus = buildCorpus(contextRoot, {
    types,
    ...(minLevel !== null ? { minLevel } : {}),
  });
  corpusCache.set(key, { corpus, builtAt: now });
  return corpus;
}

/**
 * GET /api/recall?q=<query>&types=knowledge,task,...&top=10
 *
 * Local, zero-LLM recall across the project brain — the SAME engine and mode as
 * the CLI's `dreamcontext memory recall`. Honours the vault's recall mode: when
 * it's 'hybrid' AND already warm (model downloaded + cache built), it fuses BM25
 * with local dense embeddings; otherwise plain BM25. `hybridReady` guarantees a
 * keystroke never triggers a download or a cold index — those are explicit
 * (Settings card / `embed refresh`). The response `mode` reports which ran, so
 * the UI can label it accurately and drop the (now-redundant) Intelligent toggle.
 * `tier` is always 'local': this route never sends anything off the machine, whatever
 * cloud tier the vault has consented to (that is for the prompt hook and the CLI).
 */
export async function handleRecallGet(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const query = (url.searchParams.get('q') ?? '').trim();

  const useHybrid = hybridReady(contextRoot, resolveRecallMode(contextRoot));
  const mode = useHybrid ? 'hybrid' : 'bm25';
  // A label for the response only. hybridSearch below gets no tier, so it can never go off-machine.
  const tier = 'local' as const;

  if (!query) {
    sendJson(res, 200, { query: '', mode, tier, hits: [], tookMs: 0 });
    return;
  }

  const types = parseTypes(url.searchParams.get('types')) ?? ALL_TYPES;
  const minLevel = parseLevel(url.searchParams.get('level'));

  const topRaw = Number.parseInt(url.searchParams.get('top') ?? '12', 10);
  const topK = Number.isFinite(topRaw) ? Math.max(1, Math.min(50, topRaw)) : 12;

  try {
    const started = Date.now();
    const corpus = corpusFor(contextRoot, types, minLevel);
    const hits = useHybrid
      ? await hybridSearch(query, corpus, contextRoot, topK)
      : bm25Search(query, corpus, topK);
    const tookMs = Date.now() - started;

    sendJson(res, 200, { query, mode, tier, tookMs, hits: hits.map(serializeHit) });
  } catch (err) {
    sendError(res, 500, 'recall_failed', err instanceof Error ? err.message : 'Recall failed');
  }
}

const SERVED_TIERS: readonly RecallTier[] = ['local', 'cloud-index', 'cloud'];

/**
 * The tier this server runs for a request: exactly the one the caller resolved (absent = 'local', what every
 * hook before this field sent). The caller already dropped to local inside a spawned session or past the
 * daily cap; the server re-checks the vault's own limits (consent, key, daily cap) with no environment of
 * its own, so its env can never lift a tier. Null when it cannot serve that tier as asked: one it does not
 * know (an older or newer caller), or one the vault does not allow here (say the recall key lives only in
 * the caller's env). The caller then recalls itself, at its own tier, instead of getting a quieter answer.
 */
export function servedTier(requested: unknown, contextRoot: string, home?: string): RecallTier | null {
  const want = requested === undefined ? 'local' : requested;
  if (typeof want !== 'string' || !(SERVED_TIERS as readonly string[]).includes(want)) return null;
  const tier = want as RecallTier;
  return minTier(tier, resolvePromptTier(contextRoot, {}, home).tier) === tier ? tier : null;
}

/** Parse the `types` list of a query request; undefined = every type. */
function bodyTypes(raw: unknown): CorpusType[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const types = raw.filter((t): t is CorpusType => typeof t === 'string' && (ALL_TYPES as string[]).includes(t));
  return types.length > 0 ? types : undefined;
}

/**
 * POST /api/recall/prompt  { prompt, root, tier?, kind?, topK?, types?, minLevel? }
 *
 * Recall run here, for a CLI process on this machine: this server keeps the query model, the vector index
 * and the parsed corpus cache in memory, where a hook or a `memory recall` is a fresh process that loads all
 * three every time (~2.4 s per prompt measured on a cloud-index vault). Two shapes:
 *   - default: the prompt hook's hybrid recall (`hybridPromptRecall`), so the hook prints the same block
 *     either way.
 *   - `kind: 'query'`: `memory recall`'s hybrid search (`hybridVaultSearch`) with its topK, types and level;
 *     the answer echoes `kind` so a caller can tell it from an older server's prompt answer.
 * `tier` is the caller's resolved tier (see {@link servedTier}). This machine only (loopback socket). `root`
 * is not a vault selector: it must name the vault this request already resolved to. Anything this server
 * cannot serve (another vault, an unknown tier, the model or index not ready here) is a 409 and the caller
 * recalls itself.
 */
export async function handleRecallPromptPost(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!isLoopback(req)) {
    sendError(res, 403, 'forbidden', 'Only an agent hook on this machine may ask for this.');
    return;
  }
  const body = await parseJsonBody(req);
  const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
  const root = typeof body?.root === 'string' ? body.root : '';
  if (!prompt.trim() || !root || !contextRoot) {
    sendError(res, 400, 'bad_request', 'prompt and root are required');
    return;
  }
  const real = (p: string) => { try { return realpathSync(p); } catch { return null; } };
  if (real(root) === null || real(root) !== real(contextRoot)) {
    sendError(res, 409, 'other_vault', 'This server is not serving that vault.');
    return;
  }
  const tier = servedTier(body?.tier, contextRoot);
  if (tier === null) {
    sendError(res, 409, 'not_ready', 'This server cannot serve that recall tier.');
    return;
  }
  if (!hybridReady(contextRoot, 'hybrid', tier)) {
    sendError(res, 409, 'not_ready', 'The recall model or index is not ready here.');
    return;
  }
  try {
    if (body?.kind === 'query') {
      const topRaw = typeof body.topK === 'number' ? body.topK : 10;
      const topK = Number.isFinite(topRaw) ? Math.max(1, Math.min(50, Math.floor(topRaw))) : 10;
      const minLevel = body.minLevel === 1 || body.minLevel === 2 || body.minLevel === 3 ? body.minLevel : undefined;
      const r = await hybridVaultSearch(contextRoot, prompt, topK, bodyTypes(body.types), minLevel, tier);
      sendJson(res, 200, { kind: 'query', corpusSize: r.corpusSize, timing: r.timing, hits: r.hits.map(toWireQueryHit) });
      return;
    }
    const r = await hybridPromptRecall(prompt, contextRoot, tier);
    sendJson(res, 200, { label: r.label, timing: r.timing, hits: r.hits.map(toWirePromptHit) });
  } catch (err) {
    sendError(res, 500, 'recall_failed', err instanceof Error ? err.message : 'Recall failed');
  }
}

/**
 * GET /api/recall/haiku?q=<query>&types=knowledge,task,...
 *
 * Intent-aware recall. Instead of BM25 keyword overlap, a single stateless
 * `claude --model haiku` call reads the whole corpus index and returns only the
 * 0–3 docs DIRECTLY relevant to the question (with a one-line reason each) —
 * resolving vague, cross-language, or noisy prompts that keyword search misses.
 *
 * This is a deliberate one-shot (Ask mode), not a per-keystroke search: it spends
 * a few seconds and a few tokens, so the UI showcases a staged loading state
 * while it runs. Degrades gracefully:
 *   - claude CLI missing / errors  → falls back to BM25, `mode: 'bm25'`
 *   - pure greeting/acknowledgment → `skip: true`, no hits
 *
 * The executor timeout (25s) is kept under the server's 30s socket timeout so the
 * call can never out-live its own response.
 */
export async function handleRecallHaikuGet(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const query = (url.searchParams.get('q') ?? '').trim();

  if (!query) {
    sendJson(res, 200, { query: '', mode: 'haiku', skip: false, hits: [], tookMs: 0 });
    return;
  }

  const requestedTypes = parseTypes(url.searchParams.get('types'));
  const minLevel = parseLevel(url.searchParams.get('level'));

  try {
    const started = Date.now();
    const result = haikuRecall(query, contextRoot, { executor: makeClaudeExecutor(25_000) });
    const tookMs = Date.now() - started;

    // Pure greeting — Haiku says there's nothing to recall.
    if (result === 'skip') {
      sendJson(res, 200, { query, mode: 'haiku', skip: true, hits: [], tookMs });
      return;
    }

    // null = claude unavailable or errored → fall back to the proven BM25 path
    // so Ask always returns grounded hits, even without the CLI installed.
    if (result === null) {
      const types = requestedTypes ?? ALL_TYPES;
      const corpus = corpusFor(contextRoot, types, minLevel);
      const hits = bm25Search(query, corpus, 4);
      sendJson(res, 200, { query, mode: 'bm25', skip: false, tookMs, hits: hits.map(serializeHit) });
      return;
    }

    // Haiku already filtered by relevance; honour an explicit type + level filter
    // on top. Haiku picks from the whole corpus (it has no level notion), so the
    // level gate is applied to its RESULT rather than its input.
    let hits = requestedTypes
      ? result.filter(h => requestedTypes.includes(h.doc.type))
      : result;
    if (minLevel !== null) hits = hits.filter(h => docLevel(h.doc) >= minLevel);
    sendJson(res, 200, { query, mode: 'haiku', skip: false, tookMs, hits: hits.map(serializeHit) });
  } catch (err) {
    sendError(res, 500, 'recall_failed', err instanceof Error ? err.message : 'Recall failed');
  }
}
