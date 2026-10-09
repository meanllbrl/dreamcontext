/**
 * Synthetic funnel-explorer SNAPSHOT for the fictional product "Acme Storefront":
 * the `{ source, data }` file an agent writes with `dreamcontext lab data write`
 * and the `lab create --preset funnel-explorer` script reads. Everything here is
 * invented (see the synthetic-fixtures-for-published-artifacts pattern): no real
 * product, company, customer or project name, no real figure.
 *
 * Deterministic: a seeded PRNG and a fixed window, so every call returns the same
 * payload byte for byte (the verify runs compare the UI and the CLI against it).
 *
 * `snapshot('full')` carries every part of the explorer contract:
 *   - 3 funnels; platform, country and language axes, one-axis paths with a
 *     previous window, platform x country and platform x language intersections
 *     declared at 300 users (the thin ones are absent: "below the floor");
 *   - a ladder with book values, set and funnel weekly history (one funnel with
 *     too few weeks inherits the set band);
 *   - `rates`, and a path whose denominator is under 100 (shown as k/n);
 *   - derived steps (rate x users) and one unmeasured step with its reason;
 *   - payment with two cohorts, decline reasons, a k/n cell and one clipped cell,
 *     a funnel without payment (the set-level payment answers for it);
 *   - an access ladder;
 *   - reading-trap notes: a funnel with 2 traps, 1 set trap, 3 set info notes;
 *   - hints, the window and the provenance.
 * `snapshot('bare')` drops daily, payment and access (the empty states and the
 * hidden Access tab), and keeps the hints.
 *
 * Self-contained (no imports): the verify runs import it and write it as JSON.
 */

const WINDOW = { from: '2026-08-31', to: '2026-09-27', prev_from: '2026-08-03', prev_to: '2026-08-30' };
const PULLED_AT = '2026-09-28T09:00:00Z';
const FRESHNESS = 'data 3h old';
const PRODUCT = 'Acme Storefront';
const DAYS = 28;
/** Paths and weeks under this many users are not pulled (declared on the intersections). */
const FLOOR = 300;

/** mulberry32: a tiny seeded PRNG, so the numbers never change between runs. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

/** `n` ISO days ending at `toISO` (inclusive), oldest first. */
function days(n, toISO) {
  const end = Date.parse(`${toISO}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(end - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

/** `n` week starts (Mondays) ending the week before `beforeISO`, oldest first. */
function weeksBefore(n, beforeISO) {
  const start = Date.parse(`${beforeISO}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(start - (n - i) * 7 * 86_400_000).toISOString().slice(0, 10));
}

const STEPS = [
  ['visit', 'Visit'],
  ['page2', 'Second page'],
  ['lead', 'Lead'],
  ['finish', 'Quiz finished'],
  ['purchase', 'Purchase'],
  ['upsell', 'Upsell'],
];
/** Middle steps are rate x users, not counted directly. */
const DERIVED = new Set(['page2', 'lead', 'finish']);

const DIMENSIONS = [
  { key: 'platform', label: 'Platform', values: ['Meta Ads', 'TikTok Ads', 'Unattributed'] },
  { key: 'country', label: 'Country', values: ['US', 'DE', 'GB', 'FR'] },
  { key: 'language', label: 'Language', values: ['EN', 'DE', 'ES', 'PT'] },
];

const RATES = {
  page2_rate: { num: 'page2', den: 'visit' },
  lead_rate: { num: 'lead', den: 'visit' },
  finish_rate: { num: 'finish', den: 'visit' },
  visit_to_purchase: { num: 'purchase', den: 'visit' },
  lead_to_purchase: { num: 'purchase', den: 'lead' },
};

