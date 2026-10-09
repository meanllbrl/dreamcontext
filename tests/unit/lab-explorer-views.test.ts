/**
 * The funnel explorer's view functions (frameOps.ts): k/n, ranking, payment,
 * access, missing-path reasons, band origin, unmeasured steps, note order and
 * the all-funnels projection. Pure functions over a synthetic Acme frame.
 */
import { describe, expect, it } from 'vitest';
import {
  KN_THRESHOLD,
  RANKING_DEFAULT_FLOOR,
  accessView,
  benchmarkRows,
  breakdownAxes,
  explorerHint,
  funnelSlice,
  hasAccess,
  isSmallKn,
  knOf,
  orderedNotes,
  paymentView,
  projectFunnelFrame,
  rankableMetrics,
  rankingRows,
  segmentRows,
  shareFrames,
  stepDrops,
  unmeasuredColumns,
  type FunnelFrame,
  type FunnelFrameBand,
  type FunnelFrameMetric,
  type FunnelFrameSegment,
} from '../../src/lib/lab/frameOps.js';
import { BLOCK_CATALOG, BLOCK_TYPES } from '../../src/lib/lab/blocks.js';
import { cardPicksFunnels, funnelExplorerBlocks } from '../../src/lib/lab/presets.js';

const pct = (v: number | null, prev: number | null = null, extra: Partial<FunnelFrameMetric> = {}): FunnelFrameMetric => ({
  v, prev, format: 'pct', label: null, measured: true, reason: null, ...extra,
});
const band = (floor: number | null, target: number | null, extra: Partial<FunnelFrameBand> = {}): FunnelFrameBand => ({
  floor, target, floorSource: null, targetSource: null, better: 'higher', ...extra,
});
const seg = (dims: Record<string, string>, users: number, conv: number, extra: Partial<FunnelFrameSegment> = {}): FunnelFrameSegment => ({
  dims,
  users,
  steps: [{ key: 'visit', users }, { key: 'lead', users: Math.round(users * 0.4) }, { key: 'paid', users: Math.round(users * conv / 100) }],
  measured: true,
  reason: null,
  metrics: { conversion: pct(conv) },
  ...extra,
});

