/**
 * A synthetic funnel set carrying every funnel explorer field (window,
 * provenance, notes, hints, rates, intersections, ladder + weekly, payment,
 * access, derived and unmeasured steps, a funnel without segments). Shared by
 * the explorer wiring and `lab data` CLI tests. Every name here is synthetic.
 */

/** A synthetic funnel set carrying every explorer field. */
export function explorerSet(): Record<string, unknown> {
  const weeks = [['2026-08-10', 0.4], ['2026-08-17', 0.6], ['2026-08-24', 0.8], ['2026-08-31', 1.0], ['2026-09-07', 3.0]] as const;
  return {
    kind: 'funnel-set/v1',
    segment_mode: 'lookup',
    low_sample_threshold: 100,
    primary: 'subs',
    window: { from: '2026-09-07', to: '2026-10-04', prev_from: '2026-08-10', prev_to: '2026-09-06' },
    provenance: { source: 'Funnel Analysis via KB MCP', pulled_at: '2026-10-08T14:33:48Z', freshness: 'data 2h old', filters: ['product = Acme'] },
    dimensions: [
      { key: 'platform', label: 'Platform', mode: 'client' },
      { key: 'country', label: 'Country', mode: 'client' },
    ],
    hints: { daily: 'pull the daily series by funnel and day' },
    rates: { click_to_sub: { num: 'subs', den: 'users' } },
    intersections: [{ dims: ['country', 'platform'], min_users: 300 }],
    ladder: { stages: [{ metric: 'click_to_sub', book_floor: 0.5, book_target: 1.5, book_source: 'web funnel book' }] },
    weekly: weeks.map(([t, v]) => ({ t, users: 1000, m: { click_to_sub: v } })),
    notes: [
      { text: 'refund rate not used: it ignores the date filter', level: 'info' },
      { code: 'R1', text: 'RU is a language, not a country', keys: ['dim:country'] },
    ],
    payment_reasons: [{ key: 'insufficient', label: 'Insufficient funds' }],
    access: {
      stages: [{ key: 'paid', label: 'Paid' }, { key: 'app', label: 'Opened the app' }],
      rows: [{ counts: { paid: 60, app: 45 } }, { funnel: '100', counts: { paid: 40, app: 30 } }],
      as_of: '2026-10-08',
    },
    funnels: [
      {
        id: '100',
        name: 'F100',
        meta: {},
        metrics: {
          users: { v: 5000, format: 'count', prev: 4000 },
          subs: { v: 60, format: 'count' },
          click_to_sub: { v: 1.2, format: 'pct', prev: 1.0 },
        },
        steps: [
          { key: 'users', label: 'Users', users: 5000 },
          { key: 'lead', label: 'Lead', users: 1200, basis: 'derived' },
          { key: 'finish', label: 'Finish', users: 0, measured: false, reason: 'finish event not recorded' },
          { key: 'subs', label: 'Subscribed', users: 60 },
        ],
        notes: [{ code: 'C1', text: 'no checkout event in this series', keys: ['subs'] }],
        payment: {
          cells: [
            { dims: {}, attempts: 400, declines: 80, reasons: { insufficient: 30 } },
            { dims: { country: 'TR' }, attempts: 50, declines: 10, reasons: { insufficient: 4 } },
          ],
        },
        daily: [{ t: '2026-09-07', m: { users: 180, subs: 2 } }],
        segments: [
          { dims: { country: 'TR' }, users: 3000, steps: [{ key: 'users', users: 3000 }, { key: 'lead', users: 700 }, { key: 'subs', users: 40 }], metrics: { click_to_sub: { v: 1.33, format: 'pct' } } },
          { dims: { country: 'DE' }, users: 80, steps: [{ key: 'users', users: 80 }, { key: 'lead', users: 20 }, { key: 'subs', users: 2 }], metrics: { click_to_sub: { v: 2.5, format: 'pct' } } },
          { dims: { platform: 'Meta' }, users: 4000, steps: [{ key: 'users', users: 4000 }, { key: 'lead', users: 1000 }, { key: 'subs', users: 50 }], metrics: { click_to_sub: { v: 1.25, format: 'pct' } } },
          { dims: { country: 'TR', platform: 'Meta' }, users: 2500, steps: [{ key: 'users', users: 2500 }, { key: 'lead', users: 600 }, { key: 'subs', users: 36 }], metrics: { click_to_sub: { v: 1.44, format: 'pct' } } },
        ],
      },
      {
        id: '200',
        name: 'F200',
        meta: {},
        metrics: { users: { v: 900, format: 'count' }, subs: { v: 7, format: 'count' }, click_to_sub: { v: 0.78, format: 'pct' } },
        steps: [
          { key: 'users', label: 'Users', users: 900 },
          { key: 'lead', label: 'Lead', users: 200, basis: 'derived' },
          { key: 'subs', label: 'Subscribed', users: 7 },
        ],
        notes: [{ code: 'C8', text: 'users denominator suspicious in late September' }],
        unmeasured: { segments: 'breakdowns are pulled for the larger funnels only' },
      },
    ],
  };
}
