/**
 * Synthetic funnel-explorer demo: a lab script for the fictional product
 * "Acme Storefront". Everything here is invented (see the
 * synthetic-fixtures-for-published-artifacts pattern): no real product,
 * company or project name. Deterministic: a seeded PRNG and a fixed window
 * ending 2026-09-28, so every run returns the same payload byte for byte.
 *
 * Shape (the funnel explorer contract, D1): `{ data: dataset/v1 }` whose
 * bundle carries one `funnel` member (funnel-set/v1, segment_mode lookup) next
 * to two tables:
 *   - funnels "Quiz checkout (v2)" and "Activation ladder"
 *   - dims platform (3 values), language (4), country (8)
 *   - one-axis paths for every value; platform x language intersections, some
 *     measured and some `measured: false` with a reason
 *   - 28 days of daily metrics on every funnel and every measured path
 *   - bands with sources, cost_per_lead better:'lower', checkout_to_purchase
 *     not measured (broken denominator), one path lacking a step
 *   - datasets `declines` (reason x cohort) and `decline_rate` (cohort)
 *
 * Self-contained (no imports): the verify run copies it as a lab script.
 */

const END_UTC = Date.UTC(2026, 8, 28);
const DAYS = 28;
const LOW_SAMPLE_REASON = 'fewer than 300 users in the window';

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

function days(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(END_UTC - i * 86400000).toISOString().slice(0, 10));
  return out;
}

const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;

const PLATFORMS = ['Meta Ads', 'TikTok Ads', 'Unattributed'];
const LANGUAGES = ['EN', 'ES', 'DE', 'PT'];
const COUNTRIES = ['United States', 'Germany', 'Spain', 'Brazil', 'Mexico', 'United Kingdom', 'Canada', 'Portugal'];

const QUIZ_STEPS = [
  ['landing', 'Landing'],
  ['quiz_start', 'Quiz start'],
  ['quiz_finish', 'Quiz finish'],
  ['email', 'Email captured'],
  ['paywall', 'Paywall seen'],
  ['checkout', 'Checkout'],
  ['purchase', 'Purchase'],
];
/** Base step-to-step rates (landing = 1). */
const QUIZ_RATES = [1, 0.64, 0.71, 0.58, 0.83, 0.41, 0.36];

const LADDER_STEPS = [
  ['signup', 'Signup'],
  ['profile', 'Profile complete'],
  ['first_order', 'First order'],
  ['second_order', 'Second order'],
];
const LADDER_RATES = [1, 0.72, 0.44, 0.38];

/** Per-platform steering so the paths differ in shape, not just in size. */
const PLATFORM_TILT = { 'Meta Ads': 1.04, 'TikTok Ads': 0.9, Unattributed: 1.1 };
const PLATFORM_USERS = { 'Meta Ads': 18400, 'TikTok Ads': 12600, Unattributed: 3900 };
const PLATFORM_CPL = { 'Meta Ads': 4.2, 'TikTok Ads': 3.1, Unattributed: null };
const LANGUAGE_SHARE = { EN: 0.52, ES: 0.23, DE: 0.15, PT: 0.1 };
const COUNTRY_SHARE = [0.31, 0.14, 0.12, 0.11, 0.1, 0.09, 0.08, 0.05];

/** platform x language intersections with a measured path; the rest are too thin. */
const MEASURED_PAIRS = new Set([
  'Meta Ads|EN', 'Meta Ads|ES', 'Meta Ads|DE',
  'TikTok Ads|EN', 'TikTok Ads|ES', 'TikTok Ads|PT',
  'Unattributed|EN',
]);

/** A step path: top users, each step a noisy fraction of the one before it. */
function path(rand, top, steps, rates, tilt) {
  const out = [];
  let users = Math.round(top);
  steps.forEach(([key, label], i) => {
    if (i > 0) {
      const r = Math.min(0.97, rates[i] * (i >= 3 ? tilt : 1) * (0.94 + rand() * 0.12));
      users = Math.max(1, Math.round(users * r));
    }
    out.push({ key, label, users });
  });
  return out;
}

const usersAt = (steps, key) => steps.find((s) => s.key === key)?.users ?? null;
const pct = (num, den) => (num === null || den === null || den === 0 ? null : round((num / den) * 100, 2));

/** Quiz checkout metrics from a path. checkout_to_purchase is never measured:
 *  the checkout event is missing on one app branch, so its denominator is broken. */
