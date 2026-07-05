// DEMO FIXTURE (throwaway) — synthesizes 14 days of plausible daily signup
// counts ending today. Exists only to exercise the Lab dashboard's `number`
// render + fresh staleness badge for the manual checklist. Not real data.
export default async function demoSignups() {
  const DAY_MS = 86_400_000;
  const today = new Date();
  const points = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today.getTime() - i * DAY_MS);
    const t = d.toISOString().slice(0, 10);
    // A gentle upward trend with a little noise, always positive.
    const base = 40 + (13 - i) * 1.5;
    const noise = Math.round(Math.sin(i) * 4 + Math.random() * 3);
    points.push({ t, v: Math.max(5, Math.round(base + noise)) });
  }
  return [{ name: 'signups', points }];
}
