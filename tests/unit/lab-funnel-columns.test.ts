/**
 * The funnel overview's column picker: derived step columns, the selection's
 * URL/prefs precedence, and the Markdown export following the visible set.
 *
 * All three are PURE view math over a frozen payload (`funnel-set/v1` gained
 * nothing for this feature), which is why they live in funnelModel.ts and can be
 * asserted here without a DOM — plus the textual drift guard the lab tests use,
 * so the page cannot quietly re-inline the math it is supposed to route through.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  conversionColumnKey,
  defaultColumnKeys,
  ofTopColumnKey,
  overviewCellPrev,
  overviewCellValue,
  overviewColumns,
  overviewRowMarkdown,
  overviewTableMarkdown,
  readColumnKeys,
  resolveColumnKeys,
  writeColumnKeys,
  type FunnelDef,
  type FunnelPrev,
  type FunnelSet,
  type OverviewColumn,
} from '../../dashboard/src/components/lab/funnel/funnelModel.js';

const PAGE = join(
  import.meta.dirname,
  '../../dashboard/src/components/lab/funnel/FunnelOverviewPage.tsx',
);

/** Three funnels that DISAGREE about their steps — the alignment case: `b` has
 *  no `email_input` and adds `plan_select`; `zero` has an empty top step. */
function fixtureSet(): FunnelSet {
  const funnel = (
    id: string,
    steps: { key: string; label: string; users: number }[],
    metrics: FunnelDef['metrics'] = {},
  ): FunnelDef => ({ id, name: `funnel-${id}`, meta: {}, metrics, steps });

  return {
    kind: 'funnel-set/v1',
    dimensions: [],
    funnels: [
      funnel('a', [
        { key: 'session_start', label: 'session_start', users: 1000 },
        { key: 'email_input', label: 'email_input', users: 400 },
        { key: 'finish', label: 'Finish', users: 100 },
      ], {
        users: { v: 1000, format: 'count' },
        finish_rate: { v: 10, format: 'pct' },
      }),
      funnel('b', [
        { key: 'session_start', label: 'session_start', users: 500 },
        { key: 'finish', label: 'Finish', users: 50 },
        { key: 'plan_select', label: 'plan_select', users: 25 },
      ], {
        users: { v: 500, format: 'count' },
      }),
      funnel('zero', [
        { key: 'session_start', label: 'session_start', users: 0 },
        { key: 'email_input', label: 'email_input', users: 0 },
      ], {
        users: { v: 0, format: 'count' },
      }),
    ],
  };
}

const byId = (set: FunnelSet, id: string): FunnelDef =>
  set.funnels.find((f) => f.id === id)!;

const col = (set: FunnelSet, key: string): OverviewColumn =>
  overviewColumns(set).find((c) => c.key === key)!;

describe('overviewColumns — what the picker may offer', () => {
  it('lists the payload metric columns first, unchanged', () => {
    const cols = overviewColumns(fixtureSet());
    expect(cols.slice(0, 2).map((c) => c.key)).toEqual(['users', 'finish_rate']);
    expect(cols.slice(0, 2).every((c) => c.kind === 'metric')).toBe(true);
  });

  it('derives one conversion column per adjacent pair of the UNION step order', () => {
    // Union = a's order, then b's unseen key: session_start, email_input, finish, plan_select.
    const conversions = overviewColumns(fixtureSet()).filter((c) => c.kind === 'conversion');
    expect(conversions.map((c) => c.steps)).toEqual([
      ['session_start', 'email_input'],
      ['email_input', 'finish'],
      ['finish', 'plan_select'],
    ]);
  });

  it('derives one "% of top" column per union step', () => {
    const ofTop = overviewColumns(fixtureSet()).filter((c) => c.kind === 'of_top');
    expect(ofTop.map((c) => c.key)).toEqual([
      ofTopColumnKey('session_start'),
      ofTopColumnKey('email_input'),
      ofTopColumnKey('finish'),
      ofTopColumnKey('plan_select'),
    ]);
  });

  it('labels derived columns from the payload step labels, inventing no translation', () => {
    const set = fixtureSet();
    expect(col(set, conversionColumnKey('session_start', 'email_input')).label)
      .toBe('session_start → email_input %');
    expect(col(set, ofTopColumnKey('email_input')).label).toBe('% of top: email_input');
    // A declared label is the author's own words — used verbatim.
    expect(col(set, conversionColumnKey('email_input', 'finish')).label)
      .toBe('email_input → Finish %');
  });

  it('falls back to the prettified KEY when a step declares no label', () => {
    const set = fixtureSet();
    set.funnels[0].steps[1] = { key: 'email_input', label: '', users: 400 };
    expect(col(set, ofTopColumnKey('email_input')).label).toBe('% of top: Email Input');
  });

  it('formats every derived column as a percentage', () => {
    expect(overviewColumns(fixtureSet()).filter((c) => c.kind !== 'metric').every((c) => c.format === 'pct')).toBe(true);
  });

  it('never lets a derived key shadow a payload metric key', () => {
    const set = fixtureSet();
    set.funnels[0].metrics[ofTopColumnKey('finish')] = { v: 42, format: 'pct' };
    const cols = overviewColumns(set).filter((c) => c.key === ofTopColumnKey('finish'));
    expect(cols).toHaveLength(1);
    expect(cols[0].kind).toBe('metric');
  });

  it('defaults to exactly the payload metric columns (derived all off)', () => {
    expect(defaultColumnKeys(fixtureSet())).toEqual(['users', 'finish_rate']);
  });
});

