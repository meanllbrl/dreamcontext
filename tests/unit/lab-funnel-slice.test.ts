import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInsight, writeCache } from '../../src/lib/lab/store.js';
import { resolveBoardFrames, resolveFrame } from '../../src/lib/lab/frames.js';
import {
  benchmarkRows,
  breakdownAxes,
  dailySeries,
  funnelSlice,
  parseSelection,
  projectFunnelFrame,
  segmentRows,
  selectionKey,
  stepDrops,
  toggleSelection,
  type FunnelFrame,
  type FunnelFrameMetric,
} from '../../src/lib/lab/frameOps.js';
import {
  FUNNEL_EXPLORER_SIZE,
  PRESET_LABELS,
  funnelExplorerBlocks,
} from '../../src/lib/lab/presets.js';
import type { InsightCache } from '../../src/lib/lab/types.js';

const metric = (v: number | null, prev: number | null, extra: Partial<FunnelFrameMetric> = {}): FunnelFrameMetric => ({
  v, prev, format: 'pct', label: null, measured: true, reason: null, ...extra,
});

const STEPS = [
  { key: 'visit', label: 'Visit', users: 1000 },
  { key: 'lead', label: 'Lead', users: 400 },
  { key: 'buy', label: 'Buy', users: 100 },
];

/** Synthetic Acme explorer frame: platform x language, lookup mode. */
function lookupFrame(): FunnelFrame {
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
        steps: STEPS,
        metrics: { lead_rate: metric(40, 35), cost_per_lead: metric(8, 10, { format: 'usd' }) },
        daily: [{ t: '2026-09-01', m: { lead_rate: 38, cost_per_lead: null } }, { t: '2026-09-02', m: { lead_rate: 41, cost_per_lead: 9 } }],
        segments: [
          {
            dims: { platform: 'Meta Ads' }, users: 600, measured: true, reason: null,
            steps: [{ key: 'visit', users: 600 }, { key: 'lead', users: 300 }, { key: 'buy', users: 90 }],
            metrics: { lead_rate: metric(50, 50) },
            daily: [{ t: '2026-09-01', m: { lead_rate: 49 } }],
          },
          {
            dims: { platform: 'TikTok Ads' }, users: 400, measured: true, reason: null,
            steps: [{ key: 'visit', users: 400 }, { key: 'lead', users: 100 }],
            metrics: { lead_rate: metric(25, 30) },
            bands: { lead_rate: { floor: 20, target: 28, floorSource: 'own', targetSource: 'own', better: 'higher' } },
          },
          {
            dims: { platform: 'Meta Ads', language: 'EN' }, users: 40, measured: true, reason: null,
            steps: [{ key: 'visit', users: 40 }, { key: 'lead', users: 22 }, { key: 'buy', users: 7 }],
          },
          { dims: { platform: 'TikTok Ads', language: 'ES' }, users: 0, steps: [], measured: false, reason: 'fewer than 300 users in the window' },
          { dims: { language: 'EN' }, users: 700, measured: true, reason: null, steps: [{ key: 'visit', users: 700 }] },
        ],
      },
      { id: 'activation', name: 'Activation ladder', steps: [{ key: 'a', label: 'A', users: 10 }] },
    ],
  };
}

describe('selection helpers', () => {
  it('selectionKey sorts, parseSelection is lenient and last wins, toggle clears the active value', () => {
    expect(selectionKey({ language: 'EN', platform: 'Meta Ads' })).toBe('language=EN&platform=Meta Ads');
    expect(selectionKey({})).toBe('');
    expect(parseSelection('platform=TikTok Ads, language=EN,bad,=x,y=,language=ES')).toEqual({ platform: 'TikTok Ads', language: 'ES' });
    expect(parseSelection('')).toEqual({});
    expect(toggleSelection({ platform: 'Meta Ads' }, 'platform', 'Meta Ads')).toEqual({});
    expect(toggleSelection({ platform: 'Meta Ads' }, 'platform', 'TikTok Ads')).toEqual({ platform: 'TikTok Ads' });
    const sel = { platform: 'Meta Ads' };
    toggleSelection(sel, 'language', 'EN');
    expect(sel).toEqual({ platform: 'Meta Ads' });
  });
});

