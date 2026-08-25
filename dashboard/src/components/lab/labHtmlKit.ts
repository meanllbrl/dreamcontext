/** The kit, embedded as a TS string so it survives every toolchain (vitest
 *  stubs `.css?raw` imports to empty). `lab-html-kit.css` next to this file
 *  is the SAME text — the reference copy script authors read — and
 *  tests/unit/lab-html-body.test.ts pins the two byte-identical. */
export const LAB_HTML_KIT_CSS = "/**\n * lab-html-kit.css — the curated class kit a script's `html` card body writes\n * against (html/v1 hybrid). Embedded into the sandboxed iframe's srcdoc together\n * with a :root block of RESOLVED design-token values (CSS variables do not cross\n * the iframe document boundary, so labHtmlKit.ts inlines the current theme's\n * values and re-injects on theme change).\n *\n * The rule for script authors: don't write your own CSS — use these classes and\n * the card looks native dreamcontext by default. Classes are prefixed `lk-`.\n */\n\n* { box-sizing: border-box; }\n\nbody {\n  margin: 0;\n  padding: 2px;\n  font-family: var(--font-family);\n  font-size: 12.5px;\n  color: var(--color-text);\n  background: transparent;\n  -webkit-font-smoothing: antialiased;\n}\n\n/* ── Typography ── */\n.lk-title { font-size: 13px; font-weight: 600; color: var(--color-text); margin: 0 0 6px; }\n.lk-label { font-size: 11.5px; font-weight: 600; color: var(--color-text-secondary); }\n.lk-muted { font-size: 11.5px; color: var(--color-text-tertiary); }\n.lk-value { font-family: var(--font-mono); font-size: 20px; font-weight: 700; color: var(--color-text); }\n.lk-value--sm { font-size: 14px; }\n.lk-unit { font-size: 12px; font-weight: 500; color: var(--color-text-secondary); margin-left: 3px; }\n.lk-num { font-family: var(--font-mono); text-align: right; white-space: nowrap; }\n\n/* ── Deltas ── */\n.lk-delta { font-size: 11px; font-weight: 600; }\n.lk-delta--up { color: var(--color-success); }\n.lk-delta--down { color: var(--color-error); }\n.lk-delta--flat { color: var(--color-text-tertiary); }\n\n/* ── Layout ── */\n.lk-row { display: flex; align-items: center; gap: 8px; min-width: 0; }\n.lk-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(90px, 1fr)); gap: 8px; }\n.lk-spacer { flex: 1; }\n.lk-divider { border: none; border-top: 1px solid var(--color-border); margin: 8px 0; }\n\n/* ── Stat tile ── */\n.lk-stat { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-bg-tertiary); }\n\n/* ── Chip / badge ── */\n.lk-chip {\n  display: inline-block; padding: 2px 8px; border-radius: 999px;\n  font-size: 10.5px; font-weight: 600;\n  border: 1px solid var(--color-border);\n  color: var(--color-text-secondary); background: transparent;\n}\n.lk-chip--accent { color: var(--color-accent); background: var(--color-accent-soft); border-color: transparent; }\n.lk-chip--good { color: var(--color-success); background: var(--color-success-subtle); border-color: transparent; }\n.lk-chip--bad { color: var(--color-error); background: var(--color-error-subtle); border-color: transparent; }\n\n/* ── Table (the MetricTable idiom) ── */\n.lk-table { width: 100%; border-collapse: collapse; font-size: 12px; border: 1px solid var(--color-border); border-radius: 8px; overflow: hidden; }\n.lk-table th { text-align: left; padding: 5px 9px; font-weight: 600; font-size: 11.5px; color: var(--color-text-secondary); background: var(--color-bg-tertiary); }\n.lk-table th.lk-num, .lk-table td.lk-num { text-align: right; }\n.lk-table td { padding: 4px 9px; border-top: 1px solid var(--color-border); color: var(--color-text); }\n\n/* ── Bar row (the BarList idiom) ── */\n.lk-bar { display: flex; align-items: center; gap: 8px; font-size: 12px; min-width: 0; }\n.lk-bar-label { flex: 0 0 34%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-secondary); }\n.lk-bar-track { flex: 1; min-width: 0; height: 8px; border-radius: 4px; background: var(--color-bg-tertiary); overflow: hidden; }\n.lk-bar-fill { display: block; height: 100%; border-radius: 4px; background: var(--chart-1); }\n.lk-bar-fill--2 { background: var(--chart-2); }\n.lk-bar-fill--3 { background: var(--chart-3); }\n.lk-bar-fill--4 { background: var(--chart-4); }\n.lk-bar-fill--5 { background: var(--chart-5); }\n.lk-bar-fill--6 { background: var(--chart-6); }\n.lk-bar-fill--7 { background: var(--chart-7); }\n.lk-bar-fill--8 { background: var(--chart-8); }\n.lk-bar-value { flex-shrink: 0; font-family: var(--font-mono); font-size: 11.5px; color: var(--color-text); }\n\n/* ── Honesty helpers ── */\n.lk-low-sample { opacity: 0.45; }\n.lk-empty { color: var(--color-text-tertiary); font-size: 13px; padding: 24px 0; }\n";

