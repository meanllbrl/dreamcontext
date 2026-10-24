/**
 * A project web page's OWN pictures and stylesheets, carried INTO its sandboxed srcdoc.
 *
 * A page opened from the project (a mockup `akis.html` next to `sonra/1-pano.png`) is drawn in
 * the chat's network-less sandbox (lib/sandboxHtml.ts: CSP `default-src 'none'; img-src data:`),
 * so every `<img src="sonra/1-pano.png">` and `<link rel="stylesheet" href="x.css">` in it was
 * blocked and the page read as empty boxes with alt text.
 *
 * The fix does NOT touch the CSP. The HOST reads each file the page names, through the same
 * project-scoped file routes (and their consent rules) that already serve a picture to the
 * reader, and writes it into the document: a picture as a `data:` URL, a stylesheet as an
 * inline `<style>`. The frame still issues zero requests; the document is quoting itself, the
 * exact allowance `img-src data:` was made for.
 *
 * WHAT IS CARRIED, AND WHY THAT IS ALL. The page's scripts run, and a sandboxed frame can
 * always navigate itself (knowledge: sandboxed-app-bridge-pattern §3), so whatever is inlined is
 * readable by the page and can leave in a navigation before the teardown notices. The bound is
 * authorship: only a file in the page's OWN folder or below it is carried, i.e. the material the
 * page's author put beside it (`v6/akis.html` → `v6/sonra/1-pano.png`). A reference that climbs
 * out of that folder (`../`), names a hidden segment (`.git/`, `.cache/`), is rooted (`/`, `~`)
 * or has a scheme (`https:`, `data:`) is left exactly as written, so the CSP keeps blocking it.
 * The page cannot reach the rest of the project, its brain or a credential through this.
 *
 * Only real markup is rewritten: text inside `<script>`, `<style>`, `<template>`, `<textarea>`
 * and comments is left byte for byte (a gallery built from `"<img src='a.png'>"` in a JS string
 * keeps parsing), and an attribute keeps the quote character it was written with.
 *
 * Pure string work, no DOM, no React: importable by root vitest (tests/unit/html-local-assets.test.ts).
 */
import { parentDir, resolveDocumentRef } from '../components/appLink/viewerPaths.js';

/** Picture types a page may show. SVG is drawn through `<img>`, where its scripts never run. */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']);

/** One picture larger than this stays unloaded: the srcdoc is a string held in memory. */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
/** All of one page's pictures and stylesheets together. */
export const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
/** How many distinct files one page may pull in. */
export const MAX_ASSETS = 120;

export interface LocalAssets {
  /** Project-relative paths of the pictures the page names, deduped, in document order. */
  images: string[];
  /** Project-relative paths of the stylesheets the page links, deduped, in document order. */
  styles: string[];
}

/** What the host managed to read: path → `data:` URL / path → CSS text. A missing key stays as written. */
export interface LoadedAssets {
  images: ReadonlyMap<string, string>;
  styles: ReadonlyMap<string, string>;
}

const IMG_TAG = /<img\b[^>]*>/gi;
const LINK_TAG = /<link\b[^>]*>/gi;

