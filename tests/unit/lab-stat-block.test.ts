/**
 * The board `stat` block and NumberCard: `size` (the hero figure's px from the
 * measured box, and the fixed step without one), `goal` (a progress meter with
 * "x% of goal"), and the change as arrow + sign + percent + period. Static
 * markup through the dashboard's own React plus the pure sizing helpers.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { Frame } from '../../dashboard/src/generated/frameOps.js';
import type { Block, BlockProps } from '../../dashboard/src/components/lab/board/boardTypes.js';

const COPY: Record<string, string> = {
  'lab.blocks.stat.ofGoal': '{pct} of goal',
  'lab.blocks.stat.goal': 'Goal {v}',
  'lab.blocks.stat.vsDay': 'vs previous day',
  'lab.blocks.stat.vsPrev': 'vs previous',
};

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => COPY[key] ?? key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

const { NumberCard, heroFontPx, goalPercent, periodKey, toStatSize } = await import('../../dashboard/src/components/lab/NumberCard.js');
const { StatBlock } = await import('../../dashboard/src/components/lab/blocks/StatBlock.js');

const html = (el: ReactElement) => renderToStaticMarkup(el);

const SERIES = [{ name: 's', points: [{ t: '1', v: 1100 }, { t: '2', v: 1200 }, { t: '3', v: 1234.5 }] }];
const VALUE_FRAME: Frame = { kind: 'value', insight: 'mrr', value: 1240, prev: 1200, spark: [1100, 1150, 1200, 1240], unit: null };
const SERIES_FRAME: Frame = {
  kind: 'series', insight: 'signups', unit: null, granularity: 'daily',
  series: [{ name: 'web', points: [{ t: '2026-09-01', v: 10 }, { t: '2026-09-02', v: 8 }] }],
};

function renderStat(options: Record<string, unknown>, frame: Frame = VALUE_FRAME): string {
  const block: Block = { type: 'stat', data: 'mrr', options };
  const props: BlockProps & { block: Block } = { frame, options, block };
  return html(createElement(StatBlock as never, props as never));
}

describe('size: the hero figure scales with the box', () => {
  it('without a box each size has its fixed step', () => {
    expect(heroFontPx('sm', null, 5)).toBe(24);
    expect(heroFontPx('md', null, 5)).toBe(32);
    expect(heroFontPx('lg', null, 5)).toBe(48);
    expect(heroFontPx('md', null, 5, 0, 1.25)).toBe(40);
  });

  it('in a box: lg > md > sm, and a bigger box a bigger figure', () => {
    const box = { width: 400, height: 160 };
    const sm = heroFontPx('sm', box, 5);
    const md = heroFontPx('md', box, 5);
    const lg = heroFontPx('lg', box, 5);
    expect(sm).toBeLessThan(md);
    expect(md).toBeLessThan(lg);
    expect(heroFontPx('lg', { width: 900, height: 500 }, 5)).toBeGreaterThan(lg);
  });

  it('a long figure in a narrow box shrinks to the width, never under the floor', () => {
    const wide = heroFontPx('lg', { width: 600, height: 300 }, 4);
    const long = heroFontPx('lg', { width: 600, height: 300 }, 14);
    expect(long).toBeLessThan(wide);
    expect(long * 14 * 0.62).toBeLessThanOrEqual(600);
    expect(heroFontPx('md', { width: 40, height: 20 }, 12)).toBe(20);
  });

  it('the rows under the figure (change, goal) come out of its height', () => {
    const box = { width: 2000, height: 200 };
    expect(heroFontPx('lg', box, 4, 60)).toBeLessThan(heroFontPx('lg', box, 4, 0));
  });

  it('the block passes the size through and fits its cell', () => {
    const lg = renderStat({ size: 'lg' });
    expect(lg).toContain('data-size="lg"');
    expect(lg).toContain('class="lab-stat lab-stat--lg lab-stat--fit"');
    expect(renderStat({})).toContain('class="lab-stat lab-stat--md lab-stat--fit"');
    expect(toStatSize('huge')).toBe('md');
  });

  it('a fit stat never scrolls: its content lies on an absolute inner box, the root clips', () => {
    const css = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab/NumberCard.css'), 'utf-8');
    expect(css).toMatch(/\.lab-stat--fit \{[^}]*overflow: hidden;/);
    expect(css).toMatch(/\.lab-stat--fit \.lab-stat-inner \{[^}]*position: absolute;[^}]*inset: 0;/);
    expect(css).not.toMatch(/overflow: (auto|scroll)/);
  });
});

describe('goal: progress meter and "x% of goal"', () => {
  it('goalPercent: value over goal, unclamped; no usable goal = null', () => {
    expect(goalPercent(62, 100)).toBe(62);
    expect(goalPercent(150, 100)).toBe(150);
    expect(goalPercent(5, 0)).toBeNull();
    expect(goalPercent(5, null)).toBeNull();
    expect(goalPercent(null, 10)).toBeNull();
  });

  it('draws the meter with its aria value and the share of the goal', () => {
    const out = html(createElement(NumberCard, { latest: 1240, unit: null, series: SERIES, goal: 2000 }));
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('aria-valuenow="62"');
    expect(out).toContain('data-goal-pct="62"');
    expect(out).toContain('style="width:62.0%"');
    expect(out).toContain('62% of goal');
    expect(out).toContain('Goal 2,000');
  });

  it('past the goal the bar is full and marked reached, the text says how far', () => {
    const out = html(createElement(NumberCard, { latest: 150, unit: null, series: SERIES, goal: 100 }));
    expect(out).toContain('data-reached=""');
    expect(out).toContain('aria-valuenow="100"');
    expect(out).toContain('150% of goal');
  });

  it('the block option: no goal no meter', () => {
    expect(renderStat({})).not.toContain('role="progressbar"');
    expect(renderStat({ goal: 0 })).not.toContain('role="progressbar"');
    expect(renderStat({ goal: 2000 })).toContain('data-goal-pct="62"');
  });
});

describe('delta: arrow + sign + percent + period', () => {
  it('a rise: the up arrow, a plus, the percent change and the period', () => {
    const out = renderStat({ delta: 'prev' });
    expect(out).toMatch(/class="lab-delta" data-dir="up" data-colored="">\s*<svg class="lab-delta-icon"[^>]*><path d="M5 1\.5 9 8\.5H1z"/);
    expect(out).toContain('>+40<');
    expect(out).toContain('(+3.3%)');
    expect(out).toContain('vs previous');
  });

  it('a fall on a daily series: the down arrow, a minus, "vs previous day"', () => {
    const out = renderStat({ delta: 'prev' }, SERIES_FRAME);
    expect(out).toContain('data-dir="down"');
    expect(out).toContain('>−2<');
    expect(out).toContain('(−20%)');
    expect(out).toContain('vs previous day');
  });

  it('delta none: no mark at all', () => {
    expect(renderStat({})).not.toContain('lab-delta');
  });

  it('periodKey names the grain', () => {
    expect(periodKey('daily')).toBe('lab.blocks.stat.vsDay');
    expect(periodKey('weekly')).toBe('lab.blocks.stat.vsWeek');
    expect(periodKey('monthly')).toBe('lab.blocks.stat.vsMonth');
    expect(periodKey(null)).toBe('lab.blocks.stat.vsPrev');
  });
});

describe('spark, unit and format', () => {
  it('the spark sits beside the figure in its own slot', () => {
    const out = renderStat({ spark: true });
    expect(out).toMatch(/class="lab-stat-main">.*class="lab-stat-value".*class="lab-stat-spark"/s);
  });

  it('format and unit reach the figure', () => {
    expect(renderStat({ format: 'compact' })).toContain('>1.2K<');
    expect(renderStat({ unit: 'orders' })).toContain('>orders<');
  });
});
