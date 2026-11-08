/**
 * The sealed page for an INSIGHT card picture (plan R6-R9, S1, S3, T4), from the parts the window
 * sent with `render_card`. The window's bytes are never trusted:
 *
 *  - Scanner (S3, T4), sequential and anchored over the raw string: comments are stripped until
 *    the string is stable and any remaining `<!` refuses; every `<` must begin a start tag
 *    (`name="value"` attributes only, as `outerHTML` writes them) or an end tag, else refuse.
 *  - Tag allowlist: the chart SVG set + layout HTML; every other tag refuses (no `img`, `canvas`,
 *    `picture`, `style`, `a`, `iframe` other than the exact placeholder).
 *  - Attributes: a name starting `on`, `srcdoc`, `src`, `srcset`, `poster`, `data`, `background`
 *    refuse everywhere; `href`/`xlink:href` only on SVG and only `#fragment`; a value holding
 *    `javascript:` (whitespace and controls removed) refuses; in `style`, `url(` only as `url(#id)`
 *    and no `\`.
 *  - Placeholders `<iframe data-dc-frame="N"></iframe>`: each id once, each a frame entry; the
 *    server writes the frame itself with `sandbox="${SANDBOX_GRANT}" allow="${SANDBOX_ALLOW}"`, an
 *    escaped srcdoc it REBUILT from its own lab cache for that slug (T4), and structured geometry.
 *  - The text of the body passes the redactor (a hit → text); each insight's stored html passes
 *    the authored-bytes redactor.
 *  - Root: theme from the known set, class tokens `^[A-Za-z0-9_-]+$`, zoom from ZOOM_LEVELS,
 *    scheme light|dark, tokens `^--[a-z0-9-]+$` with safe values.
 * Any refusal → null and the caller sends the card as text. No partial picture.
 */
import { SANDBOX_ALLOW, SANDBOX_CSP, SANDBOX_FONT_CSS, SANDBOX_GRANT } from './chat-kit.js';
import { buildLabSrcdocServer } from './lab-kit.js';
import { labTokens } from './kit-tokens.js';
import { wouldRedact } from './format.js';
import { authoredSecretHit } from './render.js';
import type { RenderCardFrame, RenderCardResult, RenderCardRoot } from './contract.js';

/** `WindowChrome.tsx` ZOOM_LEVELS (drift test in `tests/unit/telegram-render.test.ts`). */
export const ZOOM_LEVELS: readonly number[] = [0.85, 0.9, 1.0, 1.1, 1.2];
export const KNOWN_THEMES: readonly string[] = ['light', 'dark'];

const SVG_TAGS = ['svg', 'g', 'path', 'rect', 'circle', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'marker', 'clippath', 'lineargradient', 'stop', 'title', 'desc'];
const HTML_TAGS = ['div', 'span', 'p', 'b', 'strong', 'em', 'i', 'small', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr', 'section', 'header', 'footer', 'figure', 'figcaption', 'button'];
const SVG = new Set(SVG_TAGS);
const ALLOWED = new Set([...SVG_TAGS, ...HTML_TAGS]);
const VOID = new Set(['br', 'hr']);
const REFUSED_ATTRS = new Set(['srcdoc', 'src', 'srcset', 'poster', 'data', 'background']);

const START_TAG = /<([a-zA-Z][^\s/>]*)((?:\s+[^\s"'>/=]+(?:="[^"]*")?)*)\s*\/?>/y;
const END_TAG = /<\/([a-zA-Z][^\s>]*)>/y;
const ATTR = /\s+([^\s"'>/=]+)(?:="([^"]*)")?/g;
const PLACEHOLDER = /<iframe data-dc-frame="(\d{1,3})"><\/iframe>/y;

function decodeEntities(v: string): string {
  return v.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d) % 0x110000))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16) % 0x110000))
    .replace(/&amp;/g, '&');
}

