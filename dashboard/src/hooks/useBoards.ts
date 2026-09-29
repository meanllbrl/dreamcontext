import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { RequestError } from '../api/client';
import { useApi } from '../context/VaultContext';
import type { InsightCache, InsightSummary } from './useLab';
import type {
  Board, BoardListResponse, BoardResponse, BoardSpec, Card, LibraryBlock,
} from '../components/lab/board/boardTypes';

/**
 * Boards over `/api/lab/boards`: list, show, save, and the bulk cache read the
 * legacy `insight` blocks draw from.
 *
 * Every key sits under the `['lab', …]` prefix on purpose: a sync already
 * invalidates `['lab']`, so the open board's frames and summaries refresh with
 * the insights they show. `boards`, `blocks` and `caches` are reserved insight
 * slugs, so `['lab', 'boards', …]`, `['lab', 'blocks']` and the per-insight
 * `['lab', 'caches', slug]` can never collide with a detail `['lab', slug]`.
 *
 * SAVING is a queue, not a mutation. A drag burst fires one edit per drop; a
 * PUT per edit would race itself and 409 against its own previous write. So
 * each board has at most ONE PUT in flight, edits made during the flight
 * coalesce into the next PUT (the latest whole spec wins), and that PUT carries
 * the rev the previous one returned. The queue owns the rev once it has saved:
 * a render that has not caught up with the last response cannot hand it a stale
 * one. A 409 means someone else wrote the file: pending edits are dropped, the
 * board is refetched, the page is told ("board changed elsewhere, reloaded")
 * and its undo stack cleared. A network error, 500 or 503 (the board lock was
 * busy) keeps the edits pending and on screen; the next edit or Retry resends.
 */

export const BOARDS_KEY = ['lab', 'boards'] as const;
export const boardKey = (slug: string) => ['lab', 'boards', slug] as const;
/** One insight's summary + cache, seeded by the bulk read (`caches` is a reserved insight slug). */
export const insightCacheKey = (slug: string) => ['lab', 'caches', slug] as const;

/** The server caps `?slugs=` at 60. */
export const CACHES_CHUNK = 60;

// ─── Save queue (pure, testable) ────────────────────────────────────────────

export type BoardSaveStatus = 'idle' | 'saving' | 'failed';

/** What the page is told once, as it happens. */
export type BoardSaveSignal =
  | { kind: 'conflict'; slug: string }
  | { kind: 'failed'; slug: string; status: number | null };

interface SaveEntry {
  rev: string;
  /** The spec on the wire, or null. */
  inFlight: BoardSpec | null;
  /** The newest edit not yet sent. */
  pending: BoardSpec | null;
  failed: boolean;
}

export interface BoardSaverDeps {
  put: (slug: string, spec: BoardSpec, rev: string) => Promise<Board>;
  onSaved?: (board: Board) => void;
  /** 409: the caller refetches. */
  onConflict?: (slug: string) => void;
  onSignal?: (signal: BoardSaveSignal) => void;
}

export interface BoardSaver {
  /** Queue the board's whole next spec. `rev` is only read when the queue holds nothing for `slug`. */
  save: (slug: string, spec: BoardSpec, rev: string) => void;
  /** Resend a failed board's pending edits. */
  retry: (slug: string) => void;
  status: (slug: string) => BoardSaveStatus;
  /** The spec the screen should show while edits are unsaved (newest first), else null. */
  unsaved: (slug: string) => BoardSpec | null;
  subscribe: (listener: () => void) => () => void;
  /** Resolves when no PUT is in flight for `slug` (tests, teardown). */
  idle: (slug: string) => Promise<void>;
}

/** The HTTP status of a failed request, or null for a network failure. */
function statusOf(err: unknown): number | null {
  return err instanceof RequestError ? err.status : null;
}

