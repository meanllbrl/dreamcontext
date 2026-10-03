import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi, useVault } from '../context/VaultContext';
import { RequestError } from '../api/client';
import { deliverDownload, deliveredNote, type ExportNote } from '../lib/exportDownload';
import type { WhiteboardCanvasApi, WhiteboardScene } from '../components/whiteboard/LazyWhiteboardCanvas';
import { IMAGES_LATER_MESSAGE, stripImageElements } from '../components/whiteboard/sceneSync';
import {
  POLL_INTERVAL_MS, WhiteboardSaveLoop, fitWhenReady, reasonOf, type SaveState, type SceneResponse,
} from './whiteboardSaveLoop';

/** One row of `GET /api/whiteboards` (mirrors `WhiteboardSummary` in src/lib/whiteboards/store.ts). */
export interface WhiteboardSummary {
  slug: string;
  name: string;
  description: string;
  /** Live (non-deleted) element count. */
  elements: number;
  updatedAt: string;
  /** Set when the board does not parse. */
  corrupt?: string;
}

interface WhiteboardDoc {
  name: string;
  description?: string;
  elements: readonly unknown[];
  appState?: Record<string, unknown>;
  rev: string;
}

/** Where a board lives, for the corrupt-board card (D2). */
export function whiteboardFilePath(slug: string): string {
  return `_dream_context/whiteboards/${slug}/${slug}.excalidraw.md`;
}

/** Paths for the `api` client, which adds the `/api` prefix itself: a literal `/api/…` here
 *  would request `/api/api/whiteboards`. Every whiteboard request goes through these. */
const LIST_PATH = '/whiteboards';
const boardUrl = (slug: string) => `${LIST_PATH}/${encodeURIComponent(slug)}`;
const TRASH_PATH = `${LIST_PATH}/trash`;
const restoreUrl = (id: string) => `${TRASH_PATH}/${encodeURIComponent(id)}/restore`;

const LIST_KEY = ['whiteboards'] as const;
const TRASH_KEY = [...LIST_KEY, 'trash'] as const;

/** The fit-on-open's clear margins, in screen px: the top clears Excalidraw's tool bar and the
 *  "To move canvas…" hint under it; the sides and bottom keep content off the edges. */
const FIT_INSETS = { top: 112, right: 32, bottom: 32, left: 32 };

export function useWhiteboardList() {
  const api = useApi();
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: async () => {
      const res = await api.get<WhiteboardSummary[] | { whiteboards: WhiteboardSummary[] }>(LIST_PATH);
      return Array.isArray(res) ? res : (res.whiteboards ?? []);
    },
  });
}

/**
 * The default board's slug (A15). The server ensures the board exists under the store lock and
 * returns its slug, so two windows opening Control Panel at once never make two boards; the
 * client never creates it itself. `enabled` is off when a deep link already names a board.
 */
export function useDefaultWhiteboard(enabled: boolean) {
  const api = useApi();
  const qc = useQueryClient();
  return useQuery({
    queryKey: [...LIST_KEY, 'default'],
    enabled,
    staleTime: Infinity,
    queryFn: async () => {
      const res = await api.get<{ slug: string }>(`${LIST_PATH}/default`);
      // The call may just have created it: the switcher's list should show it.
      void qc.invalidateQueries({ queryKey: LIST_KEY, exact: true });
      return res.slug;
    },
  });
}

export function useCreateWhiteboard() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; description: string }) =>
      api.post<{ slug: string }>(LIST_PATH, input),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: LIST_KEY, exact: true }); },
  });
}

export function useDeleteWhiteboard() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => api.del<unknown>(boardUrl(slug)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LIST_KEY, exact: true });
      void qc.invalidateQueries({ queryKey: TRASH_KEY });
    },
  });
}

/** One row of `GET /api/whiteboards/trash` (mirrors `TrashedWhiteboard` in src/lib/whiteboards/store.ts). */
export interface TrashedWhiteboard {
  id: string;
  slug: string;
  name: string;
  elements: number;
  deletedAt: string;
}