function quizMetrics(rand, steps, cpl) {
  const landing = usersAt(steps, 'landing');
  const email = usersAt(steps, 'email');
  const checkout = usersAt(steps, 'checkout');
  const purchase = usersAt(steps, 'purchase');
  const drift = () => 0.9 + rand() * 0.2;
  const visitToLead = pct(email, landing);
  const leadToCheckout = pct(checkout, email);
  const conversion = pct(purchase, landing);
  return {
    visit_to_lead: { v: visitToLead, prev: visitToLead === null ? null : round(visitToLead * drift(), 2), format: 'pct', label: 'Visit to lead' },
    lead_to_checkout: { v: leadToCheckout, prev: leadToCheckout === null ? null : round(leadToCheckout * drift(), 2), format: 'pct', label: 'Lead to checkout' },
    checkout_to_purchase: {
      v: null, prev: null, format: 'pct', label: 'Checkout to purchase',
      measured: false, reason: 'denominator event missing on one branch',
    },
    conversion: { v: conversion, prev: conversion === null ? null : round(conversion * drift(), 2), format: 'pct', label: 'Conversion' },
    cost_per_lead: cpl === null
      ? { v: null, prev: null, format: 'usd', label: 'Cost per lead', measured: false, reason: 'no ad spend on unattributed traffic' }
      : { v: round(cpl, 2), prev: round(cpl * drift(), 2), format: 'usd', label: 'Cost per lead' },
  };
}

function ladderMetrics(rand, steps) {
  const activation = pct(usersAt(steps, 'first_order'), usersAt(steps, 'signup'));
  return {
    activation_rate: { v: activation, prev: activation === null ? null : round(activation * (0.9 + rand() * 0.2), 2), format: 'pct', label: 'Activation rate' },
    repeat_rate: { v: pct(usersAt(steps, 'second_order'), usersAt(steps, 'first_order')), prev: null, format: 'pct', label: 'Repeat rate' },
  };
}

/** 28 days around each measured metric's current value; unmeasured metrics stay null. */
function daily(rand, metrics) {
  return days(DAYS).map((t, i) => {
    const m = {};
    for (const [key, metric] of Object.entries(metrics)) {
      if (metric.measured === false || metric.v === null) {
        m[key] = null;
        continue;
      }
      const wave = 1 + 0.06 * Math.sin((i / DAYS) * Math.PI * 2 + key.length);
      m[key] = round(metric.v * wave * (0.95 + rand() * 0.1), 2);
    }
    return { t, m };
  });
}

function measuredSegment(rand, dims, top, steps, rates, tilt, metricsOf) {
  const p = path(rand, top, steps, rates, tilt);
  const metrics = metricsOf(p);
  return { dims, users: p[0].users, steps: p.map(({ key, users }) => ({ key, users })), metrics, daily: daily(rand, metrics) };
}

function unmeasuredSegment(rand, dims) {
  return { dims, users: 120 + Math.round(rand() * 160), steps: [], measured: false, reason: LOW_SAMPLE_REASON };
}

/** Unattributed traffic lands on a branch that never fires the email-capture
 *  event: its paths lack that step, and the rates built on it are not measured. */
function withoutEmailStep(rand, seg) {
  const reason = 'no email step on this branch';
  seg.steps = seg.steps.filter((s) => s.key !== 'email');
  seg.metrics.visit_to_lead = { v: null, prev: null, format: 'pct', label: 'Visit to lead', measured: false, reason };
  seg.metrics.lead_to_checkout = { v: null, prev: null, format: 'pct', label: 'Lead to checkout', measured: false, reason };
  seg.daily = daily(rand, seg.metrics);
  return seg;
}

