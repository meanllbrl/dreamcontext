/**
 * Taking a `dream-html` block OUT of the conversation — as a file, or as an image on the
 * clipboard.
 *
 * WHY THIS EXISTS (owner feature request, 2026-08-29). The only way to get a block out was
 * a screenshot, so anything worth sharing got written a SECOND time as a hand-authored HTML
 * file: six of them onto one desktop in a single week, none searchable, none carrying the
 * conversation they came from. The request itself was the seventh.
 *
 * THE ONE IDEA THIS FILE IS BUILT ON: the block is already self-contained. It has to be —
 * the sandbox gives it no network, so every byte it draws with (the kit, the resolved
 * theme tokens, the brand override, the data) is already inside the document. A surface
 * that could fetch would need a bundler to export; this one only needs a wrapper. That is
 * also why the export can keep the CSP: a file you email to someone cannot phone home
 * either, and that property is free rather than engineered.
 *
 * WHAT IS EXPORTED IS WHAT IS ON SCREEN, not the markup the agent wrote. The frame hands
 * back its own live body over the bridge (`SNAPSHOT_REQUEST_KEY` — see chatHtmlKit.ts for
 * why that leaks nothing), so a number the block's script filled in, and the tab the reader
 * left open, are both in the file.
 *
 * The pure half of this module (document assembly, filenames) takes no DOM and is unit
 * tested with a `.js` specifier by root vitest, exactly like `chatHtmlKit.ts`. The
 * rasterising half is browser-only and proven in `scripts/verify/chat-html.mjs`.
 */
import { SANDBOX_CSP, SANDBOX_FONT_CSS } from '../../../lib/sandboxHtml';
import { CHAT_HTML_KIT_CSS } from './chatHtmlKit';

/**
 * The width a block is exported AT, regardless of how narrow the pane it was read in was.
 *
 * An artifact is not a pane: 900px is the measure the kit's grids and tables were designed
 * for, and re-flowing to it is why an export off a 380px slide-over does not come out as a
 * column of stacked tiles. The container queries do the rest.
 */
export const EXPORT_WIDTH = 900;

/** Chrome around the block in an exported file — a title, where it came from, when. */
export interface ExportMeta {
  /** The block's name. Falls back to the first heading, then to a generic. */
  title: string;
  /** The conversation this was drawn in — the provenance the request asks for by name. */
  source?: string;
  /** ISO date. Defaults to today at build time. */
  date?: string;
}

/**
 * The frame around the block in an exported document.
 *
 * Deliberately thin, and deliberately NOT the Lab Reports masthead: a single exported block
 * is one picture, and a full report letterhead around one picture reads as a document with
 * something missing. The masthead belongs to the composed report (E3), where there is a
 * document to head. What this does carry is the line the request is actually about — the
 * name, and which conversation it came out of.
 */
export const EXPORT_CHROME_CSS = `
.dcx-sheet { max-width: ${EXPORT_WIDTH}px; margin: 0 auto; padding: 28px 24px 20px; }
.dcx-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  margin-bottom: 4px; }
.dcx-title { font-family: var(--font-family-display); font-size: 1.286rem; font-weight: 700;
  letter-spacing: -0.02em; color: var(--color-text); margin: 0; }
.dcx-meta { font-size: 0.786rem; color: var(--color-text-tertiary); }
.dcx-rule { border: none; border-top: 1px solid var(--color-border); margin: 12px 0 18px; }
.dcx-foot { margin-top: 22px; padding-top: 10px; border-top: 1px solid var(--color-border);
  font-size: 0.786rem; color: var(--color-text-tertiary); display: flex; gap: 8px;
  align-items: center; }
.dcx-mark { width: 9px; height: 9px; border-radius: 3px; background: var(--color-accent);
  display: inline-block; }

/* Print: white paper, no theme surface, and nothing allowed to break mid-card. */
@media print {
  html, body { background: #fff; }
  .dcx-sheet { max-width: none; padding: 0; }
  .dc-card, .dc-stat, .dc-callout, .dc-option, .dc-table, .dc-slide { break-inside: avoid; }
  .dc-h1, .dc-h2, .dc-h3 { break-after: avoid; }
}
`;

/** `esc` for the few strings this module interpolates. The BLOCK is not escaped — it is
 *  markup by definition, and the sandbox (not a filter) is what makes it safe. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface StandaloneInput {
  /** The block's LIVE body markup (from the snapshot), not the authored string. */
  html: string;
  /** Resolved design-token values — same set the on-screen frame was built with. */
  tokens: Record<string, string>;
  meta: ExportMeta;
  scheme?: 'light' | 'dark';
  overrideCss?: string;
  lang?: string;
}

