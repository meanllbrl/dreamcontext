/**
 * The explorer's `trend` block (blocks/TrendBlock.tsx): the card selection's
 * slice (`funnelSlice`) as a daily series (`dailySeries`) drawn by the existing
 * LineBlock, or BarBlock with one column per day, chart options passed through.
 * The metric switch draws one metric at a time and switching changes the series;
 * a null day is a gap, never a 0; an unmeasured slice or metric says so in
 * words. Static markup through the dashboard's own React; the element tree of a
 * direct call (with a tiny hook harness) shows what reaches the chart.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, isValidElement, type ReactElement, type ReactNode } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { FunnelFrame, FunnelFrameMetric, SeriesFrame, TableFrame } from '../../dashboard/src/generated/frameOps.js';
import type { Block, BlockProps } from '../../dashboard/src/components/lab/board/boardTypes.js';

const COPY: Record<string, string> = {
  'lab.blocks.breakdown.all': 'All traffic',
  'lab.blocks.breakdown.noPath': 'No measured path for this combination.',
  'lab.blocks.explorer.notMeasured': 'Not measured for {sel}: {reason}',
  'lab.blocks.explorer.unknownFunnel': 'Funnel {id} is not in the data. Showing {name}.',
  'lab.blocks.explorer.lowSample': 'Low sample: {n} users',
  'lab.blocks.explorer.notSplit': 'Not split by {dims}',
  'lab.blocks.explorer.unknownMetrics': 'Not in the data: {keys}',
  'lab.blocks.trend.noDaily': 'No daily values for this selection.',
  'lab.blocks.trend.metric': 'Metric',
  'lab.blocks.breakdown.optionUnmeasured': '{value} (not measured)',
  'lab.blocks.trend.metricNotMeasured': '{metric} is not measured: {reason}',
  'lab.explorer.emptyDaily': 'No daily series in the snapshot. Add `daily` to each funnel.',
  'lab.explorer.emptyDailyPath': 'No daily series for {sel}: the snapshot carries daily for the funnel level only.',
  'lab.explorer.fill': 'To fill it: {hint}',
};

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => COPY[key] ?? key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

/** Direct calls get a slot-backed useState (slot 0 = the picked metric, slot 1 = the compact switch) and no effects; renders keep React's. */
const H: { on: boolean; slots: unknown[]; i: number; set: (i: number, v: unknown) => void } = {
  on: false, slots: [], i: 0, set: () => {},
};
vi.mock('../../dashboard/node_modules/react/index.js', async (orig) => {
  const real = (await orig()) as typeof import('react');
  return {
    ...real,
    useState: <T,>(init: T) => {
      if (!H.on) return real.useState(init);
      const k = H.i++;
      const v = k < H.slots.length ? H.slots[k] : init;
      return [v, (next: unknown) => H.set(k, next)];
    },
    useRef: <T,>(v: T) => (H.on ? { current: v } : real.useRef(v)),
    useEffect: (...a: Parameters<typeof real.useEffect>) => (H.on ? undefined : real.useEffect(...a)),
    useLayoutEffect: (...a: Parameters<typeof real.useLayoutEffect>) => (H.on ? undefined : real.useLayoutEffect(...a)),
  };
});

const { TrendBlock, trendKeys, pickMetrics, dailyTable } = await import('../../dashboard/src/components/lab/blocks/TrendBlock.js');
const { LineBlock } = await import('../../dashboard/src/components/lab/blocks/LineBlock.js');
const { BarBlock } = await import('../../dashboard/src/components/lab/blocks/BarBlock.js');

const metric = (v: number | null, label: string, extra: Partial<FunnelFrameMetric> = {}): FunnelFrameMetric => ({
  v, prev: null, format: 'pct', label, measured: true, reason: null, ...extra,
});
const STEPS = [{ key: 'visit', label: 'Visit', users: 1000 }, { key: 'lead', label: 'Lead', users: 400 }];

