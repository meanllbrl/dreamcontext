import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
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
  /** `saveAndWait` callers: settled when the queue next empties (saved), 409s or fails. */
  waiters: { resolve: (board: Board) => void; reject: (err: unknown) => void }[];
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
  /**
   * `save`, then resolve with the saved board once this edit (or a later one
   * coalesced over it) is on disk; reject with the error on a 409 or a failure
   * (a failed edit still stays pending for Retry, as with `save`).
   */
  saveAndWait: (slug: string, spec: BoardSpec, rev: string) => Promise<Board>;
  /** Resend a failed board's pending edits. */
  retry: (slug: string) => void;
  status: (slug: string) => BoardSaveStatus;
  /**
   * The rev THIS client's last successful PUT produced for `slug`, or null.
   * A board whose server rev is anything else was written by someone else
   * (an agent, the CLI, a brain-sync pull): the page's undo stack must go.
   */
  savedRev: (slug: string) => string | null;
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
  /** Outlives the entry: the rev our own last write produced, per board. */
  const lastSaved = new Map<string, string>();
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
        lastSaved.set(slug, board.rev);
        deps.onSaved?.(board);
        // The key dies with its last edit: an idle, saved board holds no entry.
        if (entry.pending) flush(slug);
        else {
          entries.delete(slug);
          for (const w of entry.waiters.splice(0)) w.resolve(board);
        }
      },
      (err: unknown) => {
        entry.inFlight = null;
        const status = statusOf(err);
        const waiters = entry.waiters.splice(0);
        for (const w of waiters) w.reject(err);
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

  const save = (slug: string, spec: BoardSpec, rev: string): void => {
    let entry = entries.get(slug);
    if (!entry) {
      entry = { rev, inFlight: null, pending: null, failed: false, waiters: [] };
      entries.set(slug, entry);
    }
    entry.pending = spec;
    flush(slug);
    notify();
  };

  return {
    save,
    saveAndWait(slug, spec, rev) {
      return new Promise<Board>((resolve, reject) => {
        save(slug, spec, rev);
        const entry = entries.get(slug);
        if (entry) entry.waiters.push({ resolve, reject });
      });
    },
    retry(slug) {
      flush(slug);
    },
    savedRev(slug) {
      return lastSaved.get(slug) ?? null;
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
  const savedRev = useSyncExternalStore(saver.subscribe, () => (slug ? saver.savedRev(slug) : null));

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
  return { save, retry, status, savedRev };
}

/**
 * Write ANY board, not just the open one (Move to board writes the target
 * too), and wait for it: same queue, same rev rules, same signals as
 * `useSaveBoard`. `idle(slug)` resolves once nothing is in flight for it.
 */
export function useBoardWriter() {
  const saver = useBoardSaver();
  return useMemo(() => ({
    saveAndWait: (slug: string, spec: BoardSpec, rev: string) => saver.saveAndWait(slug, spec, rev),
    idle: (slug: string) => saver.idle(slug),
    unsaved: (slug: string) => saver.unsaved(slug),
  }), [saver]);
}

/**
 * A board read FRESH from the server (and written into the query cache): a
 * cached copy may carry a rev the first materializing write already replaced.
 */
export function useFetchBoard() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useCallback((slug: string) => queryClient.fetchQuery({
    queryKey: boardKey(slug),
    queryFn: () => api.get<BoardResponse>(`/lab/boards/${encodeURIComponent(slug)}`),
    staleTime: 0,
  }), [api, queryClient]);
}

/** `POST /api/lab/boards { title }`: a new empty board after the last one (slug from the title). */
export function useCreateBoard() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (title: string) => api.post<BoardResponse>('/lab/boards', { title }),
    onSuccess: (r) => {
      queryClient.setQueryData(boardKey(r.board.slug), r);
      // A derived vault materialized every board with this create: every rev moved.
      void queryClient.invalidateQueries({ queryKey: BOARDS_KEY });
    },
  });
}

/** `DELETE /api/lab/boards/:slug?rev=`: a rev that moved is a 409, never a silent delete. */
export function useDeleteBoard() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, rev }: { slug: string; rev: string }) =>
      api.del<{ deleted: string }>(`/lab/boards/${encodeURIComponent(slug)}?rev=${encodeURIComponent(rev)}`),
    onSettled: (_r, _e, { slug }) => {
      queryClient.removeQueries({ queryKey: boardKey(slug), exact: true });
      void queryClient.invalidateQueries({ queryKey: BOARDS_KEY });
    },
  });
}