/**
 * One file, openable anywhere, that renders exactly what the block rendered.
 *
 * Order matches the live srcdoc (`lib/sandboxHtml.ts`) for a reason: tokens, then the kit,
 * then the export chrome, then the vault's brand override LAST so "later wins" still holds
 * and a branded block exports branded. The CSP rides along — see the file header.
 */
export function buildStandaloneHtml(input: StandaloneInput): string {
  const { html, tokens, meta, scheme = 'light', overrideCss, lang } = input;
  const rootVars = Object.entries(tokens).map(([t, v]) => `${t}: ${v};`).join(' ');
  const date = meta.date ?? new Date().toISOString().slice(0, 10);
  const langAttr = lang ? ` lang="${lang.replace(/[^a-zA-Z0-9-]/g, '')}"` : '';
  return [
    `<!doctype html><html${langAttr} data-dc-mode="card"><head>`,
    `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${esc(meta.title)}</title>`,
    `<style>${SANDBOX_FONT_CSS}</style>`,
    `<style>:root { color-scheme: ${scheme}; ${rootVars} }</style>`,
    // The export is a page, not a pane: it sets its own reading size rather than inheriting
    // the transcript's, which does not exist here. 15px is that same reading size.
    '<style>html { font-size: 15px; } body { margin: 0; background: var(--color-bg); }</style>',
    `<style>${CHAT_HTML_KIT_CSS}</style>`,
    `<style>${EXPORT_CHROME_CSS}</style>`,
    overrideCss ? `<style>${overrideCss}</style>` : '',
    '</head><body><div class="dcx-sheet">',
    '<div class="dcx-head">',
    `<h1 class="dcx-title">${esc(meta.title)}</h1>`,
    `<span class="dcx-meta">${esc(date)}${meta.source ? ` · ${esc(meta.source)}` : ''}</span>`,
    '</div><hr class="dcx-rule">',
    html,
    '<footer class="dcx-foot"><span class="dcx-mark"></span>Drawn in dreamcontext</footer>',
    '</div></body></html>',
  ].filter(Boolean).join('\n');
}

/**
 * A filesystem-safe stem for the download.
 *
 * Transliterates rather than strips: a Turkish title is the common case here, and
 * `pay-el-degistiriyor.png` is a findable filename where `pay-el-.png` is not.
 */
const TR_MAP: Record<string, string> = {
  ç: 'c', Ç: 'c', ğ: 'g', Ğ: 'g', ı: 'i', İ: 'i', ö: 'o', Ö: 'o',
  ş: 's', Ş: 's', ü: 'u', Ü: 'u',
};

