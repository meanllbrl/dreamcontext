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
 *     font, no stylesheet. `style-src`/`script-src 'unsafe-inline'` are what make the body
 *     drawable and interactive at all, and they grant nothing that reaches the network.
 *   • Therefore the markup is NOT sanitized, and must not be: the sandbox is the boundary,
 *     not a filter. A `<script>` in the body can animate, compute and respond to clicks
 *     against data already embedded in the document, and can do nothing else.
 *
 * No React, no CSS imports, no `api/client` — this module must stay importable by root
 * vitest with a `.js` specifier.
 */

/** The CSP embedded as the FIRST element of every srcdoc. */
export const SANDBOX_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

/** The sandbox grant — scripts yes, same-origin NEVER (that would void the CSP). */
export const SANDBOX_GRANT = 'allow-scripts';

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
  /** Optional inline script appended to the end of the body (e.g. the height bridge). */
  bodyScript?: string;
}

/**
 * The complete srcdoc: CSP meta FIRST, then the resolved tokens, then the kit, then any
 * brand override, then the body.
 *
 * Order is load-bearing in two places. The CSP must precede anything that could fetch, or a
 * parser that has already seen a resource declaration has already lost. The override must
 * follow the kit, because "later wins" is the entire mechanism by which a brand restyles the
 * kit without forking it.
 */
export function buildSandboxSrcdoc(input: SandboxSrcdocInput): string {
  const { html, css, tokens, scheme = 'light', overrideCss, bodyScript } = input;
  const rootVars = Object.entries(tokens)
    .map(([token, value]) => `${token}: ${value};`)
    .join(' ');

  const parts = [
    '<!doctype html><html><head>',
    `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`,
    '<meta charset="utf-8">',
    `<style>:root { color-scheme: ${scheme}; ${rootVars} }</style>`,
    `<style>${css}</style>`,
  ];
  if (overrideCss) parts.push(`<style>${overrideCss}</style>`);
  parts.push('</head><body>', html);
  if (bodyScript) parts.push(`<script>${bodyScript}</script>`);
  parts.push('</body></html>');
  return parts.join('\n');
}
