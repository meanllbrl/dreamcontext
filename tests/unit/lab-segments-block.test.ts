/**
 * The board `segments` block (W2-L5, unregistered until W3): one row per value
 * of the `by` dim, each the exact slice under the card's selection on the other
 * axes (segmentRows), band tone washes, faded low-sample rows, unmeasured cells
 * as a dash with the reason on hover and focus (never a 0), and sort + limit.
 * Static markup through the dashboard's own React. Synthetic Acme vocabulary.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import { segmentRows, type FunnelFrame, type FunnelFrameMetric } from '../../dashboard/src/generated/frameOps.js';
import type { Block, BlockProps } from '../../dashboard/src/components/lab/board/boardTypes.js';

const COPY: Record<string, string> = {
  'lab.blocks.segments.noDim': '{by} is not a breakdown of this data',
  'lab.blocks.segments.users': 'Users',
  'lab.blocks.benchmark.notMeasured': 'Not measured: {reason}',
  'lab.blocks.benchmark.status.below': 'Below floor',
  'lab.blocks.benchmark.status.between': 'Between floor and target',
  'lab.blocks.benchmark.status.above': 'At target',
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

const { SegmentsBlock, segmentsSort, segmentsView, segmentSortValue, USERS_COL, VALUE_COL } = await import(
  '../../dashboard/src/components/lab/blocks/SegmentsBlock.js'
);

const m = (v: number | null, prev: number | null, extra: Partial<FunnelFrameMetric> = {}): FunnelFrameMetric => ({
  v, prev, format: 'pct', label: null, measured: true, reason: null, ...extra,
});

const FEW = 'fewer than 300 users in the window';
const DENOM = 'denominator event missing on one branch';
const seg = (dims: Record<string, string>, users: number, metrics?: Record<string, FunnelFrameMetric>) => ({
  dims, users, measured: true, reason: null as string | null, steps: [{ key: 'visit', users }], metrics,
});

function frame(): FunnelFrame {
  return {
    kind: 'funnel',
    insight: 'acme-funnel-explorer',
    segmentMode: 'lookup',
    lowSample: 50,
    dimensions: [
      { key: 'platform', label: 'Platform', values: ['Meta Ads', 'TikTok Ads', 'Unattributed'] },
      { key: 'language', label: 'Language', values: ['EN', 'ES'] },
    ],
    bands: {
      lead_rate: { floor: 30, target: 45, floorSource: 'book', targetSource: null, better: 'higher' },
      cost_per_lead: { floor: 12, target: 6, floorSource: 'book', targetSource: null, better: 'lower' },
    },
    funnels: [{
      id: 'quiz',
      name: 'Quiz checkout (v2)',
      steps: [{ key: 'visit', label: 'Visit', users: 5040 }],
      metrics: {
        lead_rate: m(40, 35, { label: 'Lead rate' }),
        cost_per_lead: m(8, 10, { format: 'usd', label: 'Cost per lead' }),
        checkout_to_purchase: m(null, null, { label: 'Checkout to purchase', measured: false, reason: DENOM }),
      },
      segments: [
        seg({ platform: 'Meta Ads' }, 3000, { lead_rate: m(48, 44), cost_per_lead: m(7, 7, { format: 'usd' }) }),
        seg({ platform: 'TikTok Ads' }, 2000, { lead_rate: m(25, 28), cost_per_lead: m(13, 12, { format: 'usd' }) }),
        seg({ platform: 'Unattributed' }, 40, { lead_rate: m(38, null) }),
        seg({ platform: 'Meta Ads', language: 'EN' }, 1800, { lead_rate: m(50, 49) }),
        { dims: { platform: 'TikTok Ads', language: 'EN' }, users: 0, measured: false, reason: FEW, steps: [] },
        seg({ language: 'EN' }, 2600, { lead_rate: m(44, 40) }),
      ],
    }],
  };
}

function render(options: Record<string, unknown> = {}, selection: Record<string, string> = {}, f: FunnelFrame = frame()): string {
  const block: Block = { type: 'segments' as Block['type'], data: 'acme-funnel-explorer', options };
  const props: BlockProps & { block: Block } = { frame: f, options, block, selection };
  return renderToStaticMarkup(createElement(SegmentsBlock as never, props as never));
}

const rowKeys = (html: string) => [...html.matchAll(/data-lab-segment-row="([^"]+)"/g)].map((x) => x[1]);
function row(html: string, value: string): string {
  const start = html.indexOf(`data-lab-segment-row="${value}"`);
  expect(start, `row ${value}`).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</tr>', start));
}
const cell = (rowHtml: string, metric: string) => {
  const start = rowHtml.indexOf(`data-metric="${metric}"`);
  return rowHtml.slice(start, rowHtml.indexOf('</td>', start));
};

describe('segments: one row per dim value under the cross-selection', () => {
  it('lists every value of the by dim, in the dim order, with users and a column per metric', () => {
    const html = render({ by: 'platform' });
    expect(rowKeys(html)).toEqual(['Meta Ads', 'TikTok Ads', 'Unattributed']);
    expect(html).toContain('data-by="platform"');
    for (const label of ['Platform', 'Users', 'Lead rate', 'Cost per lead', 'Checkout to purchase']) expect(html).toContain(label);
    expect(row(html, 'Meta Ads')).toContain('3,000');
    expect(cell(row(html, 'Meta Ads'), 'lead_rate')).toContain('48%');
    expect(cell(row(html, 'Meta Ads'), 'lead_rate')).toContain('+4%');
  });

  it('under a selection on another axis each row is that exact intersection, looked up, never summed', () => {
    const html = render({ by: 'platform' }, { language: 'EN' });
    const expected = segmentRows(frame(), null, 'platform', { language: 'EN' }, null);
    expect(rowKeys(html)).toEqual(expected.map((r) => r.value));
    expect(row(html, 'Meta Ads')).toContain('1,800');
    expect(cell(row(html, 'Meta Ads'), 'lead_rate')).toContain('50%');
    // TikTok Ads x EN is unmeasured: a dash with the reason, not the platform's own 2,000.
    const tiktok = row(html, 'TikTok Ads');
    expect(tiktok).toContain('data-lab-unmeasured');
    expect(tiktok).not.toContain('2,000');
    expect(tiktok).toContain(`Not measured: ${FEW}`);
  });

  it('by defaults to the first dimension; an unknown by is refused visibly', () => {
    expect(render()).toContain('data-by="platform"');
    const html = render({ by: 'country' });
    expect(html).toContain('country is not a breakdown of this data');
    expect(html).not.toContain('<table');
  });

  it('marks the row the selection already holds on the by dim', () => {
    expect(row(render({ by: 'platform' }, { platform: 'TikTok Ads' }), 'TikTok Ads')).toContain('data-active');
  });
});

describe('segments: band washes, low sample, not measured', () => {
  it('washes each figure in its band tone (better: lower flips cost) and says the tone in words', () => {
    const html = render({ by: 'platform' });
    expect(html).toContain('data-bands');
    expect(cell(row(html, 'Meta Ads'), 'lead_rate')).toContain('data-tone="above"');
    expect(cell(row(html, 'TikTok Ads'), 'lead_rate')).toContain('data-tone="below"');
    expect(cell(row(html, 'Meta Ads'), 'cost_per_lead')).toContain('data-tone="between"');
    expect(cell(row(html, 'TikTok Ads'), 'cost_per_lead')).toContain('data-tone="below"');
    expect(cell(row(html, 'TikTok Ads'), 'lead_rate')).toContain('Below floor');
  });

  it('bands: false draws no washes', () => {
    const html = render({ by: 'platform', bands: false });
    expect(html).not.toContain('data-bands');
    expect(html).not.toContain('data-tone=');
  });

  it('fades a low-sample row (and says why)', () => {
    const html = render({ by: 'platform' });
    expect(row(html, 'Unattributed')).toContain('data-lab-low-sample');
    expect(row(html, 'Unattributed')).toContain('Low sample: 40 users');
    expect(row(html, 'Meta Ads')).not.toContain('data-lab-low-sample');
  });

  it('an unmeasured metric or slice is a dash with its reason, never a 0', () => {
    const html = render({ by: 'platform' });
    const denom = cell(row(html, 'Meta Ads'), 'checkout_to_purchase');
    expect(denom).toContain('data-lab-seg-unmeasured');
    expect(denom).toContain(`Not measured: ${DENOM}`);
    expect(denom).toContain('tabindex="0"');
    const tiktok = row(render({ by: 'platform' }, { language: 'EN' }), 'TikTok Ads');
    expect(tiktok).not.toMatch(/>0%?</);
    expect(tiktok).not.toContain('$0');
    expect((tiktok.match(/data-lab-seg-unmeasured/g) ?? []).length).toBe(4);
  });
});

describe('segments: sort, limit, density, metrics', () => {
  it('sort orders the rows (users, a metric, the value), unmeasured last in both directions', () => {
    expect(rowKeys(render({ by: 'platform', sort: 'users' }))).toEqual(['Unattributed', 'TikTok Ads', 'Meta Ads']);
    expect(rowKeys(render({ by: 'platform', sort: '-lead_rate' }))).toEqual(['Meta Ads', 'Unattributed', 'TikTok Ads']);
    expect(rowKeys(render({ by: 'platform', sort: '-value' }))).toEqual(['Unattributed', 'TikTok Ads', 'Meta Ads']);
    const rows = segmentRows(frame(), null, 'platform', { language: 'EN' }, null);
    for (const dir of ['asc', 'desc'] as const) {
      const view = segmentsView(rows, { key: USERS_COL, dir }, null);
      expect(view[view.length - 1].value).toBe('Unattributed');
    }
    expect(render({ by: 'platform', sort: '-users' })).toContain('aria-sort="descending"');
  });

  it('segmentsSort maps names and refuses an unknown column', () => {
    expect(segmentsSort('-users', ['lead_rate'])).toEqual({ key: USERS_COL, dir: 'desc' });
    expect(segmentsSort('value', ['lead_rate'])).toEqual({ key: VALUE_COL, dir: 'asc' });
    expect(segmentsSort({ by: 'lead_rate', dir: 'desc' }, ['lead_rate'])).toEqual({ key: 'lead_rate', dir: 'desc' });
    expect(segmentsSort('-nope', ['lead_rate'])).toBeNull();
    expect(segmentsSort(null, ['lead_rate'])).toBeNull();
    const rows = segmentRows(frame(), null, 'platform', { language: 'EN' }, null);
    expect(segmentSortValue(rows.find((r) => r.value === 'TikTok Ads')!, USERS_COL)).toBeNull();
  });

  it('limit keeps the top rows after the sort', () => {
    expect(rowKeys(render({ by: 'platform', sort: '-users', limit: 2 }))).toEqual(['Meta Ads', 'TikTok Ads']);
  });

  it('density sets the table rhythm on the shared table classes', () => {
    expect(render({ by: 'platform' })).toContain('lab-table--compact');
    expect(render({ by: 'platform', density: 'comfortable' })).toContain('lab-table--comfortable');
    expect(render({ by: 'platform' })).toContain('lab-table-head');
  });

  it('metrics picks the columns; an unknown key is noted', () => {
    const html = render({ by: 'platform', metrics: ['cost_per_lead', 'ghost'] });
    expect(html).toContain('data-col="cost_per_lead"');
    expect(html).not.toContain('data-col="lead_rate"');
    expect(html).toContain('Not in the data: ghost');
  });

  it('an unknown funnel pick shows the visible fallback note', () => {
    expect(render({ by: 'platform', funnel: 'ghost' })).toContain('Funnel ghost is not in the data. Showing Quiz checkout (v2).');
  });

  it('script-authored values and labels render as text, never HTML', () => {
    const f = frame();
    f.dimensions![0].values.push('<script>x</script>');
    f.funnels[0].metrics!.lead_rate.label = '<i>Lead</i>';
    const html = render({ by: 'platform' }, {}, f);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<i>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });
});

describe('segments.css speaks only in tokens', () => {
  it('no literal colours, sizes off the 12/14 ladder, weights off 400/600 or literal durations', () => {
    const css = readFileSync(join(__dirname, '../../dashboard/src/components/lab/blocks/segments.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\b(rgba?|hsla?)\(/i);
    for (const [, v] of css.matchAll(/font-size:\s*([^;]+);/g)) expect(v.trim()).toMatch(/^var\(--font-size-(xs|sm)\)$/);
    for (const [, v] of css.matchAll(/font-weight:\s*([^;]+);/g)) expect(v.trim()).toMatch(/^var\(--font-weight-(normal|semibold)\)$/);
    expect(css).not.toMatch(/(transition|animation)[^;]*\d+m?s/);
    expect(css).not.toContain('\u2014');
  });
});
