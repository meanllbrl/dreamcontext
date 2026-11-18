/**
 * A question option's `preview` that names project pictures, made drawable for Telegram (owner
 * 2026-11-18: every option picture of a kitUP card reached his phone as a white box with a
 * broken-image icon).
 *
 * The preview is drawn in the network-less sandbox (`SANDBOX_CSP`: `img-src data:` only), so
 * `<img src="docs/a.png">` loads nothing there. The Mac card never draws it that way: a preview
 * that is nothing but one project picture or clip is drawn natively, and any other preview gets
 * its project pictures inlined as `data:` URLs first (dashboard `previewImages.ts`, `loneMedia`
 * and `usePreviewHtml`). The Telegram path skipped both and screenshotted the raw markup.
 *
 * This is the server's twin of those two rules:
 *   - a lone picture or clip → the FILE itself, sent as the option's picture or video;
 *   - any other preview → every `<img src>` that names a file read through H
 *     (`readProjectFile`: inside the project or a media root, no symlink, no secret class),
 *     capped per file and per preview, written in as a `data:` URL.
 * A picture that cannot be read (missing, refused, remote, too large) means the drawing is not
 * sent at all: the question then says the drawing is on the Mac, never a blank box.
 */
import { MAX_ASSET_BYTES, MAX_TOTAL_BYTES } from '../../lib/telegram/html-local-assets.js';
import { readProjectFile, type CardContext } from './cards.js';
import type { MediaItem } from './pictures.js';

type Ctx = Pick<CardContext, 'contextRoot' | 'isGitIgnored' | 'mediaRoots'>;

/** What one preview becomes: a file to send as is, markup to draw, or nothing that may go. */
export type PreviewSource =
  | { kind: 'file'; item: MediaItem }
  | { kind: 'html'; html: string }
  | { kind: 'unreadable'; refs: string[] };

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
};
/** Telegram shows these as a photo; any other picture type goes as a document. */
const PHOTO_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'webm']);

/** `<img … src="…">`, the attribute's quote kept (the dashboard's IMG_SRC, plus unquoted). */
const IMG_SRC = /(<img\b[^>]*?\ssrc\s*=\s*)(?:(["'])(.*?)\2|([^\s"'=<>`]+))/gi;
/** Regions whose `<img` is text, not markup. */
const OPAQUE = /<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<template\b[\s\S]*?<\/template\s*>|<textarea\b[\s\S]*?<\/textarea\s*>|<!--[\s\S]*?-->/gi;

/** A path the reader resolves to a file (the dashboard's `isLocalImageRef`). */
export function isLocalRef(src: string): boolean {
  const s = src.trim();
  return !!s && !/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(s) && !s.startsWith('/api/');
}

/** A preview that is NOTHING but one project picture or clip (the dashboard's `loneMedia`). */
export function loneMedia(html: string): { kind: 'image' | 'video'; src: string } | null {
  const m = /^\s*<(img|video)\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\2[^>]*>\s*(?:<\/video>)?\s*$/i.exec(html);
  if (!m || !isLocalRef(m[3])) return null;
  return { kind: m[1].toLowerCase() === 'video' ? 'video' : 'image', src: m[3].trim() };
}

function extOf(path: string): string {
  const clean = path.split(/[?#]/)[0];
  const cut = clean.lastIndexOf('.');
  return cut === -1 ? '' : clean.slice(cut + 1).toLowerCase();
}

function decodeRef(src: string): string {
  const clean = src.trim().replace(/&amp;/g, '&').split(/[?#]/)[0];
  try { return decodeURIComponent(clean); } catch { return clean; }
}

/** Apply `fn` to markup only, every opaque region left byte for byte. */
function mapMarkup(html: string, fn: (markup: string) => string): string {
  let out = '';
  let at = 0;
  for (const m of html.matchAll(OPAQUE)) {
    out += fn(html.slice(at, m.index)) + m[0];
    at = m.index! + m[0].length;
  }
  return out + fn(html.slice(at));
}

/** One option's preview, ready for Telegram (see the module doc). */
/** `ctx` null (no project known): no file can be read, so a preview naming one is unreadable. */
export function previewSource(ctx: Ctx | null, preview: string, title: string): PreviewSource {
  const lone = loneMedia(preview);
  if (lone) {
    const ext = extOf(lone.src);
    const ok = lone.kind === 'video' ? VIDEO_EXT.has(ext) : !!IMAGE_MIME[ext];
    const f = ok && ctx ? readProjectFile(ctx, decodeRef(lone.src)) : null;
    if (!f?.ok) return { kind: 'unreadable', refs: [lone.src] };
    const kind = lone.kind === 'video' ? 'video' : PHOTO_EXT.has(ext) ? 'photo' : 'document';
    return { kind: 'file', item: { kind, file: f.file, title } };
  }
  const loaded = new Map<string, string | null>();
  let budget = MAX_TOTAL_BYTES;
  const load = (src: string): string | null => {
    if (loaded.has(src)) return loaded.get(src)!;
    let url: string | null = null;
    const ext = extOf(src);
    if (ctx && isLocalRef(src) && IMAGE_MIME[ext] && budget > 0) {
      // The page carries base64 (4/3 of the bytes): the cap is on what the page will hold.
      const f = readProjectFile(ctx, decodeRef(src), Math.min(MAX_ASSET_BYTES, Math.floor((budget * 3) / 4)));
      if (f.ok) {
        const data = f.file.data;
        // An SVG goes as text, the way the card's file route hands it over; <img> never runs its scripts.
        url = ext === 'svg'
          ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.toString('utf8'))}`
          : `data:${IMAGE_MIME[ext]};base64,${data.toString('base64')}`;
        budget -= url.length;
      }
    }
    loaded.set(src, url);
    return url;
  };
  const missing: string[] = [];
  const html = mapMarkup(preview, (markup) => markup.replace(IMG_SRC, (whole, head: string, quote: string | undefined, quoted: string | undefined, bare: string | undefined) => {
    const src = (quoted ?? bare ?? '').trim();
    // Inline already, or an empty placeholder (it loads nothing on the Mac either).
    if (!src || /^data:/i.test(src)) return whole;
    const url = load(src);
    if (!url) { if (!missing.includes(src)) missing.push(src); return whole; }
    const q = quote ?? '"';
    return `${head}${q}${url}${q}`;
  }));
  return missing.length ? { kind: 'unreadable', refs: missing } : { kind: 'html', html };
}