const LADDER = {
  stages: [
    { metric: 'page2_rate', book_floor: 25, book_target: 40, book_source: 'Acme web funnel book' },
    { metric: 'lead_rate', book_floor: 10, book_target: 17, book_source: 'Acme web funnel book' },
    { metric: 'finish_rate', book_floor: 9, book_target: 15, book_source: 'Acme web funnel book' },
    { metric: 'lead_to_purchase', book_floor: 5, book_target: 12, book_source: 'Acme web funnel book' },
    { metric: 'visit_to_purchase', book_floor: 0.5, book_target: 1.5, book_source: 'Acme web funnel book' },
    { metric: 'roas', book_floor: 0.25, book_target: 0.4, book_source: 'Acme web funnel book' },
  ],
  min_weeks: 4,
  min_week_users: FLOOR,
  max_weeks: 12,
};

/**
 * The funnels: users, spend, the step rates (of visit; upsell of purchase), the
 * revenue per purchase, axis shares, and what each funnel deliberately lacks.
 */
const FUNNELS = [
  {
    id: 'quiz-v3', name: 'Quiz checkout v3', users: 48_000, prevUsers: 41_200, spend: 21_500, prevSpend: 19_800,
    rates: { page2: 0.42, lead: 0.21, finish: 0.19, purchase: 0.0125, upsell: 0.31 }, aov: 38,
    // PT is a thin path (about 90 users): the default funnel's Language tab shows a faded row read as k/n.
    shares: { platform: [0.62, 0.31, 0.07], country: [0.46, 0.24, 0.17, 0.13], language: [0.55, 0.21, 0.18, 0.0019] },
    daily: true, segmentDaily: 'platform', weeks: 8, intersections: true, payment: 'quiz',
    notes: [
      { code: 'T1', text: 'No checkout event on this funnel: Purchase follows Quiz finished directly, there is no checkout step', level: 'trap', keys: ['purchase'] },
      { code: 'T2', text: 'Visit doubled on 9 to 14 Sep after a tracking change: compare its rates across funnels with care', level: 'trap', keys: ['page2_rate', 'lead_rate', 'finish_rate'] },
    ],
  },
  {
    id: 'trial-start', name: 'Trial start', users: 16_400, prevUsers: 17_100, spend: 7_900, prevSpend: 8_300,
    rates: { page2: 0.36, lead: 0, finish: 0.14, purchase: 0.0098, upsell: 0.22 }, aov: 29,
    shares: { platform: [0.58, 0.36, 0.06], country: [0.51, 0.22, 0.15, 0.12], language: [0.6, 0.2, 0.14, 0.06] },
    daily: true, weeks: 3, intersections: false, payment: 'trial', unmeasuredLead: true,
    notes: [
      { code: 'T3', text: 'The lead event is not recorded on this funnel: read the Lead step as not measured, never as zero', level: 'trap', keys: ['lead', 'lead_rate', 'lead_to_purchase'] },
    ],
  },
  {
    id: 'gift-card', name: 'Gift card', users: 5_200, prevUsers: 4_700, spend: 0, prevSpend: 0,
    rates: { page2: 0.39, lead: 0.14, finish: 0.15, purchase: 0.021, upsell: 0.12 }, aov: 45,
    shares: { platform: [0.7, 0.2, 0.1], country: [0.4, 0.3, 0.2, 0.1], language: [0.62, 0.2, 0.162, 0.018] },
    daily: false, weeks: 0, intersections: true, payment: null,
    notes: [
      { code: 'T4', text: 'Lead is below Quiz finished here: the step order is not a full chain on this funnel', level: 'trap', keys: ['lead', 'finish'] },
      { code: 'I4', text: 'No ad spend: ROAS is undefined for this funnel', level: 'info', keys: ['roas'] },
    ],
  },
];

const SET_NOTES = [
  { code: 'S1', text: 'Brazil reads as a language (PT), not a country: look for it on the Language tab', level: 'trap', keys: ['dim:country', 'dim:language'] },
  { code: 'I1', text: 'Refund rate is not carried: the source ignores the date filter for it', level: 'info' },
  { code: 'I2', text: 'Purchases after 1 Sep may include reversed rows', level: 'info', keys: ['purchase'] },
  { code: 'I3', text: 'A returning user keeps the funnel id of the first visit', level: 'info' },
];

