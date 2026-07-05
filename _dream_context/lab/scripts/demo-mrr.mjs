// DEMO FIXTURE (throwaway) — synthesizes a plausible MRR ramp, bound (via the
// manifest's `binding`) to the make-it-a-business roadmap objective's Key
// Result. Exists only to exercise the insight-side "feeds <objective>"
// provenance chip for the manual dashboard checklist. NOT a real revenue
// figure — running `lab sync demo-mrr` overwrites that objective's
// metric.current with this fixture's latest value.
export default async function demoMrr() {
  const DAY_MS = 86_400_000;
  const today = new Date();
  const points = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 7 * DAY_MS); // weekly cadence
    const t = d.toISOString().slice(0, 10);
    const v = Math.round(500 + (5 - i) * 70 + Math.random() * 20);
    points.push({ t, v });
  }
  return [{ name: 'mrr', points }];
}