/** Synthetic Acme explorer, lookup mode: funnel-level and per-platform daily trends. */
function frame(): FunnelFrame {
  return {
    kind: 'funnel',
    insight: 'acme-funnel-explorer',
    segmentMode: 'lookup',
    dimensions: [
      { key: 'platform', label: 'Platform', values: ['Meta Ads', 'TikTok Ads'] },
      { key: 'language', label: 'Language', values: ['EN', 'ES'] },
    ],
    funnels: [
      {
        id: 'quiz',
        name: 'Quiz checkout (v2)',
        steps: STEPS,
        metrics: {
          lead_rate: metric(40, 'Lead rate'),
          cost_per_lead: metric(3.8, 'Cost per lead', { format: 'usd' }),
          checkout_to_purchase: metric(null, 'Checkout to purchase', { measured: false, reason: 'denominator event missing on one branch' }),
        },
        daily: [
          { t: '2026-09-01', m: { lead_rate: 38, cost_per_lead: 4.1, checkout_to_purchase: null } },
          { t: '2026-09-02', m: { lead_rate: null, cost_per_lead: 3.9, checkout_to_purchase: null } },
          { t: '2026-09-03', m: { lead_rate: 41.5, cost_per_lead: 3.6, checkout_to_purchase: null } },
        ],
        segments: [
          {
            dims: { platform: 'Meta Ads' }, users: 600, measured: true, reason: null,
            steps: [{ key: 'visit', users: 600 }, { key: 'lead', users: 250 }],
            metrics: { lead_rate: metric(42, 'Lead rate') },
            daily: [{ t: '2026-09-01', m: { lead_rate: 44 } }, { t: '2026-09-02', m: { lead_rate: 43 } }],
          },
          { dims: { platform: 'TikTok Ads' }, users: 120, steps: [], measured: false, reason: 'fewer than 300 users in the window' },
          {
            dims: { language: 'EN' }, users: 700, measured: true, reason: null,
            steps: [{ key: 'visit', users: 700 }], metrics: { lead_rate: metric(40, 'Lead rate') },
          },
        ],
      },
      { id: 'ladder', name: 'Activation ladder', steps: STEPS },
    ],
  };
}

type Props = Partial<BlockProps>;
const BLOCK: Block = { type: 'funnel', data: 'acme-funnel-explorer', options: {} };
const props = (p: Props) => ({ frame: frame(), options: {}, block: BLOCK, ...p }) as BlockProps & { block: Block };
const html = (p: Props) => renderToStaticMarkup(createElement(TrendBlock as never, props(p) as never) as ReactElement);

function tree(p: Props, slots: unknown[] = [], set: (i: number, v: unknown) => void = () => {}): ReactElement {
  Object.assign(H, { on: true, slots, i: 0, set });
  try {
    return (TrendBlock as (x: unknown) => ReactElement)(props(p));
  } finally {
    H.on = false;
  }
}
function findAll(node: ReactNode, pred: (el: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement(n)) return;
    const el = n as ReactElement<Record<string, unknown>>;
    if (pred(el)) out.push(el);
    walk(el.props.children as ReactNode);
  };
  walk(node);
  return out;
}
const chartOf = (root: ReactNode) => findAll(root, (e) => e.type === LineBlock || e.type === BarBlock)[0];
const seriesOf = (root: ReactNode) => (chartOf(root)?.props.frame as SeriesFrame | undefined)?.series ?? null;

describe('the trend draws the selection slice through the existing line chart', () => {
  it('default: a line chart of the first metric, exact daily values, a null day is a gap', () => {
    const root = tree({});
    expect(chartOf(root).type).toBe(LineBlock);
    expect(seriesOf(root)).toEqual([
      { name: 'Lead rate', points: [{ t: '2026-09-01', v: 38 }, { t: '2026-09-03', v: 41.5 }] },
    ]);
    expect((chartOf(root).props.frame as SeriesFrame).unit).toBe('%');
  });

  it('the selection picks its own path', () => {
    expect(seriesOf(tree({ selection: { platform: 'Meta Ads' } }))).toEqual([
      { name: 'Lead rate', points: [{ t: '2026-09-01', v: 44 }, { t: '2026-09-02', v: 43 }] },
    ]);
  });

  it('chart options pass through; colours are assigned over every metric', () => {
    const opts = { legend: 'top', axes: 'x', grid: false, format: 'percent' };
    const el = chartOf(tree({ options: opts }));
    expect(el.props.options).toEqual(opts);
    expect(el.props.colorDomain).toEqual({ series: ['Lead rate', 'Cost per lead', 'Checkout to purchase'], rows: [] });
  });

  it('renders to markup (the real chart, no throw)', () => {
    const out = html({});
    expect(out).toContain('data-lab-trend=""');
    expect(out).toContain('data-state="ok"');
    expect(out).toContain('data-lab-trend-chart="line"');
  });
});