const HINTS = {
  daily: 'Pull one row per day and funnel (dims: event_date, funnel_id) for the same window, granularity day',
  segments: 'Pull one row per funnel and axis value (dims: funnel_id plus the axis field) for the same window',
  intersections: 'Pull funnel_id with two axis fields, keep rows with 300 users or more, declare them in intersections',
  payment: 'Pull attempts and declines per funnel and country from the payments report, one query per decline reason',
  access: 'Pull paid users and whether they created an account and opened the app from the product database',
  weekly: 'Pull the 12 full weeks before the window (granularity week), whole product and per funnel',
};

const PAYMENT_REASONS = [
  { key: 'insufficient', label: 'Insufficient funds' },
  { key: 'declined', label: 'Card declined by the bank' },
  { key: 'unsupported', label: 'Card not supported', note: 'Mostly prepaid cards the payment provider refuses' },
];

const PAYMENTS = {
  quiz: {
    cells: [
      { dims: {}, cohort: 'first', attempts: 1240, declines: 186, reasons: { insufficient: 82, declined: 61, unsupported: 14 } },
      { dims: {}, cohort: 'renewal', attempts: 410, declines: 37, reasons: { insufficient: 21, declined: 9 } },
      { dims: { country: 'US' }, cohort: 'first', attempts: 610, declines: 71, reasons: { insufficient: 30, declined: 28, unsupported: 6 } },
      { dims: { country: 'DE' }, cohort: 'first', attempts: 300, declines: 52, reasons: { insufficient: 25, declined: 20 } },
      // Under 100 attempts: shown as k/n, never as a rate.
      { dims: { country: 'GB' }, cohort: 'first', attempts: 88, declines: 13, reasons: { insufficient: 7 } },
      // The reasons add up to more than the declines (35 > 30): the clipped warning.
      { dims: { country: 'FR' }, cohort: 'first', attempts: 242, declines: 30, reasons: { insufficient: 21, declined: 14 } },
      { dims: { country: 'US' }, cohort: 'renewal', attempts: 220, declines: 19, reasons: { insufficient: 12 } },
    ],
  },
  trial: {
    cells: [
      { dims: {}, cohort: 'first', attempts: 420, declines: 58, reasons: { insufficient: 30, declined: 17 } },
      { dims: { country: 'US' }, cohort: 'first', attempts: 210, declines: 24, reasons: { insufficient: 13, declined: 8 } },
    ],
  },
};
/** All funnels together: what the Payment page shows for a funnel that has no split of its own. */
const SET_PAYMENT = {
  cells: [
    { dims: {}, cohort: 'first', attempts: 1790, declines: 262, reasons: { insufficient: 118, declined: 83, unsupported: 19 } },
    { dims: {}, cohort: 'renewal', attempts: 520, declines: 48, reasons: { insufficient: 27, declined: 12 } },
  ],
};

const ACCESS = {
  stages: [
    { key: 'paid', label: 'Paid' },
    { key: 'account', label: 'Account created' },
    { key: 'app', label: 'Opened the app' },
  ],
  rows: [
    { counts: { paid: 1420, account: 1190, app: 905 } },
    { funnel: 'quiz-v3', counts: { paid: 980, account: 842, app: 655 } },
    { funnel: 'trial-start', counts: { paid: 352, account: 281, app: null } },
    // Under 100 paid: shares shown as k/n.
    { funnel: 'gift-card', counts: { paid: 88, account: 70, app: 51 } },
    { dims: { language: 'EN' }, counts: { paid: 760, account: 655, app: 512 } },
  ],
  as_of: '2026-09-28',
};

