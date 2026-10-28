import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApi, useVault } from '../../../context/VaultContext';
import { boardFailure, boardRetryDelay, type BoardFailure } from '../../../lib/boardFailure';
import { loadWhiteboardPictures, whiteboardSlugOf, type BoardPictureFile } from '../../../lib/boardFit';
import { ExcalidrawPreview } from '../../core/ExcalidrawPreview';
import { FullscreenOverlay } from '../../layout/FullscreenOverlay';

/**
 * An Excalidraw board the answer named, DRAWN — inline as a transcript card
 * ({@link BoardEmbed}) and, from every entry point, genuinely fullscreen
 * ({@link BoardFullscreen}, portaled to `document.body`). There is no side-panel board view
 * any more: a board is a canvas, and a canvas wants the window, not a cramped panel.
 *
 * The whole point of the Chat view: an agent that just built a board should be able to show
 * it, not tell you where it is. Both render the same live canvas the Knowledge page uses
 * (`ExcalidrawPreview` — pan/zoom, crisp at any scale, lazy-loaded), so a board made two
 * seconds ago is visible without leaving the conversation.
 *
 * Two fetches, because a board is two things — see {@link useBoardScene}.
 */

interface AssetFiles { [fileId: string]: { mimeType: string; dataURL: string } }

interface BoardScene {
  content: string | null;
  assets: AssetFiles | undefined;
  assetsLoading: boolean;
  failed: boolean;
  /** Why it failed, in a few words, for the card (null while it has not). */
  failure: BoardFailure | null;
  /** A whiteboard (`whiteboards/<slug>/<slug>.excalidraw.md`): drawn with its widgets. */
  whiteboard: boolean;
}

/** One stored picture of a whiteboard, from the route the Whiteboards page reads it from
 *  (`GET /api/whiteboards/<slug>/files/<id>`, raw bytes, the vault header as the API client
 *  sends it), as a data URL. */
async function downloadBoardPicture(slug: string, vault: string | null, id: string): Promise<BoardPictureFile> {
  const res = await fetch(`/api/whiteboards/${encodeURIComponent(slug)}/files/${encodeURIComponent(id)}`, {
    headers: vault ? { 'X-Dreamcontext-Vault': vault } : {},
  });
  if (!res.ok) throw Object.assign(new Error(`picture ${id}: ${res.status}`), { status: res.status });
  const blob = await res.blob();
  const dataURL = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return { id, mimeType: blob.type, dataURL };
}

/**
 * Load a board: its scene (`GET /agent/file`, markdown) and the screenshots it embeds by
 * wikilink (`GET /agent/board-assets`). Both are needed — an Obsidian board keeps no pixels
 * in its own scene JSON, so without the second call every embedded image renders blank —
 * but only the first is load-bearing: a board whose assets fail still renders its shapes
 * and text, which is most of what it says. A board that embeds nothing skips the (sharp-
 * backed) asset resolve entirely.
 */
