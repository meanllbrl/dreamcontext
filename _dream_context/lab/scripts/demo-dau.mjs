// DEMO FIXTURE (throwaway) — synthesizes ONE daily point per day across the
// RESOLVED `range` tweak window (ctx.resolvedTweaks.range.fromISO..toISO), so
// editing the tweak from last_30_days -> last_1_year and refreshing genuinely
// changes the raw series length the rollup engine has to coarsen. Exists only
// to exercise the Lab dashboard's `line` render + granularity coarsening for
// the manual checklist. Not real data.
const DAY_MS = 86_400_000;

export default async function demoDau(ctx) {
  const { fromISO, toISO } = ctx.resolvedTweaks.range;
  const from = Date.parse(`${fromISO}T00:00:00Z`);
  const to = Date.parse(`${toISO}T00:00:00Z`);
  const days = Math.max(1, Math.round((to - from) / DAY_MS));

  const points = [];
  for (let i = 0; i <= days; i++) {
    const d = new Date(from + i * DAY_MS);
    const t = d.toISOString().slice(0, 10);
    // A slow seasonal wave plus weekly cadence plus noise — plausible DAU shape.
    const seasonal = 500 + 150 * Math.sin((i / Math.max(days, 1)) * Math.PI * 2);
    const weekly = 40 * Math.sin((i / 7) * Math.PI * 2);
    const noise = (Math.random() - 0.5) * 30;
    points.push({ t, v: Math.max(0, Math.round(seasonal + weekly + noise)) });
  }
  return [{ name: 'dau', points }];
}
