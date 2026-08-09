/**
 * Human labels for lab tweak keys and enum values — the single place that turns
 * a manifest key into something a person reads. Every surface that renders a
 * tweak (dropdown option, funnel range pill, toast, details rail) goes through
 * here, so a raw `last_7_days` never reaches the UI.
 *
 * The relative-range grammar MIRRORS `src/lib/lab/tweaks.ts#parseRelativeRange`
 * (`last_<n>_<day|week|month|year>[s]`) — a change to the engine's accepted
 * shapes has to be reflected here or those values fall back to Title Case.
 *
 * `lang` is the resolved locale from `I18nContext` (`useI18n().locale`); the
 * strings live here rather than in the translation map because they are
 * parametric (`Last {n} days`), which `t(key)` cannot express.
 */

type Lang = 'en' | 'tr';

const RELATIVE_RANGE_RE = /^last_(\d+)_(day|days|week|weeks|month|months|year|years)$/;

/** Unit nouns per language. Turkish nouns stay singular after a numeral. */
const UNIT_NOUNS: Record<Lang, Record<string, { one: string; many: string }>> = {
  en: {
    day: { one: 'day', many: 'days' },
    week: { one: 'week', many: 'weeks' },
    month: { one: 'month', many: 'months' },
    year: { one: 'year', many: 'years' },
  },
  tr: {
    day: { one: 'gün', many: 'gün' },
    week: { one: 'hafta', many: 'hafta' },
    month: { one: 'ay', many: 'ay' },
    year: { one: 'yıl', many: 'yıl' },
  },
};

/** Well-known tweak keys — everything else falls back to Title Case. */
const KNOWN_KEYS: Record<Lang, Record<string, string>> = {
  en: { range: 'Date range', from: 'From', to: 'To' },
  tr: { range: 'Tarih aralığı', from: 'Başlangıç', to: 'Bitiş' },
};

/** Well-known non-range values (the custom-range pill is one). */
const KNOWN_VALUES: Record<Lang, Record<string, string>> = {
  en: { custom: 'Custom' },
  tr: { custom: 'Özel' },
};

function resolveLang(lang: string | undefined): Lang {
  return typeof lang === 'string' && lang.toLowerCase().startsWith('tr') ? 'tr' : 'en';
}

/** `new_users` → "New Users". Only `_` splits: `-` belongs to the calendar
 *  dates the `from`/`to` tweaks carry, and "2026 01 31" is not a label. Words
 *  with no lowercase letter (acronyms, ISO codes) are left exactly as they are
 *  — they are data, not vocabulary. */
function titleCase(raw: string): string {
  return raw
    .split(/_+/)
    .filter((word) => word.length > 0)
    .map((word) => (/[a-z]/.test(word) ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/**
 * Render one tweak VALUE for a human: relative ranges become "Last 7 days" /
 * "Son 7 gün", everything else is Title Cased.
 */
export function humanizeTweakValue(value: string, lang?: string): string {
  const raw = (value ?? '').trim();
  if (raw === '') return '';
  const l = resolveLang(lang);

  const known = KNOWN_VALUES[l][raw.toLowerCase()];
  if (known) return known;

  const match = RELATIVE_RANGE_RE.exec(raw);
  if (match) {
    const n = Number(match[1]);
    const noun = UNIT_NOUNS[l][match[2].replace(/s$/, '')];
    if (Number.isFinite(n) && n > 0 && noun) {
      // English drops the numeral at 1 ("Last year"); Turkish keeps it ("Son 1 yıl").
      if (l === 'en') return n === 1 ? `Last ${noun.one}` : `Last ${n} ${noun.many}`;
      return `Son ${n} ${noun.many}`;
    }
  }

  return titleCase(raw);
}

/** Render one tweak KEY for a human — the `t.label ?? t.key` fallback. */
export function humanizeTweakKey(key: string, lang?: string): string {
  const raw = (key ?? '').trim();
  if (raw === '') return '';
  return KNOWN_KEYS[resolveLang(lang)][raw.toLowerCase()] ?? titleCase(raw);
}
