/**
 * The board `pivot` block scrolls with a sticky header: the table wrapper is the
 * only scroll box, its header cells stick to its top, and the filter chips and the
 * total line sit OUTSIDE the scrolling area. The `breakdown` render elsewhere
 * (cards, detail panel) keeps its natural layout. Static markup plus the
 * stylesheet rules; the browser geometry is the lab-boards verify run's job.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { Frame } from '../../dashboard/src/generated/frameOps.js';
import type { Block } from '../../dashboard/src/components/lab/board/boardTypes.js';

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

const { PivotBlock } = await import('../../dashboard/src/components/lab/blocks/PivotBlock.js');
const { BreakdownBody, pivotFit } = await import('../../dashboard/src/components/lab/BreakdownPivot.js');
const { frameToMatrixSet } = await import('../../dashboard/src/components/lab/blocks/frameAdapters.js');

const html = (el: ReactElement) => renderToStaticMarkup(el);
const LAB = join(import.meta.dirname, '../../dashboard/src/components/lab');

// Three dims: plan down, country across, tier as filter chips (fictional data).
const PLANS = ['team', 'pro', 'starter', 'trial'];
const FRAME: Frame = {
  kind: 'table', insight: 'plans', dataset: 'plans', label: 'Plans',
  dims: [{ key: 'plan', label: 'Plan' }, { key: 'country', label: 'Country' }, { key: 'tier', label: 'Tier' }],
  rows: PLANS.flatMap((plan, i) => ['Atlantis', 'Lemuria'].map((country, j) => ({ d: { plan, country, tier: j === 0 ? 'self' : 'sales' }, v: 100 - i * 10 + j }))),
  sourceTotal: { v: 1000 }, total: { count: 8, v: 1000, n: null }, unit: null,
};

function renderPivot(): string {
  const block: Block = { type: 'pivot', data: 'plans', options: { rows: 'plan', cols: 'country' } };
  return html(createElement(PivotBlock as never, { frame: FRAME, options: block.options, block } as never));
}

/** The element whose opening tag carries `cls`, as the substring from that tag onward. */
const from = (out: string, cls: string) => out.slice(out.indexOf(`class="${cls}`));

describe('pivot block: the table scrolls, chips and total do not', () => {
  it('mounts in a fill column, not a scroll box', () => {
    const out = renderPivot();
    expect(out.startsWith('<div class="lab-block-pivot">')).toBe(true);
    expect(out).not.toContain('lab-block-scroll');
    expect(out).toContain('class="lab-pivot lab-pivot--fit"');
  });

  it('the chips come BEFORE the scroll box and outside it; the total line after it', () => {
    const out = renderPivot();
    const chips = out.indexOf('class="lab-pivot-chips"');
    const scroll = out.indexOf('class="lab-pivot-scroll"');
    const foot = out.indexOf('class="lab-pivot-foot"');
    expect(chips).toBeGreaterThan(-1);
    expect(from(out, 'lab-pivot-chips')).toContain('>self<');
    expect(chips).toBeLessThan(scroll);
    // The scroll box holds only the table: no chip button inside it.
    const scrollBox = from(out, 'lab-pivot-scroll');
    const table = scrollBox.slice(0, scrollBox.indexOf('</table>'));
    expect(table).not.toContain('>self<');
    expect(foot).toBeGreaterThan(scroll + table.length);
    expect(from(out, 'lab-pivot-foot')).toContain('Total');
  });

  it('the header cells are the sticky ones, at the top of the scroll box', () => {
    const out = renderPivot();
    expect(from(out, 'lab-pivot-scroll')).toMatch(/^class="lab-pivot-scroll"[^>]*overflow:auto[^>]*><table[^>]*><thead class="lab-pivot-head">/);
    const css = readFileSync(join(LAB, 'BreakdownPivot.css'), 'utf-8');
    expect(css).toMatch(/\.lab-pivot-head th \{[^}]*position: sticky;[^}]*top: 0;[^}]*background: var\(--color-bg-tertiary\);/);
    // Fit: the view clips, chips/total never shrink, the table box shrinks into the rest and scrolls.
    expect(css).toMatch(/\.lab-pivot--fit \{[^}]*flex-direction: column;[^}]*overflow: hidden;/);
    expect(css).toMatch(/\.lab-pivot--fit > \.lab-pivot-chips,\s*\.lab-pivot--fit > \.lab-pivot-foot \{\s*flex: none;/);
    expect(css).toMatch(/\.lab-pivot--fit > \.lab-pivot-scroll \{[^}]*min-height: 0;/);
    const block = readFileSync(join(LAB, 'blocks/dataBlocks.css'), 'utf-8');
    expect(block).toMatch(/\.lab-block-pivot \{[^}]*flex-direction: column;[^}]*min-height: 0;[^}]*overflow: hidden;/);
  });
});

describe('pivotFit: the table scroll box always has room for its sticky header', () => {
  // WebKit, 2-row card: a 38px block, chips 33 + total 25 left the scroll box 0px tall,
  // so the 31px sticky header was pushed out of it on scroll (verify: after -30).
  it('a short cell drops the total line first, then the chips; the table keeps header + a row', () => {
    expect(pivotFit(300, 33, 25, false)).toEqual({ chips: true, foot: true });
    expect(pivotFit(110, 33, 25, false)).toEqual({ chips: true, foot: false });
    expect(pivotFit(38, 33, 25, false)).toEqual({ chips: false, foot: false });
    // Whatever stays, the room left is never under header + one row (64px) when it can be.
    for (const h of [38, 80, 97, 110, 122, 200]) {
      const s = pivotFit(h, 33, 25, false);
      const left = h - (s.chips ? 33 : 0) - (s.foot ? 25 : 0);
      expect(left >= 64 || (!s.chips && !s.foot), `h=${h}`).toBe(true);
    }
  });

  it('never hides the chips while a filter is applied, nor chips a view does not have', () => {
    expect(pivotFit(38, 33, 25, true)).toEqual({ chips: true, foot: false });
    expect(pivotFit(38, 0, 25, false)).toEqual({ chips: false, foot: false });
    expect(pivotFit(100, 0, 25, false)).toEqual({ chips: false, foot: true });
  });

  it('unmeasured (server render, first paint): everything shows', () => {
    expect(pivotFit(0, 33, 25, false)).toEqual({ chips: true, foot: true });
  });
});

describe('the breakdown render elsewhere keeps its layout', () => {
  it('BreakdownBody (card, detail panel) draws the same pivot without the fit column', () => {
    const set = frameToMatrixSet(FRAME as Extract<Frame, { kind: 'table' }>);
    const summary = { unit: null } as never;
    const cache = { fetchedAt: '2026-09-28T00:00:00Z', matrix: { set, notices: [], range: { fromISO: '', toISO: '' } } } as never;
    for (const full of [false, true]) {
      const out = html(createElement(BreakdownBody as never, { summary, cache, series: [], full } as never));
      expect(out).toContain('class="lab-pivot"');
      expect(out).not.toContain('lab-pivot--fit');
      expect(out).not.toContain('lab-pivot-host');
      expect(out).toContain('<thead class="lab-pivot-head">');
      expect(out).toContain('>Lemuria<');
    }
  });
});
