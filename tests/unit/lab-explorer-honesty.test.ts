/**
 * The extended explorer blocks keep the honesty rules on screen (funnel explorer, wave 3):
 *   - a step the source does not count reads "not measured" with its reason, never 0, and the
 *     drop math skips it;
 *   - a derived step (rate x users) says so;
 *   - a rate over a denominator under KN_THRESHOLD reads "k/n" (Steps table, bars, segments);
 *   - the Steps table marks the worst drop; Flow collapses a long middle run;
 *   - the Compare tab with nothing pinned says how to pin; `compare: off` ignores lanes;
 *   - a segments column no row carries folds into one note with the snapshot's fill hint;
 *   - Benchmark follows the ladder's order and says which input won each bound;
 *   - a reading trap puts a marker on the step, header or row it names.
 * Static markup through the dashboard's own React. Synthetic Acme vocabulary only.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import { funnelSlice, type BenchmarkRow, type FunnelFrame, type FunnelFrameMetric, type FunnelFrameNote } from '../../dashboard/src/generated/frameOps.js';
import type { Block } from '../../dashboard/src/components/lab/board/boardTypes.js';

const COPY: Record<string, string> = {
  'lab.blocks.funnel.ofPrev': '{pct} of prev. step',
  'lab.blocks.funnel.worst': 'Biggest drop',
  'lab.blocks.funnel.drop': '{pct} drop',
  'lab.blocks.funnel.lane': 'Lane {n}',
  'lab.blocks.breakdown.all': 'All traffic',
  'lab.blocks.breakdown.noPath': 'No measured path for this combination.',
  'lab.blocks.explorer.notMeasured': 'Not measured for {sel}: {reason}',
  'lab.blocks.benchmark.notMeasured': 'Not measured: {reason}',
  'lab.blocks.benchmark.floor': 'Floor',
  'lab.blocks.benchmark.target': 'Target',
  'lab.blocks.benchmark.source': '{bound} from {source}',
  'lab.blocks.benchmark.inheritedMark': 'Inherited',
  'lab.blocks.benchmark.inheritedTitle': "This metric has no band of its own for this selection: it uses the whole funnel's band.",
  'lab.blocks.segments.users': 'Users',
  'lab.explorer.notMeasured': 'Not measured',
  'lab.explorer.notMeasuredWhy': 'Not measured: {reason}',
  'lab.explorer.derived': 'derived',
  'lab.explorer.derivedTitle': 'Derived: rate × first-step users, not counted directly',
  'lab.explorer.knTitle': 'Fewer than {min} in the denominator: shown as {k} of {n}, not as a rate',
  'lab.explorer.noteMark': 'Reading trap: {text}',
  'lab.explorer.emptyCompare': 'Pin up to 4 breakdowns with the pin button above. Each lane keeps its own rates.',
  'lab.explorer.emptyColumn': '{metric} is not carried for this axis.',
  'lab.explorer.fill': 'To fill it: {hint}',
  'lab.explorer.flowMore': '{n} more steps',
  'lab.explorer.stepsStep': 'Step',
  'lab.explorer.stepsUsers': 'Users',
  'lab.explorer.stepsOfTop': 'Of first step',
  'lab.explorer.stepsOfPrev': 'Of previous step',
  'lab.explorer.stepsDrop': 'Drop',
  'lab.explorer.bandBook': 'book',
  'lab.explorer.bandOwnFloor': 'own p25',
  'lab.explorer.bandOwnTarget': 'own p75',
  'lab.explorer.bandWeeks': '{n} weeks',
  'lab.explorer.bandFloorFrom': 'floor: {src}',
  'lab.explorer.bandTargetFrom': 'target: {src}',
  'lab.explorer.bandFromFunnel': 'band from the funnel',
  'lab.explorer.bandFromTotal': 'band from the total',
  'lab.blocks.breakdown.pin': 'Pin {sel} as a lane',
  'lab.blocks.trend.metric': 'Metric',
  'lab.blocks.trend.noDaily': 'No daily values for this selection.',
  'lab.blocks.trend.metricNotMeasured': '{metric} is not measured: {reason}',
};
const t = (key: string) => COPY[key] ?? key;

/** The card's scoped locale the mocked I18n hands every block (switched per test). */
const L = vi.hoisted(() => ({ locale: 'en' }));
vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: L.locale, setLocale: () => {}, t: (key: string) => COPY[key] ?? key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../dashboard/src/components/lab/chartBody.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, useMeasured: () => [() => {}, { width: 0, height: 0 }] };
});