export function createBoardSaver(deps: BoardSaverDeps): BoardSaver {
  const entries = new Map<string, SaveEntry>();
  const flights = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const l of listeners) l(); };

  const flush = (slug: string): void => {
    const entry = entries.get(slug);
    if (!entry || entry.inFlight || !entry.pending) return;
    const spec = entry.pending;
    entry.inFlight = spec;
    entry.pending = null;
    entry.failed = false;
    const flight = deps.put(slug, spec, entry.rev).then(
      (board) => {
        entry.inFlight = null;
        entry.rev = board.rev;
        deps.onSaved?.(board);
        // The key dies with its last edit: an idle, saved board holds no entry.
        if (entry.pending) flush(slug);
        else entries.delete(slug);
      },
      (err: unknown) => {
        entry.inFlight = null;
        const status = statusOf(err);
        if (status === 409) {
          entries.delete(slug);
          deps.onConflict?.(slug);
          deps.onSignal?.({ kind: 'conflict', slug });
          return;
        }
        // Kept: the newer edit if one arrived during the flight, else the one that failed.
        entry.pending = entry.pending ?? spec;
        entry.failed = true;
        deps.onSignal?.({ kind: 'failed', slug, status });
      },
    ).finally(() => {
      if (flights.get(slug) === flight) flights.delete(slug);
      notify();
    });
    flights.set(slug, flight);
    notify();
  };

  return {
    save(slug, spec, rev) {
      let entry = entries.get(slug);
      if (!entry) {
        entry = { rev, inFlight: null, pending: null, failed: false };
        entries.set(slug, entry);
      }
      entry.pending = spec;
      flush(slug);
      notify();
    },
    retry(slug) {
      flush(slug);
    },
    status(slug) {
      const entry = entries.get(slug);
      if (!entry) return 'idle';
      if (entry.inFlight) return 'saving';
      return entry.failed ? 'failed' : 'idle';
    },
    unsaved(slug) {
      const entry = entries.get(slug);
      return entry ? entry.pending ?? entry.inFlight : null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async idle(slug) {
      while (flights.has(slug)) await flights.get(slug);
    },
  };
}

// ─── Bulk caches (pure, testable) ───────────────────────────────────────────

/** `slugs` deduped and cut into `?slugs=` chunks of at most `size`. */
export function chunkSlugs(slugs: readonly string[], size = CACHES_CHUNK): string[][] {
  const unique = [...new Set(slugs)].sort();
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += size) out.push(unique.slice(i, i + size));
  return out;
}

/** `GET /api/lab/caches?slugs=`: summaries + caches (history trails stripped). Unknown slugs are absent. */
export interface CachesResponse {
  summaries: Record<string, InsightSummary>;
  caches: Record<string, InsightCache | null>;
}

/** What one insight's per-slug cache entry holds. */
export interface InsightCacheEntry {
  summary: InsightSummary | null;
  cache: InsightCache | null;
}

/** Every chunk in parallel, merged. A slug the server does not know is simply absent. */
export async function fetchCaches(
  get: <T>(path: string) => Promise<T>,
  slugs: readonly string[],
  size = CACHES_CHUNK,
): Promise<Record<string, InsightCacheEntry>> {
  const chunks = chunkSlugs(slugs, size);
  const parts = await Promise.all(
    chunks.map((chunk) => get<CachesResponse>(`/lab/caches?slugs=${chunk.map(encodeURIComponent).join(',')}`)),
  );
  const out: Record<string, InsightCacheEntry> = {};
  for (const part of parts) {
    const summaries = part.summaries ?? {};
    const caches = part.caches ?? {};
    for (const slug of new Set([...Object.keys(summaries), ...Object.keys(caches)])) {
      out[slug] = { summary: summaries[slug] ?? null, cache: caches[slug] ?? null };
    }
  }
  return out;
}

/** Seed the per-insight cache entries, so `useInsightCache(slug)` never asks again (no 1+N). */
export function seedInsightCaches(queryClient: QueryClient, entries: Record<string, InsightCacheEntry>): void {
  for (const [slug, entry] of Object.entries(entries)) queryClient.setQueryData(insightCacheKey(slug), entry);
}

/** The insight slugs a board's legacy `insight` blocks draw (a card with no blocks is one). */
export function legacyInsightSlugs(cards: readonly Card[]): string[] {
  const out = new Set<string>();
  for (const card of cards) {
    if (!card.blocks || card.blocks.length === 0) {
      if (card.insight) out.add(card.insight);
      continue;
    }
    const visit = (blocks: Card['blocks']) => {
      for (const b of blocks ?? []) {
        if (b.type === 'insight') {
          const slug = b.data ?? card.insight;
          if (slug) out.add(slug);
        }
        for (const tab of b.tabs ?? []) visit(tab.blocks);
      }
    };
    visit(card.blocks);
  }
  return [...out].sort();
}

// ─── Hooks ──────────────────────────────────────────────────────────────────

/** Every board (derived, materialized and error boards). */
export function useBoards() {
  const api = useApi();
  return useQuery({
    queryKey: BOARDS_KEY,
    queryFn: () => api.get<BoardListResponse>('/lab/boards'),
    retry: 0,
  });
}

/**
 * One board: spec + frames + summaries. Unsaved edits are laid over the
 * server's spec, so a refetch mid-save (a sync invalidating `['lab']`) never
 * snaps a card back to where it was before the drag.
 */