/** Step users from a visit count and the funnel's rates (upsell is a share of purchase). */
function stepUsers(visit, r) {
  const purchase = Math.round(visit * r.purchase);
  return {
    visit,
    page2: Math.round(visit * r.page2),
    lead: Math.round(visit * r.lead),
    finish: Math.round(visit * r.finish),
    purchase,
    upsell: Math.round(purchase * r.upsell),
  };
}

/** The funnel's steps in order: derived middle steps labelled, an unmeasured lead with its reason. */
function stepsOf(u, def, withLabels) {
  return STEPS.map(([key, label]) => {
    const s = { key, users: u[key] };
    if (withLabels) s.label = label;
    if (DERIVED.has(key)) s.basis = 'derived';
    if (key === 'lead' && def.unmeasuredLead) {
      s.users = 0;
      s.measured = false;
      s.reason = 'Lead event not recorded on this funnel';
    }
    return s;
  });
}

/** The metric columns of a level: counts, money, the rates (percent) and ROAS. */
function metricsOf(u, spend, revenue, def, prev) {
  const pct = (num, den) => (den > 0 ? round((num / den) * 100) : null);
  const m = {
    spend: { v: round(spend, 2), format: 'usd', label: 'Spend' },
    users: { v: u.visit, format: 'count', label: 'Users' },
    purchases: { v: u.purchase, format: 'count', label: 'Purchases' },
    revenue: { v: round(revenue, 2), format: 'usd', label: 'Revenue' },
    page2_rate: { v: pct(u.page2, u.visit), format: 'pct', label: 'Second page rate' },
    lead_rate: { v: pct(u.lead, u.visit), format: 'pct', label: 'Lead rate' },
    finish_rate: { v: pct(u.finish, u.visit), format: 'pct', label: 'Finish rate' },
    lead_to_purchase: { v: pct(u.purchase, u.lead), format: 'pct', label: 'Lead to purchase' },
    visit_to_purchase: { v: pct(u.purchase, u.visit), format: 'pct', label: 'Visit to purchase' },
    roas: { v: spend > 0 ? round(revenue / spend) : null, format: 'x', label: 'ROAS' },
  };
  if (def.unmeasuredLead) {
    for (const k of ['lead_rate', 'lead_to_purchase']) m[k] = { v: null, format: 'pct', label: m[k].label, measured: false, reason: 'Lead event not recorded on this funnel' };
  }
  if (!(spend > 0)) m.roas = { v: null, format: 'x', label: 'ROAS', measured: false, reason: 'No ad spend on this funnel' };
  if (prev) {
    for (const [k, p] of Object.entries(prev)) {
      if (m[k] && m[k].measured !== false && p !== null) m[k].prev = p;
    }
  }
  return m;
}

/** The previous window's values for the same metric keys (a level measured both windows). */
function prevOf(def, visit, spend, rand) {
  const r = { ...def.rates };
  for (const k of Object.keys(r)) r[k] = r[k] * (0.9 + rand() * 0.2);
  const u = stepUsers(visit, r);
  const revenue = u.purchase * def.aov * (0.95 + rand() * 0.1);
  const m = metricsOf(u, spend, revenue, def, null);
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.v]));
}

function dailyOf(u, spend, revenue, def, rand, dayList) {
  return dayList.map((t, i) => {
    const wave = 1 + 0.18 * Math.sin((i / 7) * Math.PI * 2) + (rand() - 0.5) * 0.12;
    const visit = Math.round((u.visit / DAYS) * wave);
    const purchase = Math.round((u.purchase / DAYS) * wave * (0.85 + rand() * 0.3));
    const daySpend = round((spend / DAYS) * (0.9 + rand() * 0.2), 2);
    const dayRevenue = round(purchase * def.aov, 2);
    return {
      t,
      m: {
        spend: daySpend,
        users: visit,
        purchases: purchase,
        revenue: dayRevenue,
        visit_to_purchase: visit > 0 ? round((purchase / visit) * 100) : null,
        roas: daySpend > 0 ? round(dayRevenue / daySpend) : null,
      },
    };
  });
}