/** Two funnels (one with a dead lead event), lookup paths, declared intersections, rates, notes, payment, access. */
function frame(): FunnelFrame {
  return {
    kind: 'funnel',
    insight: 'acme-storefront-funnels',
    segmentMode: 'lookup',
    lowSample: 100,
    dimensions: [
      { key: 'platform', label: 'Platform', values: ['web', 'ios'] },
      { key: 'country', label: 'Country', values: ['TR', 'DE'] },
    ],
    bands: { conversion: band(1, 3, { floorFrom: 'book', targetFrom: 'own', weeks: 8 }) },
    ladder: ['conversion'],
    rates: { conversion: { num: 'paid', den: 'visit' } },
    intersections: [{ dims: ['country', 'platform'], minUsers: 300 }],
    notes: [
      { code: null, text: 'Country is the billing country.', level: 'trap', keys: ['dim:country'], scope: 'set' },
      { code: 'A1', text: 'Refunds are not netted.', level: 'info', keys: [], scope: 'set' },
    ],
    hints: { daily: 'pull dims [date, funnel], granularity day' },
    paymentReasons: [
      { key: 'insufficient', label: 'Insufficient funds', note: null },
      { key: 'declined', label: 'Card declined', note: 'issuer said no' },
    ],
    payment: { measured: true, reason: null, cells: [{ dims: {}, cohort: 'all', attempts: 1000, declines: 100, reasons: {} }] },
    access: {
      stages: [{ key: 'paid', label: 'Paid' }, { key: 'app', label: 'Opened the app' }],
      rows: [
        { funnel: null, dims: {}, counts: { paid: 400, app: 300 } },
        { funnel: 'quiz', dims: {}, counts: { paid: 50, app: 20 } },
        { funnel: 'quiz', dims: { country: 'DE' }, counts: { paid: 10, app: null } },
      ],
      asOf: '2026-09-30',
    },
    funnels: [
      {
        id: 'quiz',
        name: 'Quiz checkout',
        steps: [
          { key: 'visit', label: 'Visit', users: 1000 },
          { key: 'lead', label: 'Lead', users: 400, basis: 'derived' },
          { key: 'paid', label: 'Paid', users: 20 },
        ],
        metrics: { conversion: pct(2, 1.8) },
        bands: { conversion: band(1.5, 2.5, { floorFrom: 'own', targetFrom: 'own', weeks: 6 }) },
        notes: [
          { code: 'C1', text: 'No checkout event.', level: 'trap', keys: ['paid'], scope: 'funnel' },
          { code: null, text: 'Pricing test ran in week 2.', level: 'info', keys: [], scope: 'funnel' },
        ],
        unmeasured: { 'dim:language': 'language was not pulled for this funnel' },
        payment: {
          measured: true,
          reason: null,
          cells: [
            { dims: {}, cohort: 'first', attempts: 500, declines: 50, reasons: { insufficient: 30, declined: 10 } },
            { dims: { country: 'TR' }, cohort: 'first', attempts: 400, declines: 40, reasons: { insufficient: 30, declined: 15 } },
            { dims: { country: 'DE' }, cohort: 'first', attempts: 60, declines: 6, reasons: { declined: 2, odd: 1 } },
            { dims: {}, cohort: 'renewal', attempts: 200, declines: 10, reasons: {} },
          ],
        },
        segments: [
          seg({ platform: 'web' }, 700, 2.4),
          seg({ platform: 'ios' }, 300, 1.2),
          seg({ country: 'TR' }, 800, 2.2),
          seg({ country: 'DE' }, 150, 1.0),
          // Same cohort as `country: TR` (95% of its users, value within 5%): a duplicate in the ranking.
          seg({ country: 'TR', platform: 'web' }, 760, 2.25),
          seg({ country: 'DE', platform: 'ios' }, 0, 0, { measured: false, reason: 'fewer than 300 users', steps: [], metrics: undefined }),
        ],
      },
      {
        id: 'ladder',
        name: 'Activation ladder',
        steps: [
          { key: 'visit', label: 'Visit', users: 500 },
          { key: 'lead', label: 'Lead', users: 0, measured: false, reason: 'lead event not recorded' },
          { key: 'paid', label: 'Paid', users: 40 },
        ],
        metrics: { conversion: pct(8) },
        notes: [{ code: 'C10', text: 'Lead is not recorded.', level: 'trap', keys: ['lead'], scope: 'funnel' }],
        unmeasured: { segments: 'breakdowns pulled for the top funnel only' },
        segments: [seg({ platform: 'web' }, 90, 9)],
      },
    ],
  };
}

describe('k/n', () => {
  it('reads the slice steps through the rate definition; null without one or on a dead step', () => {
    const f = frame();
    expect(knOf(f, funnelSlice(f, 'quiz', {}), 'conversion')).toEqual({ k: 20, n: 1000 });
    expect(knOf(f, funnelSlice(f, 'quiz', { country: 'DE' }), 'conversion')).toEqual({ k: 2, n: 150 });
    expect(knOf(f, funnelSlice(f, 'quiz', {}), 'missing')).toBeNull();
    expect(knOf(f, funnelSlice(f, 'quiz', { country: 'DE', platform: 'ios' }), 'conversion')).toBeNull();
    const dead = { ...f, rates: { lead_rate: { num: 'lead', den: 'visit' } } };
    expect(knOf(dead, funnelSlice(dead, 'ladder', {}), 'lead_rate')).toBeNull();
    expect(isSmallKn({ k: 3, n: KN_THRESHOLD - 1 })).toBe(true);
    expect(isSmallKn({ k: 3, n: KN_THRESHOLD })).toBe(false);
    expect(isSmallKn(null)).toBe(false);
  });

  it('segment cells carry k/n', () => {
    const rows = segmentRows(frame(), 'quiz', 'country', {}, ['conversion']);
    expect(rows.find((r) => r.value === 'DE')!.cells.conversion.kn).toEqual({ k: 2, n: 150 });
  });
});

