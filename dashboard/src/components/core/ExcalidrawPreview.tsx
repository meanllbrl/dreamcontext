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
export function ExcalidrawPreview({ content, slug }: Props) {
  const { resolved } = useTheme();

  const scene = useMemo(() => extractExcalidrawScene(content), [content]);

  const hasEmbedded = useMemo(() => content.includes('## Embedded Files'), [content]);
  const assetsQuery = useKnowledgeAssets(slug ?? '', !!slug && hasEmbedded);
  const assetFiles = assetsQuery.data;
  // Only block on the FIRST load. Once the query settles — success OR error — mount
  // the board: on error we render it without embedded images rather than wedging it
  // behind a permanent spinner (the scene itself parsed fine).
  const waitingForAssets = !!slug && hasEmbedded && assetsQuery.isLoading;

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