function weeklyOf(def, count, rand) {
  return weeksBefore(count, WINDOW.from).map((t, i) => {
    // The first week of a long history is under the floor: the engine must skip it.
    const users = i === 0 && count >= 8 ? 250 : Math.round((def.users / 4) * (0.85 + rand() * 0.3));
    const jitter = () => 0.88 + rand() * 0.24;
    return {
      t,
      users,
      m: {
        page2_rate: round(def.rates.page2 * 100 * jitter()),
        lead_rate: def.unmeasuredLead ? null : round(def.rates.lead * 100 * jitter()),
        finish_rate: round(def.rates.finish * 100 * jitter()),
        lead_to_purchase: def.unmeasuredLead ? null : round((def.rates.purchase / def.rates.lead) * 100 * jitter()),
        visit_to_purchase: round(def.rates.purchase * 100 * jitter()),
        roas: def.spend > 0 ? round(((def.users * def.rates.purchase * def.aov) / def.spend) * jitter()) : null,
      },
    };
  });
}

function setWeekly(rand) {
  return weeksBefore(12, WINDOW.from).map((t) => {
    const jitter = () => 0.9 + rand() * 0.2;
    return {
      t,
      users: Math.round(16_000 * jitter()),
      m: {
        page2_rate: round(40.5 * jitter()),
        lead_rate: round(19.5 * jitter()),
        finish_rate: round(17.2 * jitter()),
        lead_to_purchase: round(6.1 * jitter()),
        visit_to_purchase: round(1.15 * jitter()),
        roas: round(0.34 * jitter()),
      },
    };
  });
}

/** One lookup path: its own steps, metrics (a previous window when asked) and daily when asked. */
function pathOf(def, dims, share, rand, { prev, daily, dayList }) {
  const r = { ...def.rates };
  for (const k of Object.keys(r)) if (r[k] > 0) r[k] = r[k] * (0.85 + rand() * 0.3);
  const visit = Math.round(def.users * share);
  const u = stepUsers(visit, r);
  const spend = def.spend * share * (0.9 + rand() * 0.2);
  const revenue = u.purchase * def.aov * (0.95 + rand() * 0.1);
  const seg = {
    dims,
    users: visit,
    steps: stepsOf(u, def, false).filter((s) => s.measured !== false).map((s) => ({ key: s.key, users: s.users })),
    metrics: metricsOf(u, spend, revenue, def, prev ? prevOf(def, Math.round(def.prevUsers * share), def.prevSpend * share, rand) : null),
  };
  // No ad spend: the paths carry no ROAS at all (the funnel level says why once), so the axis
  // tables fold the column into one note instead of a reason in every row.
  if (!(def.spend > 0)) delete seg.metrics.roas;
  if (daily) seg.daily = dailyOf(u, spend, revenue, def, rand, dayList);
  return seg;
}