describe('missing paths and band origin', () => {
  it('an undeclared combination is not-pulled, a declared one below-floor, one axis carries no code', () => {
    const f = frame();
    expect(funnelSlice(f, 'quiz', { country: 'DE', platform: 'web' })).toMatchObject({ measured: false, reasonCode: 'below-floor' });
    const noDecl = { ...f, intersections: [] };
    expect(funnelSlice(noDecl, 'quiz', { country: 'DE', platform: 'web' })).toMatchObject({ measured: false, reasonCode: 'not-pulled' });
    // A set that declares nothing keeps the old wording (no code).
    const legacy = { ...f };
    delete legacy.intersections;
    expect(funnelSlice(legacy, 'quiz', { country: 'DE', platform: 'web' }).reasonCode ?? null).toBeNull();
    // The path exists but is unmeasured: its own reason, no code.
    expect(funnelSlice(f, 'quiz', { country: 'DE', platform: 'ios' })).toMatchObject({ reason: 'fewer than 300 users', reasonCode: null });
  });

  it('a funnel without paths says why from its own unmeasured map', () => {
    expect(funnelSlice(frame(), 'ladder', { country: 'TR' })).toMatchObject({ measured: false, reason: 'breakdowns pulled for the top funnel only' });
    const chip = breakdownAxes(frame(), 'quiz', { country: 'DE' }).find((a) => a.key === 'platform')!.chips.find((c) => c.value === 'web')!;
    expect(chip).toMatchObject({ enabled: false, reasonCode: 'below-floor' });
  });

  it('funnel level: the funnel band wins; under a ladder a set band is inherited from the total', () => {
    const f = frame();
    const q = funnelSlice(f, 'quiz', {});
    expect(q.bands.conversion.floor).toBe(1.5);
    expect(q.bandOrigin).toEqual({ conversion: 'funnel' });
    expect(benchmarkRows(q, ['conversion'])[0]).toMatchObject({ inherited: false, floorFrom: 'own', targetFrom: 'own', weeks: 6, inheritedFrom: null });
    const l = funnelSlice(f, 'ladder', {});
    expect(benchmarkRows(l, ['conversion'])[0]).toMatchObject({ floor: 1, inherited: true, inheritedFrom: 'set', floorFrom: 'book', targetFrom: 'own', weeks: 8 });
    // Without a ladder the set band is the funnel's own (today's pin): not inherited.
    const noLadder = { ...f };
    delete noLadder.ladder;
    expect(benchmarkRows(funnelSlice(noLadder, 'ladder', {}), ['conversion'])[0]).toMatchObject({ inherited: false, inheritedFrom: null });
  });

  it('a path inherits the funnel band before the set band', () => {
    const p = funnelSlice(frame(), 'quiz', { country: 'TR' });
    expect(p.bands.conversion.floor).toBe(1.5);
    expect(benchmarkRows(p, ['conversion'])[0]).toMatchObject({ inherited: true, inheritedFrom: 'funnel' });
  });
});

describe('stepDrops with an unmeasured step', () => {
  it('skips the dead step and compares the next one with the last measured', () => {
    const drops = stepDrops(funnelSlice(frame(), 'ladder', {}).steps);
    expect(drops[1]).toMatchObject({ key: 'lead', measured: false, ofPrev: null, dropPct: null, worst: false, prevUsers: 500 });
    expect(drops[2]).toMatchObject({ key: 'paid', measured: true, prevUsers: 500, worst: true });
    expect(drops[2].ofPrev).toBeCloseTo(8);
  });

  it('carries basis and prevUsers', () => {
    const drops = stepDrops(funnelSlice(frame(), 'quiz', {}).steps);
    expect(drops.map((d) => [d.basis, d.prevUsers])).toEqual([['measured', null], ['derived', 1000], ['measured', 400]]);
  });

  it('a path keeps the funnel step\'s dead mark and basis', () => {
    const f = frame();
    f.funnels[1].segments = [seg({ platform: 'web' }, 400, 9)];
    const steps = funnelSlice(f, 'ladder', { platform: 'web' }).steps;
    expect(steps[1]).toMatchObject({ key: 'lead', measured: false, reason: 'lead event not recorded', users: 0 });
    expect(funnelSlice(frame(), 'quiz', { country: 'TR' }).steps[1].basis).toBe('derived');
  });
});

