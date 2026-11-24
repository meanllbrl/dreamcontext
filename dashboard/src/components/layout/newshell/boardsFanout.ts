import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiClient } from '../../../api/client';

/**
 * Board lists of every project for the sidebar's boards mode (tek-kenar C6): the existing
 * `GET /api/whiteboards` asked of each listed project that is not on screen, 3 at a time, each read
 * racing 8 s (a failure or a timeout marks that project failed and blocks no other). Cached per
 * project and stale after 30 s; the project on screen is seeded from its own list query
 * (`seedBoards`), so its flat list is ready the moment it stops being active.
 */
export const BOARDS_PARALLEL = 3;
export const BOARDS_TIMEOUT_MS = 8_000;
export const BOARDS_STALE_MS = 30_000;

export interface SidebarBoard { slug: string; name: string }

export interface BoardsEntry {
  /** `loading` only before a first answer; a refresh keeps the old list on screen. */
  state: 'loading' | 'ok' | 'failed';
  boards: SidebarBoard[];
  /** When the list was last answered (ms). */
  at: number;
}

type Read = (vault: string) => Promise<SidebarBoard[]>;

/** Races `p` against `ms`: the slot is freed when the race settles, whichever wins. */
function within<T>(p: Promise<T>, ms: number, setTimer: (fn: () => void, ms: number) => unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    setTimer(() => reject(new Error('timeout')), ms);
    p.then(resolve, reject);
  });
}

/** Reads every vault, at most {@link BOARDS_PARALLEL} at once; `onEntry` hears each as it lands. */
export async function fanOutBoards(
  vaults: readonly string[],
  read: Read,
  onEntry: (vault: string, entry: Omit<BoardsEntry, 'at'>) => void,
  opts: { parallel?: number; timeoutMs?: number; setTimer?: (fn: () => void, ms: number) => unknown; current?: () => boolean } = {},
): Promise<void> {
  const parallel = opts.parallel ?? BOARDS_PARALLEL;
  const timeoutMs = opts.timeoutMs ?? BOARDS_TIMEOUT_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const current = opts.current ?? (() => true);
  let next = 0;
  const worker = async () => {
    while (next < vaults.length && current()) {
      const vault = vaults[next++];
      try {
        const boards = await within(read(vault), timeoutMs, setTimer);
        onEntry(vault, { state: 'ok', boards });
      } catch {
        onEntry(vault, { state: 'failed', boards: [] });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, vaults.length) }, worker));
}

/** The list the server answers, reduced to what a sidebar row draws. */
export function toSidebarBoards(res: unknown): SidebarBoard[] {
  const list = Array.isArray(res) ? res : (res && typeof res === 'object' && Array.isArray((res as { whiteboards?: unknown }).whiteboards) ? (res as { whiteboards: unknown[] }).whiteboards : []);
  return list.flatMap((b) => (b && typeof b === 'object' && typeof (b as SidebarBoard).slug === 'string'
    ? [{ slug: (b as SidebarBoard).slug, name: typeof (b as SidebarBoard).name === 'string' ? (b as SidebarBoard).name : (b as SidebarBoard).slug }]
    : []));
}

/** Which listed projects to read now: missing, stale, or due for a refresh. */
export function boardsDue(vaults: readonly string[], cache: ReadonlyMap<string, BoardsEntry>, refresh: ReadonlySet<string>, now: number, inFlight: ReadonlySet<string>): string[] {
  return vaults.filter((v) => !inFlight.has(v) && (refresh.has(v) || !cache.has(v) || now - (cache.get(v)?.at ?? 0) > BOARDS_STALE_MS));
}

const readBoards: Read = (vault) => new ApiClient(vault).get<unknown>('/whiteboards').then(toSidebarBoards);

/**
 * The sidebar's board lists. `enabled` = boards mode is on screen; `vaults` = the listed projects
 * that are not active. Every non-active project is read again when boards mode opens and when it
 * stops being active.
 */
export function useBoardsFanout(enabled: boolean, vaults: readonly string[], activeVault: string, read: Read = readBoards) {
  const cache = useRef(new Map<string, BoardsEntry>());
  const refresh = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  // Boards mode opening asks every project again.
  const wasEnabled = useRef(false);
  if (enabled && !wasEnabled.current) for (const v of vaults) refresh.current.add(v);
  wasEnabled.current = enabled;
  // The project that just stopped being active is asked again (its seed shows meanwhile).
  const lastActive = useRef(activeVault);
  if (lastActive.current !== activeVault) {
    if (lastActive.current) refresh.current.add(lastActive.current);
    lastActive.current = activeVault;
  }

  const key = vaults.join('\u0000');
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    const due = boardsDue(vaults, cache.current, refresh.current, Date.now(), inFlight.current);
    if (!due.length) return undefined;
    for (const v of due) {
      refresh.current.delete(v);
      inFlight.current.add(v);
      if (!cache.current.has(v)) cache.current.set(v, { state: 'loading', boards: [], at: 0 });
    }
    rerender();
    void fanOutBoards(due, read, (vault, entry) => {
      inFlight.current.delete(vault);
      const prev = cache.current.get(vault);
      // A failed refresh keeps a list that was read before.
      if (entry.state === 'failed' && prev?.state === 'ok') cache.current.set(vault, { ...prev, at: Date.now() });
      else cache.current.set(vault, { ...entry, at: Date.now() });
      if (live) rerender();
    });
    return () => { live = false; };
  }, [enabled, key, activeVault, read, rerender]); // eslint-disable-line react-hooks/exhaustive-deps -- vaults by key

  /** The active project's own list (its explorer's query), on every change. */
  const seed = useCallback((vault: string, list: readonly { slug: string; name: string }[]) => {
    const boards = list.map((b) => ({ slug: b.slug, name: b.name || b.slug }));
    const prev = cache.current.get(vault);
    if (prev?.state === 'ok' && prev.boards.length === boards.length && prev.boards.every((b, i) => b.slug === boards[i].slug && b.name === boards[i].name)) return;
    cache.current.set(vault, { state: 'ok', boards, at: Date.now() });
    rerender();
  }, [rerender]);

  return { entries: cache.current as ReadonlyMap<string, BoardsEntry>, seed };
}