export function exportFilename(title: string, ext: string): string {
  const stem = [...(title || 'block')]
    .map((ch) => TR_MAP[ch] ?? ch)
    .join('')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${stem || 'block'}.${ext}`;
}

/**
 * The block's own name, when nobody gave it one: its first heading.
 *
 * Reuses no parser — a heading in this kit is a `dc-h1|h2|h3`, and the outline the
 * streaming placeholder already builds uses the same idea (`htmlOutline`).
 */
export function titleFromHtml(html: string, fallback = 'Rendered answer'): string {
  // To the MATCHING close tag, not to the next `<`: a heading with a chip or a `dc-mark`
  // inside it is ordinary, and stopping at the first tag would title the block "Two ways"
  // when it says "Two ways to ship this".
  const m = html.match(
    /<([a-z][a-z0-9]*)\b[^>]*class\s*=\s*["'][^"']*\bdc-h[123]\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i,
  );
  const text = m ? m[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
  return text || fallback;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Browser-only from here down.
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The document, as well-formed XML.
 *
 * `<foreignObject>` content is parsed as XML, and agent-authored HTML is not XML: one
 * `<br>` or one unquoted attribute and the whole image fails to decode with no error worth
 * reading. Round-tripping through the HTML parser and back out through the XML serialiser
 * is what makes an ordinary author's markup rasterisable at all.
 */
export function toXhtml(doc: string): string {
  const parsed = new DOMParser().parseFromString(doc, 'text/html');
  parsed.documentElement.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  return new XMLSerializer().serializeToString(parsed.documentElement);
}

/** Raster scale — 2x so the PNG is legible when someone drops it into a deck. */
export const PNG_SCALE = 2;

/**
 * How tall the exported document is AT the export width.
 *
 * The height the frame reported is the height in the PANE, and the export re-flows to
 * `EXPORT_WIDTH` — a block read in a 380px slide-over is a different shape at 900px, so
 * reusing the on-screen height would crop it or pad it. Cheaper and more honest to lay it
 * out once and read the answer.
 *
 * The grant here is the print frame's, for the print frame's reason: `allow-same-origin`
 * so the host can read `scrollHeight` out of it, and NO `allow-scripts`, which is what
 * makes same-origin inert. See `printStandalone`.
 */
export async function measureStandalone(
  doc: string, width = EXPORT_WIDTH,
): Promise<{ width: number; height: number }> {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText =
    `position:fixed;left:-10000px;top:0;width:${width}px;height:10px;border:0;visibility:hidden;`;
  frame.srcdoc = doc;
  document.body.appendChild(frame);
  try {
    await new Promise<void>((resolve) => {
      frame.onload = () => resolve();
      setTimeout(resolve, 4000);
    });
    const body = frame.contentDocument?.body;
    const height = body ? Math.ceil(body.getBoundingClientRect().height) : 0;
    return { width, height: Math.max(height, 40) };
  } finally {
    frame.remove();
  }
}

/**
 * The standalone document, rasterised, with no network and no third-party library.
 *
 * `<foreignObject>` inside an SVG data URL is the whole trick, and it works here for the
 * same reason the export needs no bundler: everything is already inline. An SVG loaded as
 * an IMAGE also cannot run script or fetch, which is why the canvas stays untainted and
 * `toBlob` is allowed to return pixels at all.
 *
 * The honest limits, both consequences of that same rule: a webfont the document did not
 * embed is not loaded (the block on screen is already in the fallback face, so the PNG
 * matches it), and script does not run — which is exactly why the caller passes the
 * frame's LIVE body rather than the authored markup.
 */
export async function rasterize(
  doc: string, width: number, height: number, scale = PNG_SCALE,
): Promise<Blob> {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `,
    `viewBox="0 0 ${width} ${height}">`,
    `<foreignObject width="100%" height="100%">${toXhtml(doc)}</foreignObject></svg>`,
  ].join('');
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  const img = new Image();
  img.decoding = 'sync';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    // No error detail is available for a failed SVG decode, so say what actually causes it.
    img.onerror = () => reject(new Error('The block could not be drawn as an image.'));
    img.src = url;
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable.');
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Rasterising failed.'))), 'image/png');
  });
}

/* Putting the file on disk lives in `lib/exportDownload.ts`, not here: in the desktop app
   a `<a download>` reports nothing back — no path, no completion, no error — so the write
   goes through the server and the surface can say where it landed. This module's job ends
   at producing the bytes. */

/**
 * The image onto the clipboard, for pasting into Slack.
 *
 * `ClipboardItem` is the only API that carries a bitmap, and it has no `execCommand`
 * fallback — unlike text (see `lib/clipboard.ts`), where WKWebView's mangling forced a
 * three-strategy ladder. So this reports failure honestly instead of pretending.
 */
export async function copyBlobAsImage(blob: Blob): Promise<boolean> {
  try {
    const Ctor = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
    if (!Ctor || !navigator.clipboard?.write) return false;
    await navigator.clipboard.write([new Ctor({ [blob.type]: blob })]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Print the block ALONE — not the app around it.
 *
 * A hidden iframe, printed directly. `window.print()` on the page (what the Lab report
 * does, correctly, because there the page IS the document) would here print the whole
 * chat: the nav, the composer, every other message.
 *
 * READ THE GRANT CAREFULLY — it is the one place in this codebase that says
 * `allow-same-origin`, and it is safe for the single reason that makes the doctrine a
 * doctrine: `allow-same-origin` is catastrophic WITH `allow-scripts`, because together the
 * frame can reach into the parent and strip its own sandbox attribute. Alone it grants
 * nothing, because there is no code in the frame to use it — and there is no code because
 * `allow-scripts` is deliberately absent. Same-origin is required at all only so the parent
 * may call `print()` on the frame; an opaque-origin frame cannot be printed by its host.
 *
 * Nothing is lost by dropping scripts: the document being printed is already the
 * post-script SNAPSHOT the frame handed back, so a script here would only run twice.
 * `tests/unit/chat-html.test.ts` pins both halves of this grant.
 */
export async function printStandalone(doc: string): Promise<void> {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:900px;height:1200px;border:0;';
  frame.srcdoc = doc;
  document.body.appendChild(frame);
  try {
    await new Promise<void>((resolve) => {
      frame.onload = () => resolve();
      setTimeout(resolve, 4000);
    });
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    // The print dialog is modal but not awaitable; give the platform a beat to take the
    // document before it is torn out from under the dialog.
    await new Promise((r) => setTimeout(r, 1500));
  } finally {
    frame.remove();
  }
}
