/**
 * Legacy insight renders fill their board cell like the new blocks: a chart
 * render (registry `fit: 'fill'`) mounts in a box of definite size with NO
 * scroll box around it and gets the measured height; table-like renders,
 * app/v1 and html/v1 bodies keep scrolling. Also the funnel block's fit (it
 * turns compact in a short cell, never scrolls) and `showConversion`.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { Frame } from '../../dashboard/src/generated/frameOps.js';
import type { Block, BlockProps } from '../../dashboard/src/components/lab/board/boardTypes.js';

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => (key === 'lab.blocks.funnel.ofPrev' ? '{pct} of prev. step' : key) }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

const { CHART_REGISTRY, RENDERS } = await import('../../dashboard/src/components/lab/chartRegistry.js');
const { InsightBlock } = await import('../../dashboard/src/components/lab/blocks/InsightBlock.js');
const { NumberBody } = await import('../../dashboard/src/components/lab/NumberCard.js');
const { FunnelBlock, funnelFit, funnelNaturalHeight } = await import('../../dashboard/src/components/lab/blocks/FunnelBlock.js');
const { FunnelBars } = await import('../../dashboard/src/components/lab/funnel/FunnelBars.js');

const html = (el: ReactElement) => renderToStaticMarkup(el);
const LAB = join(import.meta.dirname, '../../dashboard/src/components/lab');

const SERIES = [{ name: 'web', points: [{ t: '2026-09-01', v: 10 }, { t: '2026-09-02', v: 14 }, { t: '2026-09-03', v: 12 }] }];

function summary(render: string) {
  return {
    slug: 'signups', title: 'Signups', render, unit: null, latest: 12, granularity: 'daily', tweaks: [],
    size: null, width: null, height: null, binding: null, fetchedAt: null, error: null, errorAt: null,
    ttlMinutes: 60, staleMinutes: null, stale: null,
  };
}

function cache(extra: Record<string, unknown> = {}) {
  return { slug: 'signups', fetchedAt: '2026-09-03T00:00:00Z', tweaks: {}, granularity: 'daily', unit: null, series: SERIES, latest: 12, ...extra };
}

function renderInsight(render: string, extra: Record<string, unknown> = {}): string {
  const block: Block = { type: 'insight', options: {} };
  const props = { frame: null, options: {}, block, summary: summary(render), cache: cache(extra) };
  return html(createElement(InsightBlock as never, props as never));
}

/** The block's root element (its opening tag). */
const rootTag = (out: string) => /^<div [^>]*>/.exec(out)?.[0] ?? '';

describe('the registry says how each render sits in a cell', () => {
  const FILL = ['number', 'line', 'pie', 'bar', 'bar_compare', 'stacked', 'heatmap'];

  it('every render declares a fit; charts fill, table-like bodies scroll', () => {
    for (const r of RENDERS) {
      expect(['fill', 'scroll'], r).toContain(CHART_REGISTRY[r].fit);
      expect(CHART_REGISTRY[r].fit, r).toBe(FILL.includes(r) ? 'fill' : 'scroll');
    }
  });
});

