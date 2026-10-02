/**
 * Demo run 2 findings for the table, the stat and the funnel:
 *   - one number style per table column (`auto` resolves once, from the column's
 *     largest value: never "12.4K" above "5,200");
 *   - the table total counts the source rows it covers (an "Other (2)" fold is two);
 *   - a big stat is written whole from 1,000 up (no cents), its change and goal too;
 *   - a narrow tile or funnel drops whole parts instead of cutting text: the stat's
 *     change sentence and goal line are one-line flex-wrap boxes (a part that does
 *     not fit wraps onto the clipped second line, the full text in the tooltip), and
 *     the funnel's step marker goes full, then arrow + percent, then tooltip only.
 * Static markup through the dashboard's own React plus the pure helpers; the
 * rendered geometry at a narrowed board is measured by the lab-boards verify run.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { Frame } from '../../dashboard/src/generated/frameOps.js';
import type { Block, BlockProps } from '../../dashboard/src/components/lab/board/boardTypes.js';

const COPY: Record<string, string> = {
  'lab.blocks.stat.ofGoal': '{pct} of goal',
  'lab.blocks.stat.goal': 'Goal {v}',
  'lab.blocks.stat.vsDay': 'vs previous day',
  'lab.blocks.stat.vsPrev': 'vs previous',
  'lab.blocks.otherCount': 'Other ({n})',
  'lab.blocks.table.total': 'Total',
  'lab.blocks.table.rows': 'rows',
  'lab.blocks.funnel.ofPrev': '{pct} of prev. step',
};

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => COPY[key] ?? key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

const { FrameTable, columnMagnitude, coveredRows } = await import('../../dashboard/src/components/lab/MetricTable.js');
const { NumberCard, wholeFigure } = await import('../../dashboard/src/components/lab/NumberCard.js');
const { StatBlock, statFormatter } = await import('../../dashboard/src/components/lab/blocks/StatBlock.js');
const { funnelStepMode } = await import('../../dashboard/src/components/lab/blocks/FunnelBlock.js');
const { FunnelBars } = await import('../../dashboard/src/components/lab/funnel/FunnelBars.js');

const html = renderToStaticMarkup;
const DIMS = [{ key: 'country', label: 'Country' }];
/** The demo's Top countries after sync: eight countries and a fold of two. */
const COUNTRIES = [
  { d: { country: 'United States' }, v: 12400, prev: 11800 },
  { d: { country: 'Germany' }, v: 5200, prev: 4900 },
  { d: { country: 'United Kingdom' }, v: 4700, prev: 4650 },
  { d: { country: 'Brazil' }, v: 3900, prev: 3350 },
  { d: { country: 'Japan' }, v: 3300, prev: 3400 },
  { d: { country: 'India' }, v: 2900, prev: 2400 },
  { d: { country: 'France' }, v: 2600, prev: 2500 },
  { d: { country: 'Canada' }, v: 2100, prev: 2050 },
  { d: {}, v: 2700, prev: 2500, other: 2 },
];

describe('one number style per table column', () => {
  it('the magnitude is the column\'s largest absolute value', () => {
    expect(columnMagnitude([5200, -12400, null, undefined, 300])).toBe(12400);
    expect(columnMagnitude([])).toBe(0);
  });

  it('auto resolves once per column: every value compact when the largest is, never 12.4K beside 5,200', () => {
    const out = html(createElement(FrameTable, { dims: DIMS, rows: COUNTRIES, unit: 'users' }));
    for (const s of ['>12.4K<', '>5.2K<', '>2.1K<', '>11.8K<', '>4.9K<']) expect(out).toContain(s);
    expect(out).not.toContain('>5,200<');
    expect(out).not.toContain('>4,900<');
    // The change column's largest move is 600: it stays plain digits, all of it.
    expect(out).toContain('>+600<');
    expect(out).toContain('>+550<');
  });

  it('a column of small values stays plain', () => {
    const rows = [{ d: { country: 'Mu' }, v: 5200 }, { d: { country: 'Lemuria' }, v: 900 }];
    const out = html(createElement(FrameTable, { dims: DIMS, rows, unit: null }));
    expect(out).toContain('>5,200<');
    expect(out).toContain('>900<');
  });
});

describe('the total counts the source rows it covers', () => {
  it('an Other (n) fold counts as n rows', () => {
    expect(coveredRows(9, COUNTRIES)).toBe(10);
    expect(coveredRows(3, [{}, {}, {}])).toBe(3);
    expect(coveredRows(4, [{}, { other: 1 }, { other: 5 }])).toBe(8);
  });

  it('the demo table reads "Total (10 rows)" over eight countries and Other (2)', () => {
    const out = html(createElement(FrameTable, { dims: DIMS, rows: COUNTRIES, unit: 'users', total: { count: 9, v: 39800, n: null } }));
    expect(out).toContain('Total (10 rows)');
    expect(out).toContain('Other (2)');
  });
});