describe('overviewCellValue — derived math, aligned by step KEY', () => {
  const set = fixtureSet();

  it('reads a metric column straight from the payload', () => {
    expect(overviewCellValue(byId(set, 'a'), col(set, 'users'))).toBe(1000);
    expect(overviewCellValue(byId(set, 'b'), col(set, 'finish_rate'))).toBeNull();
  });

  it('computes an adjacent-pair conversion', () => {
    expect(overviewCellValue(byId(set, 'a'), col(set, conversionColumnKey('session_start', 'email_input')))).toBe(40);
    expect(overviewCellValue(byId(set, 'a'), col(set, conversionColumnKey('email_input', 'finish')))).toBe(25);
  });

  it('returns null when a funnel does not have the step key (never 0)', () => {
    // `b` has no email_input at all — both columns that touch it are unknown.
    expect(overviewCellValue(byId(set, 'b'), col(set, conversionColumnKey('session_start', 'email_input')))).toBeNull();
    expect(overviewCellValue(byId(set, 'b'), col(set, ofTopColumnKey('email_input')))).toBeNull();
    // …and `a` has no plan_select.
    expect(overviewCellValue(byId(set, 'a'), col(set, ofTopColumnKey('plan_select')))).toBeNull();
  });

  it('aligns by key, not index — b\'s 2nd step is `finish`, not `email_input`', () => {
    // b: session_start 500 → finish 50 → plan_select 25.
    expect(overviewCellValue(byId(set, 'b'), col(set, ofTopColumnKey('finish')))).toBe(10);
    expect(overviewCellValue(byId(set, 'b'), col(set, conversionColumnKey('finish', 'plan_select')))).toBe(50);
  });

  it('computes % of the funnel\'s OWN top step', () => {
    expect(overviewCellValue(byId(set, 'a'), col(set, ofTopColumnKey('session_start')))).toBe(100);
    expect(overviewCellValue(byId(set, 'a'), col(set, ofTopColumnKey('finish')))).toBe(10);
  });

  it('guards division by zero — a 0-user denominator is unknown, not ∞ and not 0', () => {
    const zero = byId(set, 'zero');
    expect(overviewCellValue(zero, col(set, conversionColumnKey('session_start', 'email_input')))).toBeNull();
    expect(overviewCellValue(zero, col(set, ofTopColumnKey('email_input')))).toBeNull();
  });
});

describe('overviewCellPrev — Δ only where it is honestly computable', () => {
  const set = fixtureSet();
  const prev: FunnelPrev = {
    metrics: { a: { users: 800 } },
    steps: {
      a: { session_start: 800, email_input: 200, finish: null },
      b: { session_start: 400 },
    },
    source: { at: '2026-08-01T00:00:00Z', range: { fromISO: '2026-07-01', toISO: '2026-07-31' } },
  };

  it('keeps the metric column on its existing prev source', () => {
    expect(overviewCellPrev(byId(set, 'a'), col(set, 'users'), prev)).toBe(800);
  });

  it('computes the previous conversion when BOTH steps have previous users', () => {
    expect(overviewCellPrev(byId(set, 'a'), col(set, conversionColumnKey('session_start', 'email_input')), prev)).toBe(25);
    expect(overviewCellPrev(byId(set, 'a'), col(set, ofTopColumnKey('email_input')), prev)).toBe(25);
  });

  it('shows NOTHING when one side of the derived rate has no previous value', () => {
    expect(overviewCellPrev(byId(set, 'a'), col(set, conversionColumnKey('email_input', 'finish')), prev)).toBeNull();
    expect(overviewCellPrev(byId(set, 'b'), col(set, ofTopColumnKey('finish')), prev)).toBeNull();
  });

  it('shows nothing at all when there is no prev payload', () => {
    expect(overviewCellPrev(byId(set, 'a'), col(set, conversionColumnKey('session_start', 'email_input')), null)).toBeNull();
    expect(overviewCellPrev(byId(set, 'zero'), col(set, 'users'), prev)).toBeNull();
  });
});