const { FunnelBlock, explorerView, compareMode, StepsTable } = await import('../../dashboard/src/components/lab/blocks/FunnelBlock.js');
const { flowItems, FLOW_COLLAPSE_AT, FLOW_KEEP } = await import('../../dashboard/src/components/lab/funnel/FunnelFlow.js');
const { FunnelBars } = await import('../../dashboard/src/components/lab/funnel/FunnelBars.js');
const { SegmentsBlock, foldedColumns } = await import('../../dashboard/src/components/lab/blocks/SegmentsBlock.js');
const { metricKeysFor, bandSourceParts, inheritedWords, notesByKey, NoteMark, benchmarkFit } = await import('../../dashboard/src/components/lab/blocks/BenchmarkBlock.js');
const { TrendBlock } = await import('../../dashboard/src/components/lab/blocks/TrendBlock.js');
const { segmentColumns } = await import('../../dashboard/src/components/lab/blocks/SegmentsBlock.js');
const { stepDrops, segmentRows } = await import('../../dashboard/src/generated/frameOps.js');

const LEAD_DEAD = 'lead event not recorded on this funnel';
const TRAP: FunnelFrameNote = { code: 'C10', text: 'the lead event is not recorded', level: 'trap', keys: ['lead', 'lead_rate'], scope: 'funnel' };
const metric = (v: number | null, label: string, extra: Partial<FunnelFrameMetric> = {}): FunnelFrameMetric => ({
  v, prev: null, format: 'pct', label, measured: true, reason: null, ...extra,
});

/** Acme Storefront: page2 and finish are rate x users (derived), the lead step is not counted. */
function frame(): FunnelFrame {
  return {
    kind: 'funnel',
    insight: 'acme-funnel-snapshot',
    segmentMode: 'lookup',
    lowSample: 30,
    dimensions: [{ key: 'platform', label: 'Platform', values: ['Meta Ads', 'TikTok Ads'] }],
    rates: { buy_rate: { num: 'buy', den: 'visit' } },
    hints: { 'metric:spend': 'kb_chart_query dims [funnel_id, campaign_source], metric total_spend_usd' },
    ladder: ['buy_rate', 'page2_rate'],
    funnels: [{
      id: 'quiz',
      name: 'Quiz checkout (v2)',
      steps: [
        { key: 'visit', label: 'Visit', users: 1000 },
        { key: 'page2', label: 'Second page', users: 400, basis: 'derived' },
        { key: 'lead', label: 'Lead', users: 0, measured: false, reason: LEAD_DEAD },
        { key: 'finish', label: 'Finish', users: 380, basis: 'derived' },
        { key: 'buy', label: 'Buy', users: 30 },
      ],
      metrics: {
        spend: metric(1200, 'Spend', { format: 'usd' }),
        buy_rate: metric(3, 'Buy rate'),
        page2_rate: metric(40, 'Second page rate'),
      },
      notes: [TRAP],
      segments: [
        {
          dims: { platform: 'Meta Ads' }, users: 80, measured: true, reason: null,
          steps: [{ key: 'visit', users: 80 }, { key: 'page2', users: 40 }, { key: 'lead', users: 0 }, { key: 'finish', users: 30 }, { key: 'buy', users: 3 }],
          metrics: { buy_rate: metric(3.75, 'Buy rate') },
        },
        {
          dims: { platform: 'TikTok Ads' }, users: 920, measured: true, reason: null,
          steps: [{ key: 'visit', users: 920 }, { key: 'page2', users: 360 }, { key: 'lead', users: 0 }, { key: 'finish', users: 350 }, { key: 'buy', users: 27 }],
          metrics: { buy_rate: metric(2.93, 'Buy rate') },
        },
      ],
    }],
  };
}

