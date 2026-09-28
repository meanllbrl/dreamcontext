import { useEffect, useState } from 'react';
import { agentFileUrl } from '../../../api/client';
import { useVault } from '../../../context/VaultContext';

/**
 * Project pictures inside an AskUserQuestion `preview`.
 *
 * A preview is drawn in the same network-less sandbox as `dream-html` (`lib/sandboxHtml.ts`):
 * `img-src data:` and nothing else. So `<img src="docs/shot.png">` — the natural way for the
 * agent to say "which of these two screens?" — would render as a broken image. The bytes
 * have to ride IN the document, which is exactly what `data:` is for: this swaps every
 * project-relative `src` for a data URL fetched through `GET /api/agent/file`, the one route
 * that already serves project files to the transcript (and applies its own containment).
 *
 * Remote and already-inline sources are left alone: `https:` stays blocked by the CSP (no
 * network, by design), `data:` already works.
 */

/** Cap per picture — a preview is a thumbnail-sized comparison, not a gallery. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Cap per preview, so a pathological fragment cannot fan out into dozens of fetches. */
const MAX_IMAGES = 8;

const IMG_SRC = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi;

export function isLocalImageRef(src: string): boolean {
  const s = src.trim();
  return !!s && !/^(https?:|data:|blob:|mailto:|#|\/\/)/i.test(s) && !s.startsWith('/api/');
}

/** Distinct project-relative image paths a fragment references, in order, capped. */
export function localImageRefs(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(IMG_SRC)) {
    const src = m[3].trim();
    if (isLocalImageRef(src) && !out.includes(src)) out.push(src);
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}

/**
 * A preview that is NOTHING BUT one project picture or clip — `<video src="tmp/a.mp4"></video>`,
 * `<img src="docs/b.png">`. Returned so the card can draw it natively instead of in the
 * sandbox: a clip cannot play there at all (no `media-src`, and a data-URL video would be the
 * whole file inlined into the document), and a lone picture looks better at the tile's own
 * aspect than inside a padded frame. The designer's "this one or that one?" between two
 * videos is exactly this shape.
 */
export function loneMedia(html: string | undefined): { kind: 'image' | 'video'; src: string } | null {
  if (!html) return null;
  const m = /^\s*<(img|video)\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\2[^>]*>\s*(?:<\/video>)?\s*$/i.exec(html);
  if (!m || !isLocalImageRef(m[3])) return null;
  return { kind: m[1].toLowerCase() === 'video' ? 'video' : 'image', src: m[3].trim() };
}

/** Replace every loaded path's `src` with its data URL; a path that failed stays as it was
 *  (a broken image says "this file is missing" more honestly than a silently dropped one). */
export function substituteImages(html: string, loaded: Record<string, string>): string {
  return html.replace(IMG_SRC, (whole, head: string, quote: string, src: string) => {
    const url = loaded[src.trim()];
    return url ? `${head}${quote}${url}${quote}` : whole;
  });
}

async function loadAsDataUrl(vault: string | null, path: string): Promise<string | null> {
  try {
    const res = await fetch(agentFileUrl(vault, path, { raw: true }));
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/') || blob.size > MAX_IMAGE_BYTES) return null;
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * The preview with its project pictures inlined. Returns the ORIGINAL markup until the
 * pictures land (so the text of the preview never waits on its images), then the inlined
 * one. A preview with no local pictures never changes.
 */
export function usePreviewHtml(html: string | undefined): string | undefined {
  const { vault } = useVault();
  // A lone clip or picture is drawn natively (see `loneMedia`) — never fetch it as a data URL.
  if (loneMedia(html)) html = undefined;
  const [inlined, setInlined] = useState<{ source: string; html: string } | null>(null);

  useEffect(() => {
    if (!html) return;
    const refs = localImageRefs(html);
    if (!refs.length) return;
    let alive = true;
    void Promise.all(refs.map(async (ref) => [ref, await loadAsDataUrl(vault, ref)] as const)).then((pairs) => {
      if (!alive) return;
      const loaded: Record<string, string> = {};
      for (const [ref, url] of pairs) if (url) loaded[ref] = url;
      setInlined({ source: html, html: substituteImages(html, loaded) });
    });
    return () => { alive = false; };
  }, [html, vault]);

  if (!html) return undefined;
  return inlined?.source === html ? inlined.html : html;
}
