/**
 * Column sizing for the tables an answer writes — the difference between "the browser's
 * default table layout" and a table that shares its row sensibly inside a chat message.
 *
 * A markdown table lands in a card whose width is `fit-content` capped at the transcript
 * measure, and CSS auto table layout resolves an over-wide table by shrinking EVERY column in
 * proportion to its content. So one long prose column drags the short ones down with it: on the
 * 4-column case measured in the harness (960px measure), a `Task` column that needs 102px was
 * given 95px and wrapped `context gauge` onto a second line, while the prose column next to it
 * held 683px. The row got taller so that a column with room to spare could stay wide.
 *
 * Two rules fix it, and both are per-CELL because a column is only as rigid as its widest
 * short value:
 *
 *  1. A cell whose text is short enough to be a label, an id, a status, a number or a date
 *     ({@link holdsItsWidth}) is marked `data-fit` and never wraps. Its column therefore keeps
 *     its natural width, and the deficit is taken by the columns that hold prose — which have
 *     the room to give. Measured: the 4-column case goes 95px → 102px on the label column and
 *     loses a wrapped line (184px → 165px tall at 960px, 223px → 203px at 652px).
 *  2. Everything else is free to wrap, and to break mid-token when a token is longer than the
 *     column (a URL, a deep path), instead of setting an unbreakable floor.
 *
 * Rule 1 can still add up to more than the card holds — twelve short columns are legitimately
 * wide — so each table is wrapped in a horizontal scroller. Without it a wide table simply
 * painted outside the message card: measured at a 652px card, the 12-column grid drew 761px
 * wide and the long-URL table 777px, both spilling over the card's own border with no way to
 * reach the cut-off columns. Inside the scroller they stay in the card and scroll.
 *
 * DOM-level rather than a markdown-renderer option because the HTML is written by `marked` and
 * patched into the page block by block ({@link ../lib/markdownBlocks}); this runs after that
 * patch, like the mermaid/highlight passes, and is idempotent so a streamed table can be
 * re-decorated on every commit.
 */

/** Class on the wrapper that gives one table its own horizontal scroller. */
export const TABLE_SCROLL_CLASS = 'md-table-scroll';

/**
 * Attribute marking a cell that must not wrap, so its column keeps its natural width.
 *
 * Both marks are POSITIVE — `data-fit` for the rigid cells, `data-wrap` for the ones free to
 * break — rather than one mark and a `:not()` rule for its complement. An unmarked cell must
 * render the way it did before any of this existed: if this pass ever fails to run (a throw
 * upstream, a table some other pass inserts), a `:not([data-fit])` rule would hand `anywhere`
 * to EVERY cell and break `Status` into `Sta`/`tus` — a worse table than the one being fixed.
 * Unmarked is therefore the browser default, and the pass can only ever improve on it.
 */
export const FIT_ATTR = 'data-fit';

/** Attribute marking a cell long enough that it may break mid-token instead of overflowing. */
export const WRAP_ATTR = 'data-wrap';

/**
 * Longest cell text still treated as a label rather than as prose. 18 characters is about
 * 130px at the table's font size: comfortably wider than a status, an id, a date, a number or
 * a currency amount, and comfortably narrower than the shortest sentence — which is the
 * content that SHOULD absorb the squeeze.
 */
export const FIT_MAX_CHARS = 18;

/**
 * Should this cell hold its natural width instead of wrapping?
 *
 * Length alone is the test, deliberately: what matters for layout is how much width the cell
 * demands, not what the text means. Whitespace is trimmed first because a cell's text node
 * carries the markup's own indentation.
 */
export function holdsItsWidth(text: string): boolean {
  const trimmed = text.trim();
  // An empty cell (`—`, a blank) demands nothing and must not be allowed to wrap to zero.
  return trimmed.length <= FIT_MAX_CHARS;
}

/**
 * Apply both rules to every table under `root`. Safe to call on every render: the wrapper is
 * created once per table, and the per-cell marks are re-derived because a streamed cell's text
 * grows — a cell that was a label three tokens ago can be a sentence now.
 */
export function decorateMarkdownTables(root: HTMLElement): void {
  root.querySelectorAll('table').forEach((table) => {
    const parent = table.parentElement;
    if (!parent?.classList.contains(TABLE_SCROLL_CLASS)) {
      const scroller = document.createElement('div');
      scroller.className = TABLE_SCROLL_CLASS;
      table.replaceWith(scroller);
      scroller.appendChild(table);
    }
    table.querySelectorAll('th, td').forEach((cell) => {
      const fits = holdsItsWidth(cell.textContent ?? '');
      // Written only on change: an attribute set on every commit of a streaming answer is a
      // style invalidation per cell per token, for a value that almost never differs. The
      // guard reads the mark this cell SHOULD carry — reading only `data-fit` would take an
      // unmarked long cell (every long cell, on the first pass) for an up-to-date one.
      if (cell.hasAttribute(fits ? FIT_ATTR : WRAP_ATTR)) return;
      if (fits) {
        cell.setAttribute(FIT_ATTR, '');
        cell.removeAttribute(WRAP_ATTR);
      } else {
        cell.removeAttribute(FIT_ATTR);
        cell.setAttribute(WRAP_ATTR, '');
      }
    });
  });
}