describe('ranking', () => {
  it('each funnel\'s best path over the floor, duplicates dropped, funnels without a path listed', () => {
    const r = rankingRows(frame(), 'conversion');
    expect(r.minUsers).toBe(RANKING_DEFAULT_FLOOR);
    expect(r.rows.map((x) => [x.funnelId, x.selection])).toEqual([['quiz', { platform: 'web' }]]);
    expect(r.rows[0]).toMatchObject({ value: 2.4, users: 700, total: 2, kn: { k: 17, n: 700 }, lowSample: false });
    expect(r.dropped).toEqual([{ funnelId: 'ladder', funnelName: 'Activation ladder', why: 'no-path' }]);
  });

  it('the duplicate intersection never wins, a lower floor admits small paths, best first', () => {
    const f = frame();
    // Push the TR x web intersection above its parent, still within 5%: still a duplicate.
    f.funnels[0].segments![4] = seg({ country: 'TR', platform: 'web' }, 760, 2.3);
    f.funnels[0].segments![0] = seg({ platform: 'web' }, 700, 2.0);
    expect(rankingRows(f, 'conversion').rows[0].selection).toEqual({ country: 'TR' });
    const low = rankingRows(frame(), 'conversion', { minUsers: 30 });
    expect(low.rows.map((x) => x.funnelId)).toEqual(['ladder', 'quiz']);
    expect(low.rows[0]).toMatchObject({ value: 9, lowSample: true });
  });

  it('lower is better flips the order; cells mode ranks nothing; ladder metrics are offered', () => {
    const f = frame();
    f.bands = { conversion: band(3, 1, { better: 'lower' }) };
    // DE (1.0) is under the 300-user floor, so the lowest path over it wins.
    expect(rankingRows(f, 'conversion').rows[0].selection).toEqual({ platform: 'ios' });
    expect(rankingRows({ ...frame(), segmentMode: 'cells' }, 'conversion').rows).toEqual([]);
    expect(rankableMetrics(frame())).toEqual(['conversion']);
    const noLadder = frame();
    delete noLadder.ladder;
    expect(rankableMetrics(noLadder)).toEqual(['conversion']);
  });
});

describe('payment', () => {
  it('rate, k/n, reason shares, residual other, total only from the {} cell, one cohort at a time', () => {
    const v = paymentView(frame(), 'quiz', { country: 'DE' });
    expect(v).toMatchObject({ scope: 'funnel', measured: true, cohorts: ['first', 'renewal'], cohort: 'first' });
    expect(v.current).toMatchObject({ dims: { country: 'DE' }, attempts: 60, declines: 6, rate: 10, kn: { k: 6, n: 60 }, other: 3, clipped: false, lowSample: true });
    expect(v.current!.reasons.map((r) => [r.key, r.label, r.count])).toEqual([['declined', 'Card declined', 2], ['odd', 'odd', 1]]);
    expect(v.total).toMatchObject({ attempts: 500, declines: 50, other: 10 });
    expect(v.total!.reasons[0]).toMatchObject({ key: 'insufficient', share: 60 });
    expect(v.byDim).toEqual([{ dim: 'country', rows: [expect.objectContaining({ attempts: 400 }), expect.objectContaining({ attempts: 60 })] }]);
    const tr = paymentView(frame(), 'quiz', { country: 'TR' });
    expect(tr.current).toMatchObject({ clipped: true, other: 0 });
    expect(paymentView(frame(), 'quiz', {}, 'renewal')).toMatchObject({ cohort: 'renewal', total: { attempts: 200 }, byDim: [] });
    expect(paymentView(frame(), 'quiz', { country: 'US' }).current).toBeNull();
  });

  it('a funnel without payment shows the set\'s; none at all says so', () => {
    expect(paymentView(frame(), 'ladder', {})).toMatchObject({ scope: 'set', cohort: 'all', total: { attempts: 1000, rate: 10 } });
    const f = frame();
    delete f.payment;
    f.funnels[1].unmeasured = { payment: 'acceptance report has no funnel id' };
    expect(paymentView(f, 'ladder', {})).toMatchObject({ scope: 'none', measured: false, reason: 'acceptance report has no funnel id', total: null });
    f.funnels[0].payment = { measured: false, reason: 'no checkout events', cells: [] };
    expect(paymentView(f, 'quiz', {})).toMatchObject({ scope: 'funnel', measured: false, reason: 'no checkout events' });
  });
});

