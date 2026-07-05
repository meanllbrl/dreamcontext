// DEMO FIXTURE (throwaway) — synthesizes a small event-count series so the
// `raw` render has something to show in both its table and JSON views.
// Exists only for the manual dashboard checklist. Not real data.
export default async function demoRawEvents() {
  const DAY_MS = 86_400_000;
  const today = new Date();
  const points = [];
  for (let i = 7; i >= 0; i--) {
    const d = new Date(today.getTime() - i * DAY_MS);
    const t = d.toISOString().slice(0, 10);
    points.push({ t, v: Math.round(10 + Math.random() * 20) });
  }
  return [{ name: 'events', points }];
}
