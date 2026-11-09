/**
 * Which canvas a project web page is drawn on (a Super report card, the file viewer).
 *
 * The host paints the app's theme under every page: `color-scheme`, the kit's body text colour
 * and a transparent body over the card. A page that writes its OWN colours into its stylesheet
 * (`h1 { color: #111 }`, `th { background: #fff }`) only half takes that: in the dark theme its
 * dark headings sat on the dark card, nearly invisible, while its white table heads and callouts
 * stayed white slabs (owner, 2026-11-09, "rapor dark mode problemi"). Each half was right on its
 * own; the mix was unreadable.
 *
 * So a page is either fully themed or fully its own: one that names a literal colour in a
 * stylesheet, and says nothing about dark (`prefers-color-scheme`, a `color-scheme` naming dark),
 * is drawn on a light canvas with the light tokens in BOTH themes, the way it was written and the
 * way its Telegram PDF already prints it. A page on the `dc-` kit alone, or with no CSS, follows
 * the theme. Inline `style=` inside the page is not counted: that is the kit's word for geometry
 * (a bar width, `var(--chart-1)`) and a mockup's self-contained frame; only `<html>`/`<body>`
 * attributes are, since they colour everything.
 *
 * No React, no CSS imports: importable by root vitest with a `.js` specifier.
 */
import { CHAT_KIT_TOKENS } from '../../../src/lib/telegram/kit-tokens.js';

/** Values that are no colour of the page's own: they defer to the canvas. */
const NOT_A_COLOUR = new Set(['transparent', 'none', 'inherit', 'initial', 'unset', 'revert', 'currentcolor', 'auto']);

/** A literal colour: hex, a colour function, or a CSS named colour word. */
const LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|\b(?:white|black|gr[ae]y|silver|whitesmoke|gainsboro|snow|ivory|beige|linen|red|green|blue|navy|teal|maroon|olive|purple|orange|yellow|pink|brown|crimson|darkgr[ae]y|lightgr[ae]y|dimgr[ae]y|slategr[ae]y|darkslategr[ae]y|ghostwhite|aliceblue|floralwhite|mintcream|honeydew|seashell|lavender|lightyellow|lightblue|lightgreen|darkblue|darkred|darkgreen)\b/i;

/** A colour or background declaration and its value, up to `;`, `}` or the end of an attribute. */
const DECL = /(?:^|[\s;{"'])(color|background(?:-color)?)\s*:\s*([^;}"']*)/gi;

function stripVars(value: string): string {
  // `var(--x, #fff)`: the kit always defines the token, so its fallback is never used.
  let out = value;
  for (let i = 0; i < 4 && /var\(/i.test(out); i++) out = out.replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/gi, '');
  return out;
}

function namesLiteralColour(css: string): boolean {
  for (const m of css.matchAll(DECL)) {
    const value = stripVars(m[2]).trim().toLowerCase();
    if (!value || NOT_A_COLOUR.has(value)) continue;
    if (LITERAL.test(value)) return true;
  }
  return false;
}

/** The page's stylesheet text: every `<style>` (an inlined project stylesheet too) and the
 *  `style=` of `<html>`/`<body>`. */
function pageCss(html: string): string {
  const parts: string[] = [];
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) parts.push(m[1]);
  for (const m of html.matchAll(/<(?:html|body)\b[^>]*\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi)) parts.push(m[2] ?? m[3] ?? '');
  return parts.join('\n');
}

/** True when the page brings its own light-only palette (see the module comment). */
export function pageOwnsPalette(html: string): boolean {
  // Legacy colour attributes colour as much as a stylesheet does.
  if (/<(?:html|body|table|tr|td|th|font)\b[^>]*\s(?:bgcolor|text|color)\s*=/i.test(html)) return !declaresDark(html);
  const css = pageCss(html);
  if (!namesLiteralColour(css)) return false;
  return !declaresDark(html, css);
}

/** The page says it handles dark itself: a dark media query or a `color-scheme` naming dark. */
function declaresDark(html: string, css = pageCss(html)): boolean {
  if (/prefers-color-scheme\s*:\s*dark/i.test(css)) return true;
  if (/color-scheme\s*:[^;}]*\bdark\b/i.test(css)) return true;
  return /<meta\b[^>]*name\s*=\s*["']?color-scheme["']?[^>]*content\s*=\s*["'][^"']*\bdark\b/i.test(html);
}

/** Painted under a page on its own canvas: opaque, so no card colour shows through anywhere. */
export const OWN_CANVAS_CSS = 'html { background: var(--color-bg); }';

/**
 * The tokens for a page drawn in `scheme` while the app shows `theme`. The same theme: the live
 * ones. A light canvas under the dark app: the live ones (fonts, spacing, reading size) with the
 * light theme's colours over them, the generated values the Telegram PDF prints with, since the
 * app's stylesheet only resolves the theme it is in.
 */
export function pageTokens(live: Record<string, string>, scheme: 'light' | 'dark', theme: 'light' | 'dark'): Record<string, string> {
  if (scheme === theme) return live;
  const out = { ...live };
  for (const [token, value] of Object.entries(CHAT_KIT_TOKENS[scheme])) {
    if (/^--(?:color|chart|shadow)-/.test(token)) out[token] = value;
  }
  return out;
}