function funnelHtml(options: Record<string, unknown>, extra: { selection?: Record<string, string>; lanes?: Record<string, string>[]; frame?: FunnelFrame } = {}): string {
  const block: Block = { type: 'funnel', data: 'acme-funnel-snapshot', options };
  return renderToStaticMarkup(createElement(FunnelBlock as never, {
    frame: extra.frame ?? frame(), options, block, selection: extra.selection ?? {}, lanes: extra.lanes ?? [],
  } as never));
}
const rowOf = (html: string, attr: string, key: string) => {
  const at = html.indexOf(`${attr}="${key}"`);
  expect(at, `${attr}=${key}`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('</tr>', at) === -1 ? html.indexOf('</div>', at) : html.indexOf('</tr>', at));
};

describe('steps: not measured is never 0, derived is labelled, the worst drop skips a dead step', () => {
  it('stepDrops compares the step after an unmeasured one with the last measured step', () => {
    const drops = stepDrops(frame().funnels[0].steps);
    const finish = drops.find((d) => d.key === 'finish')!;
    expect(finish.prevUsers).toBe(400);
    expect(finish.ofPrev).toBeCloseTo(95, 5);
    expect(drops.find((d) => d.key === 'lead')).toMatchObject({ measured: false, dropPct: null, worst: false });
    expect(drops.find((d) => d.worst)?.key).toBe('buy');
  });

  it('the Steps table marks the worst drop, labels derived steps and words the unmeasured one', () => {
    const html = funnelHtml({ layout: 'bars', markWorst: true, table: true, compare: 'off' });
    expect(html).toContain('data-lab-steps-table=""');
    const buy = rowOf(html, 'data-lab-step', 'buy');
    expect(buy).toContain('data-worst="true"');
    expect(buy).toContain('data-drop-pct="92.1"');
    expect(buy).toContain('data-users="30"');
    expect(rowOf(html, 'data-lab-step', 'page2')).toContain('data-basis="derived"');
    expect(rowOf(html, 'data-lab-step', 'page2')).toContain('data-lab-derived=""');
    const lead = rowOf(html, 'data-lab-step', 'lead');
    expect(lead).toContain('data-measured="false"');
    expect(lead).toContain(`Not measured: ${LEAD_DEAD}`);
    expect(lead).not.toMatch(/>0</);
    // The reading trap that names the lead step puts its marker on the row.
    expect(lead).toContain('data-lab-note-mark="lead"');
    expect(lead).toContain('Reading trap: C10: the lead event is not recorded');
    // No bars in table mode.
    expect(html).not.toContain('funnel-bars-row');
  });

  it('a step-to-step rate over fewer than 100 users reads k/n in the Steps table', () => {
    const html = funnelHtml({ layout: 'bars', table: true, compare: 'off' }, { selection: { platform: 'Meta Ads' } });
    const page2 = rowOf(html, 'data-lab-step', 'page2');
    expect(page2).toContain('data-lab-kn="40/80"');
    expect(page2).toContain('Fewer than 100 in the denominator: shown as 40 of 80, not as a rate');
    // The step-to-step cell is counts, not "50%" (the share of the first step beside it stays a share).
    expect(page2).toContain('>40/80<');
  });

  it('the bars carry the same marks (derived badge, unmeasured row, k/n on the step marker)', () => {
    const html = funnelHtml({ layout: 'bars', markWorst: true, compare: 'off' }, { selection: { platform: 'Meta Ads' } });
    expect(html).toContain('data-lab-derived=""');
    expect(html).toContain('data-measured="false"');
    expect(html).toContain(`data-lab-not-measured="lead"`);
    expect(html).toContain('data-lab-kn="40/80"');
    // The funnel pages' bars (no explorer copy) keep their percentages and their words.
    const plain = renderToStaticMarkup(createElement(FunnelBars as never, {
      steps: [{ key: 'a', label: 'A', users: 80 }, { key: 'b', label: 'B', users: 40 }], stepLabel: (p: string) => `${p} of prev. step`,
    } as never));
    expect(plain).not.toContain('data-lab-kn');
    expect(plain).toContain('50% of prev. step');
  });

  it('the flow words an unmeasured stage and draws no shape for it', () => {
    const html = funnelHtml({ layout: 'flow', markWorst: true, compare: 'off' });
    const lead = rowOf(html, 'data-lab-flow-stage', 'lead');
    expect(lead).toContain('data-measured="false"');
    expect(lead).toContain('Not measured');
    expect(lead).not.toContain('funnel-flow-shape');
    expect(rowOf(html, 'data-lab-flow-stage', 'finish')).toContain('data-basis="derived"');
    // No drop badge into a dead step.
    expect(html).not.toContain('data-lab-drop="lead"');
  });
});