describe('InsightBlock: no scroll box around chart renders', () => {
  it.each(['number', 'line', 'pie', 'bar', 'bar_compare', 'stacked', 'heatmap'])('%s fills the cell', (render) => {
    const out = renderInsight(render);
    const root = rootTag(out);
    expect(root).toContain('data-insight-fit="fill"');
    expect(root).not.toContain('lab-block-scroll');
    expect(out).not.toContain('lab-block-scroll');
    expect(out).toContain('<div class="lab-block-insight-body">');
  });

  it.each(['table', 'raw', 'breakdown', 'funnel'])('%s keeps its scroll box', (render) => {
    const root = rootTag(renderInsight(render));
    expect(root).toContain('data-insight-fit="scroll"');
    expect(root).toContain('lab-block-scroll');
  });

  it('html/v1 and app/v1 bodies scroll whatever the render', () => {
    // Their bodies need a DOM (the sandboxed frame), so the rule is read from the source.
    const src = readFileSync(join(LAB, 'blocks/InsightBlock.tsx'), 'utf-8');
    expect(src).toContain("const fill = !!entry && !cache?.app && !cache?.html && entry.fit === 'fill';");
  });

  it('the fill box is definite and clips; the body is placed absolutely inside it', () => {
    const css = readFileSync(join(LAB, 'blocks/dataBlocks.css'), 'utf-8');
    const fill = /\.lab-block-insight--fill \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(fill).toContain('overflow: hidden;');
    expect(fill).toContain('position: relative;');
    const body = /\.lab-block-insight-body \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(body).toContain('position: absolute;');
    expect(body).toContain('inset: 0;');
    expect(body).toContain('overflow: hidden;');
  });

  it('the fill body gets the measured height (ChartBodyProps.height)', () => {
    const src = readFileSync(join(LAB, 'blocks/InsightBlock.tsx'), 'utf-8');
    expect(src).toMatch(/<Body [^>]*height=\{height\}/);
    // No remount-on-data workaround: the foundation's size hook follows its element.
    expect(src).not.toMatch(/key=\{hasData/);
    // A number render fits (and scales) when the host passes a height.
    const withHeight = html(createElement(NumberBody as never, { summary: summary('number'), cache: null, series: SERIES, height: 200 } as never));
    const without = html(createElement(NumberBody as never, { summary: summary('number'), cache: null, series: SERIES } as never));
    expect(withHeight).toContain('lab-stat--fit');
    expect(without).not.toContain('lab-stat--fit');
  });

  it('a missing insight still renders the one root', () => {
    const block: Block = { type: 'insight', options: {} };
    const out = html(createElement(InsightBlock as never, { frame: null, options: {}, block } as never));
    expect(out).toContain('lab.blocks.insight.missing');
  });
});

describe('funnel block: fits its cell, step-to-step conversion', () => {
  const funnel: Frame = {
    kind: 'funnel', insight: 'onboarding',
    funnels: [
      { id: 'a', name: 'Signup', steps: [{ key: 's1', label: 'Visit', users: 100 }, { key: 's2', label: 'Join', users: 40 }, { key: 's3', label: 'Pay', users: 10 }] },
      { id: 'b', name: 'Checkout', steps: [{ key: 's1', label: 'Cart', users: 50 }, { key: 's2', label: 'Paid', users: 20 }] },
    ],
  };
  const render = (options: Record<string, unknown>) => {
    const block: Block = { type: 'funnel', data: 'onboarding', options };
    return html(createElement(FunnelBlock as never, { frame: funnel, options, block } as BlockProps as never));
  };

  it('tall enough: every funnel at natural density; short: dense by itself; very short: the first funnel only', () => {
    const counts = [3, 2];
    const natural = funnelNaturalHeight(counts, false);
    expect(funnelFit(counts, natural + 40, false)).toEqual({ dense: false, auto: false, count: 2, note: false });
    const short = funnelFit(counts, natural - 10, false);
    expect(short.dense).toBe(true);
    expect(short.auto).toBe(true);
    expect(funnelFit(counts, 50, false)).toEqual({ dense: true, auto: true, count: 1, note: false });
    // Room for the first funnel and the "+1 more" line, not for the second funnel.
    expect(funnelFit(counts, funnelNaturalHeight([3], true) + 12 + 18, false)).toMatchObject({ count: 1, note: true });
    // Unmeasured: the options alone decide.
    expect(funnelFit(counts, 0, false)).toEqual({ dense: false, auto: false, count: 2, note: false });
    expect(funnelFit(counts, 0, true)).toEqual({ dense: true, auto: false, count: 1, note: false });
  });

  it('the bars share the cell (fill grid) and the block never scrolls', () => {
    const out = render({});
    expect(out).toContain('funnel-bars--fill');
    expect(out).not.toContain('lab-block-scroll');
    const css = readFileSync(join(LAB, 'blocks/dataBlocks.css'), 'utf-8');
    expect(/\.lab-block-funnel--fit \{([^}]*)\}/.exec(css)?.[1]).toContain('overflow: hidden;');
  });

  it('the percent beside each count keeps its meaning: share of the first step, in both modes', () => {
    // Visit 100, Join 40, Pay 10: share of top = 40% and 10%; step to step = 40% and 25%.
    for (const out of [render({}), render({ showConversion: false })]) {
      expect(out).toContain('<span class="funnel-bars-pct"> · 40%</span>');
      expect(out).toContain('<span class="funnel-bars-pct"> · 10%</span>');
      expect(out).not.toContain('<span class="funnel-bars-pct"> · 25');
    }
  });

  it('showConversion (default on) ADDS the step-to-step rate as its own labelled marker; off drops only the marker', () => {
    const on = render({});
    expect(on).toContain('data-step-conversion=""');
    // Every step after the first carries arrow icon + "<pct> of prev. step"; the first has none.
    const markers = on.match(/<span class="funnel-bars-step" data-step-pct="[\d.]+"><svg class="funnel-bars-step-icon"[^>]*aria-hidden="true"[\s\S]*?<\/svg>[^<]*<\/span>/g) ?? [];
    expect(markers).toHaveLength(2 + 1); // Signup funnel: Join, Pay; Checkout: Paid
    // The first steps only hold an invisible, aria-hidden spacer (no number is read there).
    expect((on.match(/class="funnel-bars-step funnel-bars-step--spacer" aria-hidden="true"/g) ?? []).length).toBe(2);
    expect(on).toMatch(/data-step-pct="40\.0">[\s\S]*?<\/svg>40% of prev\. step<\/span>/);
    expect(on).toMatch(/data-step-pct="25\.0">[\s\S]*?<\/svg>25% of prev\. step<\/span>/);
    // The step rate never appears unlabelled in the share-of-top spot.
    expect(on).not.toMatch(/funnel-bars-pct"> · 25/);
    const off = render({ showConversion: false });
    expect(off).not.toContain('data-step-conversion');
    expect(off).not.toContain('funnel-bars-step');
    expect(off).not.toContain('of prev. step');
  });

  it('the funnel pages (no stepLabel) render exactly the old markup', () => {
    const steps = [{ key: 'a', label: 'Visit', users: 100 }, { key: 'b', label: 'Join', users: 40 }];
    const out = html(createElement(FunnelBars, { steps }));
    expect(out).toBe(
      '<div class="funnel-bars"><div class="funnel-bars-row" title="Visit: 100 users · 100.0% of top"><span class="funnel-bars-label">Visit</span>'
      + '<span class="funnel-bars-track"><span class="funnel-bars-fill" style="width:100%"></span></span><span class="funnel-bars-value">100'
      + '<span class="funnel-bars-pct"> · 100%</span></span></div>'
      + '<div class="funnel-bars-row" title="Join: 40 users · 40.0% of top"><span class="funnel-bars-label">Join</span>'
      + '<span class="funnel-bars-track"><span class="funnel-bars-fill" style="width:40%"></span></span><span class="funnel-bars-value">40'
      + '<span class="funnel-bars-pct"> · 40%</span></span></div></div>',
    );
  });
});
