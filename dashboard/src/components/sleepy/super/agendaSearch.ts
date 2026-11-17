/**
 * The agenda's search (owner 2026-11-17): the pure half. Matching ignores case and Turkish
 * accents (İ/ı, ş/s, ğ/g, ç/c, ö/o, ü/u), reads the lines of every day, and says WHERE the match
 * sits in the original text so the row can mark it. React-free, so every rule is a unit test
 * (agenda-search.test.ts).
 */
import { dayGroups, localDay, type AgendaEntry } from './agendaGroups';
import type { SuperPadItem } from '../../../lib/superTypes';

/** One char, folded: Turkish lower case, accents off, dotless ı as i. */
function foldChar(c: string): string {
  return c.toLocaleLowerCase('tr').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i');
}

/** `s` as one spelling for the same Turkish word. */
export function foldTr(s: string): string {
  let out = '';
  for (const c of s) out += foldChar(c);
  return out;
}

/** The folded text with, for each folded char, where it starts and ends in the original. */
type Folded = { folded: string; starts: number[]; ends: number[] };
// Each line is folded once, not once per keystroke (a long archive runs to thousands of lines).
const foldCache = new Map<string, Folded>();
function foldMap(text: string): Folded {
  const hit = foldCache.get(text);
  if (hit) return hit;
  const made = foldMapOf(text);
  if (foldCache.size > 20000) foldCache.clear();
  foldCache.set(text, made);
  return made;
}
function foldMapOf(text: string): Folded {
  let folded = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const c of text) {
    const f = foldChar(c);
    for (let k = 0; k < f.length; k++) { starts.push(i); ends.push(i + c.length); }
    folded += f;
    i += c.length;
  }
  return { folded, starts, ends };
}

/** [start, end) of the first match of `query` in `text`, in `text`'s own indices; null when the
 *  query is blank or absent. */
export function matchRange(text: string, query: string): [number, number] | null {
  const q = foldTr(query.trim());
  if (!q) return null;
  const { folded, starts, ends } = foldMap(text);
  const at = folded.indexOf(q);
  return at < 0 ? null : [starts[at], ends[at + q.length - 1]];
}

/** `text` split around the first match, or null (nothing to mark). */
export function highlightParts(text: string, query: string): { before: string; hit: string; after: string } | null {
  const r = matchRange(text, query);
  return r ? { before: text.slice(0, r[0]), hit: text.slice(r[0], r[1]), after: text.slice(r[1]) } : null;
}

/** Every word a row shows that a search may read. */
export function entryText(e: AgendaEntry): string {
  return [e.row?.text, e.row?.line, e.approval?.title, e.inbox?.title].filter((s): s is string => typeof s === 'string' && s !== '').join(' ');
}

export interface SearchDay { day: string; entries: AgendaEntry[] }

/**
 * The lines of every day that match, grouped under their day, newest day first. A line seen under
 * two days is listed once, under the newest. A blank query is no search (null); a day with no hit
 * is not listed.
 */
export function searchDays(days: readonly SearchDay[], query: string): SearchDay[] | null {
  if (!query.trim()) return null;
  const seen = new Set<string>();
  const out: SearchDay[] = [];
  for (const d of [...days].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))) {
    const entries = d.entries.filter((e) => {
      if (seen.has(e.key) || !matchRange(entryText(e), query)) return false;
      seen.add(e.key);
      return true;
    });
    if (entries.length) out.push({ day: d.day, entries });
  }
  return out;
}

/**
 * What a search reads: today's lines, every day that has a file, and every day a Done line still
 * on the live pad finished (it is archived later and must be found before that too). `dayDone` is
 * each loaded day's Done lines (the route's answer), keyed by day.
 */
export function searchSources(today: string, todayEntries: AgendaEntry[], pad: readonly SuperPadItem[], dayDone: Readonly<Record<string, readonly SuperPadItem[] | null | undefined>>): SearchDay[] {
  const days = new Set([...Object.keys(dayDone), ...pad.filter((p) => p.section === 'done').map((p) => localDay(p.at))]);
  days.delete(today);
  return [
    { day: today, entries: todayEntries },
    ...[...days].map((d): SearchDay => {
      // A day not fetched yet reads the live pad's own Done lines of that day (the route's answer,
      // once fetched, already holds them).
      const done = dayDone[d] ?? pad.filter((p) => p.section === 'done' && localDay(p.at) === d);
      const g = dayGroups(d, pad, done);
      return { day: d, entries: [...g.dayOpen, ...g.dayDone] };
    }),
  ];
}
