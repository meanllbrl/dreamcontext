/**
 * The board `benchmark` block (W2-L5, unregistered until W3): one row per
 * benchmarkRows entry of the card's slice, floor / now / target on one ruler at
 * their linear-scale positions, the change vs the previous window with a status
 * word that `better: 'lower'` flips, each bound's source, the inherited-band
 * note, and "Not measured: reason" with no marker (never a 0). Static markup
 * through the dashboard's own React; the ruler's size hook is pinned to 300px
 * so markers are drawn. Synthetic Acme vocabulary only.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import {
  benchmarkRows,
  funnelSlice,
  type FunnelFrame,
  type FunnelFrameMetric,
} from '../../dashboard/src/generated/frameOps.js';
import type { Block, BlockProps } from '../../dashboard/src/components/lab/board/boardTypes.js';

const COPY: Record<string, string> = {
  'lab.blocks.benchmark.floor': 'Floor',
  'lab.blocks.benchmark.target': 'Target',
  'lab.blocks.benchmark.current': 'Now',
  'lab.blocks.benchmark.prev': 'Previous',
  'lab.blocks.benchmark.delta': '{delta} vs previous window',
  'lab.blocks.benchmark.noBand': 'No band set',
  'lab.blocks.benchmark.notMeasured': 'Not measured: {reason}',
  'lab.blocks.benchmark.inherited': 'Band from the whole funnel (this selection has none of its own)',
  'lab.blocks.benchmark.source': '{bound} from {source}',
  'lab.blocks.benchmark.improving': 'Improving',
  'lab.blocks.benchmark.worsening': 'Worsening',
  'lab.blocks.benchmark.flat': 'Flat',
  'lab.blocks.benchmark.status.below': 'Below floor',
  'lab.blocks.benchmark.status.between': 'Between floor and target',
  'lab.blocks.benchmark.status.above': 'At target',
  'lab.blocks.benchmark.more': '+{n} more metrics. Make the card taller to see them.',
  'lab.blocks.breakdown.noPath': 'No measured path for this combination.',
  'lab.blocks.explorer.unknownFunnel': 'Funnel {id} is not in the data. Showing {name}.',
  'lab.blocks.explorer.unknownMetrics': 'Not in the data: {keys}',
  'lab.blocks.explorer.notSplit': 'Not split by {dims}',
  'lab.blocks.explorer.lowSample': 'Low sample: {n} users',
};

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => COPY[key] ?? key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

const RULER_W = 300;
vi.mock('../../dashboard/src/components/lab/chart/useChartSize.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    useChartSize: () => {
      const ref = Object.assign(() => {}, { current: null });
      return { ref, width: RULER_W, height: 32, fontPx: 12, measure: (s: string) => s.length * 7, dpr: 1, ready: true };
    },
  };
});

const { BenchmarkBlock, benchmarkFit, formatMetric, rulerScale, rulerZones, toneOf } = await import(
  '../../dashboard/src/components/lab/blocks/BenchmarkBlock.js'
);

const m = (v: number | null, prev: number | null, extra: Partial<FunnelFrameMetric> = {}): FunnelFrameMetric => ({
  v, prev, format: 'pct', label: null, measured: true, reason: null, ...extra,
});

const DENOM = 'denominator event missing on one branch';
const FEW = 'fewer than 300 users in the window';

function frame(): FunnelFrame {
  const steps = [
    { key: 'visit', label: 'Visit', users: 5000 },
    { key: 'lead', label: 'Lead', users: 2000 },
    { key: 'buy', label: 'Buy', users: 400 },
  ];
  return {
    kind: 'funnel',
    insight: 'acme-funnel-explorer',
    segmentMode: 'lookup',
    lowSample: 50,
    dimensions: [
      { key: 'platform', label: 'Platform', values: ['Meta Ads', 'TikTok Ads'] },
      { key: 'language', label: 'Language', values: ['EN', 'ES'] },
    ],
    bands: {
      lead_rate: { floor: 30, target: 45, floorSource: 'book', targetSource: 'own p25 (8 wk)', better: 'higher' },
      cost_per_lead: { floor: 12, target: 6, floorSource: 'book', targetSource: null, better: 'lower' },
    },
    funnels: [
      {
        id: 'quiz',
        name: 'Quiz checkout (v2)',
        steps,
        metrics: {
          lead_rate: m(40, 35, { label: 'Lead rate' }),
          cost_per_lead: m(8, 10, { format: 'usd', label: 'Cost per lead' }),
          checkout_to_purchase: m(null, null, { label: 'Checkout to purchase', measured: false, reason: DENOM }),
        },
        segments: [
          {
            dims: { platform: 'Meta Ads' }, users: 3000, measured: true, reason: null,
            steps: [{ key: 'visit', users: 3000 }, { key: 'lead', users: 1300 }, { key: 'buy', users: 300 }],
            metrics: { lead_rate: m(43, 43), cost_per_lead: m(13, 11, { format: 'usd' }) },
          },
          {
            dims: { platform: 'TikTok Ads' }, users: 2000, measured: true, reason: null,
            steps: [{ key: 'visit', users: 2000 }, { key: 'lead', users: 700 }, { key: 'buy', users: 100 }],
            metrics: { lead_rate: m(35, 30) },
            bands: { lead_rate: { floor: 20, target: 32, floorSource: 'tiktok p25', targetSource: null, better: 'higher' } },
          },
          { dims: { platform: 'Meta Ads', language: 'ES' }, users: 0, measured: false, reason: FEW, steps: [] },
          {
            dims: { platform: 'TikTok Ads', language: 'ES' }, users: 20, measured: true, reason: null,
            steps: [{ key: 'visit', users: 20 }, { key: 'lead', users: 9 }],
            metrics: { lead_rate: m(45, 40) },
          },
        ],
      },
      { id: 'activation', name: 'Activation ladder', steps, metrics: { lead_rate: m(20, 20, { label: 'Activation rate' }) } },
    ],
  };
}

function render(options: Record<string, unknown> = {}, selection: Record<string, string> = {}, f: FunnelFrame = frame()): string {
  const block: Block = { type: 'benchmark' as Block['type'], data: 'acme-funnel-explorer', options };
  const props: BlockProps & { block: Block } = { frame: f, options, block, selection };
  return renderToStaticMarkup(createElement(BenchmarkBlock as never, props as never));
}

/** The markup of one row (`data-lab-bench-row="key"` up to its closing li). */
function row(html: string, key: string): string {
  const start = html.indexOf(`data-lab-bench-row="${key}"`);
  expect(start, `row ${key}`).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</li>', start));
}

