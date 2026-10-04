/**
 * The date window a whiteboard widget prints on its card ("6 Tem – 4 Eki").
 *
 * The window is the one the DATA is for, not the one the control last asked for: a cache that
 * carries its own resolved window (a funnel set, a matrix, a dataset bundle, an app spec) wins;
 * otherwise the window the insight's tweaks resolve to today (`resolvedRange`, the server's
 * `resolveTweaks`). A re-sync in flight therefore keeps the old label until the new data lands,
 * which is the truth about what the card shows.
 *
 * No React, no CSS: root vitest imports this file.
 */

export interface DateWindow {
  fromISO: string;
  toISO: string;
}

interface WindowSource {
  resolvedRange?: DateWindow;
  cache?: {
    funnel?: { range?: DateWindow };
    matrix?: { range?: DateWindow };
    datasets?: { range?: DateWindow };
    app?: { range?: DateWindow };
  } | null;
}

function isWindow(w: unknown): w is DateWindow {
  if (!w || typeof w !== 'object') return false;
  const { fromISO, toISO } = w as Record<string, unknown>;
  return typeof fromISO === 'string' && typeof toISO === 'string' && fromISO !== '' && toISO !== '';
}

/** The window the widget's data covers, or null when nothing says. */
export function dataWindow(detail: WindowSource | null | undefined): DateWindow | null {
  if (!detail) return null;
  const c = detail.cache;
  for (const w of [c?.funnel?.range, c?.matrix?.range, c?.datasets?.range, c?.app?.range, detail.resolvedRange]) {
    if (isWindow(w)) return w;
  }
  return null;
}

/** A calendar date (`YYYY-MM-DD`) as a local date, or null when it is not one. */
function day(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * "6 Tem – 4 Eki" in the reader's locale: day and short month, the year only when the two ends
 * fall in different years or the window is not this year. A one-day window is one date.
 */
export function formatWindow(w: DateWindow, locale: string, now: Date = new Date()): string {
  const from = day(w.fromISO);
  const to = day(w.toISO);
  if (!from || !to) return `${w.fromISO} – ${w.toISO}`;
  const withYear = from.getFullYear() !== to.getFullYear() || to.getFullYear() !== now.getFullYear();
  const opts: Intl.DateTimeFormatOptions = withYear
    ? { day: 'numeric', month: 'short', year: 'numeric' }
    : { day: 'numeric', month: 'short' };
  const fmt = new Intl.DateTimeFormat(locale, opts);
  if (w.fromISO.slice(0, 10) === w.toISO.slice(0, 10)) return fmt.format(to);
  return `${fmt.format(from)} – ${fmt.format(to)}`;
}
