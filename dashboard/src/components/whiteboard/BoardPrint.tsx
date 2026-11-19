import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useApi, useVaultId } from '../../context/VaultContext';
import { missingPictureIds } from '../../lib/boardFit';
import { withoutHtmlFrames } from '../../lib/excalidraw';
import { installImageThemeShim } from '../../lib/excalidrawImageTheme';
import { downloadBoardPicture } from '../sleepy/chat/BoardEmbed';
import { ensureExcalidrawAssetPath } from './LazyWhiteboardCanvas';
import { READ_EMBEDS } from './WhiteboardReadCanvas';
import '../core/ExcalidrawCanvas.css';
import '../core/ExcalidrawPreview.css';
import './BoardPrint.css';

installImageThemeShim();
ensureExcalidrawAssetPath();

/**
 * A whiteboard drawn for `dreamcontext whiteboard export` (`?boardprint=<slug>`): the board as
 * the app draws it, the same Excalidraw canvas and the same widget slot as a read-only board
 * (WhiteboardReadCanvas), so the handwriting font, the pictures and every widget's content are
 * the app's own. The CLI opens this page in headless Chromium and drives it through
 * `window.__dcBoardPrint`: it sizes the viewport to one section, calls `show()` with that
 * section's board rectangle (and which elements it draws), waits, and takes the screenshot.
 *
 * Nothing here edits: Excalidraw runs in view mode and every widget is drawn inactive.
 */

interface Region { x: number; y: number; w: number; h: number }

interface PrintApi {
  /** 'loading' until the board, its pictures and the canvas are up; then 'ready' or 'error'. */
  state: 'loading' | 'ready' | 'error';
  error?: string;
  /** Picture file ids the board names and the page could not load (by id). */
  missingPictures: string[];
  pictures: number;
  /** Draw `region` filling the viewport, only `ids` when given; resolves once it has settled. */
  show: (region: Region, ids?: string[] | null) => Promise<{ ok: true } | { ok: false; error: string }>;
}

declare global {
  interface Window { __dcBoardPrint?: PrintApi }
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; elements: readonly unknown[]; files: Record<string, unknown>; missing: string[]; pictures: number };

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Decode a data URL once, so the canvas has the pixels when it draws (a failure is the canvas's to show). */
async function predecode(dataURL: string): Promise<void> {
  const img = new Image();
  img.src = dataURL;
  try { await img.decode(); } catch { /* drawn as Excalidraw draws a broken picture */ }
}

export function BoardPrint({ slug }: { slug: string }) {
  const api = useApi();
  const { vault } = useVaultId();
  const queryClient = useQueryClient();
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const allRef = useRef<readonly unknown[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const doc = await api.get<{ elements?: unknown[] }>(`/whiteboards/${encodeURIComponent(slug)}`);
      const elements = withoutHtmlFrames(Array.isArray(doc?.elements) ? doc.elements : []);
      const ids = missingPictureIds(elements, undefined);
      const got = await Promise.allSettled(ids.map((id) => downloadBoardPicture(slug, vault, id)));
      const files: Record<string, unknown> = {};
      const missing: string[] = [];
      got.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value.dataURL.startsWith('data:image/')) {
          files[r.value.id] = { id: r.value.id, mimeType: r.value.mimeType, dataURL: r.value.dataURL, created: 0 };
        } else missing.push(ids[i]);
      });
      await Promise.all(Object.values(files).map((f) => predecode((f as { dataURL: string }).dataURL)));
      if (cancelled) return;
      allRef.current = elements;
      setLoad({ kind: 'ready', elements, files, missing, pictures: ids.length });
    })().catch((err: unknown) => {
      if (!cancelled) setLoad({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    });
    return () => { cancelled = true; };
  }, [api, slug, vault]);

  useEffect(() => {
    if (load.kind === 'loading') {
      window.__dcBoardPrint = { state: 'loading', missingPictures: [], pictures: 0, show: async () => ({ ok: false, error: 'not ready' }) };
      return;
    }
    if (load.kind === 'error') {
      window.__dcBoardPrint = { state: 'error', error: load.message, missingPictures: [], pictures: 0, show: async () => ({ ok: false, error: load.message }) };
      return;
    }
    let cancelled = false;
    const settle = async () => {
      // Fonts (the handwriting font arrives late, per script range), widgets' own fetches and
      // pictures inside widgets; then a few frames for the canvas to redraw with them.
      for (let i = 0; i < 2; i++) {
        await document.fonts?.ready;
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline && (queryClient.isFetching() > 0 || [...document.images].some((im) => !im.complete))) await sleep(50);
        await frame(); await frame();
        await sleep(120);
      }
    };
    const show: PrintApi['show'] = async (region, ids) => {
      const ex = apiRef.current;
      if (!ex) return { ok: false, error: 'the canvas is not up' };
      try {
        const keep = ids ? new Set(ids) : null;
        const elements = keep
          ? allRef.current.filter((el) => keep.has(String((el as { id?: unknown }).id)))
          : allRef.current;
        ex.updateScene({ elements: elements as never });
        ex.refresh();
        await frame();
        const width = window.innerWidth;
        const zoom = width / Math.max(1, region.w);
        ex.updateScene({ appState: { scrollX: -region.x, scrollY: -region.y, zoom: { value: zoom as never } } as never });
        await settle();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    };
    (async () => {
      // The canvas mounts with the board; wait for its API and a first settle.
      const deadline = Date.now() + 15000;
      while (!apiRef.current && Date.now() < deadline) await sleep(50);
      await settle();
      if (cancelled) return;
      window.__dcBoardPrint = apiRef.current
        ? { state: 'ready', missingPictures: load.missing, pictures: load.pictures, show }
        : { state: 'error', error: 'the canvas did not start', missingPictures: load.missing, pictures: load.pictures, show };
    })();
    return () => { cancelled = true; };
  }, [load, queryClient]);

  if (load.kind === 'loading') return <div className="board-print-status">Loading board…</div>;
  if (load.kind === 'error') return <div className="board-print-status">{load.message}</div>;
  return (
    <div className="board-print excalidraw-preview" data-theme="light">
      <div className="excalidraw-canvas-wrap">
        <Excalidraw
          excalidrawAPI={(a) => { apiRef.current = a; }}
          initialData={{ elements: load.elements as never, files: load.files as never, appState: { viewBackgroundColor: '#ffffff' } }}
          viewModeEnabled
          zenModeEnabled
          theme="light"
          validateEmbeddable={READ_EMBEDS.validateEmbeddable}
          renderEmbeddable={READ_EMBEDS.renderEmbeddable as never}
          UIOptions={{ canvasActions: { changeViewBackgroundColor: false, clearCanvas: false, export: false, loadScene: false, saveToActiveFile: false, saveAsImage: false, toggleTheme: false } }}
        />
      </div>
    </div>
  );
}

export default BoardPrint;