const dataX = (html: string, attr: string): number | null => {
  const hit = new RegExp(`${attr}=""[^>]*data-x="([\\d.]+)"`).exec(html);
  return hit ? Number(hit[1]) : null;
};

describe('benchmark: one row per metric on one ruler', () => {
  it('draws one row per benchmarkRows entry, labelled from the funnel metrics', () => {
    const html = render();
    const keys = [...html.matchAll(/data-lab-bench-row="([^"]+)"/g)].map((x) => x[1]);
    expect(keys).toEqual(['lead_rate', 'cost_per_lead', 'checkout_to_purchase']);
    expect(row(html, 'lead_rate')).toContain('Lead rate');
    expect(row(html, 'lead_rate')).toContain('40%');
  });

  it('places floor, target, current and the previous ghost at their scale positions (within 1px)', () => {
    const html = row(render(), 'lead_rate');
    const r = benchmarkRows(funnelSlice(frame(), null, {}), ['lead_rate'])[0];
    const scale = rulerScale(r, RULER_W, true)!;
    expect(scale).not.toBeNull();
    expect(Math.abs(dataX(html, 'data-lab-bench-current')! - scale(40))).toBeLessThan(1);
    expect(Math.abs(dataX(html, 'data-lab-bench-floor')! - scale(30))).toBeLessThan(1);
    expect(Math.abs(dataX(html, 'data-lab-bench-target')! - scale(45))).toBeLessThan(1);
    expect(Math.abs(dataX(html, 'data-lab-bench-prev')! - scale(35))).toBeLessThan(1);
    // The CSS left is the same x (the marker is centred on it).
    expect(html).toMatch(new RegExp(`data-lab-bench-current=""[^>]*left:${scale(40).toFixed(0)}`));
    // floor < prev < current < target along the ruler.
    expect(scale(30)).toBeLessThan(scale(35));
    expect(scale(40)).toBeLessThan(scale(45));
  });

  it('the scale pads its ends so no marker sits on an edge and a non-negative metric never goes below 0', () => {
    const r = benchmarkRows(funnelSlice(frame(), null, {}), ['lead_rate'])[0];
    const scale = rulerScale(r, RULER_W, true)!;
    expect(scale.domain[0]).toBeGreaterThanOrEqual(0);
    expect(scale(30)).toBeGreaterThan(7);
    expect(scale(45)).toBeLessThan(RULER_W - 7);
    expect(rulerScale(r, 0, true)).toBeNull();
    expect(rulerScale({ ...r, current: null }, RULER_W, true)).toBeNull();
  });

  it('the band zones tone below / between / above along the ruler, flipped for better: lower', () => {
    const [lead, cost] = benchmarkRows(funnelSlice(frame(), null, {}), ['lead_rate', 'cost_per_lead']);
    expect(rulerZones(lead, rulerScale(lead, RULER_W, true)!).map((z) => z.tone)).toEqual(['below', 'between', 'above']);
    expect(rulerZones(cost, rulerScale(cost, RULER_W, true)!).map((z) => z.tone)).toEqual(['above', 'between', 'below']);
    expect(toneOf(13, cost)).toBe('below');
    expect(toneOf(5, cost)).toBe('above');
  });
});