describe('the metric switch: one series at a time', () => {
  it('a radio per metric, the first checked', () => {
    const out = html({});
    expect(out).toContain('role="radiogroup"');
    expect(out).toMatch(/data-lab-trend-metric="lead_rate"[^>]*aria-checked="true"/);
    expect(out).toMatch(/data-lab-trend-metric="cost_per_lead"[^>]*aria-checked="false"/);
    expect(out).toMatch(/data-lab-trend-metric="checkout_to_purchase"[^>]*data-measured="false"/);
  });

  it('clicking a metric picks it, and the picked metric changes the series', () => {
    const set = vi.fn();
    const root = tree({}, [], set);
    const cost = findAll(root, (e) => e.props['data-lab-trend-metric'] === 'cost_per_lead')[0];
    (cost.props.onClick as () => void)();
    expect(set).toHaveBeenCalledWith(0, 'cost_per_lead');
    const after = seriesOf(tree({}, ['cost_per_lead']));
    expect(after).toEqual([{
      name: 'Cost per lead',
      points: [{ t: '2026-09-01', v: 4.1 }, { t: '2026-09-02', v: 3.9 }, { t: '2026-09-03', v: 3.6 }],
    }]);
    expect(after).not.toEqual(seriesOf(root));
  });

  it('an unmeasured metric reads as not measured, with its reason, and draws no line', () => {
    const root = tree({}, ['checkout_to_purchase']);
    expect(chartOf(root)).toBeUndefined();
    const out = renderToStaticMarkup(root);
    expect(out).toContain('Checkout to purchase is not measured: denominator event missing on one branch');
    expect(out).not.toMatch(/>0%?</);
  });

  it('`switch: false` draws every measured metric together and names the unmeasured one', () => {
    const root = tree({ options: { switch: false } });
    expect(findAll(root, (e) => e.props['data-lab-trend-switch'] === '')).toHaveLength(0);
    expect(seriesOf(root)?.map((s) => s.name)).toEqual(['Lead rate', 'Cost per lead']);
    expect(renderToStaticMarkup(root)).toContain('Checkout to purchase is not measured');
  });

  it('`metrics` picks and orders; an unknown key is named', () => {
    const root = tree({ options: { metrics: ['cost_per_lead', 'lead_rate', 'nope'] } });
    const out = renderToStaticMarkup(root);
    expect(out).toContain('Not in the data: nope');
    expect(out.indexOf('data-lab-trend-metric="cost_per_lead"')).toBeLessThan(out.indexOf('data-lab-trend-metric="lead_rate"'));
    expect(seriesOf(root)?.[0].name).toBe('Cost per lead');
    expect(pickMetrics(['a', 'b'], null)).toEqual({ keys: ['a', 'b'], unknown: [] });
  });

  it('a single metric needs no switch', () => {
    expect(html({ selection: { platform: 'Meta Ads' } })).not.toContain('data-lab-trend-switch');
  });
});

describe('bar chart: one column per day', () => {
  it('`chart: bar` draws a day x metric table in date order, vertical, unsorted', () => {
    const el = chartOf(tree({ options: { chart: 'bar', grid: false } }));
    expect(el.type).toBe(BarBlock);
    const t = el.props.frame as TableFrame;
    expect(t.kind).toBe('table');
    expect(t.rows.map((r) => [r.d.day, r.v])).toEqual([['Sep 1', 38], ['Sep 3', 41.5]]);
    expect(el.props.options).toMatchObject({ orientation: 'v', sort: 'none', grid: false });
    expect(html({ options: { chart: 'bar' } })).toContain('data-lab-trend-chart="bar"');
  });

  it('dailyTable keeps dates in order and skips gaps', () => {
    const s: SeriesFrame = {
      kind: 'series', insight: 'x', unit: null, granularity: 'daily',
      series: [{ name: 'A', points: [{ t: '2026-09-02', v: 2 }, { t: '2026-09-01', v: 1 }] }, { name: 'B', points: [{ t: '2026-09-02', v: 5 }] }],
    };
    expect(dailyTable(s, (d) => d, 'Metric').rows).toEqual([
      { d: { day: '2026-09-01', metric: 'A' }, v: 1 },
      { d: { day: '2026-09-02', metric: 'A' }, v: 2 },
      { d: { day: '2026-09-02', metric: 'B' }, v: 5 },
    ]);
  });
});

