/**
 * How a `stat` block writes its figure (`format` option). Pure, so the
 * options can be unit-tested without a DOM.
 *
 *   number   - grouped digits, up to two decimals;
 *   compact  - 1.2K / 3.4M;
 *   percent  - the value is a FRACTION (0.235 -> 23.5%); a metric already in
 *              percent points reads better as `number` with unit `%`;
 *   currency - the unit names the ISO code when it is one (EUR, TRY), else USD.
 */

export const STAT_FORMATS = ['number', 'compact', 'percent', 'currency'] as const;
export type StatFormat = (typeof STAT_FORMATS)[number];

export function toStatFormat(v: unknown): StatFormat {
  return (STAT_FORMATS as readonly unknown[]).includes(v) ? (v as StatFormat) : 'number';
}

/** The ISO currency a `currency` stat uses: the unit when it is a 3-letter code, else USD. */
export function currencyCode(unit: string | null | undefined): string {
  return unit && /^[A-Z]{3}$/.test(unit.trim()) ? unit.trim() : 'USD';
}

export function formatStat(v: number, format: StatFormat, unit: string | null, locale?: string): string {
  switch (format) {
    case 'compact':
      return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(v);
    case 'percent':
      return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(v);
    case 'currency':
      return new Intl.NumberFormat(locale, { style: 'currency', currency: currencyCode(unit), maximumFractionDigits: 2 }).format(v);
    default:
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(v);
  }
}

/** The unit written after the figure: none for percent/currency (the format carries it). */
export function statUnitSuffix(format: StatFormat, unit: string | null): string | null {
  return format === 'percent' || format === 'currency' ? null : unit;
}
