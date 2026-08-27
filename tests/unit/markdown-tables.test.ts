/**
 * Unit tests for the chat table column model — `holdsItsWidth` and `decorateMarkdownTables`.
 *
 * The layout claim these back is measured in a browser, not here (see the module header): what
 * this suite pins is the CONTRACT the stylesheet reads — which cells are marked rigid, that a
 * table is wrapped exactly once however many times the pass runs, and that a cell's mark is
 * re-derived as a streamed cell grows from a label into a sentence. Get any of those wrong and
 * the CSS is correct about the wrong elements.
 *
 * There is no jsdom/happy-dom in this repo (root vitest runs under plain Node), so the DOM
 * surface the pass actually uses — querySelectorAll, replaceWith, appendChild, classList,
 * get/set/hasAttribute — is shimmed below over a real parent/child tree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  holdsItsWidth, decorateMarkdownTables, FIT_ATTR, WRAP_ATTR, FIT_MAX_CHARS, TABLE_SCROLL_CLASS,
} from '../../dashboard/src/lib/markdownTables.js';

// ─── The smallest honest DOM ────────────────────────────────────────────────────────

class El {
  tag: string;
  children: El[] = [];
  parentElement: El | null = null;
  attrs = new Map<string, string>();
  text: string | null = null;
  className = '';

  constructor(tag: string, text?: string) {
    this.tag = tag;
    if (text !== undefined) this.text = text;
  }

  get classList() {
    return { contains: (c: string) => this.className.split(/\s+/).includes(c) };
  }

  get textContent(): string {
    if (this.text !== null) return this.text;
    return this.children.map((c) => c.textContent).join('');
  }

  appendChild(child: El): void {
    child.parentElement?.remove(child);
    child.parentElement = this;
    this.children.push(child);
  }

  remove(child: El): void {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
  }

  /** Swap this node for `next` in its parent, keeping position — the pass wraps in place. */
  replaceWith(next: El): void {
    const parent = this.parentElement;
    if (!parent) return;
    parent.children[parent.children.indexOf(this)] = next;
    next.parentElement = parent;
    this.parentElement = null;
  }

  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }

  /** Supports only the two selectors the pass uses: `table` and `th, td`. */
  querySelectorAll(selector: string): El[] {
    const wanted = selector.split(',').map((s) => s.trim());
    const out: El[] = [];
    const walk = (node: El) => {
      for (const child of node.children) {
        if (wanted.includes(child.tag)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

/** `document.createElement` is the pass's only global — the wrapper it inserts. */
const realDocument = (globalThis as { document?: unknown }).document;
beforeEach(() => {
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new El(tag),
  };
});
afterEach(() => {
  (globalThis as { document?: unknown }).document = realDocument;
});

/** A `<table>` of the given cell texts (first row is the header), inside a container. */
function tableOf(rows: string[][]): { root: El; table: El } {
  const root = new El('div');
  const table = new El('table');
  rows.forEach((cells, r) => {
    const tr = new El('tr');
    cells.forEach((text) => tr.appendChild(new El(r === 0 ? 'th' : 'td', text)));
    table.appendChild(tr);
  });
  root.appendChild(table);
  return { root, table };
}

/** Each cell as the stylesheet sees it: `fit` (rigid), `wrap` (may break), or `-` (unmarked). */
const marks = (table: El) => table.querySelectorAll('th, td').map((c) => (
  c.hasAttribute(FIT_ATTR) ? 'fit' : c.hasAttribute(WRAP_ATTR) ? 'wrap' : '-'
));

// ─── holdsItsWidth — which cells are allowed to dictate a column's width ────────────

describe('holdsItsWidth — a label holds its width, prose gives it up', () => {
  it('holds the cell shapes a column is usually made of', () => {
    for (const text of ['done', 'open', '1240', '$4,320', '3.1%', '2026-W23', 'recall-v2', 'kerem', '—']) {
      expect(holdsItsWidth(text), text).toBe(true);
    }
  });

  it('lets a sentence wrap — that is the column with room to give', () => {
    expect(holdsItsWidth('Sizes to the model\'s real window instead of assuming 200K.')).toBe(false);
    expect(holdsItsWidth('Cmd+clicking a directory path chip blanked the chat view.')).toBe(false);
  });

  it('lets a long unbreakable token wrap rather than set an unbreakable floor', () => {
    expect(holdsItsWidth('dashboard/src/components/sleepy/chat/TranscriptItem.tsx')).toBe(false);
    expect(holdsItsWidth('https://github.com/dreamcontext/dreamcontext/pull/237/files')).toBe(false);
  });

  it('is decided on the trimmed text — a cell carries the markup\'s indentation', () => {
    expect(holdsItsWidth('\n      done\n    ')).toBe(true);
  });

  it('holds an empty cell, which demands no width at all', () => {
    expect(holdsItsWidth('')).toBe(true);
    expect(holdsItsWidth('   ')).toBe(true);
  });

  it('switches exactly at the documented boundary', () => {
    expect(holdsItsWidth('x'.repeat(FIT_MAX_CHARS))).toBe(true);
    expect(holdsItsWidth('x'.repeat(FIT_MAX_CHARS + 1))).toBe(false);
  });
});

// ─── decorateMarkdownTables — the DOM contract the stylesheet reads ─────────────────

describe('decorateMarkdownTables', () => {
  it('wraps each table in its own scroller, in place', () => {
    const { root, table } = tableOf([['Week', 'MRR'], ['2026-W23', '$5,410']]);
    decorateMarkdownTables(root as unknown as HTMLElement);

    expect(root.children).toHaveLength(1);
    const scroller = root.children[0];
    expect(scroller.tag).toBe('div');
    expect(scroller.className).toBe(TABLE_SCROLL_CLASS);
    expect(scroller.children).toEqual([table]);
    expect(table.parentElement).toBe(scroller);
  });

  it('marks the short cells and leaves the prose column free to wrap', () => {
    const { root, table } = tableOf([
      ['Task', 'Status', 'Why it matters'],
      ['recall-v2', 'done', 'Spans all nine channels so a recall no longer misses automations.'],
    ]);
    decorateMarkdownTables(root as unknown as HTMLElement);

    // Headers are labels too — `Why it matters` stays on one line and sets its column's
    // floor; only the body cell holding the sentence is free to wrap.
    expect(marks(table)).toEqual(['fit', 'fit', 'fit', 'fit', 'fit', 'wrap']);
  });

  it('is idempotent — a streamed answer re-runs it on every commit', () => {
    const { root, table } = tableOf([['Week', 'MRR'], ['2026-W23', '$5,410']]);
    for (let i = 0; i < 5; i++) decorateMarkdownTables(root as unknown as HTMLElement);

    expect(root.children).toHaveLength(1);
    expect(root.children[0].children).toEqual([table]);
    // Still the same table node: re-wrapping would have re-created the subtree, which is the
    // thing markdownBlocks.ts exists to avoid.
    expect(root.children[0].children[0]).toBe(table);
  });

  it('re-derives a mark when a streaming cell grows from a label into a sentence', () => {
    const { root, table } = tableOf([['Note'], ['Sizes']]);
    decorateMarkdownTables(root as unknown as HTMLElement);
    expect(marks(table)).toEqual(['fit', 'fit']);

    const cell = table.querySelectorAll('td')[0];
    cell.text = 'Sizes to the model\'s real window instead of assuming 200K.';
    decorateMarkdownTables(root as unknown as HTMLElement);
    expect(marks(table)).toEqual(['fit', 'wrap']);

    // …and back, for a rewind/edit that shortens it again. Both marks are exclusive: a cell
    // that flipped must not still carry the other one.
    cell.text = 'Sizes';
    decorateMarkdownTables(root as unknown as HTMLElement);
    expect(marks(table)).toEqual(['fit', 'fit']);
    expect(table.querySelectorAll('td')[0].hasAttribute(WRAP_ATTR)).toBe(false);
  });

  it('handles several tables in one answer, and a container with none', () => {
    const { root, table } = tableOf([['a'], ['b']]);
    const second = new El('table');
    const row = new El('tr');
    row.appendChild(new El('td', 'c'));
    second.appendChild(row);
    root.appendChild(second);

    decorateMarkdownTables(root as unknown as HTMLElement);
    expect(root.children.map((c) => c.className)).toEqual([TABLE_SCROLL_CLASS, TABLE_SCROLL_CLASS]);
    expect(table.parentElement?.className).toBe(TABLE_SCROLL_CLASS);

    const empty = new El('div');
    expect(() => decorateMarkdownTables(empty as unknown as HTMLElement)).not.toThrow();
  });
});
