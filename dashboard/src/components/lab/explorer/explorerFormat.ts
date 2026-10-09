import {
  explorerHint,
  isSmallKn,
  KN_THRESHOLD,
  type FunnelFrame,
  type FunnelMetricFormat,
  type Kn,
  type Selection,
  type SliceReasonCode,
} from '../../../generated/frameOps';

/**
 * The funnel explorer's shared wording and figures, used by the header, the
 * ranking, payment and access blocks and (wave 3) the extended explorer blocks,
 * so one honesty rule reads the same everywhere:
 *
 *   - a rate whose denominator is under KN_THRESHOLD is shown as "k/n", never
 *     as a percentage (`formatRateOrKn`);
 *   - a missing path says WHY (the payload's own reason, else never pulled,
 *     else under the declared user floor), never a bare "no data" (`reasonText`);
 *   - an empty part says how to fill it when the snapshot carries a hint
 *     (`hintLine`);
 *   - a strip of cards never leaves one orphan on its last row (`balancedColumns`).
 *
 * Pure: every function takes the translate function it needs, so it is tested
 * without React.
 */

export type Translate = (key: string) => string;

/** `{name}` placeholders filled from `vars` (a placeholder with no value stays as written). */
export function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

// ─── One number formatter for the explorer (tr-TR / en-US) ────────────────
//
// Every explorer surface prints its figures through these, so a page never
// mixes "21.8%" with "%21,8" or "660 B" with "660K". Rates carry 1 decimal,
// ratios 2, counts none. A missing value is an en dash, never a 0.

/** The dash a missing figure prints as (never 0). */
export const NO_VALUE = '–';
/** U+2212: the sign a negative figure reads with. */
const MINUS = '−';

/** `tr*` reads Turkish, everything else US English. */
export function numberLocale(locale: string | undefined): 'tr-TR' | 'en-US' {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('tr') ? 'tr-TR' : 'en-US';
}

const isTr = (locale: string | undefined) => numberLocale(locale) === 'tr-TR';
const finiteOrNull = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function digitsOf(v: number, locale: string | undefined, min: number, max: number): string {
  return new Intl.NumberFormat(numberLocale(locale), { minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: true }).format(v);
}

/** A share already in percent units: TR "%21,8", EN "21.8%". `digits` defaults to 1. */
export function fmtPercent(value: number | null, locale: string, digits = 1): string {
  const v = finiteOrNull(value);
  if (v === null) return NO_VALUE;
  const n = digitsOf(Math.abs(v), locale, digits, digits);
  const sign = v < 0 && Number(n.replace(/[^\d]/g, '')) !== 0 ? MINUS : '';
  return isTr(locale) ? `${sign}%${n}` : `${sign}${n}%`;
}

/** A rate change in points: TR "−2,1 puan", EN "−2.1 pp"; signed; a zero change prints "0" (never "−0" or "+0"). */
export function fmtPoints(delta: number | null, locale: string): string {
  const v = finiteOrNull(delta);
  if (v === null) return NO_VALUE;
  const unit = isTr(locale) ? 'puan' : 'pp';
  const rounded = Math.round(v * 10) / 10;
  if (rounded === 0) return `0 ${unit}`;
  return `${rounded > 0 ? '+' : MINUS}${digitsOf(Math.abs(rounded), locale, 1, 1)} ${unit}`;
}

/** A whole count with grouping: TR "659.569", EN "659,569". */
export function fmtCount(value: number | null, locale: string): string {
  const v = finiteOrNull(value);
  if (v === null) return NO_VALUE;
  const n = digitsOf(Math.abs(Math.round(v)), locale, 0, 0);
  return v < 0 && Math.round(v) !== 0 ? `${MINUS}${n}` : n;
}

/**
 * A count in short form: TR "660 bin" / "1,2 mn" / "3,4 mr", EN "660K" / "1.2M" / "3.4bn"
 * (never the ambiguous "B"). Under 1,000 it is the plain count; one decimal under 10 of a unit.
 */