describe('access', () => {
  it('rows for this funnel or all, agreeing with the selection; share of the base stage; null without data', () => {
    const f = frame();
    expect(hasAccess(f)).toBe(true);
    const v = accessView(f, 'quiz', {})!;
    expect(v.asOf).toBe('2026-09-30');
    expect(v.rows.map((r) => [r.funnel, r.dims])).toEqual([[null, {}], ['quiz', {}], ['quiz', { country: 'DE' }]]);
    expect(v.rows[1].cells[1]).toMatchObject({ key: 'app', users: 20, ofBase: 40, kn: { k: 20, n: 50 } });
    expect(v.rows[2].cells[1]).toMatchObject({ users: null, ofBase: null, kn: null });
    expect(accessView(f, 'quiz', { country: 'TR' })!.rows).toHaveLength(2);
    expect(accessView(f, 'ladder', {})!.rows).toHaveLength(1);
    const none = frame();
    delete none.access;
    expect(hasAccess(none)).toBe(false);
    expect(accessView(none, 'quiz', {})).toBeNull();
  });
});

describe('notes, columns, hints', () => {
  it('order: funnel traps, set traps, funnel info, set info', () => {
    expect(orderedNotes(frame(), 'quiz').map((n) => [n.text, n.scope])).toEqual([
      ['No checkout event.', 'funnel'],
      ['Country is the billing country.', 'set'],
      ['Pricing test ran in week 2.', 'funnel'],
      ['Refunds are not netted.', 'set'],
    ]);
    expect(orderedNotes(frame(), 'ladder')[0]).toMatchObject({ code: 'C10', scope: 'funnel' });
  });

  it('a column no measured row carries is flagged once; hints by part key', () => {
    const rows = segmentRows(frame(), 'quiz', 'platform', {}, ['conversion', 'spend']);
    expect(unmeasuredColumns(rows, ['conversion', 'spend'])).toEqual(['spend']);
    expect(unmeasuredColumns([], ['spend'])).toEqual([]);
    expect(explorerHint(frame(), 'daily')).toBe('pull dims [date, funnel], granularity day');
    expect(explorerHint(frame(), 'payment')).toBeNull();
  });
});

