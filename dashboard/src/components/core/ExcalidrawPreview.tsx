import { Suspense, useMemo } from 'react';
import { useTheme } from '../../context/ThemeContext';
import { extractExcalidrawScene } from '../../lib/excalidraw';
import { useKnowledgeAssets } from '../../hooks/useKnowledge';
import { lazyWithReload } from '../../lib/lazyWithReload';
import './ExcalidrawPreview.css';

// The real Excalidraw editor (canvas) + its CSS are heavy — load them only when a
// board is actually opened. `lazyWithReload` self-heals a stale-chunk 404 after a
// republish by forcing a one-time reload instead of showing the error page.
const ExcalidrawCanvas = lazyWithReload('ExcalidrawCanvas', () => import('./ExcalidrawCanvas'));

interface Props {
  content: string;
  /** Knowledge slug — enables resolving the board's externally-referenced images. */
  slug?: string;
  /** Embedded images the CALLER resolved, for a board that isn't a knowledge file (the
   *  Chat transcript draws boards from anywhere in the project via `/agent/board-assets`).
   *  Supplying either this or {@link assetsLoading} takes ownership of the asset fetch and
   *  skips the knowledge-slug query entirely. */
  assets?: Record<string, { mimeType: string; dataURL: string }>;
  /** Caller's asset fetch is still in flight — gates the mount the same way the internal
   *  query's `isLoading` does (the canvas freezes `initialData` at mount, so the files map
   *  has to be final before it goes up; see this file's history). */
  assetsLoading?: boolean;
}

const Spinner = () => (
  <div className="excalidraw-loading" aria-live="polite">
    <span className="excalidraw-spinner" aria-hidden="true" />
    <span className="excalidraw-loading-label">Loading diagram…</span>
  </div>
);

/**
 * Renders an Obsidian Excalidraw board read-only via the canvas editor (see
 * ExcalidrawCanvas) — crisp at any zoom, with native wheel-pan / pinch-zoom.
 *
 * This component owns the data: it parses the scene and resolves the board's
 * externally-referenced screenshots (Obsidian stores them as wikilinks, not
 * base64) at full quality, fetched once and kept, then hands a stable
 * {elements, files} to the canvas. The canvas mounts once per board (keyed by
 * slug) so panning/zooming never re-renders or reloads it.
 */
export function ExcalidrawPreview({ content, slug, assets, assetsLoading }: Props) {
  const { resolved } = useTheme();

  const scene = useMemo(() => extractExcalidrawScene(content), [content]);

  const hasEmbedded = useMemo(() => content.includes('## Embedded Files'), [content]);
  // A caller that supplies its own assets owns the fetch — don't also run the knowledge
  // query (there is no knowledge slug behind a chat-referenced board to run it against).
  const callerOwnsAssets = assets !== undefined || assetsLoading !== undefined;
  const assetsQuery = useKnowledgeAssets(slug ?? '', !callerOwnsAssets && !!slug && hasEmbedded);
  const assetFiles = callerOwnsAssets ? assets : assetsQuery.data;
  // Only block on the FIRST load. Once the query settles — success OR error — mount
  // the board: on error we render it without embedded images rather than wedging it
  // behind a permanent spinner (the scene itself parsed fine).
  const waitingForAssets = callerOwnsAssets
    ? !!assetsLoading
    : (!!slug && hasEmbedded && assetsQuery.isLoading);

  // Merge the resolved (full-quality) embedded images into the scene files map.
  const files = useMemo(() => {
    const f: Record<string, unknown> = { ...(scene?.files ?? {}) };
    if (assetFiles) {
      for (const [id, a] of Object.entries(assetFiles)) {
        f[id] = { id, mimeType: a.mimeType, dataURL: a.dataURL, created: 0 };
      }
    }
    return f;
  }, [scene, assetFiles]);

  if (!scene) {
    return <div className="excalidraw-error">Could not read the Excalidraw drawing in this file.</div>;
  }

  return (
    <div className="excalidraw-preview" data-theme={resolved}>
      {waitingForAssets ? (
        <Spinner />
      ) : (
        <Suspense fallback={<Spinner />}>
          <ExcalidrawCanvas
            key={slug ?? 'board'}
            elements={scene.elements}
            files={files}
            appState={scene.appState}
            theme={resolved === 'dark' ? 'dark' : 'light'}
          />
        </Suspense>
      )}
    </div>
  );
}