describe('funnelSlice (lookup never sums)', () => {
  it('empty selection is the funnel level with the set bands (not inherited)', () => {
    const s = funnelSlice(lookupFrame(), null, {});
    expect(s).toMatchObject({ funnelId: 'quiz', measured: true, users: 1000, bandsInherited: false, lowSample: false, ignored: [] });
    expect(s.steps).toEqual(STEPS);
    expect(s.daily).toHaveLength(2);
  });

  it('an intersection is its own exact path, never the sum of its axes', () => {
    const s = funnelSlice(lookupFrame(), 'quiz', { platform: 'Meta Ads', language: 'EN' });
    expect(s.measured).toBe(true);
    expect(s.steps).toEqual([
      { key: 'visit', label: 'Visit', users: 40 },
      { key: 'lead', label: 'Lead', users: 22 },
      { key: 'buy', label: 'Buy', users: 7 },
    ]);
    expect(s.users).toBe(40);
    expect(s.lowSample).toBe(true);
    expect(s.bandsInherited).toBe(true);
    expect(s.metrics).toEqual({});
  });

  it('own bands win over the set bands; a missing step stays missing', () => {
    const s = funnelSlice(lookupFrame(), 'quiz', { platform: 'TikTok Ads' });
    expect(s.bandsInherited).toBe(false);
    expect(s.bands.lead_rate.floor).toBe(20);
    expect(s.steps.map((x) => x.key)).toEqual(['visit', 'lead']);
  });

  it('band inheritance is per metric: a path banding some metrics inherits the set band for the rest', () => {
    const f = lookupFrame();
    // TikTok Ads bands lead_rate itself, not cost_per_lead.
    f.funnels[0].segments![1].metrics!.cost_per_lead = metric(14, 11, { format: 'usd' });
    const s = funnelSlice(f, null, { platform: 'TikTok Ads' });
    expect(s.bandsInherited).toBe(false);
    expect(s.inheritedBands).toEqual(['cost_per_lead']);
    expect(s.bands.cost_per_lead).toEqual(f.bands!.cost_per_lead);
    const rows = benchmarkRows(s, ['lead_rate', 'cost_per_lead']);
    expect(rows[0]).toMatchObject({ key: 'lead_rate', floor: 20, target: 28, inherited: false, status: 'between' });
    // Not 'no-band': the set band applies (lower is better, 14 > floor 12), marked inherited on this row only.
    expect(rows[1]).toMatchObject({ key: 'cost_per_lead', floor: 12, target: 6, floorSource: 'book', better: 'lower', inherited: true, status: 'below', trend: 'worsening' });
    // segments tone the inherited metric by the set band as well.
    const seg = segmentRows(f, null, 'platform', {}, ['cost_per_lead']).find((r) => r.value === 'TikTok Ads')!;
    expect(seg.cells.cost_per_lead.tone).toBe('below');
    // A path with no bands of its own inherits them all; the funnel level inherits none.
    expect(funnelSlice(f, null, { platform: 'Meta Ads' })).toMatchObject({ bandsInherited: true, inheritedBands: ['lead_rate', 'cost_per_lead'] });
    expect(funnelSlice(f, null, {}).inheritedBands).toEqual([]);
    // A slice built without the per-metric list keeps the slice-level answer.
    const legacy = { ...funnelSlice(f, null, { platform: 'Meta Ads' }), inheritedBands: undefined };
    expect(benchmarkRows(legacy, ['lead_rate'])[0].inherited).toBe(true);
  });

  it('unmeasured or absent combos are not zero: measured false, reason, no steps', () => {
    const un = funnelSlice(lookupFrame(), 'quiz', { platform: 'TikTok Ads', language: 'ES' });
    expect(un).toMatchObject({ measured: false, reason: 'fewer than 300 users in the window', steps: [], metrics: {}, daily: [] });
    const none = funnelSlice(lookupFrame(), 'quiz', { platform: 'Meta Ads', language: 'ES' });
    expect(none).toMatchObject({ measured: false, reason: null, steps: [] });
  });

  it('undeclared dims are ignored; an unknown funnel id falls back to the first', () => {
    const s = funnelSlice(lookupFrame(), 'nope', { platform: 'Meta Ads', country: 'Spain' });
    expect(s.funnelId).toBe('quiz');
    expect(s.ignored).toEqual(['country']);
    expect(s.selection).toEqual({ platform: 'Meta Ads' });
    expect(s.users).toBe(600);
  });

  it('a frame with no funnels gives an unmeasured slice', () => {
    expect(funnelSlice({ kind: 'funnel', insight: 'x', funnels: [] }, null, {})).toMatchObject({ measured: false, funnelId: '' });
  });
});