describe('projection', () => {
  const kinds = ['breakdown', 'trend', 'benchmark', 'segments', 'funnel', 'ranking', 'payment', 'access'];

  it('notes and unmeasured travel on every funnel of every class, heads included (B1)', () => {
    for (const all of [false, true]) {
      for (const type of kinds) {
        const p = projectFunnelFrame(frame(), type, type === 'breakdown' ? { picker: true } : {}, { allFunnels: all });
        for (const f of p.funnels) {
          expect(f.notes, `${type} ${f.id} all=${all}`).toBeDefined();
          expect(f.unmeasured, `${type} ${f.id} all=${all}`).toBeDefined();
        }
      }
    }
    // A plain one-funnel block without the picker: the second funnel is a head, still with its notes.
    const head = projectFunnelFrame(frame(), 'trend', {}).funnels[1];
    expect(Object.keys(head).sort()).toEqual(['id', 'name', 'notes', 'steps', 'unmeasured']);
  });

  it('all funnels: rates blocks share one frame, segments keep every path, funnel blocks carry steps only', () => {
    const f = frame();
    const ctx = { allFunnels: true };
    const rates = ['benchmark', 'segments', 'ranking'].map((t) => projectFunnelFrame(f, t, { by: 'country' }, ctx));
    rates.push(projectFunnelFrame(f, 'breakdown', { picker: true }, ctx));
    for (const p of rates) {
      expect(p).toEqual(rates[0]);
      expect(p.funnels.every((x) => x.metrics !== undefined)).toBe(true);
    }
    expect(rates[0].funnels[0].segments).toHaveLength(6);
    expect(rates[0].bands).toBeDefined();
    expect(rates[0].funnels[0].bands).toBeDefined();
    const shared = shareFrames({ a: rates[0], b: rates[1], c: rates[2], d: rates[3] });
    expect(Object.keys(shared.frames)).toEqual(['a']);
    const steps = projectFunnelFrame(f, 'funnel', {}, ctx);
    expect(steps.funnels.every((x) => x.metrics === undefined && x.bands === undefined && x.payment === undefined)).toBe(true);
    expect(steps.bands).toBeUndefined();
    // Frame-level context stays everywhere; payment and access only on their own blocks.
    for (const p of [...rates, steps]) {
      expect(p.window ?? null).toEqual(f.window ?? null);
      expect(p.notes).toEqual(f.notes);
      expect(p.hints).toEqual(f.hints);
      expect(p.rates).toEqual(f.rates);
      expect(p.payment).toBeUndefined();
      expect(p.access).toBeUndefined();
    }
  });

  it('payment: heads plus payment, the set payment and reasons; access: heads plus the access ladder', () => {
    const p = projectFunnelFrame(frame(), 'payment', {}, { allFunnels: true });
    expect(p.funnels[0].payment).toBeDefined();
    expect(p.funnels[0].metrics).toBeUndefined();
    expect(p.funnels[0].segments).toBeUndefined();
    expect(p.payment).toBeDefined();
    expect(p.paymentReasons).toHaveLength(2);
    expect(p.access).toBeUndefined();
    // Without the picker: the first funnel carries its payment, the rest are heads.
    const one = projectFunnelFrame(frame(), 'payment', {});
    expect(one.funnels[0].payment).toBeDefined();
    expect(one.funnels[1].payment).toBeUndefined();
    const a = projectFunnelFrame(frame(), 'access', {});
    expect(a.access).toBeDefined();
    expect(a.funnels.every((x) => x.segments === undefined && x.metrics === undefined)).toBe(true);
    expect(a.payment).toBeUndefined();
  });

  it('ranking carries every funnel in rates form even without the picker; an explicit funnel option still wins', () => {
    const r = projectFunnelFrame(frame(), 'ranking', {});
    expect(r.funnels.every((x) => x.metrics !== undefined && x.segments !== undefined)).toBe(true);
    const picked = projectFunnelFrame(frame(), 'benchmark', { funnel: 'ladder' }, { allFunnels: true });
    expect(picked.funnels.map((x) => x.id)).toEqual(['ladder']);
    // Without the picker a segments block keeps only the paths naming its by dim (today's rule).
    expect(projectFunnelFrame(frame(), 'segments', { by: 'country' }).funnels[0].segments).toHaveLength(4);
  });

  it('views answer the same on the projected frame as on the full one', () => {
    const p = projectFunnelFrame(frame(), 'ranking', {}, { allFunnels: true });
    expect(rankingRows(p, 'conversion')).toEqual(rankingRows(frame(), 'conversion'));
    expect(paymentView(projectFunnelFrame(frame(), 'payment', {}, { allFunnels: true }), 'quiz', { country: 'DE' }))
      .toEqual(paymentView(frame(), 'quiz', { country: 'DE' }));
  });
});

describe('catalog and preset seams', () => {
  it('ranking, payment and access are appended, funnel-bound, with their options and sizes', () => {
    expect(BLOCK_TYPES.slice(-3)).toEqual(['ranking', 'payment', 'access']);
    const want = {
      ranking: { options: ['metrics', 'density'], size: { w: 8, h: 6 } },
      payment: { options: ['funnel', 'density'], size: { w: 8, h: 6 } },
      access: { options: ['density'], size: { w: 8, h: 5 } },
    } as const;
    for (const [type, w] of Object.entries(want) as [keyof typeof want, (typeof want)[keyof typeof want]][]) {
      const e = BLOCK_CATALOG[type];
      expect(e.data).toBe('binding');
      expect(e.frames).toEqual(['funnel']);
      expect(e.options.map((o) => o.key)).toEqual(w.options);
      expect(e.defaultSize).toEqual(w.size);
      expect(`${e.label.en}${e.label.tr}${e.description.en}${e.description.tr}`).not.toMatch(/—/);
    }
    expect(BLOCK_CATALOG.funnel.options.find((o) => o.key === 'compare')).toMatchObject({ enum: ['auto', 'lanes', 'off'], default: 'auto' });
    expect(BLOCK_CATALOG.breakdown.options.find((o) => o.key === 'picker')?.default).toBe(false);
  });

  it('cardPicksFunnels: only a top-level breakdown with picker true', () => {
    expect(cardPicksFunnels(funnelExplorerBlocks('acme', [], 'en'))).toBe(true);
    expect(cardPicksFunnels([{ type: 'breakdown', options: {} }])).toBe(false);
    expect(cardPicksFunnels([{ type: 'trend', options: { picker: true } }])).toBe(false);
    expect(cardPicksFunnels(undefined)).toBe(false);
  });
});
