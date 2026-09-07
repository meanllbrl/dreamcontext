/**
 * The shared primitives behind every place this app draws HTML it did not write: the Lab's
 * script-authored card body (`components/lab/labHtmlKit.ts`) and the Chat view's
 * agent-authored `dream-html` block (`components/sleepy/chat/chatHtmlKit.ts`).
 *
 * WHY THIS FILE EXISTS: both surfaces run untrusted-authored markup, and both are safe for
 * exactly the same reason — a sandbox grant with no same-origin, plus a srcdoc CSP that
 * forbids every fetch. Those two constants are the whole security argument. Kept in one
 * module so a change to either reaches BOTH surfaces; duplicated, a hardening fix would
 * silently land on one and not the other.
 *
 * SECURITY MODEL (pinned by tests/unit/lab-html-body.test.ts + tests/unit/chat-html.test.ts,
 * and proven at runtime in scripts/verify/):
 *   • `sandbox="allow-scripts"` and NOTHING ELSE. Granting `allow-same-origin` alongside
 *     `allow-scripts` would let the frame reach into the parent document and remove its own
 *     sandbox attribute — the two grants together are equivalent to no sandbox at all.
 *   • srcdoc CSP `default-src 'none'` — no fetch, no XHR, no beacon, no remote image, no
 *     remote font, no stylesheet. `style-src`/`script-src 'unsafe-inline'` are what make the
 *     body drawable and interactive at all, and `font-src data:` lets the reading face ride
 *     INSIDE the document. None of the three reaches the network: a `data:` URL contacts no
 *     host, so the frame still issues zero requests by any route.
 *   • Therefore the markup is NOT sanitized, and must not be: the sandbox is the boundary,
 *     not a filter. A `<script>` in the body can animate, compute and respond to clicks
 *     against data already embedded in the document, and can do nothing else.
 *
 * No React, no CSS imports, no `api/client` — this module must stay importable by root
 * vitest with a `.js` specifier.
 */

/**
 * The CSP embedded as the FIRST element of every srcdoc.
 *
 * `font-src data:` is the only allowance beyond drawing, and it is not a network grant: a
 * `data:` URL resolves inside the document, contacts no host, and issues no request. It
 * exists because the app's reading face could not otherwise cross the frame boundary — the
 * block fell back to system-ui while the transcript around it rendered in Inter, a measured
 * 10% difference in the same string at the same size (F5, 2026-09-02). The bytes ride in
 * the document, which is the same property that lets an exported block render offline.
 *
 * What it deliberately does NOT say is `font-src https:` or a host allow-list. Either would
 * turn "this frame cannot reach the network" into "this frame cannot reach the network
 * except…", and the whole security argument for not sanitizing the markup is that there is
 * no exception.
 */
import { SANDBOX_FONT_CSS } from './sandboxFont.js';

export const SANDBOX_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:";

/** The sandbox grant — scripts yes, same-origin NEVER (that would void the CSP). */
export const SANDBOX_GRANT = 'allow-scripts';

/**
 * The permissions-policy grant — EMPTY, denying every powerful device feature to authored
 * markup: microphone, camera, geolocation, display-capture, the lot.
 *
 * WHY AN EMPTY STRING IS THE VALUE. `allow` is a permissions ALLOW-LIST, and an iframe
 * carrying `allow=""` grants nothing. Omitting the attribute is NOT the same thing: a
 * same-origin child (which `srcdoc` is, in the ways that matter here) inherits the parent's
 * permission state by default, so "we never wrote `allow`" reads as "whatever the app has".
 *
 * WHY IT EXISTS AT ALL, given the sandbox and the CSP. Neither covers device permissions.
 * `sandbox="allow-scripts"` governs origin, navigation, forms and popups; `SANDBOX_CSP`
 * governs FETCHES — `default-src 'none'` stops the frame reaching the network and says
 * nothing about `getUserMedia`. Between them there was an uncovered class, and one member of
 * it is the microphone.
 *
 * WHY IT IS NOT THEORETICAL. wry 0.55.1 grants WKWebView media capture unconditionally,
 * discarding the requesting origin and frame (`wry_web_view_ui_delegate.rs:126-137` →
 * `WKPermissionDecision::Grant`), and the desktop app is non-sandboxed. So the moment one
 * legitimate push-to-talk satisfies the process-wide TCC prompt, there is nothing BELOW this
 * attribute — not in macOS, not in WebKit — that tells the composer's mic button apart from
 * a `getUserMedia` call inside markup an agent wrote. This attribute is the boundary.
 *
 * WHY THE CONSTANT IS NOT THE CONTROL. `sandbox` and `allow` are INDEPENDENT attributes:
 * defining this changes nothing until every JSX site that draws authored HTML spells it out.
 * There are three, and the two Lab ones matter MORE rather than less — a Lab script's output
 * renders automatically every session, with no attention-drawing moment like pressing a mic
 * button. `tests/unit/chat-html.test.ts` and `tests/unit/lab-html-body.test.ts` read the
 * component sources and pin all three, because a constant nobody uses is the exact failure
 * this note exists to prevent.
 */