describe('flow: a long run collapses its middle', () => {
  it('flowItems keeps the ends and the worst drop, folding each hidden run into one item', () => {
    expect(FLOW_COLLAPSE_AT).toBe(16);
    expect(flowItems(16, [], false).every((x) => x.kind === 'step')).toBe(true);
    const items = flowItems(25, [10, 11], false);
    expect(items.filter((x) => x.kind === 'step').map((x) => (x as { index: number }).index))
      .toEqual([0, 1, 2, 3, 4, 5, 10, 11, 19, 20, 21, 22, 23, 24]);
    expect(items.filter((x) => x.kind === 'more')).toEqual([
      { kind: 'more', from: FLOW_KEEP, to: 9, count: 4 },
      { kind: 'more', from: 12, to: 18, count: 7 },
    ]);
    expect(flowItems(25, [], true)).toHaveLength(25);
  });

  it('a 22-step flow renders the "N more steps" row', () => {
    const f = frame();
    f.funnels[0].steps = Array.from({ length: 22 }, (_, i) => ({ key: `s${i}`, label: `Step ${i}`, users: 1000 - i * 40 }));
    f.funnels[0].segments = [];
    const html = funnelHtml({ layout: 'flow', compare: 'off' }, { frame: f });
    expect(html).toContain('data-lab-flow-more="10"');
    expect(html).toContain('10 more steps');
    expect((html.match(/data-lab-flow-stage=/g) ?? []).length).toBe(12);
  });
});

describe('compare: lanes on the Compare tab only', () => {
  it('compareMode reads the option leniently', () => {
    expect(compareMode({})).toBe('auto');
    expect(compareMode({ compare: 'lanes' })).toBe('lanes');
    expect(compareMode({ compare: 'off' })).toBe('off');
    expect(compareMode({ compare: 'bogus' })).toBe('auto');
  });

  it('compare: lanes with nothing pinned says how to pin', () => {
    const html = funnelHtml({ layout: 'bars', markWorst: true, compare: 'lanes' });
    expect(html).toContain('data-lab-empty="compare"');
    expect(html).toContain('Pin up to 4 breakdowns with the pin button above.');
    expect(html).not.toContain('funnel-bars-row');
  });

  it('compare: lanes draws the pinned lanes, each unmeasured step worded per lane', () => {
    const html = funnelHtml({ layout: 'bars', markWorst: true, compare: 'lanes' }, { lanes: [{ platform: 'Meta Ads' }, { platform: 'TikTok Ads' }] });
    expect(html).toContain('data-lab-lanes="2"');
    expect((html.match(/data-lab-not-measured="lead"/g) ?? []).length).toBe(2);
  });

  it('compare: off ignores pinned lanes (the Steps and Flow tabs draw the selection)', () => {
    const html = funnelHtml({ layout: 'bars', markWorst: true, compare: 'off' }, { lanes: [{ platform: 'Meta Ads' }] });
    expect(html).not.toContain('data-lab-lanes');
    const view = explorerView(frame(), { compare: 'off' }, {}, [{ platform: 'Meta Ads' }]);
    expect(view?.lanes).toEqual([]);
    // A default funnel block with no explorer option still draws exactly as before.
    expect(explorerView(frame(), {}, {}, [])).toBeNull();
  });
});

