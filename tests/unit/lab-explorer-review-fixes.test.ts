/**
 * Wave 2 review minors, pinned (W3-L7):
 * 1. Segments: the focusable dash has an accessible name (its reason), and a
 *    measured row's null metric cell gives the SEGMENT's own reason, never the
 *    funnel level's.
 * 2. Funnel detail page, lookup mode: a lane path that skips a step is not
 *    measured there (listed as missing), never drawn as 0.
 * 3. Benchmark, cells mode: a selection's slice has no rates by design, so the
 *    block says so in one sentence instead of a row per metric.
 * Also FunnelBars' optional `worstKey` (the bars layout's markWorst row).
 * Static markup through the dashboard's own React. Synthetic Acme vocabulary.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { FunnelFrame, FunnelFrameMetric } from '../../dashboard/src/generated/frameOps.js';
import type { Block, BlockProps } from '../../dashboard/src/components/lab/board/boardTypes.js';

const COPY: Record<string, string> = {
  'lab.blocks.benchmark.notMeasured': 'Not measured: {reason}',
  'lab.blocks.benchmark.cellsNoRates': 'Rates are not measured for a combined selection',
  'lab.blocks.breakdown.noPath': 'No measured path for this combination.',
  'lab.blocks.segments.users': 'Users',
};

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => COPY[key] ?? key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

vi.mock('../../dashboard/src/components/lab/chart/useChartSize.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    useChartSize: () => {
      const ref = Object.assign(() => {}, { current: null });
      return { ref, width: 300, height: 32, fontPx: 12, measure: (s: string) => s.length * 7, dpr: 1, ready: true };
    },
  };
});

const { SegmentsBlock } = await import('../../dashboard/src/components/lab/blocks/SegmentsBlock.js');
const { BenchmarkBlock, cellsNoRates } = await import('../../dashboard/src/components/lab/blocks/BenchmarkBlock.js');
const { laneStepsOf } = await import('../../dashboard/src/components/lab/funnel/FunnelDetailPage.js');
const { FunnelBars } = await import('../../dashboard/src/components/lab/funnel/FunnelBars.js');
const { funnelSlice } = await import('../../dashboard/src/generated/frameOps.js');

const m = (v: number | null, extra: Partial<FunnelFrameMetric> = {}): FunnelFrameMetric => ({
  v, prev: null, format: 'pct', label: null, measured: true, reason: null, ...extra,
});

const FUNNEL_REASON = 'denominator event missing on one branch';
const SEGMENT_REASON = 'checkout event not sent by this platform';

function frame(mode: 'lookup' | 'cells'): FunnelFrame {
  return {
    kind: 'funnel',
    insight: 'acme-funnel-explorer',
    segmentMode: mode,
    dimensions: [{ key: 'platform', label: 'Platform', values: ['Meta Ads', 'TikTok Ads'] }],
    funnels: [{
      id: 'quiz',
      name: 'Quiz checkout (v2)',
      steps: [{ key: 'visit', label: 'Visit', users: 5000 }, { key: 'buy', label: 'Buy', users: 400 }],
      metrics: {
        lead_rate: m(40, { label: 'Lead rate' }),
        checkout_to_purchase: m(null, { label: 'Checkout to purchase', measured: false, reason: FUNNEL_REASON }),
      },
      segments: [
        {
          dims: { platform: 'Meta Ads' }, users: 3000, measured: true, reason: null,
          steps: [{ key: 'visit', users: 3000 }, { key: 'buy', users: 300 }],
          metrics: { lead_rate: m(48), checkout_to_purchase: m(null, { measured: false, reason: SEGMENT_REASON }) },
        },
        {
          dims: { platform: 'TikTok Ads' }, users: 2000, measured: true, reason: null,
          steps: [{ key: 'visit', users: 2000 }, { key: 'buy', users: 100 }],
          metrics: { lead_rate: m(25) },
        },
      ],
    }],
  };
}

function render(component: unknown, type: string, f: FunnelFrame, options: Record<string, unknown>, selection: Record<string, string> = {}): string {
  const block: Block = { type: type as Block['type'], data: 'acme-funnel-explorer', options };
  const props: BlockProps & { block: Block } = { frame: f, options, block, selection };
  return renderToStaticMarkup(createElement(component as never, props as never));
}

function cell(html: string, rowValue: string, metric: string): string {
  const row = html.indexOf(`data-lab-segment-row="${rowValue}"`);
  const start = html.indexOf(`data-metric="${metric}"`, row);
  return html.slice(start, html.indexOf('</td>', start));
}

describe('1. segments dash: accessible name, the segment\'s own reason', () => {
  const html = render(SegmentsBlock, 'segments', frame('lookup'), { by: 'platform' });

  it('a measured row\'s null cell names the SEGMENT reason, never the funnel-level one', () => {
    const meta = cell(html, 'Meta Ads', 'checkout_to_purchase');
    expect(meta).toContain(`Not measured: ${SEGMENT_REASON}`);
    expect(meta).not.toContain(FUNNEL_REASON);
  });

  it('a segment that does not carry the metric says no measured path, not the funnel reason', () => {
    const tiktok = cell(html, 'TikTok Ads', 'checkout_to_purchase');
    expect(tiktok).toContain('Not measured: No measured path for this combination.');
    expect(tiktok).not.toContain(FUNNEL_REASON);
  });

  it('the focusable dash carries its reason as its accessible name', () => {
    const meta = cell(html, 'Meta Ads', 'checkout_to_purchase');
    expect(meta).toMatch(new RegExp(`tabindex="0" role="img" aria-label="Not measured: ${SEGMENT_REASON}" data-lab-seg-unmeasured=""`));
    const dashes = [...html.matchAll(/<span class="lab-seg-dash"([^>]*)>/g)].map((x) => x[1]);
    expect(dashes.length).toBeGreaterThan(0);
    for (const attrs of dashes) expect(attrs).toMatch(/aria-label="Not measured: [^"]+"/);
  });
});

describe('2. funnel detail page: a lookup lane that skips a step is not measured there', () => {
  const spine = [
    { key: 'visit', label: 'Visit', users: 5000 },
    { key: 'lead', label: 'Lead', users: 2000 },
    { key: 'buy', label: 'Buy', users: 400 },
  ];
  const path = new Map([['visit', 300], ['buy', 20]]);

  it('lookup: the missing step is listed and left out of the drawn lane, no 0 anywhere', () => {
    const own = laneStepsOf(spine, path, 'lookup');
    expect(own.missing).toEqual([{ key: 'lead', label: 'Lead', users: 2000 }]);
    expect(own.steps).toEqual([{ key: 'visit', label: 'Visit', users: 300 }, { key: 'buy', label: 'Buy', users: 20 }]);
    expect(own.steps.some((s) => s.users === 0)).toBe(false);
  });

  it('cells: summed cells keep every step (a missing key in a sum is 0 cells)', () => {
    expect(laneStepsOf(spine, path, 'cells')).toEqual({
      steps: [{ key: 'visit', label: 'Visit', users: 300 }, { key: 'lead', label: 'Lead', users: 0 }, { key: 'buy', label: 'Buy', users: 20 }],
      missing: [],
    });
  });

  it('the page draws lanes, stacked bands and arc details through the lookup guard', () => {
    const src = readFileSync(join(new URL('../../', import.meta.url).pathname, 'dashboard/src/components/lab/funnel/FunnelDetailPage.tsx'), 'utf8');
    expect(src).toContain('laneStepsOf(laneSteps, lane.steps, segmentMode)');
    expect(src).toContain('data-lab-lane-missing=');
    expect(src).not.toMatch(/users: lane\.steps\.get\(s\.key\) \?\? 0/);
    expect(src).toMatch(/lane\.measured !== false && hasStep\(lane, step\.key\)/);
    expect(src).toMatch(/hasStep\(lane, arc\.from\) && hasStep\(lane, arc\.to\)/);
  });
});

describe('3. benchmark in cells mode: a selection has no rates, said in one sentence', () => {
  it('cells + selection: the sentence, no rows, no ruler, no "Not measured" per metric', () => {
    const html = render(BenchmarkBlock, 'benchmark', frame('cells'), {}, { platform: 'Meta Ads' });
    expect(html).toContain('data-lab-bench-cells-no-rates=""');
    expect(html).toContain('Rates are not measured for a combined selection');
    expect(html).not.toContain('lab-bench-rows');
    expect(html).not.toContain('data-lab-bench-current');
    expect(html).not.toContain('Not measured:');
  });

  it('the funnel level in cells mode and a lookup selection still draw their rows', () => {
    for (const [f, sel] of [[frame('cells'), {}], [frame('lookup'), { platform: 'Meta Ads' }]] as const) {
      const html = render(BenchmarkBlock, 'benchmark', f, {}, sel);
      expect(html).not.toContain('data-lab-bench-cells-no-rates');
      expect(html).toContain('lab-bench-rows');
    }
  });

  it('cellsNoRates: measured cells selection only', () => {
    const cells = frame('cells');
    expect(cellsNoRates(cells, funnelSlice(cells, null, { platform: 'Meta Ads' }))).toBe(true);
    expect(cellsNoRates(cells, funnelSlice(cells, null, {}))).toBe(false);
    const lookup = frame('lookup');
    expect(cellsNoRates(lookup, funnelSlice(lookup, null, { platform: 'Meta Ads' }))).toBe(false);
    const noSegmentMode: FunnelFrame = { ...cells, segmentMode: undefined };
    expect(cellsNoRates(noSegmentMode, funnelSlice(noSegmentMode, null, { platform: 'Meta Ads' }))).toBe(true);
  });
});

describe('FunnelBars worstKey: the worst row is marked, the default render unchanged', () => {
  const steps = [
    { key: 'visit', label: 'Visit', users: 400 },
    { key: 'lead', label: 'Lead', users: 100 },
    { key: 'buy', label: 'Buy', users: 20 },
  ];

  it('marks exactly the named row with data-lab-worst and a token tint', () => {
    const html = renderToStaticMarkup(createElement(FunnelBars as never, { steps, worstKey: 'buy' } as never));
    expect([...html.matchAll(/data-lab-worst="([^"]+)"/g)].map((x) => x[1])).toEqual(['buy']);
    expect(html).toMatch(/data-lab-worst="buy" style="background:color-mix\(in srgb, var\(--color-error\) 10%, transparent\)/);
    expect(html).toContain('background:var(--color-error)');
  });

  it('no worstKey (or null) draws byte-identical to before', () => {
    const plain = renderToStaticMarkup(createElement(FunnelBars as never, { steps } as never));
    expect(plain).not.toContain('data-lab-worst');
    expect(plain).not.toContain('--color-error');
    expect(renderToStaticMarkup(createElement(FunnelBars as never, { steps, worstKey: null } as never))).toBe(plain);
  });
});
