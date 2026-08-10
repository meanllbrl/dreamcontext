import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useApi } from '../context/VaultContext';
import type { ApiClient } from '../api/client';

/**
 * A single recall hit as returned by GET /api/recall.
 *
 * `type` must list EVERY channel `CORPUS_TYPES` can produce (src/lib/recall.ts) —
 * a missing member silently strands that channel: TypeScript stops complaining
 * about the icon map and the nav switch, so an objective hit renders a knowledge
 * icon and opens the Core page.
 */
export interface RecallHit {
  type:
    | 'knowledge' | 'feature' | 'task' | 'memory' | 'changelog'
    | 'objective' | 'insight' | 'thesis' | 'automation';
  slug: string;
  title: string;
  path: string;
  description: string;
  tags: string[];
  snippet: string;
  body: string;
  /** Derived importance 1-3 (★/★★/★★★) — what the `level` param filters on. */
  level: 1 | 2 | 3;
  score: number;
  rankScore: number;
}

export interface RecallResponse {
  query: string;
  /** Which engine actually ran: 'hybrid' (BM25 + dense) when hybrid mode is warm,
   *  else 'bm25'. Mirrors the vault's recall mode; lets the UI label results. */
  mode?: 'bm25' | 'hybrid';
  tookMs: number;
  hits: RecallHit[];
}

/**
 * Local BM25 recall over the project brain. Fully grounded, no tokens spent —
 * the server runs the same engine as `dreamcontext memory recall`. Disabled for
 * empty queries (the idle constellation renders instead).
 *
 * Pass a DEBOUNCED query so a burst of keystrokes collapses into one request;
 * `keepPreviousData` keeps the last hits on screen while the next set loads so
 * the list doesn't flash empty between keystrokes.
 */
export function useRecall(query: string, types: string[], topK = 12, minLevel?: number) {
  const api = useApi();
  const trimmed = query.trim();
  const typeParam = types.length ? types.join(',') : '';
  return useQuery<RecallResponse>({
    // minLevel is part of the key: a level-scoped search is a different result
    // set, so it must not read a cached unfiltered response.
    queryKey: ['recall', trimmed, typeParam, topK, minLevel ?? 0],
    queryFn: () => {
      const params = new URLSearchParams({ q: trimmed, top: String(topK) });
      if (typeParam) params.set('types', typeParam);
      if (minLevel) params.set('level', String(minLevel));
      return api.get<RecallResponse>(`/recall?${params.toString()}`);
    },
    enabled: trimmed.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  });
}

/** Imperative one-shot recall (used by Ask to ground an answer in top hits). */
export async function recallOnce(api: ApiClient, query: string, types: string[], topK = 4, minLevel?: number): Promise<RecallHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const params = new URLSearchParams({ q: trimmed, top: String(topK) });
  if (types.length) params.set('types', types.join(','));
  if (minLevel) params.set('level', String(minLevel));
  const res = await api.get<RecallResponse>(`/recall?${params.toString()}`);
  return res.hits;
}

/** Response from GET /api/recall/haiku — intent-aware, LLM-filtered recall. */
export interface HaikuRecallResponse {
  query: string;
  /** 'haiku' = the LLM picked the docs; 'bm25' = claude unavailable, BM25 fallback. */
  mode: 'haiku' | 'bm25';
  /** True when the prompt was a pure greeting/ack — nothing to recall. */
  skip: boolean;
  tookMs: number;
  hits: RecallHit[];
}

/**
 * Intent-aware one-shot recall for Ask mode. A single stateless `claude --model
 * haiku` call reads the whole brain index and returns only the directly-relevant
 * docs (each `snippet` is the LLM's reason for picking it). Unlike BM25 search
 * this costs a few seconds and tokens, so callers should show a loading state.
 * Falls back to BM25 server-side when the claude CLI isn't available.
 */
export async function haikuRecallOnce(api: ApiClient, query: string, types: string[], minLevel?: number): Promise<HaikuRecallResponse> {
  const trimmed = query.trim();
  if (!trimmed) return { query: '', mode: 'haiku', skip: false, tookMs: 0, hits: [] };
  const params = new URLSearchParams({ q: trimmed });
  if (types.length) params.set('types', types.join(','));
  if (minLevel) params.set('level', String(minLevel));
  return api.get<HaikuRecallResponse>(`/recall/haiku?${params.toString()}`);
}