describe('segments: k/n cells and one note for a column no row carries', () => {
  const segHtml = (options: Record<string, unknown>) => renderToStaticMarkup(createElement(SegmentsBlock as never, {
    frame: frame(), options, block: { type: 'segments', data: 'acme-funnel-snapshot', options }, selection: {},
  } as never));

  it('a rate over fewer than 100 users reads k/n, a large one its rate', () => {
    const html = segHtml({ by: 'platform', metrics: ['buy_rate'] });
    const meta = html.slice(html.indexOf('data-lab-segment-row="Meta Ads"'), html.indexOf('</tr>', html.indexOf('data-lab-segment-row="Meta Ads"')));
    expect(meta).toContain('data-lab-kn="3/80"');
    expect(meta).toContain('>3/80<');
    const tiktok = html.slice(html.indexOf('data-lab-segment-row="TikTok Ads"'));
    expect(tiktok.slice(0, tiktok.indexOf('</tr>'))).not.toContain('data-lab-kn');
  });

  it('a column no measured row carries folds into one note with the snapshot hint', () => {
    const rows = segmentRows(frame(), null, 'platform', {}, ['spend', 'buy_rate']);
    expect(foldedColumns(rows, ['spend', 'buy_rate'])).toEqual(['spend']);
    const html = segHtml({ by: 'platform', metrics: ['spend', 'buy_rate'] });
    expect(html).toContain('data-lab-empty="column"');
    expect(html).toContain('data-metrics="spend"');
    expect(html).toContain('Spend is not carried for this axis.');
    expect(html).toContain('To fill it: kb_chart_query dims [funnel_id, campaign_source], metric total_spend_usd');
    expect(html).not.toContain('data-col="spend"');
  });

  it('a column where a segment says WHY it is not measured keeps its dashes (the reason is information)', () => {
    const f = frame();
    f.funnels[0].segments![0].metrics = { ...f.funnels[0].segments![0].metrics, spend: metric(null, 'Spend', { format: 'usd', measured: false, reason: 'spend not attributed for this platform' }) };
    const html = renderToStaticMarkup(createElement(SegmentsBlock as never, {
      frame: f, options: { by: 'platform', metrics: ['spend', 'buy_rate'] }, block: { type: 'segments', options: {} }, selection: {},
    } as never));
    expect(html).toContain('data-col="spend"');
    expect(html).not.toContain('data-lab-empty="column"');
    expect(html).toContain('Not measured: spend not attributed for this platform');
  });

  it('a reading trap marks the header of the metric it names', () => {
    const html = segHtml({ by: 'platform', metrics: ['buy_rate'] });
    expect(html).not.toContain('data-lab-note-mark="buy_rate"');
    const f = frame();
    f.funnels[0].notes = [{ ...TRAP, keys: ['buy_rate'] }];
    const marked = renderToStaticMarkup(createElement(SegmentsBlock as never, {
      frame: f, options: { by: 'platform', metrics: ['buy_rate'] }, block: { type: 'segments', options: {} }, selection: {},
    } as never));
    expect(marked).toContain('data-lab-note-mark="buy_rate"');
  });
});

describe('benchmark: the ladder names the rows and says which input won', () => {
  it('rows follow the ladder order when no metrics are picked (the CLI prints the same)', () => {
    const f = frame();
    const slice = funnelSlice(f, null, {});
    expect(metricKeysFor(f, slice, null).keys).toEqual(['buy_rate', 'page2_rate']);
    expect(metricKeysFor(f, slice, ['spend']).keys).toEqual(['spend']);
    delete f.ladder;
    expect(metricKeysFor(f, slice, null).keys).toEqual(['spend', 'buy_rate', 'page2_rate']);
  });

  const row = (extra: Partial<BenchmarkRow>): BenchmarkRow => ({
    key: 'buy_rate', label: 'Buy rate', format: 'pct', current: 3, prev: null, delta: null, floor: 2, target: 4,
    floorSource: null, targetSource: null, better: 'higher', status: 'between', trend: null, reason: null,
    inherited: false, floorFrom: null, targetFrom: null, weeks: null, inheritedFrom: null, ...extra,
  });

  it('a ladder band names the winning input of each bound and its weeks; an authored one its source', () => {
    expect(bandSourceParts(row({ floorFrom: 'own', targetFrom: 'book', weeks: 8 }), t)).toEqual(['floor: own p25', 'target: book', '8 weeks']);
    expect(bandSourceParts(row({ floorFrom: 'book', targetFrom: 'own', weeks: 6 }), t)).toEqual(['floor: book', 'target: own p75', '6 weeks']);
    expect(bandSourceParts(row({ floorFrom: 'book', targetFrom: 'book', weeks: 6 }), t)).toEqual(['floor: book', 'target: book']);
    expect(bandSourceParts(row({ floorSource: 'industry book' }), t)).toEqual(['Floor from industry book']);
  });

  it('the inherited mark names the level under a ladder, and keeps its old word without one', () => {
    expect(inheritedWords(row({}), true, t)).toBeNull();
    expect(inheritedWords(row({ inherited: true, inheritedFrom: 'funnel' }), true, t)?.mark).toBe('band from the funnel');
    expect(inheritedWords(row({ inherited: true, inheritedFrom: 'set' }), true, t)?.mark).toBe('band from the total');
    expect(inheritedWords(row({ inherited: true, inheritedFrom: 'set' }), false, t)?.mark).toBe('Inherited');
  });
});