describe('states: not measured, no daily, notes', () => {
  it('an unmeasured slice says so with its reason and draws no chart', () => {
    const out = html({ selection: { platform: 'TikTok Ads' } });
    expect(out).toContain('data-state="unmeasured"');
    expect(out).toContain('Not measured for TikTok Ads: fewer than 300 users in the window');
    expect(out).not.toContain('data-lab-trend-chart');
  });

  it('a measured path without days says the snapshot carries daily for the funnel level only', () => {
    const out = html({ selection: { language: 'EN' } });
    expect(out).toContain('data-state="no-daily"');
    expect(out).toContain('data-lab-empty="daily"');
    expect(out).toContain('data-scope="path"');
    expect(out).toContain('No daily series for EN: the snapshot carries daily for the funnel level only.');
  });

  it('a snapshot without any daily names the missing part and shows its fill hint', () => {
    const f = frame();
    delete f.funnels[0].daily;
    f.hints = { daily: 'kb_chart_query dims [event_date_parsed, funnel_id], granularity day' };
    const out = html({ frame: f });
    expect(out).toContain('data-lab-empty="daily"');
    expect(out).toContain('data-scope="set"');
    expect(out).toContain('No daily series in the snapshot. Add `daily` to each funnel.');
    expect(out).toContain('data-lab-hint=""');
    expect(out).toContain('To fill it: kb_chart_query dims [event_date_parsed, funnel_id], granularity day');
  });

  it('table: a day-by-day table under the chart, newest first, a missing day value is an empty cell', () => {
    const out = html({ options: { table: true, switch: false } });
    expect(out).toContain('data-lab-trend-table=""');
    const days = [...out.matchAll(/data-lab-trend-day="([^"]+)"/g)].map((m) => m[1]);
    expect(days).toEqual(['2026-09-03', '2026-09-02', '2026-09-01']);
    const sep2 = out.slice(out.indexOf('data-lab-trend-day="2026-09-02"'), out.indexOf('</tr>', out.indexOf('data-lab-trend-day="2026-09-02"')));
    expect(sep2).not.toMatch(/>0%</);
    expect(html({ options: { switch: false } })).not.toContain('data-lab-trend-table');
  });

  it('an unknown funnel falls back visibly; an undeclared dim is not split', () => {
    expect(html({ options: { funnel: 'gone' } })).toContain('Funnel gone is not in the data. Showing Quiz checkout (v2).');
    expect(html({ selection: { cohort: 'New buyers' } })).toContain('Not split by cohort');
  });

  it('a low-sample slice is flagged', () => {
    expect(html({ frame: { ...frame(), lowSample: 5000 } })).toContain('Low sample: 1,000 users');
  });

  it('a non-funnel frame is the shared empty state', () => {
    expect(html({ frame: { kind: 'empty', reason: 'missing-insight', ref: null } })).toContain('data-empty-reason="missing-insight"');
  });

  it('trendKeys covers the metric keys and any extra key the days carry', () => {
    const f = frame();
    f.funnels[0].daily![0].m.extra = 1;
    const slice = { metrics: f.funnels[0].metrics!, daily: f.funnels[0].daily! } as Parameters<typeof trendKeys>[0];
    expect(trendKeys(slice)).toEqual(['lead_rate', 'cost_per_lead', 'checkout_to_purchase', 'extra']);
  });
});

describe('script strings render as text, never HTML', () => {
  it('a metric label and a reason carrying markup are escaped', () => {
    const f = frame();
    f.funnels[0].metrics!.lead_rate.label = '<img src=x onerror=alert(1)>';
    f.funnels[0].segments![1].reason = '<script>x()</script>';
    expect(html({ frame: f })).toContain('&lt;img src=x onerror=alert(1)&gt;');
    const out = html({ frame: f, selection: { platform: 'TikTok Ads' } });
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;x()&lt;/script&gt;');
  });
});

describe('W5: a narrow cell never truncates a metric name', () => {
  it('the compact form is a select naming every metric in full, the active one chosen', () => {
    const root = tree({}, [null, true]);
    expect(findAll(root, (e) => e.props.role === 'radio')).toHaveLength(0);
    const out = renderToStaticMarkup(root);
    expect(out).toMatch(/<select[^>]*aria-label="Metric"[^>]*data-lab-trend-switch=""[^>]*data-compact="true"/);
    expect(out).toContain('<option value="lead_rate" data-lab-trend-metric="lead_rate" selected="">Lead rate</option>');
    expect(out).toContain('>Cost per lead<');
    expect(out).toContain('>Checkout to purchase (not measured)<');
  });

  it('choosing in the select switches the metric', () => {
    const set = vi.fn();
    const select = findAll(tree({}, [null, true], set), (e) => e.props['data-compact'] === 'true')[0];
    (select.props.onChange as (e: unknown) => void)({ target: { value: 'cost_per_lead' } });
    expect(set).toHaveBeenCalledWith(0, 'cost_per_lead');
    expect(seriesOf(tree({}, ['cost_per_lead', true]))?.[0].name).toBe('Cost per lead');
  });

  it('switch options never shrink or ellipsize, so a label that does not fit is an overflow the block measures', () => {
    const css = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab/blocks/breakdown.css'), 'utf8');
    const rule = css.slice(css.indexOf('.lab-trend-switch-option {'), css.indexOf('}', css.indexOf('.lab-trend-switch-option {')));
    expect(rule).toContain('flex: none;');
    expect(rule).not.toContain('text-overflow');
    const src = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab/blocks/TrendBlock.tsx'), 'utf8');
    expect(src).toMatch(/useCompactFit<HTMLDivElement>\(\s*'width'/);
  });
});