describe('benchmark: change, status word, sources', () => {
  it('prints the delta vs the previous window and the status and trend words', () => {
    const lead = row(render(), 'lead_rate');
    expect(lead).toContain('+5% vs previous window');
    expect(lead).toContain('data-status="between"');
    expect(lead).toContain('Between floor and target');
    expect(lead).toContain('Improving');
    expect(lead).toContain('data-trend="improving"');
  });

  it('better: lower flips it: a falling cost is improving, a rising one above the floor is worsening and below', () => {
    const down = row(render(), 'cost_per_lead');
    expect(down).toContain('−$2.00 vs previous window');
    expect(down).toContain('Improving');
    const up = row(render({}, { platform: 'Meta Ads' }), 'cost_per_lead');
    expect(up).toContain('data-status="below"');
    expect(up).toContain('Below floor');
    expect(up).toContain('Worsening');
    expect(up).toContain('+$2.00');
  });

  it('a flat change reads Flat', () => {
    expect(row(render({}, { platform: 'Meta Ads' }), 'lead_rate')).toContain('Flat');
  });

  it('prints each bound source (sources on by default), none when sources is off', () => {
    const lead = row(render(), 'lead_rate');
    expect(lead).toContain('Floor from book · Target from own p25 (8 wk)');
    expect(row(render(), 'cost_per_lead')).toContain('Floor from book');
    expect(row(render(), 'cost_per_lead')).not.toContain('Target from');
    expect(render({ sources: false })).not.toContain('data-lab-bench-source');
  });

  it('comparePrev: false drops the delta and the previous ghost', () => {
    const html = render({ comparePrev: false });
    expect(html).not.toContain('data-lab-bench-delta');
    expect(html).not.toContain('data-lab-bench-prev');
    expect(html).toContain('data-lab-bench-current');
  });

  it('notes an inherited band only when the selection has none of its own', () => {
    expect(render()).not.toContain('data-lab-bench-inherited');
    expect(render({}, { platform: 'Meta Ads' })).toContain('Band from the whole funnel');
    const own = render({}, { platform: 'TikTok Ads' });
    expect(own).not.toContain('data-lab-bench-inherited');
    expect(row(own, 'lead_rate')).toContain('Floor from tiktok p25');
  });
});

describe('benchmark: not measured is not zero', () => {
  it('an unmeasured metric reads Not measured: reason and draws no ruler or marker', () => {
    const r = row(render(), 'checkout_to_purchase');
    expect(r).toContain(`Not measured: ${DENOM}`);
    expect(r).toContain('data-status="unmeasured"');
    expect(r).not.toContain('data-lab-bench-ruler');
    expect(r).not.toContain('data-lab-bench-current');
    expect(r).not.toMatch(/>0%?</);
  });

  it('an unmeasured selection lists every metric as Not measured with the slice reason, no 0 anywhere', () => {
    const html = render({}, { platform: 'Meta Ads', language: 'ES' });
    expect(html).toContain('data-measured="false"');
    expect((html.match(new RegExp(`Not measured: ${FEW}`, 'g')) ?? []).length).toBe(3);
    expect(html).not.toContain('data-lab-bench-current');
    expect(html).not.toMatch(/>0%?</);
    expect(html).not.toContain('$0');
  });

  it('a selection with no segment at all falls back to the no-path sentence', () => {
    expect(render({}, { platform: 'Meta Ads', language: 'EN' })).toContain('Not measured: No measured path for this combination.');
  });
});