function funnelOf(def, index, full) {
  const rand = prng(7919 + index * 104_729);
  const dayList = days(DAYS, WINDOW.to);
  const u = stepUsers(def.users, def.rates);
  const revenue = u.purchase * def.aov;
  const funnel = {
    id: def.id,
    name: def.name,
    meta: { product: PRODUCT, window: `${WINDOW.from} to ${WINDOW.to}` },
    metrics: metricsOf(u, def.spend, revenue, def, prevOf(def, def.prevUsers, def.prevSpend, rand)),
    steps: stepsOf(u, def, true),
    notes: def.notes,
  };
  if (full && def.daily) funnel.daily = dailyOf(u, def.spend, revenue, def, rand, dayList);

  const segments = [];
  for (const dim of DIMENSIONS) {
    dim.values.forEach((value, vi) => {
      const withDaily = full && def.segmentDaily === dim.key;
      segments.push(pathOf(def, { [dim.key]: value }, def.shares[dim.key][vi], rand, { prev: true, daily: withDaily, dayList }));
    });
  }
  if (def.intersections) {
    const platform = DIMENSIONS[0];
    for (const other of DIMENSIONS.slice(1)) {
      platform.values.forEach((pv, pi) => {
        other.values.forEach((ov, oi) => {
          const share = def.shares.platform[pi] * def.shares[other.key][oi] * (0.8 + rand() * 0.4);
          // Below the declared floor: not pulled (the chip says "under 300 users, or not pulled").
          if (Math.round(def.users * share) < FLOOR) return;
          segments.push(pathOf(def, { platform: pv, [other.key]: ov }, share, rand, { prev: false, daily: false, dayList }));
        });
      });
    }
  }
  funnel.segments = segments;

  const unmeasured = {};
  if (!def.intersections) unmeasured.intersections = 'Intersections not pulled for this funnel (snapshot budget)';
  if (!def.daily || !full) unmeasured.daily = 'No daily rows pulled for this funnel';
  if (full && def.payment === null) unmeasured.payment = 'The payments report has no split for this funnel: the page shows all funnels';
  if (Object.keys(unmeasured).length > 0) funnel.unmeasured = unmeasured;
  if (def.weeks > 0) funnel.weekly = weeklyOf(def, def.weeks, rand);
  if (full && def.payment) funnel.payment = PAYMENTS[def.payment];
  return funnel;
}

/** The snapshot an agent writes for the fixture's insight: `full` (every part) or `bare` (no daily, payment, access). */
export function snapshot(variant = 'full') {
  const full = variant !== 'bare';
  const data = {
    kind: 'funnel-set/v1',
    primary: 'purchases',
    low_sample_threshold: 100,
    segment_mode: 'lookup',
    dimensions: DIMENSIONS.map((d) => ({ key: d.key, label: d.label, mode: 'client', values: d.values.map((value) => ({ value })) })),
    funnels: FUNNELS.map((def, i) => funnelOf(def, i, full)),
    window: { ...WINDOW },
    provenance: {
      source: 'Acme BI funnel report (synthetic fixture)',
      pulled_at: PULLED_AT,
      freshness: FRESHNESS,
      filters: [`product = ${PRODUCT}`, `event_date ${WINDOW.from}..${WINDOW.to} (previous ${WINDOW.prev_from}..${WINDOW.prev_to})`],
    },
    notes: SET_NOTES,
    hints: { ...HINTS },
    rates: RATES,
    intersections: [
      { dims: ['country', 'platform'], min_users: FLOOR },
      { dims: ['language', 'platform'], min_users: FLOOR },
    ],
    ladder: LADDER,
    weekly: setWeekly(prng(31_337)),
  };
  if (full) {
    data.payment = SET_PAYMENT;
    data.payment_reasons = PAYMENT_REASONS;
    data.access = ACCESS;
  }
  const filters = [
    { field: 'product', op: '=', value: PRODUCT, source: 'request' },
    { field: 'event_date', op: 'between', values: [WINDOW.from, WINDOW.to], source: 'request' },
  ];
  return {
    source: {
      vault: 'acme',
      chart: 'chart-acme-funnels',
      chart_name: 'Acme funnel report',
      queries: [
        { chart: 'chart-acme-funnels', chart_name: 'Acme funnel report', dims: ['funnel_id'], applied_filters: filters, freshness: FRESHNESS },
        {
          chart: 'chart-acme-funnels', chart_name: 'Acme funnel report', dims: ['funnel_id'],
          applied_filters: [filters[0], { field: 'event_date', op: 'between', values: [WINDOW.prev_from, WINDOW.prev_to], source: 'request' }],
          freshness: FRESHNESS,
        },
      ],
      applied_filters: filters,
      freshness: FRESHNESS,
      pulled_at: PULLED_AT,
      via: 'synthetic fixture',
    },
    data,
  };
}

/** The same payload a lab script would return (`data` with its provenance), for a direct import. */
export default async function fetchSnapshot() {
  return snapshot('full').data;
}
