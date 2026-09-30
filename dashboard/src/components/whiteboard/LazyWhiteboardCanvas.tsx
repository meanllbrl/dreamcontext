import { lazyWithReload } from '../../lib/lazyWithReload';

/**
 * Where Excalidraw fetches its fonts from: our own server, not esm.sh (D9).
 *
 * The desktop app must draw text offline, and Excalidraw's default is a CDN. `vite.config.ts`
 * copies `@excalidraw/excalidraw/dist/prod/fonts` into the build at `excalidraw-assets/fonts`;
 * in dev the package's own copy is served straight out of `node_modules`.
 *
 * Excalidraw reads `window.EXCALIDRAW_ASSET_PATH` ONCE, when the first editor on the page
 * registers its fonts, and caches the result for every editor after it. So this is set at this
 * module's load, before the lazy import below, rather than when a board opens. Excalidraw still
 * appends its CDN as the last fallback source.
 */
export const EXCALIDRAW_ASSET_PATH = import.meta.env.DEV
  ? '/node_modules/@excalidraw/excalidraw/dist/prod/'
  : `${import.meta.env.BASE_URL}excalidraw-assets/`;

export function ensureExcalidrawAssetPath(): void {
  const w = window as Window & { EXCALIDRAW_ASSET_PATH?: string | string[] };
  if (w.EXCALIDRAW_ASSET_PATH === undefined) w.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH;
}

ensureExcalidrawAssetPath();

/** The editable whiteboard, loaded on first use (the Excalidraw bundle is heavy). */
export const LazyWhiteboardCanvas = lazyWithReload('WhiteboardCanvas', () => {
  ensureExcalidrawAssetPath();
  return import('./WhiteboardCanvas');
});

export type { WhiteboardCanvasApi, WhiteboardCanvasProps, WhiteboardScene } from './WhiteboardCanvas';
