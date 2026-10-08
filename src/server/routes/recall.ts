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
import { resolveRecallMode } from '../../cli/commands/sleep.js';
import { sendJson, sendError } from '../middleware.js';

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

    sendJson(res, 200, { query, mode, tookMs, hits: hits.map(serializeHit) });
  } catch (err) {
    sendError(res, 500, 'recall_failed', err instanceof Error ? err.message : 'Recall failed');
  }
}
