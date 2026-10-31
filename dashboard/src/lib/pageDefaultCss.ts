/**
 * The reading default of a project web page that brought no CSS of its own (a Super report
 * card, owner 2026-10-31: "padding vs."). The kit (chat-html-kit.css) sets `body` flush because
 * a transcript block sits in a column that already has margins; a page on a card has none.
 *
 * WHO GETS IT is asked in the CSS, by the parsed document, so it also sees what a script adds.
 * `UNSTYLED` is a document with no `<style>` but the host's (HOST_STYLE_ATTR), wherever it sits
 * (a srcdoc's body holds what the author wrote in a `<head>`, and the one the host wrote for a
 * page's stylesheet), no `style=` on the root and none anywhere outside `.dc-doc`, where it is
 * the kit's word for geometry. A `<link>` that could not load draws nothing, so it is not CSS. A
 * script's `adoptedStyleSheets` are out of CSS's sight, the known limit.
 * Plain CSS text after the kit: the sandbox grant and the CSP do not move.
 *
 * Bare elements sit at zero specificity (`:where`), so a `dc-` class always beats them. The
 * tokens are the ones the host resolves into the frame (CHAT_KIT_TOKENS).
 *
 * No React, no CSS imports: importable by root vitest with a `.js` specifier.
 */
import { HOST_STYLE_ATTR } from './sandboxHtml.js';

const UNSTYLED = `:root:not([style]):not(:has(style:not([${HOST_STYLE_ATTR}]), [style]:not(.dc-doc *))) body`;
const ANY = `:where(${UNSTYLED})`;
/** What a page's head leaves in the body, ahead of its first real element. */
const HEAD_LEFTOVERS = 'title, meta, link, base, script, style';
const HEADINGS = 'h1, h2, h3, h4, h5, h6';

/** The inset the page keeps from its card. WHY a token both sides read: the card's head strip
 *  uses the same one (widgets.css), so the title and the page share a left edge. */
const INSET = 'var(--space-6)';

/**
 * `inset`: the page is drawn edge to edge (a web card, the full-screen viewer), so it brings its
 * own margin. A reader column already has one, and only takes the type and the rhythm.
 */
export function pageDefaultCss(inset: boolean): string {
  return `
${UNSTYLED} {
  max-width: calc(72ch + 2 * ${INSET});
  margin-inline: auto;
  padding: ${inset ? INSET : '0'};
  overflow-wrap: break-word;
}
${UNSTYLED} .dc-doc > * + :is(.dc-h1, .dc-h2, .dc-h3) { margin-top: ${INSET}; }
${UNSTYLED} .dc-doc > :is(.dc-h1, .dc-h2, .dc-h3) + * { margin-top: var(--space-2); }
${ANY} :where(${HEADINGS}) {
  margin: 1.5em 0 0.5em;
  font-family: var(--font-family-display);
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.3;
  color: var(--color-text);
}
${ANY} :where(h1) { font-size: 1.714rem; }
${ANY} :where(h2) { font-size: 1.286rem; }
${ANY} :where(h3) { font-size: 1.1rem; }
${ANY} :where(h4, h5, h6) { font-size: 1rem; }
${ANY} :where(p, ul, ol, dl, pre, table, blockquote, figure) { margin: 0 0 var(--space-3); }
${ANY} :where(:is(${HEADINGS}):not(:not(${HEAD_LEFTOVERS}) ~ *)) { margin-top: 0; }
${ANY} :where(:last-child:is(p, ul, ol, dl, pre, table, blockquote, figure)) { margin-bottom: 0; }
${ANY} :where(ul, ol) { padding-inline-start: 1.5em; }
${ANY} :where(li + li) { margin-top: var(--space-1); }
${ANY} :where(li > ul, li > ol) { margin: var(--space-1) 0 0; }
${ANY} :where(a) { color: var(--color-accent); }
${ANY} :where(img, svg, video) { max-width: 100%; height: auto; }
${ANY} :where(hr) { margin: var(--space-6) 0; border: 0; border-top: 1px solid var(--color-border); }
${ANY} :where(blockquote) {
  padding-inline-start: var(--space-3);
  border-inline-start: 2px solid var(--color-border-hover);
  color: var(--color-text-secondary);
}
${ANY} :where(code, pre) { font-family: var(--font-mono); font-size: 0.9em; }
${ANY} :where(pre) {
  padding: var(--space-3);
  overflow-x: auto;
  background: var(--color-bg-secondary);
  border-radius: var(--radius-md);
}
${ANY} :where(table) { width: 100%; border-collapse: collapse; }
${ANY} :where(th, td) {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-border);
  text-align: start;
}
${ANY} :where(th) { font-weight: 600; color: var(--color-text-secondary); }
`;
}