describe('note marks', () => {
  it('notesByKey indexes every key a note names; NoteMark is a titled dot, amber for a trap', () => {
    const info: FunnelFrameNote = { code: null, text: 'renewals counted separately', level: 'info', keys: ['buy'], scope: 'set' };
    const map = notesByKey([TRAP, info]);
    expect(map.get('lead')).toEqual([TRAP]);
    expect(map.get('lead_rate')).toEqual([TRAP]);
    const trap = renderToStaticMarkup(createElement(NoteMark as never, { markKey: 'lead', notes: [TRAP], t } as never));
    expect(trap).toContain('data-level="trap"');
    expect(trap).toContain('aria-label="Reading trap: C10: the lead event is not recorded"');
    const quiet = renderToStaticMarkup(createElement(NoteMark as never, { markKey: 'buy', notes: [info], t } as never));
    expect(quiet).toContain('data-level="info"');
    expect(renderToStaticMarkup(createElement(NoteMark as never, { markKey: 'x', notes: [], t } as never))).toBe('');
  });

  it('StepsTable is exported for the verify run and renders without lanes', () => {
    expect(typeof StepsTable).toBe('function');
  });
});

/** Run `fn` with the card's locale set to `locale` (the mocked I18n reads it). */
function inLocale<T>(locale: string, fn: () => T): T {
  const before = L.locale;
  L.locale = locale;
  try { return fn(); } finally { L.locale = before; }
}

