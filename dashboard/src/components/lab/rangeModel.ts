import type { PublicTweak } from '../../hooks/useLab';

/**
 * The pure window model behind `RangeControl` — preset lists, which window a set
 * of tweaks currently describes, the URL codec, and the quick windows.
 *
 * Split out of the component for the same reason `funnelModel.ts` is: this is
 * where the precedence rules live (explicit `from`/`to` out-rank the `range`
 * enum, exactly as `resolveTweaks` decides it), and rules that mirror the engine
 * need tests. The component cannot be imported under vitest — it pulls in CSS —
 * so logic that stayed inside it was logic nobody could pin.
 */

/** Presets offered when a manifest declares no `range` options of its own.
 *  MIRRORS `DEFAULT_RANGE_OPTIONS` in src/lib/lab/store.ts (unit-test guarded). */
export const DEFAULT_RANGE_PRESETS = [
  'last_7_days',
  'last_28_days',
  'last_30_days',
  'last_90_days',
  'last_1_year',
];

/** What `resolveTweaks` falls back to when nothing is set (DEFAULT_SPAN_DAYS). */
export const ENGINE_FALLBACK_RANGE = 'last_30_days';

/** The window keys this control owns — every other tweak stays with TweakEditor,
 *  so a surface never renders two competing date pickers. */
export const WINDOW_TWEAK_KEYS = ['range', 'from', 'to'];

/** The tweaks a generic tweak editor should still show next to a RangeControl. */
export function nonWindowTweaks(tweaks: PublicTweak[]): PublicTweak[] {
  return tweaks.filter((t) => !WINDOW_TWEAK_KEYS.includes(t.key));
}

/**
 * Mirror an applied window into the funnel pages' URL params, so a deep link
 * carries the window its author was looking at. Preset and custom are mutually
 * exclusive here for the same reason they are in the manifest: a leftover
 * `from`/`to` in the query would out-rank the `range` the link asks for.
 */
export function writeRangeParams(params: URLSearchParams, values: Record<string, string>): void {
  if (values.range) {
    params.set('range', values.range);
    params.delete('from');
    params.delete('to');
    return;
  }
  if (values.from) params.set('from', values.from);
  if (values.to) params.set('to', values.to);
  params.delete('range');
}

/** The relative-range grammar the engine parses (`parseRelativeRange`). */
const RELATIVE_RANGE_RE = /^last_(\d+)_(day|days|week|weeks|month|months|year|years)$/;

export function isRelativeRange(value: string): boolean {
  return RELATIVE_RANGE_RE.test((value ?? '').trim());
}

function tweakValue(tweaks: PublicTweak[], key: string): string {
  const t = tweaks.find((x) => x.key === key);
  return (t?.value ?? '').trim();
}

/** The preset list for these tweaks: the author's curated enum, else the defaults. */
export function rangePresets(tweaks: PublicTweak[]): string[] {
  const decl = tweaks.find((t) => t.key === 'range' && t.type === 'enum');
  const options = (decl?.options ?? []).filter((o) => o.trim() !== '');
  return options.length > 0 ? options : DEFAULT_RANGE_PRESETS;
}

export type ActiveRange =
  | { kind: 'preset'; value: string }
  /** `masked` is the preset a custom window is hiding — what Clear returns to. */
  | { kind: 'custom'; from: string; to: string; masked: string };

/**
 * The preset to fall back to when no custom window is applied — and, crucially,
 * the one to RETURN to when a custom window is cleared.
 *
 * It has to be a value the manifest will accept. `ENGINE_FALLBACK_RANGE` alone
 * is not: writing `from`/`to` does NOT clear the `range` enum (from/to simply
 * out-rank it), so a curated enum like `[last_7_days, last_28_days,
 * last_90_days]` still holds the user's real preset while the engine rejects
 * `last_30_days` outright — which is how Clear came to throw
 * `Tweak "range" must be one of: …` and leave the custom window pinned.
 *
 * Precedence: the stored/declared `range` → the first curated option → the
 * engine's own default (only reachable when the insight declares no options).
 */
export function fallbackPreset(tweaks: PublicTweak[]): string {
  const decl = tweaks.find((t) => t.key === 'range' && t.type === 'enum');
  const stored = (decl?.value ?? decl?.default ?? '').trim();
  if (stored) return stored;
  const options = (decl?.options ?? []).filter((o) => o.trim() !== '');
  if (options.length > 0) return options[0];
  return ENGINE_FALLBACK_RANGE;
}

/** Which window these tweaks currently describe — the same precedence
 *  `resolveTweaks` applies (explicit from/to beat the enum). */
export function activeRange(tweaks: PublicTweak[]): ActiveRange {
  const from = tweakValue(tweaks, 'from');
  const to = tweakValue(tweaks, 'to');
  if (from && to) return { kind: 'custom', from, to, masked: fallbackPreset(tweaks) };
  return { kind: 'preset', value: fallbackPreset(tweaks) };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local-calendar ISO date — never `toISOString()`, which shifts the day for
 *  anyone east/west of UTC and would apply a window they did not pick. */
export function formatISO(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * One-click custom windows the presets can't express.
 *
 * These are the windows people actually reach for — and reaching them through
 * the calendar meant stepping months one at a time, then two more clicks and an
 * Apply. They resolve to explicit `from`/`to`, which is what they are: a pinned
 * window, not a trailing one. The trailing spans belong to the preset pills.
 *
 * `from = today - n` matches `resolveTweaks`' own arithmetic for `last_n_days`,
 * so "Last 14 days" here and "Last 7 days" on a pill count the same way.
 */
export interface QuickWindow {
  key: string;
  from: string;
  to: string;
}

export function quickWindows(today: Date): QuickWindow[] {
  const y = today.getFullYear();
  const m = today.getMonth();
  const shift = (n: number) => formatISO(new Date(y, m, today.getDate() - n));
  const lastMonthEnd = new Date(y, m, 0); // day 0 of this month = last day of the previous
  return [
    { key: 'd14', from: shift(14), to: formatISO(today) },
    { key: 'thisMonth', from: formatISO(new Date(y, m, 1)), to: formatISO(today) },
    { key: 'lastMonth', from: formatISO(new Date(y, m - 1, 1)), to: formatISO(lastMonthEnd) },
    { key: 'ytd', from: formatISO(new Date(y, 0, 1)), to: formatISO(today) },
  ];
}
