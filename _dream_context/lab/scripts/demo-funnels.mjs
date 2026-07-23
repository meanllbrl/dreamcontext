/**
 * DEMO FIXTURE (throwaway, `demo-` prefix) — synthesized onboarding funnel
 * variants returning a `funnel-set/v1` payload. Exists to exercise the funnel
 * UI end-to-end (overview table + deltas + low-sample chip, detail node lane,
 * arc gesture, client filters, breakdown, compare, benchmarks) without a real
 * data source. Not real data.
 *
 * Numbers scale with the resolved `range` tweak span so the date-range control
 * genuinely changes the data. Deterministic — no noise — so refreshes are
 * stable and deltas are readable.
 */

// Shared step keys align funnels in compare mode; `video_watch` exists only in
// the video variant so compare shows a ghosted (unmatched) step.
const STEPS = [
  { key: 'session_start', label: 'Session start' },
  { key: 'signup', label: 'Sign up' },
  { key: 'video_watch', label: 'Intro video' }, // only funnel C
  { key: 'onboarding_complete', label: 'Onboarding complete' },
  { key: 'paywall_view', label: 'Paywall view' },
  { key: 'trial_start', label: 'Trial start' },
  { key: 'subscribe', label: 'Subscribe' },
];

// Segment cells: language × device. Disjoint by construction; funnel step
// totals are computed as the SUM of cells so segments always reconcile.
const CELLS = [
  { dims: { language: 'en', device: 'mobile' }, share: 0.34 },
  { dims: { language: 'en', device: 'desktop' }, share: 0.21 },
  { dims: { language: 'tr', device: 'mobile' }, share: 0.18 },
  { dims: { language: 'tr', device: 'desktop' }, share: 0.07 },
  { dims: { language: 'de', device: 'mobile' }, share: 0.13 },
  { dims: { language: 'de', device: 'desktop' }, share: 0.07 },
];

/**
 * Per-funnel spec: top-of-funnel volume for a 28-day window, per-step
 * PASS-THROUGH rates (fraction of the previous step that survives), ad spend,
 * and a previous-period drift factor (prev = current / drift).
 */
const FUNNELS = [
  {
    id: 'onb-a',
    name: 'onb-a-classic',
    meta: {
      product: 'dreamcontext app',
      url: 'https://example.com/onboarding/a',
      hypothesis: 'Baseline 5-screen onboarding',
    },
    top: 4820,
    rates: { signup: 0.62, onboarding_complete: 0.71, paywall_view: 0.86, trial_start: 0.31, subscribe: 0.38 },
    spend: 3140,
    drift: 1.06, // slightly better than last period
  },
  {
    id: 'onb-b',
    name: 'onb-b-short',
    meta: {
      product: 'dreamcontext app',
      url: 'https://example.com/onboarding/b',
      hypothesis: 'Cut onboarding to 2 screens → less drop before paywall',
    },
    top: 4610,
    rates: { signup: 0.64, onboarding_complete: 0.88, paywall_view: 0.9, trial_start: 0.36, subscribe: 0.41 },
    spend: 3050,
    drift: 1.18, // the winner, improving fast
  },
  {
    id: 'onb-c',
    name: 'onb-c-video',
    meta: {
      product: 'dreamcontext app',
      url: 'https://example.com/onboarding/c',
      hypothesis: 'Intro video builds intent before signup',
    },
    top: 4390,
    rates: { signup: 0.58, video_watch: 0.42, onboarding_complete: 0.81, paywall_view: 0.84, trial_start: 0.33, subscribe: 0.39 },
    spend: 3320,
    drift: 0.91, // regressing — video is the leak
  },
  {
    id: 'onb-d',
    name: 'onb-d-paywall-first',
    meta: {
      product: 'dreamcontext app',
      url: 'https://example.com/onboarding/d',
      hypothesis: 'Show paywall before onboarding → qualify hard, early',
    },
    top: 4150,
    rates: { signup: 0.61, onboarding_complete: 0.93, paywall_view: 0.97, trial_start: 0.12, subscribe: 0.55 },
    spend: 2890,
    drift: 0.97,
  },
  {
    id: 'tr-516',
    name: 'tr-start-516',
    meta: {
      product: 'dreamcontext app',
      url: 'https://example.com/f/516',
      hypothesis: 'TR-localized ad set (tiny test budget)',
    },
    top: 27, // below low_sample_threshold → "low sample" chip
    rates: { signup: 0.48, onboarding_complete: 0.69, paywall_view: 0.78, trial_start: 0.29, subscribe: 0.5 },
    spend: 96,
    drift: 1.0,
  },
];