describe('funnelSlice (cells mode)', () => {
  const cells = (): FunnelFrame => ({
    kind: 'funnel',
    insight: 'acme',
    dimensions: [{ key: 'platform', label: 'Platform', values: ['A', 'B'] }, { key: 'language', label: 'Language', values: ['EN', 'ES'] }],
    funnels: [{
      id: 'f', name: 'F', steps: STEPS, metrics: { lead_rate: metric(40, 35) },
      segments: [
        { dims: { platform: 'A', language: 'EN' }, users: 100, measured: true, reason: null, steps: [{ key: 'visit', users: 100 }, { key: 'lead', users: 50 }] },
        { dims: { platform: 'A', language: 'ES' }, users: 60, measured: true, reason: null, steps: [{ key: 'visit', users: 60 }, { key: 'lead', users: 20 }] },
        { dims: { platform: 'A', language: 'DE' }, users: 999, measured: false, reason: 'broken', steps: [{ key: 'visit', users: 999 }] },
        { dims: { platform: 'B', language: 'ES' }, users: 5, measured: false, reason: 'too few', steps: [] },
      ],
    }],
  });

  it('sums matching measured cells only; rates and daily stay empty; bands inherited', () => {
    const s = funnelSlice(cells(), null, { platform: 'A' });
    expect(s.users).toBe(160);
    expect(s.steps).toEqual([
      { key: 'visit', label: 'Visit', users: 160 },
      { key: 'lead', label: 'Lead', users: 70 },
      { key: 'buy', label: 'Buy', users: 0 },
    ]);
    expect(s.metrics).toEqual({});
    expect(s.daily).toEqual([]);
    expect(s.bandsInherited).toBe(true);
  });

  it('only unmeasured cells -> unmeasured slice with their reason', () => {
    expect(funnelSlice(cells(), null, { platform: 'B' })).toMatchObject({ measured: false, reason: 'too few', steps: [] });
  });
});

describe('breakdownAxes', () => {
  it('disables chips that lead to an unmeasured slice, keeps the active chip clearable', () => {
    const axes = breakdownAxes(lookupFrame(), null, { platform: 'TikTok Ads' });
    expect(axes.map((a) => a.key)).toEqual(['platform', 'language']);
    const [platform, language] = axes;
    expect(platform.chips).toEqual([
      { value: 'Meta Ads', active: false, enabled: true, users: 600, reason: null },
      { value: 'TikTok Ads', active: true, enabled: true, users: 400, reason: null },
    ]);
    expect(language.chips[0]).toEqual({ value: 'EN', active: false, enabled: false, users: null, reason: null });
    expect(language.chips[1]).toEqual({ value: 'ES', active: false, enabled: false, users: null, reason: 'fewer than 300 users in the window' });
  });

  it('an active chip on an unmeasured selection stays enabled', () => {
    const axes = breakdownAxes(lookupFrame(), null, { platform: 'TikTok Ads', language: 'ES' });
    const es = axes[1].chips.find((c) => c.value === 'ES')!;
    expect(es).toMatchObject({ active: true, enabled: true, users: null });
  });
});

