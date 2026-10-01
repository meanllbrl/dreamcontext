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
  'lab.blocks.benchmark.inheritedMark': 'Inherited',
  'lab.blocks.benchmark.inheritedTitle': "This metric has no band of its own for this selection: it uses the whole funnel's band.",
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

/** The block's measured box (the static render has none): 0 = not measured, the options alone decide. */
const BOX = { width: 0, height: 0 };
vi.mock('../../dashboard/src/components/lab/chartBody.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, useMeasured: () => [() => {}, { ...BOX }] };
});

const { BenchmarkBlock, allRowsInherit, reasonLines, benchmarkFit, benchRowPx, boundLabels, formatMetric, noteLines, rulerScale, rulerZones, toneOf, BENCH_PX } = await import(
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

describe('benchmark: the ruler explains itself', () => {
  it('a legend names every mark: floor, target, now and previous (previous only when compared)', () => {
    const html = render();
    const legend = html.slice(html.indexOf('data-lab-bench-legend'), html.indexOf('<ul'));
    for (const word of ['Floor', 'Target', 'Now', 'Previous']) expect(legend).toContain(`</span>${word}</span>`);
    expect(legend).toContain('lab-bench-key-mark--current');
    expect(render({ comparePrev: false })).not.toContain('lab-bench-key-mark--prev');
  });

  it('floor and target carry their numbers under the ruler, at their ticks', () => {
    const lead = row(render(), 'lead_rate');
    expect(lead).toContain('data-lab-bench-bound-label="floor"');
    expect(lead).toContain('>Floor 30%</span>');
    expect(lead).toContain('>Target 45%</span>');
  });

  it('bound labels never overlap: the left one ends at its tick, the right one starts at it; too close = numbers only; no room = none', () => {
    const measure = (s: string) => s.length * 7;
    const two = boundLabels([
      { key: 'floor', x: 100, word: 'Floor', value: '30%' },
      { key: 'target', x: 200, word: 'Target', value: '45%' },
    ], 300, measure);
    expect(two.map((b) => b.text)).toEqual(['Floor 30%', 'Target 45%']);
    expect(two[0].left + measure(two[0].text)).toBeLessThanOrEqual(100);
    expect(two[1].left).toBeGreaterThanOrEqual(200);
    const close = boundLabels([
      { key: 'floor', x: 140, word: 'Floor', value: '30%' },
      { key: 'target', x: 160, word: 'Target', value: '45%' },
    ], 200, measure);
    expect(close.map((b) => b.text)).toEqual(['30%', '45%']);
    expect(boundLabels([
      { key: 'floor', x: 10, word: 'Floor', value: '30%' },
      { key: 'target', x: 20, word: 'Target', value: '45%' },
    ], 30, measure)).toEqual([]);
  });

  it('the previous window is a number too, next to the signed change', () => {
    const lead = row(render(), 'lead_rate');
    expect(lead).toMatch(/class="lab-bench-delta-text">\+5%<\/span>/);
    expect(lead).toContain('Previous 35%');
    expect(lead).toContain('title="+5% vs previous window"');
  });

  it('the status is a word in a tinted pill, never a bare coloured dot', () => {
    const html = render();
    expect(html).not.toContain('lab-bench-status-dot');
    expect(row(html, 'lead_rate')).toMatch(/data-lab-bench-status=""><span class="lab-bench-status-word">Between floor and target</);
  });

  it('a mid-height cell draws one-line rows but keeps bound labels and sources', () => {
    Object.assign(BOX, { width: 800, height: 3 * benchRowPx('compact', true, true) + BENCH_PX.legend + BENCH_PX.note });
    try {
      const html = render();
      expect(html).toContain('data-mode="compact"');
      expect(html).toContain('data-labels=""');
      expect(html).toContain('data-sources=""');
      expect(html).toContain('data-lab-bench-source');
      expect(html).toContain('data-lab-bench-bound-label');
      expect(html).toContain('data-lab-bench-legend');
    } finally {
      Object.assign(BOX, { width: 0, height: 0 });
    }
  });

  it('a short cell keeps every metric as a one-line row before any "+N more"', () => {
    Object.assign(BOX, { width: 800, height: 3 * benchRowPx('compact', false, false) });
    try {
      const html = render();
      expect(html).toContain('data-mode="compact"');
      expect(html).not.toContain('data-labels');
      expect(html).not.toContain('data-lab-bench-bound-label');
      expect([...html.matchAll(/data-lab-bench-row=/g)]).toHaveLength(3);
      expect(html).not.toContain('lab-bench-more');
    } finally {
      Object.assign(BOX, { width: 0, height: 0 });
    }
  });
});

describe('benchmark: change, status word, sources', () => {
  it('prints the delta vs the previous window and the status and trend words', () => {
    const lead = row(render(), 'lead_rate');
    expect(lead).toContain('title="+5% vs previous window"');
    expect(lead).toContain('data-status="between"');
    expect(lead).toContain('Between floor and target');
    expect(lead).toContain('Improving');
    expect(lead).toContain('data-trend="improving"');
  });

  it('better: lower flips it: a falling cost is improving, a rising one above the floor is worsening and below', () => {
    const down = row(render(), 'cost_per_lead');
    expect(down).toContain('title="−$2.00 vs previous window"');
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

  it('each inheriting row carries its own visible inherited mark (meaning in title and aria); own-band rows carry none', () => {
    const f = frame();
    // TikTok Ads: its own band on lead_rate, the set's band on cost_per_lead (per metric).
    f.funnels[0].segments![1].metrics!.cost_per_lead = m(9, 10, { format: 'usd' });
    const html = render({}, { platform: 'TikTok Ads' }, f);
    const cost = row(html, 'cost_per_lead');
    expect(cost).toContain('class="lab-bench-inherit" data-inherited=""');
    expect(cost).toContain('>Inherited</span>');
    expect(cost).toContain('title="This metric has no band of its own for this selection: it uses the whole funnel&#x27;s band."');
    expect(cost).toContain('aria-label="This metric has no band of its own');
    expect(row(html, 'lead_rate')).not.toContain('data-inherited');
    // Not every row inherits: no card-level note.
    expect(html).not.toContain('data-lab-bench-inherited');
  });

  it('the mark sits on the sources line when it is drawn, else beside the status pill', () => {
    const f = frame();
    f.funnels[0].segments![1].metrics!.cost_per_lead = m(9, 10, { format: 'usd' });
    const full = row(render({}, { platform: 'TikTok Ads' }, f), 'cost_per_lead');
    expect(full).toMatch(/class="lab-bench-sources-line">.*data-lab-bench-source="">Floor from book<\/span><span class="lab-bench-inherit"/);
    const quiet = row(render({ sources: false }, { platform: 'TikTok Ads' }, f), 'cost_per_lead');
    expect(quiet).not.toContain('lab-bench-sources-line');
    expect(quiet).toMatch(/class="lab-bench-side"><span class="lab-bench-inherit"/);
  });

  it('the card-level note appears only when every banded row inherits', () => {
    const r = (floor: number | null, inherited: boolean) => ({ floor, target: null, inherited });
    expect(allRowsInherit([r(1, true), r(2, true), r(null, false)])).toBe(true);
    expect(allRowsInherit([r(1, true), r(2, false)])).toBe(false);
    expect(allRowsInherit([r(null, false)])).toBe(false);
    const meta = render({}, { platform: 'Meta Ads' });
    expect((meta.match(/data-lab-bench-inherited=""/g) ?? []).length).toBe(1);
    expect((meta.match(/data-inherited=""/g) ?? []).length).toBe(2);
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
    expect((html.match(new RegExp(`data-lab-bench-unmeasured="">Not measured: ${FEW}<`, 'g')) ?? []).length).toBe(3);
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
  it('tiers: full rows with details and legend, then one-line rows keeping labels and sources, then no details, no legend, then +N more', () => {
    const W = 800;
    expect(benchmarkFit(5, 0, 0, true)).toEqual({ mode: 'full', labels: true, sources: true, legend: true, count: 5 });
    expect(benchmarkFit(5, 400, 0, true, W)).toEqual({ mode: 'full', labels: true, sources: true, legend: true, count: 5 });
    expect(benchmarkFit(5, 300, 0, true, W)).toEqual({ mode: 'compact', labels: true, sources: true, legend: true, count: 5 });
    // The 12x12 preset tab (about 230px): one-line rows keep the bound labels, the sources yield.
    expect(benchmarkFit(5, 230, 0, true, W)).toEqual({ mode: 'compact', labels: true, sources: false, legend: true, count: 5 });
    expect(benchmarkFit(5, 140, 0, true, W)).toEqual({ mode: 'compact', labels: false, sources: false, legend: true, count: 5 });
    expect(benchmarkFit(5, 120, 0, true, W)).toEqual({ mode: 'compact', labels: false, sources: false, legend: false, count: 5 });
    const tight = benchmarkFit(5, 80, 0, true, W);
    expect(tight).toMatchObject({ mode: 'compact', labels: false, sources: false, legend: false });
    expect(tight.count).toBeGreaterThanOrEqual(1);
    expect(tight.count).toBeLessThan(5);
  });

  it('5 metrics fit a 6x6 benchmark card: one-line rows are 23px, so 5 need 115px', () => {
    expect(benchRowPx('compact', true, false)).toBe(39);
    expect(benchRowPx('compact', false, false)).toBe(23);
    expect(5 * benchRowPx('compact', false, false)).toBeLessThanOrEqual(120);
    // Details cost one line for the bound labels and one for the sources.
    expect(benchRowPx('compact', true, true)).toBe(23 + 2 * BENCH_PX.line);
    expect(benchRowPx('compact', true, false)).toBe(23 + BENCH_PX.line);
    expect(benchRowPx('full', true, true)).toBeGreaterThan(benchRowPx('compact', true, true));
  });

  it('a narrow block keeps the ruler on its own line while that fits', () => {
    expect(benchmarkFit(5, 320, 0, true, 300)).toMatchObject({ mode: 'full', labels: true, sources: false, legend: true, count: 5 });
    expect(benchmarkFit(5, 400, 0, true, 300)).toMatchObject({ mode: 'full', labels: true, sources: true });
    expect(benchmarkFit(5, 240, 0, true, 300)).toMatchObject({ mode: 'full', labels: false, sources: false, legend: true });
  });

  it('an unmeasured reason wraps (at most 3 lines) and the fit pays for its lines', () => {
    expect(reasonLines(40, 0)).toBe(1);
    expect(reasonLines(40, 300)).toBe(1);
    expect(reasonLines(60, 200)).toBe(2);
    expect(reasonLines(500, 100)).toBe(3);
    expect(benchmarkFit(5, 125, 0, false, 480)).toMatchObject({ mode: 'compact', count: 5 });
    const wrapped = benchmarkFit(5, 125, 0, false, 480, [200]);
    expect(wrapped.legend).toBe(false);
    const css = readFileSync(join(__dirname, '../../dashboard/src/components/lab/blocks/benchmark.css'), 'utf8');
    const at = css.indexOf('.lab-bench-unmeasured {');
    const rule = css.slice(at, css.indexOf('}', at));
    expect(rule).toContain('white-space: normal');
    expect(rule).toContain('-webkit-line-clamp: 3');
    expect(rule).not.toContain('text-overflow: ellipsis');
  });

  it('a tier the rendered block proved too tall is skipped, and past the last tier rows fold into +N more', () => {
    expect(benchmarkFit(5, 400, 0, true, 800).mode).toBe('full');
    expect(benchmarkFit(5, 400, 0, true, 800, [], 1)).toMatchObject({ mode: 'compact', labels: true });
    expect(benchmarkFit(5, 400, 0, true, 800, [], 6).count).toBe(4);
  });

  it('notes cost their wrapped lines', () => {
    expect(noteLines('x'.repeat(100), 0)).toBe(1);
    expect(noteLines('x'.repeat(100), 325)).toBe(2);
    expect(benchmarkFit(5, 140, 1, true, 800).legend).toBe(false);
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