/** `name="…"`, `name='…'` or `name=bare`, preceded by whitespace (so `data-src` never matches `src`). */
function attrPattern(name: string): RegExp {
  return new RegExp(`(\\s${name}\\s*=\\s*)(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'i');
}
const SRC_ATTR = attrPattern('src');
const HREF_ATTR = attrPattern('href');
const REL_ATTR = attrPattern('rel');

function attrValue(tag: string, pattern: RegExp): string | null {
  const m = pattern.exec(tag);
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
}

/** The few entities a hand-written path can carry. */
function decodeEntities(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function extOf(path: string): string {
  const cut = path.lastIndexOf('.');
  return cut === -1 ? '' : path.slice(cut + 1).toLowerCase();
}

function isStylesheetLink(tag: string): boolean {
  const rel = attrValue(tag, REL_ATTR);
  return rel !== null && rel.toLowerCase().split(/\s+/).includes('stylesheet');
}

/** Whole regions the rewrite never touches: code, raw text and comments. */
const OPAQUE = /<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<template\b[\s\S]*?<\/template\s*>|<textarea\b[\s\S]*?<\/textarea\s*>|<!--[\s\S]*?-->/gi;

/** Apply `fn` to the markup only, leaving every {@link OPAQUE} region exactly as written. */
function mapMarkup(html: string, fn: (markup: string) => string): string {
  let out = '';
  let at = 0;
  for (const m of html.matchAll(OPAQUE)) {
    out += fn(html.slice(at, m.index)) + m[0];
    at = m.index! + m[0].length;
  }
  return out + fn(html.slice(at));
}

/** The markup alone (opaque regions dropped), for finding what the page names. */
function markupOnly(html: string): string {
  return html.replace(OPAQUE, ' ');
}

/**
 * The project-relative file a reference names, when it is inside the page's own folder (or
 * below it) and crosses no hidden segment; else null.
 */
function ownFile(docPath: string, ref: string): string | null {
  const resolved = resolveDocumentRef(docPath, ref.trim());
  if (!resolved) return null;
  const dir = parentDir(docPath);
  if (dir && !resolved.startsWith(`${dir}/`)) return null;
  if (resolved.split('/').some((part) => part.startsWith('.'))) return null;
  return resolved;
}

/** The picture a reference names, or null when it is not one of the page's own pictures. */
function localImage(docPath: string, ref: string): string | null {
  const path = ownFile(docPath, ref);
  return path && IMAGE_EXT.has(extOf(path)) ? path : null;
}

/** The stylesheet a reference names, or null when it is not one of the page's own `.css` files. */
function localStyle(docPath: string, ref: string): string | null {
  const path = ownFile(docPath, ref);
  return path && extOf(path) === 'css' ? path : null;
}

/**
 * Every project-local picture (`<img src>`) and stylesheet (`<link rel="stylesheet" href>`) the
 * page at `docPath` (project-relative) names. Capped at {@link MAX_ASSETS}, pictures first.
 * An absolute `docPath` (a file elsewhere on the computer, read under a one-file grant) names
 * nothing: its neighbours were never allowed.
 */
export function findLocalAssets(html: string, docPath: string): LocalAssets {
  if (!docPath || docPath.startsWith('/')) return { images: [], styles: [] };
  const images = new Set<string>();
  const styles = new Set<string>();
  const markup = markupOnly(html);
  for (const tag of markup.match(IMG_TAG) ?? []) {
    const src = attrValue(tag, SRC_ATTR);
    const path = src === null ? null : localImage(docPath, src);
    if (path && images.size < MAX_ASSETS) images.add(path);
  }
  for (const tag of markup.match(LINK_TAG) ?? []) {
    if (!isStylesheetLink(tag)) continue;
    const href = attrValue(tag, HREF_ATTR);
    const path = href === null ? null : localStyle(docPath, href);
    if (path && images.size + styles.size < MAX_ASSETS) styles.add(path);
  }
  return { images: [...images], styles: [...styles] };
}

/** CSS dropped into a `<style>` must not be able to close it early. */
function escapeStyleText(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style');
}

/**
 * The page with every LOADED reference written in: an `<img>`'s `src` becomes its `data:` URL,
 * a stylesheet `<link>` becomes an inline `<style>` in the same place (so the cascade order the
 * author wrote is kept). A reference the host could not read is left exactly as written.
 */
export function inlineLocalAssets(html: string, docPath: string, loaded: LoadedAssets): string {
  if (!docPath || docPath.startsWith('/')) return html;
  return mapMarkup(html, (markup) => markup.replace(IMG_TAG, (tag) => {
    const src = attrValue(tag, SRC_ATTR);
    const path = src === null ? null : localImage(docPath, src);
    const data = path ? loaded.images.get(path) : undefined;
    if (!data) return tag;
    // The value keeps the quote it was written with; a data: URL here never contains one.
    const value = data.replace(/"/g, '%22').replace(/'/g, '%27');
    return tag
      .replace(SRC_ATTR, (_m, lead: string, _d, single: string | undefined) => (single !== undefined ? `${lead}'${value}'` : `${lead}"${value}"`))
      // A `srcset` would win over the inlined `src` and fetch a blocked candidate instead.
      .replace(/\ssrcset\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '');
  }).replace(LINK_TAG, (tag) => {
    if (!isStylesheetLink(tag)) return tag;
    const href = attrValue(tag, HREF_ATTR);
    const path = href === null ? null : localStyle(docPath, href);
    const css = path ? loaded.styles.get(path) : undefined;
    return css === undefined ? tag : `<style data-dc-src="${path!.replace(/"/g, '&quot;')}">${escapeStyleText(css)}</style>`;
  }));
}

/**
 * A head script that keeps a link click from navigating the frame. A page that wraps each
 * picture in `<a href="1-pano.png">` would otherwise replace itself with that file, which the
 * reader's load-count teardown (rightly) reads as the page running away and cuts. An in-page
 * `#anchor` still scrolls; every other link does nothing. Capture phase, so it runs before the
 * author's own handlers; a script that navigates anyway is still caught by the teardown.
 */
export const LINK_GUARD = `(function () {
  document.addEventListener('click', function (event) {
    var t = event.target;
    var a = t && t.closest ? t.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (href.charAt(0) === '#') return;
    event.preventDefault();
  }, true);
})();`;