export function fmtCompact(value: number | null, locale: string): string {
  const v = finiteOrNull(value);
  if (v === null) return NO_VALUE;
  const abs = Math.abs(v);
  const sign = v < 0 ? MINUS : '';
  if (Math.round(abs) < 1000) return `${sign}${fmtCount(abs, locale)}`;
  const units = isTr(locale) ? [' bin', ' mn', ' mr'] : ['K', 'M', 'bn'];
  let scaled = abs / 1000;
  let u = 0;
  const shown = (x: number) => (x < 10 ? Math.round(x * 10) / 10 : Math.round(x));
  while (u < units.length - 1 && shown(scaled) >= 1000) {
    scaled /= 1000;
    u += 1;
  }
  const x = shown(scaled);
  return `${sign}${digitsOf(x, locale, 0, x < 10 ? 1 : 0)}${units[u]}`;
}

/** A step's drop, already in percent units: TR "%92,4 düşüş", EN "92.4% drop". */
export function fmtDrop(pct: number | null, locale: string): string {
  const v = finiteOrNull(pct);
  if (v === null) return NO_VALUE;
  return isTr(locale) ? `${fmtPercent(v, locale, 1)} düşüş` : `${fmtPercent(v, locale, 1)} drop`;
}

/** A ratio (a multiple): 2 decimals, "0,28x" / "0.28x". */
export function fmtRatio(value: number | null, locale: string): string {
  const v = finiteOrNull(value);
  if (v === null) return NO_VALUE;
  return `${v < 0 ? MINUS : ''}${digitsOf(Math.abs(v), locale, 2, 2)}x`;
}