describe('column selection — URL param, prefs, stale keys', () => {
  const set = fixtureSet();
  const available = overviewColumns(set);
  const defaults = defaultColumnKeys(set);
  const conv = conversionColumnKey('session_start', 'email_input');

  it('defaults to the payload metric columns when nothing is stored', () => {
    expect(resolveColumnKeys(available, null, undefined, defaults)).toEqual(['users', 'finish_rate']);
  });

  it('uses prefs when the URL carries no opinion', () => {
    expect(resolveColumnKeys(available, null, ['users', conv], defaults)).toEqual(['users', conv]);
  });

  it('lets the URL param WIN over prefs (a shared link shows the sender\'s view)', () => {
    expect(resolveColumnKeys(available, [conv], ['users', 'finish_rate'], defaults)).toEqual([conv]);
  });

  it('drops stale keys silently, keeping the ones the payload still has', () => {
    expect(resolveColumnKeys(available, ['users', 'gone_metric', conv], null, defaults)).toEqual(['users', conv]);
    expect(resolveColumnKeys(available, null, [ofTopColumnKey('nope'), 'finish_rate'], defaults)).toEqual(['finish_rate']);
  });

  it('falls through when EVERY key of a source went stale', () => {
    expect(resolveColumnKeys(available, ['gone_a', 'gone_b'], ['finish_rate'], defaults)).toEqual(['finish_rate']);
    expect(resolveColumnKeys(available, ['gone_a'], ['also_gone'], defaults)).toEqual(defaults);
  });

  it('honors an explicitly EMPTY selection (the user unchecked everything)', () => {
    expect(resolveColumnKeys(available, [], ['users'], defaults)).toEqual([]);
    expect(resolveColumnKeys(available, null, [], defaults)).toEqual([]);
  });

  it('returns the selection in canonical column order, whatever order it arrived in', () => {
    expect(resolveColumnKeys(available, [conv, 'finish_rate', 'users'], null, defaults))
      .toEqual(['users', 'finish_rate', conv]);
  });

  it('round-trips through the `cols` URL param', () => {
    const params = new URLSearchParams('flt=x%3Ay&sort=-users');
    writeColumnKeys(params, ['users', conv], defaults);
    expect(readColumnKeys(params)).toEqual(['users', conv]);
    // Foreign view-state params are untouched.
    expect(params.get('sort')).toBe('-users');
    expect(readColumnKeys(new URLSearchParams(params.toString()))).toEqual(['users', conv]);
  });

  it('omits the param when the selection IS the default (no param = no opinion)', () => {
    const params = new URLSearchParams('cols=users');
    writeColumnKeys(params, [...defaults].reverse(), defaults);
    expect(params.get('cols')).toBeNull();
    expect(readColumnKeys(params)).toBeNull();
  });

  it('distinguishes an empty selection from an absent param', () => {
    const params = new URLSearchParams();
    writeColumnKeys(params, [], defaults);
    expect(params.get('cols')).toBe('');
    expect(readColumnKeys(params)).toEqual([]);
  });

  it('tolerates junk in the param instead of blanking the table', () => {
    expect(readColumnKeys(new URLSearchParams('cols=users,,%E0%A4%A'))).toEqual(['users']);
  });
});

describe('copy-as-Markdown follows the visible selection', () => {
  const set = fixtureSet();
  const available = overviewColumns(set);
  const conv = conversionColumnKey('session_start', 'email_input');
  const selected = available.filter((c) => ['users', conv].includes(c.key));

  it('exports the chosen columns — derived ones included — for one row', () => {
    const md = overviewRowMarkdown(byId(set, 'a'), selected);
    expect(md.split('\n')[0]).toBe('| Funnel | Users | session_start → email_input % |');
    expect(md.split('\n')[2]).toBe('| funnel-a | 1,000 | 40.0% |');
    expect(md).not.toContain('Finish Rate');
  });

  it('exports the same columns for the whole table, with "—" where a funnel lacks the step', () => {
    const md = overviewTableMarkdown(set.funnels, selected);
    expect(md).toContain('| funnel-b | 500 | — |');
    expect(md).toContain('| funnel-zero | 0 | — |');
  });

  it('drops a column from the export the moment it is deselected', () => {
    const onlyMetric = available.filter((c) => c.key === 'users');
    expect(overviewTableMarkdown(set.funnels, onlyMetric)).not.toContain('session_start →');
  });
});

describe('FunnelOverviewPage routes through the model (drift guard)', () => {
  const source = readFileSync(PAGE, 'utf-8');

  it('resolves the visible set instead of hard-coding the payload metrics', () => {
    expect(source).toContain('resolveColumnKeys(available, readColumnKeys(params), prefs.columns[slug], defaultKeys)');
    expect(source).not.toContain('metricColumns(set)');
  });

  it('renders the Columns popover with a Reset', () => {
    expect(source).toContain('<ColumnPicker');
    expect(source).toContain('onReset={() => applyColumns(defaultKeys)}');
  });

  it('reads every cell (and its Δ) through the shared column math', () => {
    expect(source).toContain('overviewCellValue(funnel, c)');
    expect(source).toContain('overviewCellPrev(funnel, c, prev)');
  });

  it('persists a change to BOTH the URL and lab prefs', () => {
    expect(source).toContain('writeColumnKeys(p, keys, defaultKeys)');
    expect(source).toContain('setColumnKeys(slug, keys)');
  });

  it('hands the visible columns to both Markdown exports', () => {
    expect(source).toContain('overviewRowMarkdown(funnel, cols)');
    expect(source).toContain('overviewTableMarkdown(rows, cols)');
  });
});