export const SANDBOX_ALLOW = '';

export { SANDBOX_FONT_CSS } from './sandboxFont.js';

/**
 * Read the current computed value of every named token off the live document.
 *
 * CSS custom properties do NOT cross the iframe document boundary, so a srcdoc that merely
 * says `var(--color-text)` resolves to nothing. Every surface therefore inlines the CURRENT
 * theme's resolved values into the srcdoc's `:root` and rebuilds when the theme flips.
 */
export function resolveTokens(tokens: readonly string[]): Record<string, string> {
  const styles = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const token of tokens) {
    const value = styles.getPropertyValue(token).trim();
    if (value) out[token] = value;
  }
  return out;
}

export interface SandboxSrcdocInput {
  /** The author's markup — dropped in verbatim. The sandbox is the boundary. */
  html: string;
  /** The surface's class kit, embedded after the resolved tokens. */
  css: string;
  /** Resolved design-token values (see {@link resolveTokens}). */
  tokens: Record<string, string>;
  /**
   * MUST match the embedding page's theme. On a mismatch Chromium paints an opaque white
   * canvas behind the transparent iframe body, which under the dark theme reads as a white
   * slab with near-white text on it (found the hard way, 2026-08-25).
   */
  scheme?: 'light' | 'dark';
  /** Optional per-vault brand CSS, appended AFTER `css` so it can override it. */
  overrideCss?: string;
  /**
   * Optional inline script for the surface itself (e.g. Chat's height bridge), placed in
   * the HEAD — before a single byte of the author's markup is parsed.
   *
   * HEAD, and not the end of the body, IS the point of this field. A script below the body
   * is at the mercy of the markup above it: an author who writes `<\/script>` inside their
   * own inline script — the reflex from inlining JS into a page — never closes that element,
   * and the parser swallows everything after it, this script included. Chat lost its height
   * bridge exactly that way, and a frame whose bridge never runs sits at its floor for the
   * rest of the session.
   *
   * It therefore runs with NO `document.body`: anything touching the body must wait for
   * `DOMContentLoaded`, which fires even when the parser had to close an unclosed element.
   */
  headScript?: string;
}

/**
 * The complete srcdoc: CSP meta FIRST, then the resolved tokens, then the kit, then any
 * brand override, then the body.
 *
 * Order is load-bearing in three places. The CSP must precede anything that could fetch, or a
 * parser that has already seen a resource declaration has already lost. The override must
 * follow the kit, because "later wins" is the entire mechanism by which a brand restyles the
 * kit without forking it. And the surface's own script must precede the body, or the author's
 * markup can swallow it (see {@link SandboxSrcdocInput.headScript}).
 */
export function buildSandboxSrcdoc(input: SandboxSrcdocInput): string {
  const { html, css, tokens, scheme = 'light', overrideCss, headScript } = input;
  const rootVars = Object.entries(tokens)
    .map(([token, value]) => `${token}: ${value};`)
    .join(' ');

  const parts = [
    '<!doctype html><html><head>',
    `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`,
    '<meta charset="utf-8">',
    // The face BEFORE the tokens that name it: `--font-family` resolves to a stack starting
    // with 'Inter', and inside this frame that name means nothing unless the @font-face is
    // already declared. See lib/sandboxFont.ts for why it has to travel in the document.
    `<style>${SANDBOX_FONT_CSS}</style>`,
    `<style>:root { color-scheme: ${scheme}; ${rootVars} }</style>`,
    `<style>${css}</style>`,
  ];
  if (overrideCss) parts.push(`<style>${overrideCss}</style>`);
  if (headScript) parts.push(`<script>${headScript}</script>`);
  parts.push('</head><body>', html);
  parts.push('</body></html>');
  return parts.join('\n');
}