/** Deleted boards, newest first. They sit in a gitignored trash on this machine only. */
export function useWhiteboardTrash() {
  const api = useApi();
  return useQuery({
    queryKey: TRASH_KEY,
    queryFn: async () => (await api.get<{ trash: TrashedWhiteboard[] }>(TRASH_PATH)).trash ?? [],
  });
}

export function useRestoreWhiteboard() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ slug: string }>(restoreUrl(id), {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LIST_KEY, exact: true });
      void qc.invalidateQueries({ queryKey: TRASH_KEY });
    },
  });
}

export type WhiteboardLoad =
  | { kind: 'loading' }
  | { kind: 'ready'; name: string; description: string; scene: WhiteboardScene; rev: string }
  /** D12: the file does not parse. Read-only card; nothing is ever written over it. */
  | { kind: 'corrupt'; reason: string; file: string }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

/**
 * One open board: its first load, then the save + poll loop (D5, D11) for as long as it is
 * mounted. The loop itself lives in `whiteboardSaveLoop.ts`; this wires it to the API, the
 * canvas handle and the page's lifecycle (visibility, pagehide, unmount).
 */
export function useWhiteboardEditor(slug: string) {
  const api = useApi();
  const { isActive } = useVault();
  const [load, setLoad] = useState<WhiteboardLoad>({ kind: 'loading' });
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'saved' });
  const canvasRef = useRef<WhiteboardCanvasApi | null>(null);
  const loopRef = useRef<WhiteboardSaveLoop<unknown> | null>(null);
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  // The one-time fit on open. This hook lives exactly as long as one board is open (the page
  // keys the editor on the slug), so "once per hook" is "once per board open".
  const fittedRef = useRef(false);
  const cancelFitRef = useRef<(() => void) | null>(null);
  const expectContentRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: 'loading' });
    setSaveState({ kind: 'saved' });
    api.get<WhiteboardDoc>(boardUrl(slug)).then(
      (doc) => {
        if (cancelled) return;
        expectContentRef.current = Array.isArray(doc.elements)
          && doc.elements.some((el) => !(el as { isDeleted?: boolean } | null)?.isDeleted);
        setLoad({
          kind: 'ready',
          name: doc.name || slug,
          description: doc.description ?? '',
          scene: { elements: Array.isArray(doc.elements) ? doc.elements : [], appState: doc.appState },
          rev: doc.rev,
        });
      },
      (err: unknown) => {
        if (cancelled) return;
        const status = err instanceof RequestError ? err.status : undefined;
        if (status === 422) setLoad({ kind: 'corrupt', reason: reasonOf(err), file: whiteboardFilePath(slug) });
        else if (status === 404) setLoad({ kind: 'missing' });
        else setLoad({ kind: 'error', message: reasonOf(err) });
      },
    );
    return () => { cancelled = true; };
  }, [api, slug]);

  const ready = load.kind === 'ready' ? load : null;

  useEffect(() => {
    if (!ready) return;
    const url = boardUrl(slug);
    const loop = new WhiteboardSaveLoop<unknown>({
      snapshot: () => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        // The canvas already refuses images as they arrive; this is the last gate before a
        // PUT, so one that slipped through is removed and said out loud, never saved (D10).
        const stripped = stripImageElements(canvas.getElements());
        if (stripped.visible) {
          canvas.excalidraw.setToast({ message: IMAGES_LATER_MESSAGE, closable: true, duration: 4000 });
        }
        return { elements: stripped.elements, version: canvas.getSceneVersion() };
      },
      put: (elements) => api.put<{ rev: string; elements?: unknown[] }>(url, { elements }),
      getRev: async () => (await api.get<{ rev: string }>(`${url}/rev`)).rev,
      getScene: async (): Promise<SceneResponse> => {
        const doc = await api.get<WhiteboardDoc>(url);
        return { rev: doc.rev, elements: Array.isArray(doc.elements) ? doc.elements : [] };
      },
      applyRemote: (elements) => canvasRef.current?.applyRemoteElements(elements),
      onState: setSaveState,
    }, ready.rev);
    loopRef.current = loop;

    const visible = () => document.visibilityState === 'visible' && isActiveRef.current;
    const interval = window.setInterval(() => { if (visible()) void loop.poll(); }, POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') loop.flush();
      else if (visible()) void loop.poll();
    };
    const onPageHide = () => loop.flush();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      loop.dispose();
      if (loopRef.current === loop) loopRef.current = null;
    };
  }, [api, slug, ready]);

  // The final save on close runs in a LAYOUT cleanup: on unmount React runs this component's
  // layout cleanups before it unmounts the children, so the canvas (and its scene) is still
  // there. A passive cleanup runs after Excalidraw has already swapped in an empty Scene. The
  // passive cleanup above still disposes (a no-op by then) and clears the timers.
  useLayoutEffect(() => () => { loopRef.current?.dispose(); }, []);

  // A hidden project instance stops polling; coming back polls at once.
  useEffect(() => {
    if (isActive && document.visibilityState === 'visible') void loopRef.current?.poll();
  }, [isActive]);

  const onApi = useCallback((canvas: WhiteboardCanvasApi | null) => {
    // The canvas is going away: last chance to send what it holds, before the handle is gone.
    if (!canvas) {
      loopRef.current?.flush();
      cancelFitRef.current?.();
      cancelFitRef.current = null;
    }
    canvasRef.current = canvas;
    // Fit the content once, when the canvas is sized and the scene is in: opening Control
    // Panel, switching boards and a deep link all land centred. Never again for this open.
    if (canvas && !fittedRef.current) {
      fittedRef.current = true;
      const x = canvas.excalidraw;
      cancelFitRef.current = fitWhenReady({
        viewportReady: () => {
          const { width, height } = x.getAppState();
          return width > 0 && height > 0;
        },
        liveCount: () => x.getSceneElements().length,
        // Fit a big board; centre a small one at 100% rather than blowing one card up to 30x.
        fit: () => x.scrollToContent(undefined, {
          fitToViewport: true, viewportZoomFactor: 0.9, maxZoom: 1, minZoom: 0.1, animate: false,
          canvasOffsets: FIT_INSETS,
        }),
      }, expectContentRef.current);
    }
  }, []);

  const onSceneChange = useCallback((elements: readonly unknown[]) => {
    // Hand the loop the changed scene itself: if the board closes before the debounce fires,
    // this is what the final save sends, whatever the torn-down canvas reads by then.
    const canvas = canvasRef.current;
    const kept = stripImageElements(elements as Parameters<typeof stripImageElements>[0]).elements;
    const version = canvas ? canvas.getSceneVersion()
      : kept.reduce((sum, el) => sum + ((el as { version?: number }).version ?? 0), 0);
    loopRef.current?.notifyChange({ elements: kept, version });
  }, []);

  /** Download the scene held in memory as an `.excalidraw` file: the way out when a save is
   *  refused for good or the board was deleted under us. */
  const exportFile = useCallback(async (): Promise<ExportNote | null> => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const elements = stripImageElements(canvas.getElements()).elements.filter(
      (el) => !(el as { isDeleted?: boolean }).isDeleted,
    );
    const file = {
      type: 'excalidraw',
      version: 2,
      source: 'dreamcontext',
      elements,
      appState: { viewBackgroundColor: '#ffffff' },
      files: {},
    };
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    try {
      return deliveredNote(await deliverDownload(blob, `${slug}.excalidraw`));
    } catch (err) {
      return { text: reasonOf(err) };
    }
  }, [slug]);

  return { load, saveState, onApi, onSceneChange, exportFile };
}