function quizFunnel(rand) {
  const top = Object.values(PLATFORM_USERS).reduce((a, b) => a + b, 0);
  const steps = path(rand, top, QUIZ_STEPS, QUIZ_RATES, 1);
  const metrics = quizMetrics(rand, steps, 3.8);
  const q = (dims, users, tilt, cpl) => {
    const seg = measuredSegment(rand, dims, users, QUIZ_STEPS, QUIZ_RATES, tilt, (p) => quizMetrics(rand, p, cpl));
    return dims.platform === 'Unattributed' ? withoutEmailStep(rand, seg) : seg;
  };
  const segments = [];

  for (const platform of PLATFORMS) {
    const seg = q({ platform }, PLATFORM_USERS[platform], PLATFORM_TILT[platform], PLATFORM_CPL[platform]);
    if (platform === 'TikTok Ads') {
      // Its own band: the platform runs against its own recent history.
      seg.benchmarks = {
        visit_to_lead: { floor: 11, target: 15, floor_source: 'own p25 (8 wk)', target_source: 'own p75 (8 wk)' },
        cost_per_lead: { floor: 4.5, target: 2.8, floor_source: 'own p25 (8 wk)', target_source: 'book', better: 'lower' },
      };
    }
    segments.push(seg);
  }
  for (const language of LANGUAGES) {
    segments.push(q({ language }, top * LANGUAGE_SHARE[language], 1, 3.8));
  }
  COUNTRIES.forEach((country, i) => {
    segments.push(q({ country }, top * COUNTRY_SHARE[i], 0.95 + (i % 3) * 0.05, 3.8));
  });
  for (const platform of PLATFORMS) {
    for (const language of LANGUAGES) {
      const dims = { platform, language };
      segments.push(MEASURED_PAIRS.has(`${platform}|${language}`)
        ? q(dims, PLATFORM_USERS[platform] * LANGUAGE_SHARE[language], PLATFORM_TILT[platform], PLATFORM_CPL[platform])
        : unmeasuredSegment(rand, dims));
    }
  }

  return {
    id: 'quiz-checkout',
    name: 'Quiz checkout (v2)',
    meta: { product: 'Acme Storefront', entry: 'Style quiz', window: '28 days' },
    metrics,
    steps,
    daily: daily(rand, metrics),
    segments,
  };
}

function ladderFunnel(rand) {
  const top = 9800;
  const steps = path(rand, top, LADDER_STEPS, LADDER_RATES, 1);
  const metrics = ladderMetrics(rand, steps);
  const segments = PLATFORMS.map((platform) =>
    measuredSegment(rand, { platform }, PLATFORM_USERS[platform] * 0.28, LADDER_STEPS, LADDER_RATES, PLATFORM_TILT[platform], (p) => ladderMetrics(rand, p)));
  return {
    id: 'activation-ladder',
    name: 'Activation ladder',
    meta: { product: 'Acme Storefront', entry: 'Account signup', window: '28 days' },
    metrics,
    steps,
    daily: daily(rand, metrics),
    segments,
  };
}

const DECLINE_REASONS = ['Insufficient funds', 'Card expired', 'Suspected fraud', 'Do not honor', '3-D Secure failed'];
const COHORTS = ['New buyers', 'Returning buyers', 'Trial converts'];

function declineTables(rand) {
  const rows = [];
  let total = 0;
  for (const reason of DECLINE_REASONS) {
    for (const cohort of COHORTS) {
      const v = 20 + Math.round(rand() * 180);
      total += v;
      rows.push({ d: { reason, cohort }, v, prev: Math.round(v * (0.85 + rand() * 0.3)) });
    }
  }
  const rateRows = COHORTS.map((cohort) => {
    const v = round(4 + rand() * 7, 2);
    return { d: { cohort }, v, n: 800 + Math.round(rand() * 2400), prev: round(v * (0.9 + rand() * 0.2), 2) };
  });
  return [
    {
      key: 'declines',
      label: 'Payment declines',
      unit: 'declines',
      dims: [{ key: 'reason', label: 'Reason' }, { key: 'cohort', label: 'Cohort' }],
      rows,
      total: { v: total },
    },
    {
      key: 'decline_rate',
      label: 'Decline rate',
      unit: '%',
      dims: [{ key: 'cohort', label: 'Cohort' }],
      rows: rateRows,
    },
  ];
}

export default async function () {
  const rand = prng(20260928);
  const funnels = [quizFunnel(rand), ladderFunnel(rand)];
  const datasets = declineTables(rand);
  return {
    data: {
      kind: 'dataset/v1',
      primary: 'declines',
      datasets,
      funnel: {
        kind: 'funnel-set/v1',
        segment_mode: 'lookup',
        primary: 'conversion',
        low_sample_threshold: 300,
        dimensions: [
          { key: 'platform', label: 'Platform', mode: 'client', values: PLATFORMS.map((value) => ({ value })) },
          { key: 'language', label: 'Language', mode: 'client', values: LANGUAGES.map((value) => ({ value })) },
          { key: 'country', label: 'Country', mode: 'client', values: COUNTRIES.map((value) => ({ value })) },
        ],
        benchmarks: {
          visit_to_lead: { floor: 12, target: 18, floor_source: 'book', target_source: 'own p25 (8 wk)' },
          lead_to_checkout: { floor: 30, target: 42, floor_source: 'book', target_source: 'book' },
          conversion: { floor: 2.5, target: 4, floor_source: 'own p25 (8 wk)', target_source: 'book' },
          cost_per_lead: { floor: 5, target: 3.2, floor_source: 'book', target_source: 'own p25 (8 wk)', better: 'lower' },
        },
        funnels,
      },
    },
  };
}