describe('stepDrops', () => {
  it('rates 0-100, worst = largest drop, ties to the first', () => {
    const d = stepDrops(STEPS);
    expect(d.map((x) => x.ofTop)).toEqual([100, 40, 10]);
    expect(d.map((x) => x.ofPrev)).toEqual([null, 40, 25]);
    expect(d.map((x) => x.dropPct)).toEqual([null, 60, 75]);
    expect(d.map((x) => x.worst)).toEqual([false, false, true]);
    const tie = stepDrops([{ key: 'a', users: 100 }, { key: 'b', users: 50 }, { key: 'c', users: 25 }]);
    expect(tie.map((x) => x.worst)).toEqual([false, true, false]);
    expect(tie[0].label).toBe('a');
  });

  it('none worst with fewer than 2 steps; a 0-user previous step gives null, never Infinity', () => {
    expect(stepDrops([{ key: 'a', users: 5 }])[0].worst).toBe(false);
    expect(stepDrops([])).toEqual([]);
    const z = stepDrops([{ key: 'a', users: 0 }, { key: 'b', users: 0 }]);
    expect(z[1]).toMatchObject({ ofTop: null, ofPrev: null, dropPct: null, worst: false });
  });
});

describe('benchmarkRows', () => {
  it('status and trend, with better:lower flipping both', () => {
    const rows = benchmarkRows(funnelSlice(lookupFrame(), null, {}), null);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      key: 'lead_rate', current: 40, prev: 35, delta: 5, floor: 30, target: 45,
      floorSource: 'book', targetSource: 'own p25 (8 wk)', status: 'between', trend: 'improving', inherited: false,
    });
    // cost 8, floor 12, target 6, lower is better: between; 8 < 10 is improving.
    expect(rows[1]).toMatchObject({ key: 'cost_per_lead', format: 'usd', better: 'lower', status: 'between', delta: -2, trend: 'improving' });
    const f = lookupFrame();
    f.funnels[0].metrics!.cost_per_lead = metric(13, 13, { format: 'usd' });
    f.funnels[0].metrics!.lead_rate = metric(46, 50);
    const r2 = benchmarkRows(funnelSlice(f, null, {}), ['cost_per_lead', 'lead_rate']);
    expect(r2.map((r) => [r.key, r.status, r.trend])).toEqual([['cost_per_lead', 'below', 'flat'], ['lead_rate', 'above', 'worsening']]);
    f.funnels[0].metrics!.cost_per_lead = metric(5, 6, { format: 'usd' });
    expect(benchmarkRows(funnelSlice(f, null, {}), ['cost_per_lead'])[0].status).toBe('above');
  });

  it('unmeasured metrics read unmeasured with their reason, no-band when no band, inherited noted', () => {
    const f = lookupFrame();
    f.funnels[0].metrics!.checkout = metric(null, null, { measured: false, reason: 'denominator event missing' });
    f.funnels[0].metrics!.aov = metric(30, null, { format: 'usd' });
    const rows = benchmarkRows(funnelSlice(f, null, {}), ['checkout', 'aov', 'unknown']);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: 'unmeasured', current: null, reason: 'denominator event missing', trend: null });
    expect(rows[1]).toMatchObject({ status: 'no-band', delta: null, trend: null });
    const seg = benchmarkRows(funnelSlice(lookupFrame(), null, { platform: 'Meta Ads' }), null);
    expect(seg[0]).toMatchObject({ key: 'lead_rate', status: 'above', inherited: true, trend: 'flat' });
    const un = benchmarkRows(funnelSlice(lookupFrame(), null, { platform: 'TikTok Ads', language: 'ES' }), ['lead_rate']);
    expect(un[0]).toMatchObject({ status: 'unmeasured', reason: 'fewer than 300 users in the window', current: null });
  });
});