export function useBoard(slug: string | null) {
  const api = useApi();
  const saver = useBoardSaver();
  const query = useQuery({
    queryKey: boardKey(slug ?? ''),
    queryFn: () => api.get<BoardResponse>(`/lab/boards/${encodeURIComponent(slug as string)}`),
    enabled: !!slug,
    retry: 0,
  });
  const unsaved = useSyncExternalStore(saver.subscribe, () => (slug ? saver.unsaved(slug) : null));
  const data = useMemo<BoardResponse | undefined>(() => {
    if (!query.data || !unsaved) return query.data;
    return { ...query.data, board: { ...query.data.board, ...unsaved } };
  }, [query.data, unsaved]);
  return { ...query, data };
}

/** The vault's custom HTML block library (`lab/blocks/*.md`). Empty on an older backend. */
export function useBlockLibrary() {
  const api = useApi();
  return useQuery({
    queryKey: ['lab', 'blocks'],
    queryFn: () => api.get<{ blocks: LibraryBlock[] }>('/lab/blocks').then((r) => r.blocks ?? []),
    retry: 0,
  });
}

/** Bulk caches for the board's `insight` blocks: one request per 60 slugs, never one per card. */
export function useBoardCaches(cards: readonly Card[] | undefined) {
  const api = useApi();
  const queryClient = useQueryClient();
  const slugs = useMemo(() => legacyInsightSlugs(cards ?? []), [cards]);
  return useQuery({
    queryKey: ['lab', 'boards', '~caches', slugs.join(',')],
    queryFn: async () => {
      const entries = await fetchCaches((path) => api.get(path), slugs);
      seedInsightCaches(queryClient, entries);
      return entries;
    },
    enabled: slugs.length > 0,
    placeholderData: (prev) => prev,
    retry: 0,
  });
}

/** One insight's summary + cache: served from the bulk seed, fetched alone only when nothing seeded it. */
export function useInsightCache(slug: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: insightCacheKey(slug ?? ''),
    queryFn: () => fetchCaches((path) => api.get(path), [slug as string])
      .then((entries): InsightCacheEntry => entries[slug as string] ?? { summary: null, cache: null }),
    enabled: !!slug,
    staleTime: 30_000,
    retry: 0,
  });
}

/** One queue per QueryClient (one per app); it dies with it. */
const savers = new WeakMap<QueryClient, BoardSaver>();
const signalListeners = new WeakMap<QueryClient, Set<(signal: BoardSaveSignal) => void>>();

function useBoardSaver(): BoardSaver {
  const api = useApi();
  const queryClient = useQueryClient();
  let saver = savers.get(queryClient);
  if (!saver) {
    const listeners = new Set<(signal: BoardSaveSignal) => void>();
    signalListeners.set(queryClient, listeners);
    saver = createBoardSaver({
      // The queue outlives any one component, so it keeps the client it was born with.
      // The PUT answers with the whole BoardResponse (frames re-resolved for the new spec).
      put: (slug, spec, rev) =>
        api.put<BoardResponse>(`/lab/boards/${encodeURIComponent(slug)}`, { rev, spec }).then((r) => {
          queryClient.setQueryData(boardKey(slug), r);
          return r.board;
        }),
      onSaved: (board) => {
        const list = queryClient.getQueryData<BoardListResponse>(BOARDS_KEY);
        if (list?.derived) {
          // The first save materialized EVERY board: all their revs changed with it.
          void queryClient.invalidateQueries({ queryKey: BOARDS_KEY });
        } else if (list) {
          queryClient.setQueryData<BoardListResponse>(BOARDS_KEY, {
            ...list,
            boards: list.boards.map((b) => (b.slug === board.slug ? board : b)),
          });
        }
      },
      onConflict: (slug) => {
        void queryClient.invalidateQueries({ queryKey: boardKey(slug) });
        void queryClient.invalidateQueries({ queryKey: BOARDS_KEY, exact: true });
      },
      onSignal: (signal) => { for (const l of listeners) l(signal); },
    });
    savers.set(queryClient, saver);
  }
  return saver;
}

/**
 * Save a board. `onSignal` hears a conflict (show "board changed elsewhere,
 * reloaded" and clear undo) and a failure (show Retry). Status re-renders live.
 */
export function useSaveBoard(slug: string | null, onSignal?: (signal: BoardSaveSignal) => void) {
  const queryClient = useQueryClient();
  const saver = useBoardSaver();
  const status = useSyncExternalStore(saver.subscribe, () => (slug ? saver.status(slug) : 'idle'));

  useEffect(() => {
    if (!onSignal) return;
    const listeners = signalListeners.get(queryClient);
    if (!listeners) return;
    listeners.add(onSignal);
    return () => { listeners.delete(onSignal); };
  }, [queryClient, onSignal]);

  const save = useCallback((spec: BoardSpec, rev: string) => {
    if (slug) saver.save(slug, spec, rev);
  }, [saver, slug]);
  const retry = useCallback(() => {
    if (slug) saver.retry(slug);
  }, [saver, slug]);
  return { save, retry, status };
}