const pct = (v) => Math.round(v * 10000) / 100;
const usd = (v) => Math.round(v * 100) / 100;

/** Walk the step ladder for a given top-of-funnel volume. Steps a funnel has
 *  no rate for are skipped (absent from that funnel). */
function walkSteps(spec, top) {
  const out = [];
  let prev = Math.round(top);
  for (const step of STEPS) {
    if (step.key === 'session_start') {
      out.push({ key: step.key, label: step.label, users: prev });
      continue;
    }
    const rate = spec.rates[step.key];
    if (rate === undefined) continue;
    prev = Math.round(prev * rate);
    out.push({ key: step.key, label: step.label, users: prev });
  }
  return out;
}

function buildFunnel(spec, scale) {
  // Cells first, funnel totals as the sum — segments always reconcile.
  const cellWalks = CELLS.map((cell) => ({
    dims: cell.dims,
    steps: walkSteps(spec, spec.top * scale * cell.share),
  }));

  const steps = walkSteps(spec, 0).map((s) => ({ key: s.key, label: s.label, users: 0 }));
  for (const cw of cellWalks) {
    for (const cs of cw.steps) {
      const target = steps.find((s) => s.key === cs.key);
      if (target) target.users += cs.users;
    }
  }

  const prevSteps = walkSteps(spec, (spec.top * scale) / spec.drift);
  for (const s of steps) {
    const p = prevSteps.find((ps) => ps.key === s.key);
    s.prev = p ? p.users : null;
  }

  const users = steps[0].users;
  const subs = steps[steps.length - 1].users;
  const trials = steps.find((s) => s.key === 'trial_start')?.users ?? 0;
  const spend = spec.spend * scale;

  const prevUsers = prevSteps[0].users;
  const prevSubs = prevSteps[prevSteps.length - 1].users;
  const prevTrials = prevSteps.find((ps) => ps.key === 'trial_start')?.users ?? 0;
  const prevSpend = spend / spec.drift;

  return {
    id: spec.id,
    name: spec.name,
    meta: spec.meta,
    metrics: {
      users: { v: users, format: 'count', prev: prevUsers },
      spend: { v: usd(spend), format: 'usd', prev: usd(prevSpend) },
      cpm: {
        v: users > 0 ? usd((spend / users) * 1000) : null,
        format: 'usd',
        label: 'CPM',
        prev: prevUsers > 0 ? usd((prevSpend / prevUsers) * 1000) : null,
      },
      trial_rate: {
        v: users > 0 ? pct(trials / users) : null,
        format: 'pct',
        prev: prevUsers > 0 ? pct(prevTrials / prevUsers) : null,
      },
      finish_rate: {
        v: users > 0 ? pct(subs / users) : null,
        format: 'pct',
        prev: prevUsers > 0 ? pct(prevSubs / prevUsers) : null,
      },
      cac: {
        v: subs > 0 ? usd(spend / subs) : null,
        format: 'usd',
        label: 'CAC',
        prev: prevSubs > 0 ? usd(prevSpend / prevSubs) : null,
      },
    },
    steps,
    segments: cellWalks.map((cw) => ({
      dims: cw.dims,
      users: cw.steps[0].users,
      steps: cw.steps.map((s) => ({ key: s.key, users: s.users })),
    })),
  };
}

export default async function demoFunnels(ctx) {
  const { spanDays } = ctx.resolvedTweaks;
  // Volumes are specified for a 28-day window; scale linearly with the range.
  const scale = Math.max(1, spanDays ?? 28) / 28;

  return {
    kind: 'funnel-set/v1',
    dimensions: [
      { key: 'language', label: 'Language', mode: 'client' },
      { key: 'device', label: 'Device', mode: 'client' },
    ],
    primary: 'users',
    low_sample_threshold: 30,
    benchmarks: {
      finish_rate: { floor: 5, target: 9 },
      trial_rate: { floor: 8, target: 15 },
    },
    funnels: FUNNELS.map((spec) => buildFunnel(spec, scale)),
  };
}