describe('segmentRows', () => {
  it('one row per value under the other axes, band tones, low sample, unmeasured rows', () => {
    const rows = segmentRows(lookupFrame(), null, 'platform', {}, null);
    expect(rows.map((r) => r.value)).toEqual(['Meta Ads', 'TikTok Ads']);
    expect(rows[0]).toMatchObject({ measured: true, users: 600, lowSample: false, selection: { platform: 'Meta Ads' } });
    expect(rows[0].cells.lead_rate).toEqual({ v: 50, prev: 50, tone: 'above' });
    expect(rows[0].cells.cost_per_lead).toEqual({ v: null, prev: null, tone: null });
    expect(rows[1].cells.lead_rate).toEqual({ v: 25, prev: 30, tone: 'between' });
    const byLang = segmentRows(lookupFrame(), null, 'language', { platform: 'Meta Ads' }, ['lead_rate']);
    expect(byLang[0]).toMatchObject({ value: 'EN', measured: true, users: 40, lowSample: true });
    expect(byLang[1]).toMatchObject({ value: 'ES', measured: false, users: 0 });
    expect(segmentRows(lookupFrame(), null, 'country', {}, null)).toEqual([]);
  });
});

describe('dailySeries', () => {
  it('one series per metric, null days are gaps, shared format unit', () => {
    const s = dailySeries(funnelSlice(lookupFrame(), null, {}), ['lead_rate'], 'acme');
    expect(s).toEqual({
      kind: 'series', insight: 'acme', unit: '%', granularity: 'daily',
      series: [{ name: 'lead_rate', points: [{ t: '2026-09-01', v: 38 }, { t: '2026-09-02', v: 41 }] }],
    });
    const both = dailySeries(funnelSlice(lookupFrame(), null, {}), null);
    expect(both.unit).toBeNull();
    expect(both.series[1].points).toEqual([{ t: '2026-09-02', v: 9 }]);
    const seg = dailySeries(funnelSlice(lookupFrame(), null, { platform: 'Meta Ads' }), null);
    expect(seg.series).toEqual([{ name: 'lead_rate', points: [{ t: '2026-09-01', v: 49 }] }]);
  });
});

describe('projectFunnelFrame', () => {
  it('keeps the picked funnel, daily only for trend, no rates for funnel/breakdown', () => {
    const f = lookupFrame();
    const trend = projectFunnelFrame(f, 'trend', { funnel: 'quiz' });
    expect(trend.funnels.map((x) => x.id)).toEqual(['quiz']);
    expect(trend.funnels[0].daily).toHaveLength(2);
    expect(trend.funnels[0].segments![0].daily).toHaveLength(1);

    const bench = projectFunnelFrame(f, 'benchmark', {});
    expect(bench.funnels).toHaveLength(2);
    expect(bench.funnels[0].daily).toBeUndefined();
    expect(bench.funnels[0].segments!.some((s) => s.daily)).toBe(false);
    expect(bench.funnels[0].metrics).toBeDefined();
    expect(bench.bands).toBeDefined();

    for (const type of ['funnel', 'breakdown']) {
      const p = projectFunnelFrame(f, type, { funnel: 'missing' });
      expect(p.funnels).toHaveLength(2);
      expect(p.bands).toBeUndefined();
      expect(p.funnels[0].metrics).toBeUndefined();
      expect(p.funnels[0].segments!.some((s) => s.metrics || s.bands || s.daily)).toBe(false);
      expect(p.funnels[0].segments!.map((s) => s.measured)).toEqual(f.funnels[0].segments!.map((s) => s.measured));
    }
    // Pure: the input is untouched.
    expect(f.funnels[0].daily).toHaveLength(2);
    expect(f.bands).toBeDefined();
    expect(f.funnels[0].segments![0].metrics).toBeDefined();
  });
});