describe('a big stat is written whole', () => {
  it('from 1,000 up, number and currency drop the decimals; the currency keeps its symbol', () => {
    expect(wholeFigure(52073)).toBe(true);
    expect(wholeFigure(-1000)).toBe(true);
    expect(wholeFigure(999.5)).toBe(false);
    expect(wholeFigure(null)).toBe(false);
    const usd = statFormatter(52073, 'currency', null, 'en');
    expect(usd(52073)).toBe('$52,073');
    expect(usd(60000)).toBe('$60,000');
    expect(usd(212)).toBe('$212');
    expect(statFormatter(52073.46, 'number', null, 'en')(52073.46)).toBe('52,073');
  });

  it('below 1,000 the precision stays; compact and percent keep their own', () => {
    expect(statFormatter(999.5, 'currency', null, 'en')(999.5)).toBe('$999.50');
    expect(statFormatter(12.25, 'number', null, 'en')(12.25)).toBe('12.25');
    expect(statFormatter(52073, 'compact', null, 'en')(52073)).toBe('52.1K');
  });

  it('the demo MRR tile: "$52,073", "+$212", "Goal $60,000", no cents anywhere', () => {
    const frame: Frame = { kind: 'value', insight: 'mrr', value: 52073, prev: 51861, spark: [51000, 51861, 52073], unit: 'usd' };
    const options = { format: 'currency', delta: 'prev', goal: 60000 };
    const block: Block = { type: 'stat', data: 'mrr', options };
    const out = html(createElement(StatBlock as never, { frame, options, block } as BlockProps as never));
    expect(out).toContain('>$52,073<');
    expect(out).toContain('+$212');
    expect(out).toContain('Goal $60,000');
    expect(out).not.toContain('.00');
  });
});

describe('a narrow stat drops whole parts, never cuts a word', () => {
  const series = [{ name: 's', points: [{ t: '1', v: 1200 }, { t: '2', v: 1240 }] }];
  const out = html(createElement(NumberCard, { latest: 1240, unit: null, series, period: 'vs previous day', goal: 2000 }));

  it('the change sentence is a line of separate parts, with the whole sentence as its tooltip', () => {
    expect(out).toMatch(/class="lab-stat-delta lab-stat-line" title="\+40 \(\+3\.3%\) vs previous day"/);
    // The arrow + figure, the percent and the period are separate flex items, in drop order.
    expect(out).toMatch(/<span class="lab-delta" data-dir="up"[^>]*>.*<\/span><span class="lab-delta lab-stat-change" data-dir="up" data-colored="">\(\+3\.3%\)<\/span><span class="lab-stat-period">vs previous day<\/span>/s);
  });

  it('the goal line is the same kind of line, its tooltip holding both halves', () => {
    expect(out).toMatch(/class="lab-stat-goal-text lab-stat-line" title="62% of goal · Goal 2,000"/);
  });

  it('the stylesheet makes that line exactly one line tall, wrapping parts onto the clipped second line', () => {
    const css = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab/NumberCard.css'), 'utf-8');
    const rule = css.match(/\.lab-stat-line \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('flex-wrap: wrap;');
    expect(rule).toContain('overflow: hidden;');
    expect(rule).toContain('height: calc(var(--font-size-xs) * var(--line-height-normal));');
    expect(rule).toContain('line-height: var(--line-height-normal);');
    expect(css).not.toContain('text-overflow: ellipsis');
  });
});

describe('the funnel\'s step marker fits its row', () => {
  const need = { value: 90, full: 130, short: 50 };

  it('full sentence when there is room, then arrow + percent, then none; unmeasured is full', () => {
    // Row 500: label 160, gaps 16, track 24 -> 300 for the value column.
    expect(funnelStepMode(500, need)).toBe('full');
    // Row 300: label 96 -> 164: the short marker (140) fits, the full one (220) does not.
    expect(funnelStepMode(300, need)).toBe('short');
    // Row 200: label 72 -> 88: not even the count and the short marker.
    expect(funnelStepMode(200, need)).toBe('none');
    expect(funnelStepMode(0, need)).toBe('full');
  });

  const steps = [{ key: 'a', label: 'Installed', users: 1000 }, { key: 'b', label: 'Signed up', users: 700 }];
  const label = (pct: string) => `${pct} of prev. step`;

  it('short: the arrow and the percent, the sentence in the marker\'s and the row\'s tooltip', () => {
    const out = html(createElement(FunnelBars, { steps, fill: true, stepLabel: label, stepMode: 'short' }));
    expect(out).toMatch(/class="funnel-bars-step" data-step-pct="70\.0" title="70% of prev\. step"><svg[^>]*>.*<\/svg>70%<\/span>/s);
    expect(out).toMatch(/class="funnel-bars-row" title="Signed up: 700 users · 70\.0% of top · 70% of prev\. step"/);
  });

  it('full: the labelled sentence, as before', () => {
    const out = html(createElement(FunnelBars, { steps, fill: true, stepLabel: label }));
    expect(out).not.toContain('title="70% of prev. step"');
    expect(out).toMatch(/<\/svg>70% of prev\. step<\/span>/);
  });
});
