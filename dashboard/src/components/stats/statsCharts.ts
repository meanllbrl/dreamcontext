import type { ProjectRow } from './statsTypes';

/** One line of the projects chart. `others`: how many projects the "Other" line folds. */
export interface EatenItem { key: string; label: string; sleep: number; memory: number; saved: number; net: number; spend: number; prompts: number | null; others?: number }

/** A cent is the smallest thing a line can draw or say. */
const CENT = 0.005;
const TOP = 5;

const itemOf = (r: ProjectRow): EatenItem => ({
  key: r.key, label: r.label, sleep: r.sleep.cost, memory: r.estMemory.cost, saved: r.estSaved.cost, net: r.estNet.cost,
  spend: r.cost ?? 0, prompts: r.prompts?.owner ?? null,
});

/** Biggest eater first, the top five and one "Other"; a project with nothing to draw is not a line. */
export function topEaters(rows: ProjectRow[]): EatenItem[] {
  const items = rows.map(itemOf).filter((i) => i.sleep + i.memory >= CENT || i.saved >= CENT)
    .sort((a, b) => (b.sleep + b.memory) - (a.sleep + a.memory) || b.saved - a.saved);
  const rest = items.slice(TOP);
  if (rest.length === 0) return items;
  const sum = (f: (i: EatenItem) => number) => rest.reduce((a, i) => a + f(i), 0);
  const counted = rest.filter((i) => i.prompts !== null);
  return [...items.slice(0, TOP), {
    key: '\0other', label: '', sleep: sum((i) => i.sleep), memory: sum((i) => i.memory), saved: sum((i) => i.saved), net: sum((i) => i.net),
    spend: sum((i) => i.spend), prompts: counted.length ? counted.reduce((a, i) => a + (i.prompts as number), 0) : null, others: rest.length,
  }];
}

export interface TrendBucket { start: number; end: number; sleep: number; memory: number; saved: number }

/** Days as they came, or weeks counted back from today, so the newest week is whole. */
export function trendBuckets(buckets: Array<{ start: number; end: number }>, trend: { sleep: number[]; memory: number[]; saved: number[] }, weekly: boolean): TrendBucket[] {
  const days = buckets.map((b, i) => ({ ...b, sleep: trend.sleep[i], memory: trend.memory[i], saved: trend.saved[i] }));
  if (!weekly) return days;
  const out: TrendBucket[] = [];
  for (let end = days.length; end > 0; end -= 7) {
    const week = days.slice(Math.max(0, end - 7), end);
    out.unshift({
      start: week[0].start, end: week[week.length - 1].end,
      sleep: week.reduce((a, d) => a + d.sleep, 0), memory: week.reduce((a, d) => a + d.memory, 0), saved: week.reduce((a, d) => a + d.saved, 0),
    });
  }
  return out;
}

/** Where the Eco record starts, as a bucket position (2.5 = halfway through the third). Null: it covers the whole range. */
export function ecoStartAt(buckets: Array<{ start: number; end: number }>, ecoFrom: number | null): number | null {
  if (buckets.length === 0) return null;
  if (ecoFrom === null) return buckets.length;
  if (ecoFrom <= buckets[0].start) return null;
  const i = buckets.findIndex((b) => ecoFrom < b.end);
  if (i < 0) return buckets.length;
  return i + (ecoFrom - buckets[i].start) / (buckets[i].end - buckets[i].start);
}