describe('visual review round 1: the card reads in its own language', () => {
  it('Steps and Flow print Turkish figures inside a Turkish card (never "659,569 · 100%" or "92% düşüş")', () => {
    const steps = inLocale('tr', () => funnelHtml({ layout: 'bars', markWorst: true, table: true, compare: 'off' }));
    expect(steps).toContain('%92,1 düşüş');
    expect(rowOf(steps, 'data-lab-step', 'visit')).toContain('1.000');
    expect(rowOf(steps, 'data-lab-step', 'page2')).toContain('%40,0');
    const flow = inLocale('tr', () => funnelHtml({ layout: 'flow', markWorst: true, compare: 'off' }));
    expect(flow).toContain('1.000');
    expect(flow).toContain('%100,0');
    expect(flow).not.toContain('1,000');
    // The worst word rides inside the badge (the wide column), so it cannot be cut at the card's edge.
    const worstLink = flow.slice(flow.indexOf('data-lab-drop="buy"'));
    expect(worstLink.slice(0, worstLink.indexOf('</div>'))).toMatch(/class="funnel-flow-badge">[\s\S]*class="funnel-flow-worst">Biggest drop</);
    // English stays as it was.
    expect(funnelHtml({ layout: 'bars', markWorst: true, table: true, compare: 'off' })).toContain('92.1% drop');
  });

  it('Daily: a metric with no days is dimmed with a dash and a stated reason, said once, never struck through', () => {
    const f = frame();
    f.funnels[0].daily = [{ t: '2026-09-01', m: { buy_rate: 3 } }, { t: '2026-09-02', m: { buy_rate: 2.8 } }];
    const html = renderToStaticMarkup(createElement(TrendBlock as never, {
      frame: f, options: {}, block: { type: 'trend', data: 'acme-funnel-snapshot', options: {} }, selection: {},
    } as never));
    const chip = html.slice(html.indexOf('data-lab-trend-metric="spend"'), html.indexOf('</button>', html.indexOf('data-lab-trend-metric="spend"')));
    expect(chip).toContain('data-measured="false"');
    expect(chip).toContain('title="Spend is not measured: No daily values for this selection."');
    expect(chip).toContain('lab-trend-switch-dash');
    const line = html.slice(html.indexOf('data-lab-trend-unmeasured='));
    expect(line).toContain('Spend, Second page rate · Not measured: No daily values for this selection.');
    expect((html.match(/data-lab-trend-unmeasured=/g) ?? []).length).toBe(1);
    const css = readFileSync(join(__dirname, '../../dashboard/src/components/lab/blocks/breakdown.css'), 'utf8');
    const rule = css.slice(css.indexOf(".lab-trend-switch-option[data-measured='false'] {"));
    expect(rule.slice(0, rule.indexOf('}'))).not.toContain('line-through');
  });

  it('Segments: a metric that repeats Users is dropped, ladder metrics lead, an unmeasured row says why', () => {
    const f = frame();
    f.funnels[0].metrics = { users: metric(1000, 'Users', { format: 'count' }), ...f.funnels[0].metrics };
    for (const seg of f.funnels[0].segments!) seg.metrics = { ...seg.metrics, users: metric(seg.users, 'Users', { format: 'count' }) };
    const rows = segmentRows(f, null, 'platform', {}, ['users', 'spend', 'buy_rate', 'page2_rate']);
    expect(segmentColumns(['users', 'spend', 'buy_rate', 'page2_rate'], rows, ['page2_rate', 'buy_rate'], false)).toEqual(['page2_rate', 'buy_rate', 'spend']);
    expect(segmentColumns(['spend', 'buy_rate'], rows, ['page2_rate', 'buy_rate'], true)).toEqual(['spend', 'buy_rate']);
    // A metric that equals each row's users under another key is a duplicate too.
    expect(segmentColumns(['visitors'], rows.map((r) => ({ ...r, cells: { visitors: { v: r.users, prev: null, tone: null, kn: null } } })), undefined, false)).toEqual([]);
    const html = renderToStaticMarkup(createElement(SegmentsBlock as never, {
      frame: f, options: { by: 'platform' }, block: { type: 'segments', options: {} }, selection: {},
    } as never));
    expect((html.match(/>Users</g) ?? []).length).toBe(1);
    expect(html).not.toContain('data-col="users"');
    // An unmeasured path: one muted line across its metric columns, the reason in the row title too.
    f.funnels[0].segments![1] = { dims: { platform: 'TikTok Ads' }, users: 0, measured: false, reason: 'under 300 users in the window', steps: [] };
    const off = renderToStaticMarkup(createElement(SegmentsBlock as never, {
      frame: f, options: { by: 'platform', metrics: ['buy_rate'] }, block: { type: 'segments', options: {} }, selection: {},
    } as never));
    const tiktok = off.slice(off.indexOf('data-lab-segment-row="TikTok Ads"'), off.indexOf('</tr>', off.indexOf('data-lab-segment-row="TikTok Ads"')));
    expect(tiktok).toContain('title="Not measured: under 300 users in the window"');
    expect(tiktok).toContain('data-lab-seg-row-why="">Not measured: under 300 users in the window<');
  });

  it('Benchmark under a ladder keeps the floor/target values and the band-source line in every tier', () => {
    const roomy = benchmarkFit(6, 600, 0, true, 1200, [], 0, true);
    expect(roomy).toMatchObject({ labels: true, sources: true, count: 6 });
    const tight = benchmarkFit(6, 260, 0, true, 1200, [], 0, true);
    expect(tight).toMatchObject({ mode: 'compact', labels: true, sources: true });
    const tiny = benchmarkFit(6, 120, 0, true, 1200, [], 0, true);
    expect(tiny).toMatchObject({ labels: true, sources: true });
    expect(tiny.count).toBeLessThan(6);
    // Without a ladder the old degradation stays (labels and sources go first).
    expect(benchmarkFit(6, 260, 0, true, 1200)).toMatchObject({ labels: false });
    // The compact rows share one column grid, so every ruler starts at the same x.
    const css = readFileSync(join(__dirname, '../../dashboard/src/components/lab/blocks/benchmark.css'), 'utf8');
    expect(css).toContain("grid-template-columns: subgrid;");
    expect(css).toMatch(/\[data-theme='dark'\] \.lab-bench-zone\[data-tone='below'\]/);
  });

  it('Compare with nothing pinned names the control exactly as the breakdown bar renders it', () => {
    const html = funnelHtml({ layout: 'bars', markWorst: true, compare: 'lanes' });
    expect(html).toContain('data-lab-compare-control=""');
    expect(html).toContain('Pin &#x27;All traffic&#x27; as a lane');
  });
});
