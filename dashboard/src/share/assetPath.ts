/**
 * Excalidraw's fonts from this share's own origin only (the build copies them under
 * excalidraw-assets/), never a CDN: the viewer's CSP allows only 'self'.
 *
 * Excalidraw builds every font face as `url(<asset path>) , url(<its CDN>)`. Chromium checks
 * each source against the CSP when the face is registered and logs one violation per refused
 * CDN source (230 lines on every guest's console, though nothing leaves the page and the font
 * comes from the share). So, before Excalidraw loads (main.tsx imports the viewer after this):
 *  - the asset path points at the share's own copy;
 *  - FontFace keeps only the same-origin sources of a source list (never an empty list: a list
 *    with no same-origin source is passed through unchanged).
 */
export function sameOriginFontSources(src: string, origin: string): string {
  const parts = src.split(/,\s*(?=url\()/);
  const kept = parts.filter((p) => {
    const m = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(p);
    if (!m) return true;
    try { return new URL(m[1], origin).origin === origin; } catch { return false; }
  });
  return kept.length > 0 ? kept.join(', ') : src;
}

export function setExcalidrawAssetPath(): void {
  const w = window as Window & { EXCALIDRAW_ASSET_PATH?: string };
  w.EXCALIDRAW_ASSET_PATH = import.meta.env.DEV ? '/node_modules/@excalidraw/excalidraw/dist/prod/' : '/excalidraw-assets/';
  const Native = window.FontFace;
  if (typeof Native !== 'function') return;
  const origin = window.location.origin;
  class SameOriginFontFace extends Native {
    constructor(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) {
      super(family, typeof source === 'string' ? sameOriginFontSources(source, origin) : source, descriptors);
    }
  }
  window.FontFace = SameOriginFontFace;
}