describe('projectFunnelFrame: each block type gets only what it reads', () => {
  it('one-funnel blocks keep the shown funnel in full and the rest as id, name, steps', () => {
    const f = lookupFrame();
    for (const type of ['breakdown', 'trend', 'benchmark', 'segments']) {
      const p = projectFunnelFrame(f, type, {});
      expect(p.funnels.map((x) => x.id), type).toEqual(['quiz', 'activation']);
      expect(p.funnels[1], type).toEqual({ id: 'activation', name: 'Activation ladder', steps: f.funnels[1].steps });
      expect(p.funnels[0].segments!.length, type).toBeGreaterThan(0);
    }
    // An unknown pick falls back to the first, like funnelSlice.
    expect(projectFunnelFrame(f, 'benchmark', { funnel: 'nope' }).funnels[0].metrics).toBeDefined();
    // The funnel block draws every funnel when nothing is picked: all stay whole.
    expect(projectFunnelFrame(f, 'funnel', {}).funnels[1]).toEqual(f.funnels[1]);
  });

  it('trend: metrics without bands, days trimmed to its metrics pick, null entries dropped where the level names the metric', () => {
    const f = lookupFrame();
    f.funnels[0].segments![0].metrics!.cost_per_lead = metric(9, 8, { format: 'usd' });
    f.funnels[0].segments![0].daily = [{ t: '2026-09-01', m: { lead_rate: 49, cost_per_lead: null } }];
    const all = projectFunnelFrame(f, 'trend', {});
    expect(all.bands).toBeUndefined();
    expect(all.funnels[0].segments!.some((s) => s.bands)).toBe(false);
    // cost_per_lead is null on day 1 and the funnel names it: the entry goes, the metric stays known.
    expect(all.funnels[0].daily![0]).toEqual({ t: '2026-09-01', m: { lead_rate: 38 } });
    expect(all.funnels[0].segments![0].daily).toEqual([{ t: '2026-09-01', m: { lead_rate: 49 } }]);
    for (const sel of [{}, { platform: 'Meta Ads' }]) {
      expect(dailySeries(funnelSlice(all, null, sel), null)).toEqual(dailySeries(funnelSlice(f, null, sel), null));
    }
    const picked = projectFunnelFrame(f, 'trend', { metrics: ['cost_per_lead'] });
    expect(picked.funnels[0].daily!.map((d) => Object.keys(d.m))).toEqual([[], ['cost_per_lead']]);
    expect(Object.keys(picked.funnels[0].segments![0].metrics!)).toEqual(['cost_per_lead']);
    // The funnel level keeps every metric (the inspector lists them from the frame).
    expect(Object.keys(picked.funnels[0].metrics!)).toEqual(['lead_rate', 'cost_per_lead']);
    expect(dailySeries(funnelSlice(picked, null, {}), ['cost_per_lead'])).toEqual(dailySeries(funnelSlice(f, null, {}), ['cost_per_lead']));
  });

  it('trend: a comma-separated metrics string picks each metric (as the blocks and the CLI read it)', () => {
    const f = lookupFrame();
    f.funnels[0].segments![0].metrics!.cost_per_lead = metric(9, 8, { format: 'usd' });
    f.funnels[0].segments![0].daily = [{ t: '2026-09-01', m: { lead_rate: 49, cost_per_lead: 7 } }];
    const keys = ['lead_rate', 'cost_per_lead'];
    const fromString = projectFunnelFrame(f, 'trend', { metrics: ' lead_rate , cost_per_lead,' });
    // The same projection as the list form, never "one key named 'lead_rate,cost_per_lead'".
    expect(fromString).toEqual(projectFunnelFrame(f, 'trend', { metrics: keys }));
    expect(Object.keys(fromString.funnels[0].segments![0].metrics!)).toEqual(keys);
    for (const sel of [{}, { platform: 'Meta Ads' }]) {
      const series = dailySeries(funnelSlice(fromString, null, sel), keys);
      expect(series).toEqual(dailySeries(funnelSlice(f, null, sel), keys));
      expect(series.series.every((s) => s.points.length > 0)).toBe(true);
    }
    // A blank string is no pick: every metric's days stay.
    expect(projectFunnelFrame(f, 'trend', { metrics: ' , ' })).toEqual(projectFunnelFrame(f, 'trend', {}));
  });

  it('segments keeps only the paths naming its by dim (the option, else the first dim)', () => {
    const f = lookupFrame();
    const byLang = projectFunnelFrame(f, 'segments', { by: 'language' });
    expect(byLang.funnels[0].segments!.every((s) => s.dims.language !== undefined)).toBe(true);
    expect(byLang.funnels[0].segments).toHaveLength(3);
    const byDefault = projectFunnelFrame(f, 'segments', { by: 'nope' });
    expect(byDefault.funnels[0].segments!.every((s) => s.dims.platform !== undefined)).toBe(true);
    for (const sel of [{}, { platform: 'Meta Ads' }, { platform: 'TikTok Ads' }, { language: 'EN' }]) {
      expect(segmentRows(byLang, null, 'language', sel, null)).toEqual(segmentRows(f, null, 'language', sel, null));
      expect(segmentRows(byDefault, null, 'platform', sel, null)).toEqual(segmentRows(f, null, 'platform', sel, null));
    }
    expect(byLang.bands).toEqual(f.bands);
  });
});

