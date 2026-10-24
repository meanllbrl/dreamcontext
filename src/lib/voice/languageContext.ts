/**
 * Which language a take is spoken in — read from CONTEXT, never remembered from whisper's guess.
 *
 * ── WHY THE STICKY PIN WAS REMOVED (measured 2026-10-24 on the owner's own takes) ─────────
 * whisper's auto-detection called three short Turkish phone takes `icelandic`, each with a
 * `detected_language_probability` of 0.966-0.986, so its language confidence is worthless as a
 * guard. The old memory then pinned that misdetection for ten minutes, and the next take was
 * decoded as Icelandic too ("Nei þurfum það í skanki" for "ne durumdayız nasıl gidiyor").
 *
 * Now the language comes from things the owner actually did: a pin in Settings, the languages
 * of this conversation's recent CLEAN takes, the "languages I speak" list, the owner's recent
 * clean takes anywhere, and the page's UI language. Only a take judged clean (`garble.ts`)
 * feeds it, so a misdetection can no longer become the next take's language.
 *
 * Every language value from outside — the page, `voice.json`, the CLI, whisper itself — goes
 * through {@link normalizeLanguage} against a FIXED table before it reaches whisper, a path or
 * `say`. Anything not in the table is not a language here.
 */

/** whisper's languages, code → the name whisper itself answers with. Fixed; never extended
 *  from input. */
const WHISPER_LANGUAGES: Readonly<Record<string, string>> = {
  en: 'english', zh: 'chinese', de: 'german', es: 'spanish', ru: 'russian', ko: 'korean',
  fr: 'french', ja: 'japanese', pt: 'portuguese', tr: 'turkish', pl: 'polish', ca: 'catalan',
  nl: 'dutch', ar: 'arabic', sv: 'swedish', it: 'italian', id: 'indonesian', hi: 'hindi',
  fi: 'finnish', vi: 'vietnamese', he: 'hebrew', uk: 'ukrainian', el: 'greek', ms: 'malay',
  cs: 'czech', ro: 'romanian', da: 'danish', hu: 'hungarian', ta: 'tamil', no: 'norwegian',
  th: 'thai', ur: 'urdu', hr: 'croatian', bg: 'bulgarian', lt: 'lithuanian', la: 'latin',
  mi: 'maori', ml: 'malayalam', cy: 'welsh', sk: 'slovak', te: 'telugu', fa: 'persian',
  lv: 'latvian', bn: 'bengali', sr: 'serbian', az: 'azerbaijani', sl: 'slovenian', kn: 'kannada',
  et: 'estonian', mk: 'macedonian', br: 'breton', eu: 'basque', is: 'icelandic', hy: 'armenian',
  ne: 'nepali', mn: 'mongolian', bs: 'bosnian', kk: 'kazakh', sq: 'albanian', sw: 'swahili',
  gl: 'galician', mr: 'marathi', pa: 'punjabi', si: 'sinhala', km: 'khmer', sn: 'shona',
  yo: 'yoruba', so: 'somali', af: 'afrikaans', oc: 'occitan', ka: 'georgian', be: 'belarusian',
  tg: 'tajik', sd: 'sindhi', gu: 'gujarati', am: 'amharic', yi: 'yiddish', lo: 'lao',
  uz: 'uzbek', fo: 'faroese', ht: 'haitian creole', ps: 'pashto', tk: 'turkmen', nn: 'nynorsk',
  mt: 'maltese', sa: 'sanskrit', lb: 'luxembourgish', my: 'myanmar', bo: 'tibetan', tl: 'tagalog',
  mg: 'malagasy', as: 'assamese', tt: 'tatar', haw: 'hawaiian', ln: 'lingala', ha: 'hausa',
  ba: 'bashkir', jw: 'javanese', su: 'sundanese', yue: 'cantonese',
};

const BY_NAME: ReadonlyMap<string, string> = new Map(Object.entries(WHISPER_LANGUAGES).map(([c, n]) => [n, c]));

/**
 * A language code from the fixed table, or null. Accepts a code ("tr"), whisper's name
 * ("turkish") or a locale ("tr-TR", the page's UI language); case and surrounding space are
 * ignored. Everything else — `auto`, `../x`, `tr;x`, a number — is null.
 */
export function normalizeLanguage(x: unknown): string | null {
  if (typeof x !== 'string') return null;
  const v = x.trim().toLowerCase();
  if (!v || v.length > 32) return null;
  if (Object.prototype.hasOwnProperty.call(WHISPER_LANGUAGES, v)) return v;
  const named = BY_NAME.get(v);
  if (named) return named;
  const locale = /^([a-z]{2,3})[-_][a-z0-9]{2,8}$/.exec(v);
  if (locale && Object.prototype.hasOwnProperty.call(WHISPER_LANGUAGES, locale[1])) return locale[1];
  return null;
}

/** whisper's own name for a normalized code. */
export function languageName(code: string): string | null {
  return Object.prototype.hasOwnProperty.call(WHISPER_LANGUAGES, code) ? WHISPER_LANGUAGES[code] : null;
}

/** What a stored take contributes to the context (read from the take store, re-validated). */
export interface ContextTake {
  language: string | null;
  quality: string;
  conv?: string;
  createdAt: number;
  chars?: number;
}

export interface LanguageContext {
  /** The language pass 1 is pinned to, or null for `auto`. */
  primary: string | null;
  /** Every language the context names, strongest first; a detection outside it is suspect. */
  set: string[];
}

/** How far back the owner's takes count, anywhere. */
export const CONTEXT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How many recent clean takes are read. */
const RECENT = 3;

/** The language at least 2 of the last 3 clean takes agree on, or null. */
function agreed(langs: string[]): string | null {
  const last = langs.slice(0, RECENT);
  for (const l of last) if (last.filter((x) => x === l).length >= 2) return l;
  return null;
}

/**
 * The language context for one take. `takes` is newest first; only a CLEAN take with text and a
 * table language counts, and anything older than {@link CONTEXT_WINDOW_MS} is ignored.
 */
export function contextFor(input: {
  conv?: string | null;
  uiLang?: unknown;
  cfg: { sttLanguage?: string; sttLanguages?: string[] };
  takes: ContextTake[];
  now?: number;
}): LanguageContext {
  const now = input.now ?? Date.now();
  const pin = normalizeLanguage(input.cfg.sttLanguage);
  const spoken = (input.cfg.sttLanguages ?? []).map(normalizeLanguage).filter((l): l is string => !!l);
  const ui = normalizeLanguage(input.uiLang);
  const clean = input.takes
    .filter((t) => t.quality === 'clean' && (t.chars ?? 1) > 0 && now - t.createdAt < CONTEXT_WINDOW_MS)
    .map((t) => ({ ...t, language: normalizeLanguage(t.language) }))
    .filter((t): t is ContextTake & { language: string } => !!t.language);
  const convLangs = input.conv ? clean.filter((t) => t.conv === input.conv).map((t) => t.language) : [];
  const globalLangs = clean.map((t) => t.language);

  const set: string[] = [];
  const add = (l: string | null) => { if (l && !set.includes(l)) set.push(l); };
  add(pin);
  convLangs.slice(0, RECENT).forEach(add);
  spoken.forEach(add);
  globalLangs.slice(0, RECENT).forEach(add);
  add(ui);

  const primary = pin
    ?? agreed(convLangs)
    ?? agreed(globalLangs)
    ?? (spoken.length === 1 ? spoken[0] : null);
  return { primary, set };
}