describe('benchmark: options and notes', () => {
  it('metrics picks and orders rows; an unknown key is noted, never silently dropped', () => {
    const html = render({ metrics: ['cost_per_lead', 'nope', 'lead_rate'] });
    expect([...html.matchAll(/data-lab-bench-row="([^"]+)"/g)].map((x) => x[1])).toEqual(['cost_per_lead', 'lead_rate']);
    expect(html).toContain('Not in the data: nope');
  });

  it('funnel picks a funnel; an unknown id shows the visible fallback note', () => {
    expect(render({ funnel: 'activation' })).toContain('Activation rate');
    const html = render({ funnel: 'ghost' });
    expect(html).toContain('Funnel ghost is not in the data. Showing Quiz checkout (v2).');
    expect(html).toContain('data-lab-unknown-funnel');
    expect(render({ funnel: 'quiz' })).not.toContain('data-lab-unknown-funnel');
  });

  it('notes a low-sample slice and a selection dim the data is not split by', () => {
    expect(render({}, { platform: 'TikTok Ads', language: 'ES' })).toContain('Low sample: 20 users');
    expect(render({}, { cohort: 'week 1' })).toContain('Not split by cohort');
  });

  it('script-authored strings render as text, never HTML', () => {
    const f = frame();
    f.funnels[0].metrics!.lead_rate.label = '<img src=x onerror=alert(1)>';
    f.bands!.lead_rate.floorSource = '<b>book</b>';
    const html = render({}, {}, f);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;b&gt;book&lt;/b&gt;');
  });

  it('a non-funnel frame or no frame is the shared empty state', () => {
    const options = {};
    const block: Block = { type: 'benchmark' as Block['type'], data: 'x', options };
    const html = renderToStaticMarkup(createElement(BenchmarkBlock as never, { frame: null, options, block } as never));
    expect(html).toContain('lab-block-empty');
  });
});

describe('benchmark: fits its cell without scrolling', () => {
  it('full rows when they fit, compact rows when not, then as many compact rows as fit', () => {
    expect(benchmarkFit(3, 0, 0, true)).toEqual({ mode: 'full', count: 3 });
    expect(benchmarkFit(3, 600, 0, true)).toEqual({ mode: 'full', count: 3 });
    expect(benchmarkFit(3, 200, 0, true)).toEqual({ mode: 'compact', count: 3 });
    const tight = benchmarkFit(8, 120, 0, true);
    expect(tight.mode).toBe('compact');
    expect(tight.count).toBeGreaterThanOrEqual(1);
    expect(tight.count).toBeLessThan(8);
  });

  it('formats every metric format', () => {
    expect(formatMetric(40, 'pct', 'en')).toBe('40%');
    expect(formatMetric(8, 'usd', 'en')).toBe('$8.00');
    expect(formatMetric(1.25, 'x', 'en')).toBe('1.25x');
    expect(formatMetric(12.5, 'seconds', 'en')).toBe('12.5s');
    expect(formatMetric(1204, 'count', 'en')).toBe('1,204');
    expect(formatMetric(-2, 'usd', 'en', true)).toBe('−$2.00');
    expect(formatMetric(0, 'pct', 'en', true)).toBe('0%');
  });
});

describe('benchmark.css speaks only in tokens', () => {
  it('no literal colours, sizes off the 12/14 ladder, weights off 400/600 or literal durations', () => {
    const css = readFileSync(join(__dirname, '../../dashboard/src/components/lab/blocks/benchmark.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\b(rgba?|hsla?)\(/i);
    for (const [, v] of css.matchAll(/font-size:\s*([^;]+);/g)) expect(v.trim()).toMatch(/^var\(--font-size-(xs|sm)\)$/);
    for (const [, v] of css.matchAll(/font-weight:\s*([^;]+);/g)) expect(v.trim()).toMatch(/^var\(--font-weight-(normal|semibold)\)$/);
    expect(css).not.toMatch(/(transition|animation)[^;]*\d+m?s/);
    expect(css).not.toContain('\u2014');
  });
});