describe('buildFunnel maps the full set; resolveBlocks projects per block', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dc-lab-slice-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function seed(): void {
    createInsight(root, { slug: 'acme-funnel-explorer', title: 'Acme funnel', render: 'funnel', adapter: 'script' });
    const cache: InsightCache = {
      slug: 'acme-funnel-explorer', fetchedAt: '2026-09-01T00:00:00Z', tweaks: {}, granularity: 'daily', unit: null,
      series: [], latest: null, error: null, errorAt: null, scriptHash: null,
      funnel: {
        notices: [],
        range: { fromISO: '2026-09-01', toISO: '2026-09-28' },
        set: {
          kind: 'funnel-set/v1',
          segment_mode: 'lookup',
          low_sample_threshold: 300,
          dimensions: [
            { key: 'platform', label: 'Platform', mode: 'client', values: [{ value: 'Meta Ads' }, { value: 'TikTok Ads' }] },
            { key: 'language', label: 'Language', mode: 'client' },
            { key: 'country', label: 'Country', mode: 'refetch' },
          ],
          benchmarks: { cost_per_lead: { floor: 12, target: 6, floor_source: 'book', better: 'lower' } },
          funnels: [{
            id: 'quiz', name: 'Quiz checkout (v2)', meta: {},
            metrics: {
              cost_per_lead: { v: 8, prev: 10, format: 'usd', label: 'Cost per lead' },
              checkout: { v: null, format: 'pct', measured: false, reason: 'denominator event missing on one branch' },
            },
            steps: [{ key: 'visit', label: 'Visit', users: 1000, prev: 900 }, { key: 'lead', label: 'Lead', users: 400 }],
            daily: [{ t: '2026-09-01', m: { cost_per_lead: 9 } }],
            segments: [
              { dims: { platform: 'Meta Ads', language: 'EN' }, users: 500, steps: [{ key: 'visit', users: 500 }], metrics: { cost_per_lead: { v: 7, format: 'usd' } }, benchmarks: { cost_per_lead: { target: 5 } }, daily: [{ t: '2026-09-01', m: { cost_per_lead: 7 } }] },
              { dims: { platform: 'TikTok Ads', language: 'ES' }, users: 0, steps: [], measured: false, reason: 'fewer than 300 users in the window' },
              { dims: { language: 'ES' }, users: 90, steps: [{ key: 'visit', users: 90 }] },
            ],
          }],
        },
      },
    };
    writeCache(root, 'acme-funnel-explorer', cache);
  }

  it('snake -> camel, measured default true, client dims only with values, bands, lowSample', () => {
    seed();
    const f = resolveFrame(root, 'acme-funnel-explorer', ['funnel']) as FunnelFrame;
    expect(f.segmentMode).toBe('lookup');
    expect(f.lowSample).toBe(300);
    expect(f.dimensions).toEqual([
      { key: 'platform', label: 'Platform', values: ['Meta Ads', 'TikTok Ads'] },
      { key: 'language', label: 'Language', values: ['EN', 'ES'] },
    ]);
    expect(f.bands).toEqual({ cost_per_lead: { floor: 12, target: 6, floorSource: 'book', targetSource: null, better: 'lower' } });
    const q = f.funnels[0];
    expect(q.steps).toEqual([{ key: 'visit', label: 'Visit', users: 1000, prev: 900 }, { key: 'lead', label: 'Lead', users: 400 }]);
    expect(q.metrics!.cost_per_lead).toEqual({ v: 8, prev: 10, format: 'usd', label: 'Cost per lead', measured: true, reason: null });
    expect(q.metrics!.checkout).toMatchObject({ v: null, measured: false, reason: 'denominator event missing on one branch' });
    expect(q.daily).toEqual([{ t: '2026-09-01', m: { cost_per_lead: 9 } }]);
    expect(q.segments![0]).toMatchObject({ measured: true, reason: null, bands: { cost_per_lead: { floor: null, target: 5, better: 'higher' } } });
    expect(q.segments![1]).toMatchObject({ measured: false, reason: 'fewer than 300 users in the window' });

    const rows = benchmarkRows(funnelSlice(f, null, {}), null);
    expect(rows.map((r) => [r.key, r.status])).toEqual([['cost_per_lead', 'between'], ['checkout', 'unmeasured']]);
    // A lookup intersection below the low-sample line.
    expect(funnelSlice(f, null, { language: 'ES' })).toMatchObject({ measured: true, users: 90, lowSample: true });
  });

  it('a board funnel block gets the projected frame (no daily, no metrics)', () => {
    seed();
    const frames = resolveBoardFrames(root, {
      cards: [{ id: 'c1', at: { x: 0, y: 0, w: 6, h: 6 }, blocks: [{ type: 'funnel', data: 'acme-funnel-explorer', options: {} }] }],
    } as never);
    const f = frames['c1:0'] as FunnelFrame;
    expect(f.kind).toBe('funnel');
    expect(f.funnels[0].daily).toBeUndefined();
    expect(f.funnels[0].metrics).toBeUndefined();
    expect(f.bands).toBeUndefined();
    expect(f.funnels[0].segments).toHaveLength(3);
  });
});

