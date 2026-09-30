/**
 * The board `table` block and the lab tables (MetricTable + FrameTable):
 * click-to-sort headers (the sort cycle and order are pure; the markup carries
 * aria-sort and a real button per header), the sticky header, density, inline
 * data bars, and the change drawn as arrow icon + sign (colour only on top,
 * `deltaColor`). Static markup through the dashboard's own React, as the other
 * lab block tests do (no DOM harness in this repo); the browser click is proved
 * by the lab-boards verify run.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { Frame } from '../../dashboard/src/generated/frameOps.js';
import type { Block, BlockProps } from '../../dashboard/src/components/lab/board/boardTypes.js';

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => (key === 'lab.blocks.otherCount' ? 'Other ({n})' : key) }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

const { MetricTable, FrameTable, nextSort, sortRows, pickFrameColumns } = await import('../../dashboard/src/components/lab/MetricTable.js');
const { TableBlock } = await import('../../dashboard/src/components/lab/blocks/TableBlock.js');

const html = (el: ReactElement) => renderToStaticMarkup(el);
const count = (s: string, needle: RegExp) => (s.match(needle) ?? []).length;

const DIMS = [{ key: 'country', label: 'Country' }];
const ROWS = [
  { d: { country: 'Atlantis' }, v: 50, n: 500, prev: 40 },
  { d: { country: 'Lemuria' }, v: 30, n: 300, prev: 35 },
  { d: { country: 'Mu' }, v: 20, n: 200, prev: 20 },
  { d: {}, v: 12, n: 120, prev: 10, other: 3 },
];

const SERIES = [
  { name: 'web', points: [{ t: '2026-09-01', v: 10 }, { t: '2026-09-02', v: 14 }] },
  { name: 'ios', points: [{ t: '2026-09-01', v: 9 }, { t: '2026-09-02', v: 6 }] },
];

const TABLE_FRAME: Frame = {
  kind: 'table', insight: 'orders', dataset: 'by-country', label: 'Orders', dims: DIMS, rows: ROWS,
  sourceTotal: null, total: { count: 6, v: 112, n: 1120 }, unit: null,
};

function renderTable(options: Record<string, unknown>, frame: Frame = TABLE_FRAME): string {
  const block: Block = { type: 'table', data: 'orders', options };
  const props: BlockProps & { block: Block } = { frame, options, block };
  return html(createElement(TableBlock as never, props as never));
}

describe('sorting: the header click cycle and the order it produces', () => {
  it('a number column goes desc, asc, then back to the delivered order', () => {
    const a = nextSort(null, 'v', true);
    expect(a).toEqual({ key: 'v', dir: 'desc' });
    const b = nextSort(a, 'v', true);
    expect(b).toEqual({ key: 'v', dir: 'asc' });
    expect(nextSort(b, 'v', true)).toBeNull();
  });

  it('a text column starts ascending; another column starts over', () => {
    const a = nextSort(null, 'country', false);
    expect(a).toEqual({ key: 'country', dir: 'asc' });
    expect(nextSort(a, 'country', false)).toEqual({ key: 'country', dir: 'desc' });
    expect(nextSort(a, 'v', true)).toEqual({ key: 'v', dir: 'desc' });
  });

  it('sorts numbers and text, missing values last both ways, the Other fold always last', () => {
    const rows = [{ k: 'b', v: 2 }, { k: 'x', v: null }, { k: 'Other', v: 99, pin: true }, { k: 'a10', v: 5 }, { k: 'a9', v: 1 }];
    const val = (r: (typeof rows)[number], key: string) => (key === 'k' ? r.k : r.v);
    const pin = (r: (typeof rows)[number]) => r.pin === true;
    expect(sortRows(rows, null, val, pin).map((r) => r.k)).toEqual(['b', 'x', 'a10', 'a9', 'Other']);
    expect(sortRows(rows, { key: 'v', dir: 'desc' }, val, pin).map((r) => r.k)).toEqual(['a10', 'b', 'a9', 'x', 'Other']);
    expect(sortRows(rows, { key: 'v', dir: 'asc' }, val, pin).map((r) => r.k)).toEqual(['a9', 'b', 'a10', 'x', 'Other']);
    // Text sorts with numeric collation: a9 before a10.
    expect(sortRows(rows, { key: 'k', dir: 'asc' }, val, pin).map((r) => r.k)).toEqual(['a9', 'a10', 'b', 'x', 'Other']);
  });

  it('every sortable header is a button inside a th that carries aria-sort', () => {
    const out = renderTable({});
    const ths = out.match(/<th [^>]*>/g) ?? [];
    expect(ths.length).toBe(5); // country, v, n, prev, delta
    for (const th of ths) expect(th).toContain('aria-sort="none"');
    expect(count(out, /<button type="button" class="lab-table-sort"/g)).toBe(5);
  });

  it('a delivered order is kept until the user sorts (topN fold stays last)', () => {
    const out = renderTable({});
    const order = ['Atlantis', 'Lemuria', 'Mu', 'Other (3)'].map((s) => out.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('sticky header', () => {
  it('the head carries the sticky class and the stylesheet sticks its cells', () => {
    expect(renderTable({})).toContain('<thead class="lab-table-head">');
    const css = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab/MetricTable.css'), 'utf-8');
    expect(css).toMatch(/\.lab-table-head th \{[^}]*position: sticky;[^}]*top: 0;/);
    // The wrapper is the scroll box the header sticks to.
    expect(css).toMatch(/\.lab-table-wrap \{[^}]*overflow: auto;/);
  });
});

describe('density', () => {
  it('compact by default, comfortable on request', () => {
    const base = renderTable({});
    const roomy = renderTable({ density: 'comfortable' });
    expect(base).toContain('class="lab-table lab-table--compact"');
    expect(base).toContain('data-density="compact"');
    expect(roomy).toContain('class="lab-table lab-table--comfortable"');
    expect(roomy).toContain('data-density="comfortable"');
  });
});

describe('data bars', () => {
  it('off by default; on, each value gets a bar scaled to the largest', () => {
    expect(renderTable({})).not.toContain('lab-table-bar');
    const out = renderTable({ bars: true });
    expect(count(out, /class="lab-table-bar-fill"/g)).toBe(4);
    expect(out).toContain('data-bar-frac="1.000"');
    expect(out).toContain('data-bar-frac="0.600"');
    // The Other fold wears the de-emphasis grey, never a categorical hue.
    expect(out).toMatch(/data-bar-frac="0\.240" style="width:24\.0%;background:var\(--viz-other\)"/);
  });

  it('the series table draws its bars in the latest column', () => {
    const out = html(createElement(MetricTable, { series: SERIES, unit: null, full: true, bars: true }));
    expect(count(out, /class="lab-table-bar-fill"/g)).toBe(2);
  });
});

describe('the change: arrow icon + sign, colour only on top', () => {
  it('a table frame with prev gets a change column: up, down and flat', () => {
    expect(pickFrameColumns(DIMS, ROWS, null)).toEqual(['country', 'v', 'n', 'prev', 'delta']);
    const out = renderTable({});
    expect(out).toMatch(/data-dir="up" data-colored="">\s*<svg class="lab-delta-icon"[^>]*><path d="M5 1\.5 9 8\.5H1z"/);
    expect(out).toContain('>+10<');
    expect(out).toMatch(/data-dir="down" data-colored="">\s*<svg class="lab-delta-icon"[^>]*><path d="M5 8\.5 1 1\.5h8z"/);
    expect(out).toContain('>−5<');
    expect(out).toMatch(/data-dir="flat"[^>]*>\s*<svg[^>]*><rect/);
  });

  it('deltaColor false keeps the arrow and the sign, drops the colour', () => {
    const out = renderTable({ deltaColor: false });
    expect(out).not.toContain('data-colored');
    expect(out).toContain('data-dir="up"');
    expect(out).toContain('>+10<');
  });

  it('the stylesheet colours only a coloured mark, with the status inks', () => {
    const css = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab/chartBody.css'), 'utf-8');
    expect(css).toMatch(/\.lab-delta\[data-colored\]\[data-dir='up'\] \{\s*color: var\(--color-success-ink\);/);
    expect(css).toMatch(/\.lab-delta\[data-colored\]\[data-dir='down'\] \{\s*color: var\(--color-error-ink\);/);
  });

  it('the series table: the change column has the same mark', () => {
    const out = html(createElement(MetricTable, { series: SERIES, unit: null, full: true }));
    expect(out).toContain('data-dir="up"');
    expect(out).toContain('>+4<');
    expect(out).toContain('data-dir="down"');
    expect(out).toContain('>−3<');
  });
});

describe('format, column pick and the Other fold', () => {
  it('format writes every figure', () => {
    const out = renderTable({ format: 'currency' });
    expect(out).toContain('$50.00');
    expect(renderTable({})).not.toContain('$50.00');
  });

  it('column pick still chooses and orders the columns', () => {
    expect(renderTable({ columns: ['delta', 'country'] })).toContain('data-columns="delta,country"');
  });

  it('the Other row is labelled with how many rows it folds', () => {
    const out = renderTable({});
    expect(out).toContain('data-other=""');
    expect(out).toContain('Other (3)');
  });
});