export function useBoardScene(path: string): BoardScene {
  const api = useApi();
  const { vault } = useVault();
  const slug = whiteboardSlugOf(path);
  const whiteboard = slug !== null;
  const [scene, setScene] = useState<BoardScene>({
    content: null, assets: undefined, assetsLoading: false, failed: false, failure: null, whiteboard,
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    setScene({ content: null, assets: undefined, assetsLoading: false, failed: false, failure: null, whiteboard });

    const load = () => api.get<{ content: string }>(`/agent/file?path=${encodeURIComponent(path)}`)
      .then((data) => {
        if (cancelled) return;
        const content = data?.content ?? '';
        if (slug) {
          setScene({ content, assets: undefined, assetsLoading: true, failed: false, failure: null, whiteboard });
          // A whiteboard keeps its pictures in its own `files/` folder, never under `## Embedded
          // Files`: fetched by id, the way the Whiteboards page gets them (lib/boardFit.ts).
          loadWhiteboardPictures(content, (id) => downloadBoardPicture(slug, vault, id))
            .then((files) => { if (!cancelled) setScene((s) => ({ ...s, assets: files, assetsLoading: false })); })
            .catch(() => { if (!cancelled) setScene((s) => ({ ...s, assets: {}, assetsLoading: false })); });
          return;
        }
        if (!content.includes('## Embedded Files')) {
          setScene({ content, assets: {}, assetsLoading: false, failed: false, failure: null, whiteboard });
          return;
        }
        setScene({ content, assets: undefined, assetsLoading: true, failed: false, failure: null, whiteboard });
        api.get<{ files: AssetFiles }>(`/agent/board-assets?path=${encodeURIComponent(path)}`)
          .then((r) => { if (!cancelled) setScene((s) => ({ ...s, assets: r?.files ?? {}, assetsLoading: false })); })
          .catch(() => { if (!cancelled) setScene((s) => ({ ...s, assets: {}, assetsLoading: false })); });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const failure = boardFailure(err);
        setScene({ content: null, assets: {}, assetsLoading: false, failed: true, failure, whiteboard });
        // A board not written yet draws once it lands (boardFailure.ts).
        const wait = boardRetryDelay(failure, tries++);
        if (wait !== null) timer = setTimeout(load, wait);
      });
    load();

    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [api, path, slug, vault, whiteboard]);

  return scene;
}

export function boardName(path: string): string {
  const clean = path.replace(/\/+$/, '');
  const i = clean.lastIndexOf('/');
  return (i === -1 ? clean : clean.slice(i + 1)).replace(/\.excalidraw(\.md)?$/i, '');
}

/**
 * The board filling the window. PORTALED to `document.body` because `.agent-surface` sets
 * `contain: layout paint`, which makes it the containing block for `position: fixed` — an
 * overlay rendered in the transcript's own tree would be clipped to the pane instead of
 * covering the app (the same reason the dock and the council chamber portal out).
 *
 * It is a SEPARATE mount from the inline card, not the same canvas relocated: each carries
 * its own `boardKey` suffix, so opening full-screen fits the board to the big viewport and
 * closing leaves the card exactly where the reader had panned it.
 */
export function BoardFullscreen({ path, onClose }: { path: string; onClose: () => void }) {
  const { content, assets, assetsLoading, failed, failure, whiteboard } = useBoardScene(path);
  return createPortal(
    <FullscreenOverlay label={boardName(path)} onClose={onClose}>
      <div className="chat-board-full">
        {failed
          ? <p className="chat-slideover-status error">{failure?.missing ? 'This board is not in the project yet.' : `Couldn't read this board: ${failure?.detail ?? ''}`}</p>
          : content === null
            ? <div className="chat-board-loading">Loading board…</div>
            : <ExcalidrawPreview content={content} boardKey={`${path}#full`} assets={assets} assetsLoading={assetsLoading} whiteboard={whiteboard} />}
      </div>
    </FullscreenOverlay>,
    document.body,
  );
}

/** The board as a transcript card: named, drawn, with a way to open it bigger. */
export function BoardEmbed({
  path, onOpenBoard,
}: {
  path: string;
  /** Open this board fullscreen — the "bigger" affordance. */
  onOpenBoard: (path: string) => void;
}) {
  const { content, assets, assetsLoading, failed, failure, whiteboard } = useBoardScene(path);

  if (failed) {
    return (
      <div className="chat-board chat-board--failed">
        <span className="chat-board-name"><span aria-hidden>▦</span> {boardName(path)}</span>
        <span className="chat-board-note" title={failure?.detail}>{failure?.note ?? "couldn't be read"}</span>
        <button type="button" className="chat-board-open" onClick={() => onOpenBoard(path)}>
          Open <span aria-hidden>↗</span>
        </button>
      </div>
    );
  }

  return (
    <div className="chat-board">
      <div className="chat-board-head">
        <span className="chat-board-name"><span aria-hidden>▦</span> {boardName(path)}</span>
        <button
          type="button"
          className="chat-board-open"
          onClick={() => onOpenBoard(path)}
          aria-label={`Open ${boardName(path)} full screen`}
        >
          Full screen <span aria-hidden>⛶</span>
        </button>
      </div>
      <div className="chat-board-canvas">
        {content === null
          ? <div className="chat-board-loading">Loading board…</div>
          : <ExcalidrawPreview content={content} boardKey={path} assets={assets} assetsLoading={assetsLoading} whiteboard={whiteboard} />}
      </div>
    </div>
  );
}