/** Dollars: TR "$238.947,01", EN "$238,947.01"; `whole` drops the cents (a headline strip). */
export function fmtUsd(value: number | null, locale: string, whole = false): string {
  const v = finiteOrNull(value);
  if (v === null) return NO_VALUE;
  const digits = whole ? 0 : 2;
  const n = new Intl.NumberFormat(numberLocale(locale), {
    style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(Math.abs(v));
  return v < 0 ? `${MINUS}${n}` : n;
}

/**
 * A funnel metric in the explorer's one formatter: pct 1 decimal, x 2 decimals,
 * counts whole (`compact` = the short form), dollars with cents (`compact` = whole
 * dollars), seconds 1 decimal.
 */
export function fmtMetric(value: number | null, format: FunnelMetricFormat, locale: string, compact = false): string {
  const v = finiteOrNull(value);
  if (v === null) return NO_VALUE;
  switch (format) {
    case 'pct': return fmtPercent(v, locale, 1);
    case 'x': return fmtRatio(v, locale);
    case 'usd': return fmtUsd(v, locale, compact);
    case 'count': return compact ? fmtCompact(v, locale) : fmtCount(v, locale);
    case 'seconds': return `${digitsOf(v, locale, 1, 1)} ${isTr(locale) ? 'sn' : 's'}`;
    default: return digitsOf(v, locale, 0, 2);
  }
}

/** A metric's change: rates in points, ratios signed to 2 decimals, the rest signed in their own form. */
export function fmtMetricDelta(delta: number | null, format: FunnelMetricFormat, locale: string, compact = false): string {
  const v = finiteOrNull(delta);
  if (v === null) return NO_VALUE;
  if (format === 'pct') return fmtPoints(v, locale);
  const body = fmtMetric(Math.abs(v), format, locale, compact);
  if (body === fmtMetric(0, format, locale, compact)) return body;
  return `${v > 0 ? '+' : MINUS}${body}`;
}

/**
 * A dollar figure where 0 means "no spend is attributed" (an unattributed path,
 * an organic funnel): an en dash with a title saying so, never "$0,00".
 */
export function spendDisplay(value: number | null, locale: string, t: Translate, compact = false): { text: string; title: string | null } {
  const v = finiteOrNull(value);
  if (v === 0) return { text: NO_VALUE, title: t('lab.explorer.noSpend') };
  return { text: fmtMetric(v, 'usd', locale, compact), title: null };
}

/** A rate as the reader sees it: the formatted rate, or `k/n` when its denominator is small. */
export interface RateDisplay {
  text: string;
  /** Set when the figure is shown as counts: the value `data-lab-kn` carries ("k/n"). */
  kn: string | null;
  /** Why it is counts, for the title (null when it is a rate). */
  title: string | null;
}

/**
 * A rate, or `k/n` when the pair's denominator is under KN_THRESHOLD. With no
 * value and no small pair the text is empty: the caller draws "not measured",
 * never a 0.
 */
export function formatRateOrKn(
  v: number | null,
  format: FunnelMetricFormat,
  kn: Kn | null | undefined,
  locale: string | undefined,
  t: Translate,
): RateDisplay {
  if (kn && isSmallKn(kn)) {
    const text = `${fmtCount(kn.k, locale ?? 'en')}/${fmtCount(kn.n, locale ?? 'en')}`;
    return { text, kn: text, title: fill(t('lab.explorer.knTitle'), { min: KN_THRESHOLD, k: kn.k, n: kn.n }) };
  }
  if (v === null || !Number.isFinite(v)) return { text: '', kn: null, title: null };
  return { text: fmtMetric(v, format, locale ?? 'en'), kn: null, title: null };
}

/** The attributes a figure from `formatRateOrKn` carries (the k/n hook and its explanation). */
export function rateAttrs(d: RateDisplay): Record<string, string | undefined> {
  return { 'data-lab-kn': d.kn ?? undefined, title: d.title ?? undefined };
}

/** The user floor the source applied to a selection's axis combination, when it declared one. */
export function minUsersFor(frame: FunnelFrame, sel: Selection): number | null {
  const dims = Object.keys(sel).sort();
  const hit = (frame.intersections ?? []).find((i) => {
    const own = [...i.dims].sort();
    return own.length === dims.length && own.every((d, n) => d === dims[n]);
  });
  return hit && typeof hit.minUsers === 'number' ? hit.minUsers : null;
}

/**
 * Why a path is missing, in words: the payload's own reason wins (a segment's
 * reason, a funnel's `unmeasured` note); else "never pulled" or "under the
 * floor" from the reason code; else the generic no-path sentence.
 */
export function reasonText(t: Translate, reason: string | null | undefined, code: SliceReasonCode | null | undefined, minUsers: number | null): string {
  if (reason) return reason;
  if (code === 'not-pulled') return t('lab.explorer.reasonNotPulled');
  if (code === 'below-floor' && minUsers !== null) return fill(t('lab.explorer.reasonBelowFloor'), { n: minUsers });
  return t('lab.blocks.breakdown.noPath');
}

/** "To fill it: {hint}" when the snapshot says how to fill `key`, else null. */
export function hintLine(t: Translate, frame: FunnelFrame, key: string): string | null {
  const hint = explorerHint(frame, key);
  return hint ? fill(t('lab.explorer.fill'), { hint }) : null;
}

/**
 * Columns for a strip of `n` equal cards, at most `maxCols`, never leaving a
 * single card alone on the last row (5 cards in 4 columns would be 4 + 1: it
 * becomes 3 + 2). Always at least 1.
 */
export function balancedColumns(n: number, maxCols: number): number {
  const count = Math.max(0, Math.floor(n));
  let cols = Math.max(1, Math.min(Math.floor(maxCols), count));
  while (cols > 1 && count % cols === 1) cols -= 1;
  return cols;
}

/** A calendar day (`YYYY-MM-DD`) in the reader's language, e.g. "7 Sep 2026" / "7 Eyl 2026". */
export function formatDay(iso: string, locale: string | undefined): string {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(ms)) return iso;
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(ms));
}

/** "3 hours ago" in the reader's language; '' for an unreadable time. */
export function relativeAgo(iso: string, locale: string | undefined, now: number = Date.now()): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const s = Math.round((ms - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(s, 'second');
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}

/** A share 0-100 as text (TR "%12,5", EN "12.5%"). */
export function formatShare(v: number, locale: string | undefined): string {
  return fmtPercent(v, locale ?? 'en', 1);
}
