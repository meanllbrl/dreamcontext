// DEMO FIXTURE (throwaway) — synthesizes 4 categorical traffic-share slices,
// one series per channel with a single current-day point (the pie renderer
// takes each series' last point as its slice value). Exists only to exercise
// the Lab dashboard's `pie` render for the manual checklist. Not real data.
export default async function demoTrafficSources() {
  const today = new Date().toISOString().slice(0, 10);
  const channels = [
    { name: 'Organic Search', v: 420 },
    { name: 'Paid Ads', v: 260 },
    { name: 'Referral', v: 140 },
    { name: 'Direct', v: 95 },
    { name: 'Social', v: 60 },
  ];
  return channels.map((c) => ({ name: c.name, points: [{ t: today, v: c.v }] }));
}