function attrOk(tag: string, name: string, rawValue: string | undefined): boolean {
  const n = name.toLowerCase();
  if (n.startsWith('on') || REFUSED_ATTRS.has(n)) return false;
  const value = decodeEntities(rawValue ?? '');
  // eslint-disable-next-line no-control-regex
  if (/javascript:/i.test(value.replace(/[\s\u0000-\u001f\u007f]/g, ''))) return false;
  if (n === 'href' || n === 'xlink:href') return SVG.has(tag) && /^#[A-Za-z0-9_-]+$/.test(value);
  if (n === 'style') {
    if (value.includes('\\')) return false;
    for (const m of value.matchAll(/url\(\s*([^)]*)\)/gi)) if (!/^["']?#[A-Za-z0-9_-]+["']?\s*$/.test(m[1])) return false;
    if (/@import|expression\(/i.test(value)) return false;
  }
  return true;
}

export interface ScanResult { ok: true; body: string; placeholders: number[] }

/** The S3/T4 scan. Returns the comment-free body that was scanned, or null. */
export function scanInsightBody(raw: string): ScanResult | null {
  let s = raw;
  for (let i = 0; i < 20; i++) {
    const next = s.replace(/<!--[\s\S]*?-->/g, '');
    if (next === s) break;
    s = next;
  }
  if (s.includes('<!') || /<!--/.test(s)) return null;
  const placeholders: number[] = [];
  // `title` is raw text (RCDATA) to the HTML parser outside <svg>: a quoted `</title>` inside an
  // attribute would end it there and turn the rest into live markup. Only inside an open <svg>.
  let svgDepth = 0;
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    PLACEHOLDER.lastIndex = lt;
    const ph = PLACEHOLDER.exec(s);
    if (ph) { placeholders.push(Number(ph[1])); i = PLACEHOLDER.lastIndex; continue; }
    END_TAG.lastIndex = lt;
    const end = END_TAG.exec(s);
    if (end) {
      if (!ALLOWED.has(end[1].toLowerCase())) return null;
      if (end[1].toLowerCase() === 'svg') svgDepth = Math.max(0, svgDepth - 1);
      i = END_TAG.lastIndex;
      continue;
    }
    START_TAG.lastIndex = lt;
    const st = START_TAG.exec(s);
    if (!st) return null;
    const tag = st[1].toLowerCase();
    if (!ALLOWED.has(tag)) return null;
    if (tag === 'title' && svgDepth === 0) return null;
    for (const a of st[2].matchAll(ATTR)) if (!attrOk(tag, a[1], a[2])) return null;
    if (tag === 'svg' && !st[0].endsWith('/>')) svgDepth += 1;
    i = START_TAG.lastIndex;
  }
  return { ok: true, body: s, placeholders };
}

function attr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Root fields, validated (R7, R8); null on anything off. */
export function validRoot(root: RenderCardRoot): RenderCardRoot | null {
  if (!root || !KNOWN_THEMES.includes(root.theme) || (root.scheme !== 'light' && root.scheme !== 'dark')) return null;
  if (!Array.isArray(root.cls) || root.cls.some((c) => typeof c !== 'string' || !/^[A-Za-z0-9_-]+$/.test(c))) return null;
  if (!ZOOM_LEVELS.includes(root.zoom)) return null;
  const tokens = root.tokens ?? {};
  for (const [k, v] of Object.entries(tokens)) {
    if (!/^--[a-z0-9-]+$/.test(k) || typeof v !== 'string' || /[<>{};\\"'\n\r]|\/\*/.test(v)) return null;
  }
  return { ...root, tokens };
}

function frameOk(f: RenderCardFrame, size: { w: number; h: number }): boolean {
  const scale = f.scale ?? 1;
  const fin = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  return fin(f.w) && fin(f.h) && fin(scale) && scale > 0 && scale <= 4 && f.w * scale <= size.w + 1 && f.h * scale <= size.h + 1
    && (f.scheme === 'light' || f.scheme === 'dark') && /^[a-z0-9][a-z0-9-]{0,79}$/.test(f.slug);
}

/** Bundled app CSS, made network-less: no `@font-face`, no `@import`, no non-`data:` `url()`. */
export function sealedAppCss(css: string): string {
  return css
    .replace(/@import[^;]*;/gi, '')
    .replace(/@font-face\s*\{[^}]*\}/gi, '')
    .replace(/url\(\s*(['"]?)(?!data:|#)[^)]*\1\s*\)/gi, 'none');
}

export interface SealInput {
  result: Extract<RenderCardResult, { ok: true }>;
  /** The stored html/v1 body of an insight in THIS project's lab cache, or null. */
  labHtml: (slug: string) => string | null;
  /** Bundled app stylesheets (already read by the server from its own dashboard dir). */
  appCss: string;
}

/** The sealed document for one insight card, or null (send it as text). */
export function sealInsight(input: SealInput): string | null {
  const { result } = input;
  const size = result.size;
  if (!size || !(size.w > 0 && size.h > 0 && size.w <= 4096 && size.h <= 8192)) return null;
  const root = validRoot(result.root);
  if (!root) return null;
  const scan = scanInsightBody(result.body);
  if (!scan) return null;
  // The text the picture would show passes the redactor.
  const text = decodeEntities(scan.body.replace(/<[^>]*>/g, ' '));
  if (wouldRedact(text)) return null;
  const frames = new Map<number, RenderCardFrame>();
  for (const f of result.frames ?? []) {
    if (frames.has(f.id) || !frameOk(f, size)) return null;
    frames.set(f.id, f);
  }
  const used = new Set<number>();
  for (const id of scan.placeholders) {
    if (used.has(id) || !frames.has(id)) return null;
    used.add(id);
  }
  if (used.size !== frames.size) return null;
  const written = new Map<number, string>();
  for (const f of frames.values()) {
    const html = input.labHtml(f.slug);
    if (!html || !html.trim() || authoredSecretHit(html)) return null;
    const srcdoc = buildLabSrcdocServer(html, labTokens(f.scheme), f.scheme);
    const scale = f.scale ?? 1;
    written.set(f.id, `<iframe sandbox="${SANDBOX_GRANT}" allow="${SANDBOX_ALLOW}" style="width:${f.w}px;height:${f.h}px;border:0;display:block;transform-origin:0 0;transform:scale(${scale});color-scheme:${f.scheme}" srcdoc="${attr(srcdoc)}"></iframe>`);
  }
  // Single pass: each exact placeholder replaced once by its server-written frame.
  const body = scan.body.replace(/<iframe data-dc-frame="(\d{1,3})"><\/iframe>/g, (_m, id: string) => written.get(Number(id)) ?? '');
  const tokens = Object.entries(root.tokens).map(([k, v]) => `${k}:${v};`).join('');
  return [
    '<!doctype html>',
    `<html data-theme="${attr(root.theme)}" class="${attr(root.cls.join(' '))}" style="--zoom:${root.zoom}">`,
    '<head>',
    `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`,
    '<meta charset="utf-8">',
    `<style data-dc-host>${SANDBOX_FONT_CSS}</style>`,
    `<style>:root{color-scheme:${root.scheme};${tokens}}</style>`,
    `<style>${sealedAppCss(input.appCss).replace(/<\/style/gi, '')}</style>`,
    '<style>*,*::before,*::after{animation:none!important;transition:none!important}html,body{margin:0;padding:0}</style>',
    '</head><body>',
    `<div style="position:relative;width:${size.w}px;height:${size.h}px;overflow:hidden">${body}</div>`,
    '</body></html>',
  ].join('');
}