/**
 * The html/v1 card body's injection layer.
 *
 * A script's `cache.html` is drawn inside a sandboxed iframe with NO
 * same-origin grant, so the parent page's CSS variables do not reach it. This
 * module builds the iframe's `srcdoc`: a locked-down CSP first, then a `:root`
 * block of the CURRENT theme's resolved token values, then the curated
 * `lab-html-kit.css` class kit — so the script author writes OUR classes and the
 * card looks native by default. The caller rebuilds the srcdoc when the theme
 * flips (the resolved values change; the kit itself doesn't).
 *
 * SECURITY MODEL (pinned by tests/unit/lab-html-body.test.ts + runtime verify):
 * `sandbox="allow-scripts"` WITHOUT `allow-same-origin`, and a srcdoc CSP of
 * `default-src 'none'` — the iframe can run its inline script against the data
 * already embedded in the html, but it cannot fetch, beacon, load an image, or
 * touch the parent origin. The html is produced at SYNC time and cached; the
 * iframe never needs the network.
 */

export const HTML_KIT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

/** The sandbox grant — scripts yes, same-origin NEVER (that would void the CSP). */
export const HTML_KIT_SANDBOX = 'allow-scripts';

/** The design tokens resolved into the srcdoc — the full kit surface: charts,
 *  surfaces/text/borders, status, spacing, typography, radii. */
export const HTML_KIT_TOKENS: readonly string[] = [
  '--chart-1', '--chart-2', '--chart-3', '--chart-4',
  '--chart-5', '--chart-6', '--chart-7', '--chart-8',
  '--color-bg', '--color-bg-secondary', '--color-bg-tertiary', '--color-bg-elevated',
  '--color-border', '--color-border-hover',
  '--color-text', '--color-text-secondary', '--color-text-tertiary',
  '--color-accent', '--color-accent-soft', '--color-accent-text',
  '--color-success', '--color-success-subtle',
  '--color-error', '--color-error-subtle',
  '--color-warning', '--color-caution',
  '--font-family', '--font-mono',
  '--space-1', '--space-2', '--space-3', '--space-4', '--space-6', '--space-8',
  '--radius-sm', '--radius-md', '--radius-lg',
  '--shadow-sm', '--shadow-md',
];

/** Read the current computed value of every kit token off the live document. */
export function resolveKitTokens(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const token of HTML_KIT_TOKENS) {
    const value = styles.getPropertyValue(token).trim();
    if (value) out[token] = value;
  }
  return out;
}

/** The complete srcdoc: CSP meta FIRST, resolved tokens, kit, then the body. */
export function buildSrcdoc(html: string, tokens: Record<string, string>): string {
  const rootVars = Object.entries(tokens)
    .map(([token, value]) => `${token}: ${value};`)
    .join(' ');
  return [
    '<!doctype html><html><head>',
    `<meta http-equiv="Content-Security-Policy" content="${HTML_KIT_CSP}">`,
    '<meta charset="utf-8">',
    `<style>:root { ${rootVars} }</style>`,
    `<style>${LAB_HTML_KIT_CSS}</style>`,
    '</head><body>',
    html,
    '</body></html>',
  ].join('\n');
}
