import { IncomingMessage, ServerResponse } from 'node:http';
import { buildCorpus, bm25Search, type CorpusType, type CorpusDoc, type RecallHit } from '../../lib/recall.js';
import { hybridSearch, hybridReady } from '../../lib/embeddings/hybrid.js';
import { haikuRecall, makeClaudeExecutor } from '../../lib/recall-query-extractor.js';
import { resolveRecallMode } from '../../cli/commands/sleep.js';
import { sendJson, sendError } from '../middleware.js';

const ALL_TYPES: CorpusType[] = ['knowledge', 'feature', 'task', 'memory', 'changelog'];

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

/**
 * Building the corpus walks the whole vault from disk, which is too expensive to
 * redo on every keystroke. Cache the built corpus per (contextRoot + type-set)
 * for a few seconds so a burst of debounced searches reuses one scan. The TTL is
 * short enough that edits made while the search view is open show up promptly.
 */
interface CacheEntry { corpus: CorpusDoc[]; builtAt: number }
const CORPUS_TTL_MS = 8_000;
const corpusCache = new Map<string, CacheEntry>();

function corpusFor(contextRoot: string, types: CorpusType[]): CorpusDoc[] {
  const key = `${contextRoot}::${[...types].sort().join(',')}`;
  const hit = corpusCache.get(key);
  const now = Date.now();
  if (hit && now - hit.builtAt < CORPUS_TTL_MS) return hit.corpus;
  const corpus = buildCorpus(contextRoot, { types });
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

  if (!query) {
    sendJson(res, 200, { query: '', mode, hits: [], tookMs: 0 });
    return;
  }

  const types = parseTypes(url.searchParams.get('types')) ?? ALL_TYPES;

  const topRaw = Number.parseInt(url.searchParams.get('top') ?? '12', 10);
  const topK = Number.isFinite(topRaw) ? Math.max(1, Math.min(50, topRaw)) : 12;

  try {
    const started = Date.now();
    const corpus = corpusFor(contextRoot, types);
    const hits = useHybrid
      ? await hybridSearch(query, corpus, contextRoot, topK)
      : bm25Search(query, corpus, topK);
    const tookMs = Date.now() - started;

    sendJson(res, 200, { query, mode, tookMs, hits: hits.map(serializeHit) });
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
      const corpus = corpusFor(contextRoot, types);
      const hits = bm25Search(query, corpus, 4);
      sendJson(res, 200, { query, mode: 'bm25', skip: false, tookMs, hits: hits.map(serializeHit) });
      return;
    }

    // Haiku already filtered by relevance; honour an explicit type filter on top.
    const hits = requestedTypes
      ? result.filter(h => requestedTypes.includes(h.doc.type))
      : result;
    sendJson(res, 200, { query, mode: 'haiku', skip: false, tookMs, hits: hits.map(serializeHit) });
  } catch (err) {
    sendError(res, 500, 'recall_failed', err instanceof Error ? err.message : 'Recall failed');
  }
}