describe('funnel explorer preset', () => {
  const dims = [
    { key: 'platform', label: 'Platform' },
    { key: 'language', label: 'Language' },
    { key: 'country', label: 'Country' },
    { key: 'device', label: 'Device' },
    { key: 'cohort', label: 'Cohort' },
  ];

  it('breakdown over tabs Daily, Benchmark, Flow, Steps, then one segments tab per dim (first 4)', () => {
    const blocks = funnelExplorerBlocks('acme-funnel-explorer', dims.slice(0, 1), 'en');
    expect(blocks).toEqual([
      { type: 'breakdown', data: 'acme-funnel-explorer', options: {} },
      {
        type: 'tabs',
        options: {},
        tabs: [
          { label: 'Daily', blocks: [{ type: 'trend', data: 'acme-funnel-explorer', options: {} }] },
          { label: 'Benchmark', blocks: [{ type: 'benchmark', data: 'acme-funnel-explorer', options: {} }] },
          { label: 'Flow', blocks: [{ type: 'funnel', data: 'acme-funnel-explorer', options: { layout: 'flow', markWorst: true } }] },
          { label: 'Steps', blocks: [{ type: 'funnel', data: 'acme-funnel-explorer', options: { layout: 'bars', markWorst: true } }] },
          { label: 'Platform', blocks: [{ type: 'segments', data: 'acme-funnel-explorer', options: { by: 'platform' } }] },
        ],
      },
    ]);
    const many = funnelExplorerBlocks('acme-funnel-explorer', dims, 'en');
    expect(many[1].tabs!.slice(4).map((t) => t.blocks[0].options.by)).toEqual(['platform', 'language', 'country', 'device']);
  });

  it('Turkish labels at insertion; size 12x12; deterministic', () => {
    const tr = funnelExplorerBlocks('acme-funnel-explorer', [], 'tr');
    expect(tr[1].tabs!.map((t) => t.label)).toEqual(['Günlük', 'Kıyas', 'Akış', 'Adımlar']);
    expect(PRESET_LABELS['funnel-explorer'].tr).toBe('Huni gezgini');
    expect(FUNNEL_EXPLORER_SIZE).toEqual({ w: 12, h: 12 });
    expect(funnelExplorerBlocks('x', dims, 'en')).toEqual(funnelExplorerBlocks('x', dims, 'en'));
    for (const l of Object.values(PRESET_LABELS)) expect(`${l.en}${l.tr}`).not.toMatch(/—/);
  });
});
