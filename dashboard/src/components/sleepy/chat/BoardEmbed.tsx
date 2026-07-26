import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../../api/client';
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
  const [scene, setScene] = useState<BoardScene>({
    content: null, assets: undefined, assetsLoading: false, failed: false,
  });

  useEffect(() => {
    let cancelled = false;
    setScene({ content: null, assets: undefined, assetsLoading: false, failed: false });

    api.get<{ content: string }>(`/agent/file?path=${encodeURIComponent(path)}`)
      .then((data) => {
        if (cancelled) return;
        const content = data?.content ?? '';
        if (!content.includes('## Embedded Files')) {
          setScene({ content, assets: {}, assetsLoading: false, failed: false });
          return;
        }
        setScene({ content, assets: undefined, assetsLoading: true, failed: false });
        api.get<{ files: AssetFiles }>(`/agent/board-assets?path=${encodeURIComponent(path)}`)
          .then((r) => { if (!cancelled) setScene((s) => ({ ...s, assets: r?.files ?? {}, assetsLoading: false })); })
          .catch(() => { if (!cancelled) setScene((s) => ({ ...s, assets: {}, assetsLoading: false })); });
      })
      .catch(() => { if (!cancelled) setScene({ content: null, assets: {}, assetsLoading: false, failed: true }); });

    return () => { cancelled = true; };
  }, [path]);

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
  const { content, assets, assetsLoading, failed } = useBoardScene(path);
  return createPortal(
    <FullscreenOverlay label={boardName(path)} onClose={onClose}>
      <div className="chat-board-full">
        {failed
          ? <p className="chat-slideover-status error">Couldn't read this board.</p>
          : content === null
            ? <div className="chat-board-loading">Loading board…</div>
            : <ExcalidrawPreview content={content} boardKey={`${path}#full`} assets={assets} assetsLoading={assetsLoading} />}
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
  const { content, assets, assetsLoading, failed } = useBoardScene(path);

  if (failed) {
    return (
      <div className="chat-board chat-board--failed">
        <span className="chat-board-name"><span aria-hidden>▦</span> {boardName(path)}</span>
        <span className="chat-board-note">couldn't be read</span>
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
          : <ExcalidrawPreview content={content} boardKey={path} assets={assets} assetsLoading={assetsLoading} />}
      </div>
    </div>
  );
}
