/**
 * Pattern triggering — how a documented pattern reaches the agent WITHOUT
 * anybody authoring trigger phrases for it.
 *
 * A pattern (`knowledge/patterns/*.md`) is a reusable solution shape the project
 * has decided on. Several of them say, in their own body, that they are
 * MANDATORY ("bu kalıp her plan sunumunda zorunludur"). Nothing read that
 * sentence: patterns were ordinary knowledge docs competing for a top-3 slot in
 * general BM25 recall, so the governing pattern usually never surfaced.
 *
 * The fix could not be "add `triggers:` to every pattern" — that is a
 * per-vault, hand-curated fix that works for exactly the person who does the
 * curating and for nobody else's brain. Every mechanism here derives its
 * triggers from what a pattern ALREADY has (its filename and its name), so a
 * user who has never heard of this feature still gets their patterns fired.
 * `triggers:`/`aliases:` exist as an OPTIONAL override, never a prerequisite.
 *
 * ─── Why this does not reuse `recall.ts`'s tokenizer ───────────────────────
 *
 * Measured on the real corpus, the recall tokenizer cannot connect a Turkish
 * prompt to an ascii filename at all:
 *
 *     "özetle"                       → ["özetl"]     (stemEn's final-e rule
 *                                                     mangles a Turkish verb)
 *     "plan-ozeti-…" (the filename)  → ["ozeti"]
 *     "Plan özeti …" (the title)     → ["özeti"]     (no ascii folding, so the
 *                                                     title and its own slug
 *                                                     tokenize differently)
 *
 * Three different stems for one word — nothing could ever match. Rather than
 * re-tune the globally-shared BM25 tokenizer (whose ranking is pinned to a
 * tuned eval baseline, so a change there risks every other recall path), this
 * module keeps its own IDENTITY folder: ascii-first, aggressively suffix-
 * stripping, and applied to BOTH sides. It is additive — it can surface a
 * pattern that recall missed, and it cannot change any existing recall score.
 *
 * The asymmetry that licenses the aggression: a false positive here costs one
 * extra pattern file being read, while a false negative costs the whole
 * feature (the agent silently ignores a rule the project declared mandatory).
 *
 * ─── Measured operating point ──────────────────────────────────────────────
 *
 * Against the real dreamcontext and Tilki vaults: 14/14 gold queries hit at
 * rank 1 (except a Firestore query, which correctly returns all three Firestore
 * patterns), and 13/15 noise queries stay silent. The two that fire are
 * topically adjacent rather than absurd — "build alıp deploy edelim" surfaces
 * the two build patterns, and "componentin state yapısı" surfaces a pattern
 * about session state files. Tuning them away cost real hits every time it was
 * tried, so they are the accepted price, not an oversight.
 */

import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import fg from 'fast-glob';
import { acquireFileLock, releaseFileLock } from './file-lock.js';
import matter from 'gray-matter';
import { foldAscii } from './fold-ascii.js';

// ─── Folding ────────────────────────────────────────────────────────────────

/**
 * Turkish suffixes in their ASCII-FOLDED form, longest-first.
 *
 * They must be written folded because folding happens BEFORE stripping: a
 * suffix list spelled with diacritics ('ları', 'ında', 'sü') would never match
 * an already-folded token. Vowel-harmony variants collapse into each other once
 * folded (`sı`/`si` both become `si`), which is why this list is shorter than
 * the diacritic one in recall.ts without covering less.
 *
 * Deliberately ABSENT: bare `in`/`un`. They are genuine English word endings
 * (design → des) and the genitive is already covered by `nin`/`nun`.
 */
const TR_SUFFIXES = [
  'lerinden', 'larindan', 'lerinde', 'larinda', 'lerine', 'larina',
  'sinden', 'sindan', 'sinin', 'sunun', 'sinde', 'sunda',
  'leri', 'lari', 'ler', 'lar',
  'daki', 'deki', 'taki', 'teki',
  'inda', 'unda', 'nda', 'nde',
  'den', 'dan', 'ten', 'tan',
  'nin', 'nun', 'nim', 'nun',
  'mek', 'mak', 'miz', 'niz',
  'siz', 'suz', 'lik', 'luk',
  'yla', 'yle', 'yi', 'yu',
  'ni', 'nu', 'si', 'su',
  'le', 'la', 'de', 'da', 'te', 'ta',
  'ci', 'cu', 'li', 'lu',
].sort((a, b) => b.length - a.length);

/**
 * Bare single-vowel endings, gated separately at a longer minimum.
 *
 * They are the most productive Turkish endings (`özeti` → `özet`) and the most
 * destructive over-strippers: at the normal gate they turned `state` into
 * `stat` and, via the English plural rule, `status` into `stat` as well — one
 * key for two unrelated words, which fired a pattern about session state on
 * "git status". Requiring six characters keeps the useful strips (`firestore`,
 * `release`, `feature`) and refuses the damaging short ones; the prefix
 * tolerance in `keysAlign` covers what is left (`ozet` still reaches `ozeti`).
 */
const TR_VOWEL_SUFFIXES = ['i', 'u', 'e', 'a'];
const VOWEL_STRIP_MIN_LENGTH = 6;

/**
 * Minimum length of what survives a strip.
 *
 * 4 rather than 3 because Turkish and English both have a large family of
 * 4-letter roots whose last letter looks like a suffix (`veri`, `test`, `data`);
 * requiring the base to stay >= 4 keeps `ozeti` → `ozet` while refusing
 * `title` → `tit`. The token itself must also be longer than 4, so a root that
 * is already short is never touched.
 */
const MIN_BASE = 4;

function stripTrOnce(token: string): string {
  if (token.length <= MIN_BASE) return token;
  for (const suf of TR_SUFFIXES) {
    if (token.endsWith(suf) && token.length - suf.length >= MIN_BASE) {
      return token.slice(0, -suf.length);
    }
  }
  if (token.length >= VOWEL_STRIP_MIN_LENGTH) {
    for (const suf of TR_VOWEL_SUFFIXES) {
      if (token.endsWith(suf)) return token.slice(0, -1);
    }
  }
  return token;
}

function stripEn(token: string): string {
  if (token.length <= MIN_BASE) return token;
  if (token.endsWith('ing') && token.length - 3 >= MIN_BASE) return token.slice(0, -3);
  if (token.endsWith('ies') && token.length - 3 >= MIN_BASE) return `${token.slice(0, -3)}y`;
  if (token.endsWith('ed') && token.length - 2 >= MIN_BASE) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss') && token.length - 1 >= MIN_BASE) {
    return token.slice(0, -1);
  }
  return token;
}

/**
 * Fold one raw word to its identity key.
 *
 * Order matters: ascii-fold first (so both sides of a comparison live in the
 * same alphabet), then English inflection, then up to two Turkish suffix hops
 * (Turkish is agglutinative — `rapor-lar-indan` needs two).
 */
export function foldKey(word: string): string {
  let t = foldAscii(word).replace(/[^a-z0-9]/g, '');
  if (!t) return '';
  t = stripEn(t);
  const once = stripTrOnce(t);
  return once === t ? t : stripTrOnce(once);
}

/**
 * Words that carry no identifying signal for a PATTERN.
 *
 * These are the words patterns are named WITH, not named BY: almost every
 * pattern's slug contains "pattern" or "rules", so matching on them would fire
 * every pattern in the vault whenever the user says the word "pattern" — the
 * exact noise that would make the whole gate ignorable. Stored already folded.
 */
const IGNORED_KEYS = new Set([
  // the category itself, EN + TR
  'pattern', 'kalip', 'rule', 'kural', 'guide', 'guidelin', 'convention',
  'practic', 'best', 'standard', 'checklist', 'playbook', 'recip',
  // structural filler that survives folding
  'nasil', 'neden', 'niye', 'nedir', 'hangi', 'icin', 'gibi', 'daha', 'kadar',
  'olan', 'eden', 'yapan', 'onc', 'sonr', 'zaman', 'seyi', 'anlatilir',
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'when', 'what', 'why',
  'how', 'not', 'must', 'should', 'every', 'each', 'over', 'into', 'per',
  'use', 'using', 'used', 'make', 'made', 'doe', 'don', 'via', 'onto',
]);

/** Fold a free-text string into its set of identity keys. */
export function foldKeys(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    const k = foldKey(raw);
    if (k.length >= 3 && !IGNORED_KEYS.has(k)) out.add(k);
  }
  return out;
}

// ─── Loading ────────────────────────────────────────────────────────────────

export interface PatternDoc {
  /** File basename without extension — stable identity across renames of prose. */
  slug: string;
  /** Absolute path on disk. */
  file: string;
  /** Path relative to the context root, e.g. `knowledge/patterns/foo.md`. */
  relPath: string;
  /** Human display name — DERIVED, never written back to the file. */
  name: string;
  /** One-line summary, trimmed to a single sentence. */
  description: string;
  /** The `/` command name this pattern is exposed under. */
  slashName: string;
  /** Identity keys, folded. Derived automatically; `triggers:` only adds to it. */
  keys: Set<string>;
  /**
   * Corroborating keys from the description and section headings. These can
   * never fire the gate on their own strength the way an identity key can —
   * they only supply the second piece of evidence when the identity match is
   * ambiguous. This is what bridges a Turkish question to an English-named
   * pattern whose description happens to be written in Turkish.
   */
  context: Set<string>;
  /**
   * Keys occurring anywhere in the pattern's PROSE. Never used to match — only
   * to measure how ordinary a word is in this vault's own vocabulary, which is
   * what stops a common term from firing a gate on its own. See `isOrdinary`.
   */
  bodyKeys: Set<string>;
  /** True when the author supplied `triggers:`/`aliases:` — reporting only. */
  authored: boolean;
}

/**
 * Turn whatever the frontmatter happens to hold into a clean display name.
 *
 * Real vaults hold every variant: a clean slug, a 90-character sentence with a
 * parenthetical, a `title:` instead of a `name:`, and (from a frontmatter that
 * was written with a broken block scalar) the literal string `>-`. Deriving the
 * name at READ time rather than rewriting the files means every user gets clean
 * names immediately, including for patterns written before this existed, and no
 * pattern file is edited to get them.
 *
 * Preference order is frontmatter prose, then the document's H1, then the slug.
 * The H1 sits ABOVE a slug-shaped frontmatter name on purpose: a `name:` that
 * merely repeats the filename carries no more information than the filename,
 * while the H1 is where a human actually wrote the title — including the
 * diacritics an ascii filename had to drop.
 */
export function displayName(
  data: Record<string, unknown>,
  slug: string,
  content = '',
): string {
  const junk = new Set(['>-', '|-', '>', '|', '']);
  const isSlugShaped = (v: string) => /^[a-z0-9]+([-_/][a-z0-9]+)+$/.test(v);

  const fmRaw = [data.name, data.title]
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim().replace(/^["']|["']$/g, ''))
    .find((v) => !junk.has(v));

  // The document's own H1 is the one place a human already wrote a proper
  // title, diacritics and all. It outranks a frontmatter `name` that is just
  // the filename again ("plan-ozeti-mehmete-nasil-anlatilir"), which is what
  // most vaults hold and what would otherwise reach the menu as ascii mush.
  const h1 = (content.match(/^#\s+(.+?)\s*$/m)?.[1] ?? '').trim();

  let name = '';
  if (fmRaw && !isSlugShaped(fmRaw)) name = fmRaw;
  else if (h1) name = h1;
  else name = (fmRaw || slug).replace(/[-_/]+/g, ' ');

  // A parenthetical tail is an explanation, not a name — it belongs in the
  // description, and it is what makes these unusable as a menu label.
  name = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  // A leading "Pattern — " / "Pattern:" prefix repeats the category.
  name = name.replace(/^patterns?\s*[:\u2014-]\s*/i, '').trim();
  if (name.length > 60) {
    const cut = name.slice(0, 60);
    const sp = cut.lastIndexOf(' ');
    name = (sp > 24 ? cut.slice(0, sp) : cut).trim();
  }
  if (!name) name = slug.replace(/[-_/]+/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** First sentence of the description, collapsed to one line. */
function oneLine(desc: unknown, limit = 160): string {
  if (typeof desc !== 'string') return '';
  const flat = desc.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const stop = flat.search(/(?<=[.!?])\s/);
  const first = stop > 30 ? flat.slice(0, stop) : flat;
  return first.length > limit ? `${first.slice(0, limit - 1).trimEnd()}…` : first;
}

function asStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

/**
 * Build the `/` command name.
 *
 * Prefixed `pattern-` so that typing `/pattern` browses ALL of them (the "which
 * patterns do we have" affordance, in the menu instead of in a skill), while
 * the composer's substring matching still finds one by any word inside its
 * name — `/ozet` reaches `pattern-plan-ozeti-mehmete`. Trailing category words
 * are dropped because `pattern-…-pattern` is noise in a menu.
 */
export function slashNameFor(slug: string): string {
  const parts = slug.split(/[^a-z0-9]+/i).map((p) => foldAscii(p)).filter(Boolean);
  while (parts.length > 1 && ['pattern', 'patterns', 'rules', 'rule'].includes(parts[parts.length - 1])) {
    parts.pop();
  }
  const kept: string[] = [];
  for (const p of parts) {
    // Cap the name so the menu stays readable; always keep at least two words
    // so it is still recognisable.
    if (kept.length >= 2 && [...kept, p].join('-').length > 28) break;
    kept.push(p);
  }
  return `pattern-${kept.join('-')}`;
}

export function patternsDir(contextRoot: string): string {
  return join(contextRoot, 'knowledge', 'patterns');
}

/**
 * Largest pattern file this module will read.
 *
 * The hook reads every pattern on every prompt, so an oversized file is not
 * merely wasteful — it is paid again on each turn, inside a hook the harness
 * will eventually time out. Patterns are prose held to a ~150-line discipline;
 * a quarter of a megabyte is far past anything legitimate, so refusing to read
 * beyond it costs nothing real and bounds the hot path.
 */
export const MAX_PATTERN_FILE_BYTES = 256 * 1024;

/**
 * Is this glob match a file we are willing to open?
 *
 * A pattern is supposed to be a markdown file the project wrote. `fast-glob`
 * matches a SYMLINK by its own name, and `readFileSync` then returns whatever
 * it points at — so `knowledge/patterns/x.md -> ../../lab/credentials.json`
 * makes the hook print that credentials file straight into the agent's
 * context. This was reproduced end-to-end before the guard existed: a fake
 * vault with such a link leaked `{"apiKey":"…"}` into a live prompt.
 *
 * That matters because the vault is not always authored by the person running
 * the agent — dreamcontext syncs a shared brain repo across a team, and a
 * pattern file gets far less scrutiny in review than code does. So a link
 * committed by anyone with vault write access would exfiltrate a local secret
 * from every teammate's machine.
 *
 * `lstatSync` rejects the link itself; the `realpathSync` containment check
 * additionally catches a link ABOVE the file (a symlinked subdirectory), which
 * `lstat` on the leaf would miss. Size is checked here too so a single guard
 * governs everything that opens a pattern.
 */
export function isReadablePatternFile(file: string, dir: string): boolean {
  try {
    const link = lstatSync(file);
    if (link.isSymbolicLink() || !link.isFile()) return false;
    if (link.size > MAX_PATTERN_FILE_BYTES) return false;
    const real = realpathSync(file);
    const realDir = realpathSync(dir);
    return real === realDir || real.startsWith(realDir + sep);
  } catch {
    // Unreadable or vanished between glob and stat — not ours to open.
    return false;
  }
}

/**
 * Load every pattern in the vault, with its triggers already derived.
 *
 * Excalidraw boards that live in a pattern subfolder are skipped: they are
 * illustrations of a pattern, not the pattern document.
 */
export function loadPatterns(contextRoot: string): PatternDoc[] {
  return loadPatternsReporting(contextRoot).patterns;
}

export interface PatternLoadResult {
  patterns: PatternDoc[];
  /**
   * Files that exist under `knowledge/patterns/` but could not become patterns:
   * unparseable frontmatter, a symlink, an oversized file, an unreadable one.
   *
   * These used to be swallowed in silence, which reintroduced — one layer down
   * — the exact bug this whole feature exists to fix: a pattern the project
   * believes is governing behaviour while nothing actually reads it. A YAML
   * typo was enough, and no command, log, or listing would have said so.
   */
  skipped: Array<{ file: string; reason: string }>;
}

/** {@link loadPatterns}, plus the files it had to refuse and why. */
export function loadPatternsReporting(contextRoot: string): PatternLoadResult {
  const dir = patternsDir(contextRoot);
  const skipped: PatternLoadResult['skipped'] = [];
  if (!existsSync(dir)) return { patterns: [], skipped };
  const files = fg.sync('**/*.md', { cwd: dir, absolute: true, ignore: ['**/*.excalidraw.md'] });
  const out: PatternDoc[] = [];

  for (const file of files.sort()) {
    if (!isReadablePatternFile(file, dir)) {
      skipped.push({ file: relative(contextRoot, file), reason: 'not a readable regular file inside knowledge/patterns (symlink, oversized, or unreadable)' });
      continue;
    }
    try {
      const { data, content } = matter(readFileSync(file, 'utf-8'));
      const fm = data as Record<string, unknown>;
      const slug = basename(file, '.md');
      const name = displayName(fm, slug, content);
      const authoredTriggers = [...asStringList(fm.triggers), ...asStringList(fm.aliases)];

      // The automatic part: a pattern's own filename and name ARE its triggers.
      // Description is deliberately excluded — it is prose, and folding it in
      // drags in every incidental noun, which is what turns a precise gate into
      // an ignorable one.
      const keys = new Set<string>([
        ...foldKeys(slug.replace(/[-_/]+/g, ' ')),
        ...foldKeys(name),
        ...authoredTriggers.flatMap((t) => [...foldKeys(t)]),
      ]);

      // Headings name the moves a pattern covers; the description says what it
      // is for. Both are prose, so they corroborate rather than identify.
      const headings = (content.match(/^#{2,3} .+$/gm) ?? []).join(' ');
      const context = new Set<string>([
        ...foldKeys(String(fm.description ?? fm.summary ?? '')),
        ...foldKeys(headings),
      ]);
      for (const k of keys) context.delete(k);

      out.push({
        slug,
        file,
        relPath: relative(contextRoot, file).replace(/\\/g, '/'),
        name,
        description: oneLine(fm.description ?? fm.summary),
        slashName: slashNameFor(slug),
        keys,
        context,
        bodyKeys: foldKeys(content),
        authored: authoredTriggers.length > 0,
      });
    } catch (err) {
      // Must never break the prompt hook — but must never be silent either.
      skipped.push({ file: relative(contextRoot, file), reason: (err as Error).message ?? 'unreadable' });
    }
  }
  return { patterns: disambiguateSlashNames(out), skipped };
}

/**
 * Give every pattern a `/` name that is unique AND stable.
 *
 * `slashNameFor` truncates, so two long slugs can collide. Resolving that with
 * a counter over the iteration order was wrong in a way that only shows up
 * later: the suffix depended on alphabetical position, so adding an unrelated
 * pattern that sorted earlier could silently hand `/pattern-foo-bar` to a
 * DIFFERENT file — and because the shim sync runs automatically, the swap would
 * be written to disk with nothing said. A user with muscle memory for a command
 * would then get someone else's "decided way of doing things" injected.
 *
 * The suffix is therefore derived from the full slug, which does not move when
 * its neighbours change.
 */
function disambiguateSlashNames(docs: PatternDoc[]): PatternDoc[] {
  const counts = new Map<string, number>();
  for (const d of docs) counts.set(d.slashName, (counts.get(d.slashName) ?? 0) + 1);
  return docs.map((d) => {
    if ((counts.get(d.slashName) ?? 0) < 2) return d;
    const suffix = createHash('sha256').update(d.slug).digest('hex').slice(0, 6);
    return { ...d, slashName: `${d.slashName}-${suffix}` };
  });
}

// ─── Matching ───────────────────────────────────────────────────────────────

export interface PatternMatch {
  pattern: PatternDoc;
  /** Identity keys the prompt and the pattern share. */
  matched: string[];
  /** Corroborating description/heading keys the prompt also hit. */
  corroborating: string[];
  /** Matched keys that identify exactly ONE pattern in this vault. */
  distinctive: string[];
  score: number;
}

/**
 * Keys that occur in only one pattern are that pattern's identity.
 *
 * This is what lets a single word fire a gate without a hand-written trigger
 * list: "özetle" folds to `ozet`, and `ozet` belongs to exactly one pattern in
 * the vault, so it is unambiguous evidence — whereas a key shared by six
 * patterns ("test", "cache") is a topic and needs corroboration.
 */
/**
 * Do two folded keys refer to the same word?
 *
 * Suffix stripping is a heuristic and it lands one letter apart more often than
 * it lands exactly: measured on the real vaults, `mobile` folds to `mobi` while
 * the Turkish `mobil` the user actually types stays `mobil`, and nothing would
 * ever match. Accepting a prefix relationship absorbs that class of error,
 * bounded to a ONE-character gap: that is the size of a stemmer slip, while two
 * characters is enough to reach a genuinely different word — `build` would
 * otherwise pull in a pattern about a `builder`, which it did.
 */
export function keysAlign(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.length - short.length <= 1 && long.startsWith(short);
}

/** The keys of `haystack` that the prompt hit, prefix tolerance included. */
function alignedHits(haystack: Set<string>, promptKeys: Set<string>): string[] {
  const out: string[] = [];
  for (const k of haystack) {
    for (const q of promptKeys) {
      if (keysAlign(k, q)) { out.push(k); break; }
    }
  }
  return out;
}

function keyFrequency(patterns: PatternDoc[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const p of patterns) for (const k of p.keys) df.set(k, (df.get(k) ?? 0) + 1);
  return df;
}

/**
 * Is one shared identity key, on its own, enough to name this pattern?
 *
 * A key belonging to exactly one pattern is that pattern's name, so 4
 * characters of it suffice ("özetle" → `ozet`). A key shared by two patterns is
 * a near-name: still decisive enough to fire when it is long and specific
 * ("firestore" names two Firestore patterns — surfacing both beats surfacing
 * neither), but 5 characters are required so short folded stems, which collide
 * far more often, cannot fire alone. The df-3 rung exists because a term can
 * name a whole family, and 7 characters keeps it to genuinely specific nouns.
 *
 * None of it applies until the prompt is short enough for one word to be what
 * the message is ABOUT — see `evidenceNeeded`.
 */
function firesAlone(key: string, df: number): boolean {
  if (df === 1) return key.length >= 4;
  if (df === 2) return key.length >= 5;
  if (df === 3) return key.length >= 7;
  return false;
}

/**
 * How much evidence a prompt of this size must produce before a pattern fires.
 *
 * This is the rule the first production firing taught. A message of three words
 * that contains "özetle" IS about summarising — one key is the whole message.
 * A 400-word status dump that happens to contain "test" is about none of the
 * patterns whose names contain "test"; the word is a coincidence of length, not
 * a topic. Requiring evidence to scale with the size of the haystack separates
 * the two without needing to know which words are "common", and it does so in
 * any language.
 *
 * Returned value is the number of IDENTITY keys required; 1 means a single
 * decisive key (per `firesAlone`) is enough.
 */
function evidenceNeeded(promptKeyCount: number): number {
  if (promptKeyCount <= 10) return 1;
  if (promptKeyCount <= 30) return 2;
  return 3;
}

/**
 * Ceiling on how many patterns one prompt may pull in.
 *
 * Raised from 3 on the owner's instruction — "ilgili olanların HEPSİ otomatik
 * enjekte edilmeli". A cap of 3 silently dropped a genuinely relevant fourth
 * pattern, which is the same failure as not firing at all. What actually bounds
 * the cost is the character budget in `selectForInjection`, not this number;
 * this is only a backstop against a pathological prompt that names half the
 * vault.
 */
export const MAX_PATTERN_MATCHES = 6;

/**
 * Match a user prompt against the vault's patterns.
 *
 * Evidence required scales with prompt length (`evidenceNeeded`). Within that
 * budget there are two ways to fire, and a prompt that does neither is left
 * alone:
 *   1. ONE identity key specific enough to name this pattern (see `firesAlone`).
 *   2. TWO pieces of evidence in total, at least one of them an identity key —
 *      so description prose alone can never drag a pattern in.
 */
export function matchPatterns(prompt: string, patterns: PatternDoc[]): PatternMatch[] {
  if (patterns.length === 0) return [];
  const promptKeys = foldKeys(prompt);
  if (promptKeys.size === 0) return [];
  const df = keyFrequency(patterns);
  const needed = evidenceNeeded(promptKeys.size);
  const matches: PatternMatch[] = [];

  for (const pattern of patterns) {
    const matched = alignedHits(pattern.keys, promptKeys);
    const corroborating = alignedHits(pattern.context, promptKeys);
    if (matched.length === 0 && corroborating.length === 0) continue;

    // At least one IDENTITY key is always required. A pattern whose name shares
    // nothing with the question can still be reached by ordinary BM25 recall;
    // what it must not do is fire this gate, because this gate says MUST READ.
    // Firing it on description prose alone was tried and measured: it bought one
    // extra hit and cost a false positive ("öğretmen kaydı nasıl siliniyor"
    // pulling in the lesson-conflict pattern, whose description mentions
    // teachers), and document frequency could not separate the two — in a
    // 27-pattern vault every description key is df-1. A directive that fires
    // wrongly is one the agent learns to ignore, which is the failure this
    // whole feature exists to fix, so the trade is refused.
    if (matched.length === 0) continue;
    if (matched.length < needed) continue;
    const decisive = matched.filter((k) => firesAlone(k, df.get(k) ?? 1));
    if (needed === 1 && decisive.length === 0 && matched.length + corroborating.length < 2) continue;

    matches.push({
      pattern,
      matched: matched.sort(),
      corroborating: corroborating.sort(),
      distinctive: decisive.sort(),
      // Identity evidence outweighs prose evidence; both beat neither.
      score: decisive.length * 3 + matched.length * 2 + corroborating.length,
    });
  }

  return matches
    .sort((a, b) => b.score - a.score || a.pattern.slug.localeCompare(b.pattern.slug))
    .slice(0, MAX_PATTERN_MATCHES);
}

// ─── `/` menu shims ─────────────────────────────────────────────────────────

/**
 * Patterns are knowledge files, so they never appeared in the agent's `/` menu:
 * that menu lists `.claude/commands/` and `.claude/skills/` and nothing else.
 * A generated command per pattern closes that gap.
 *
 * Commands rather than skills, deliberately. A skill's description is loaded
 * into EVERY session's catalogue, so exposing a 40-pattern vault as skills would
 * put 40 descriptions in front of the model on every turn, for a project whose
 * own soul caps a core file at 4,000 characters. A command costs nothing until
 * it is invoked. The automatic half of this feature does not depend on the menu
 * anyway — the prompt hook fires patterns deterministically, which is both
 * cheaper and more reliable than hoping a model picks the right skill.
 */
const SHIM_MARKER = '<!-- dreamcontext:pattern-shim -->';

export function commandsDir(projectRoot: string): string {
  return join(projectRoot, '.claude', 'commands');
}

function shimBody(p: PatternDoc): string {
  const desc = p.description ? `${p.name} — ${p.description}` : p.name;
  return `---
description: ${JSON.stringify(desc.length > 180 ? `${desc.slice(0, 179)}…` : desc)}
---
${SHIM_MARKER}

Read \`_dream_context/${p.relPath}\` IN FULL, then apply it to the work at hand.

This is a project pattern: a decided way of doing something here. Follow it
rather than re-deriving an approach. If the pattern is wrong for this case, say
which part and why before departing from it.

$ARGUMENTS
`;
}

export interface ShimSyncResult {
  written: string[];
  removed: string[];
}

/**
 * Regenerate the `/` shims so the menu matches the vault.
 *
 * Only files carrying this module's marker are ever removed, so a command the
 * user hand-wrote that happens to start with `pattern-` is left alone. Writes
 * are skipped when the content is already identical, which keeps this cheap
 * enough to run on every setup, update, and sleep without touching mtimes.
 */
export function syncPatternShims(projectRoot: string, contextRoot: string): ShimSyncResult {
  const patterns = loadPatterns(contextRoot);
  const dir = commandsDir(projectRoot);
  const written: string[] = [];
  const removed: string[] = [];

  const wanted = new Map(patterns.map((p) => [`${p.slashName}.md`, shimBody(p)]));

  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md') || wanted.has(name)) continue;
      const full = join(dir, name);
      try {
        if (readFileSync(full, 'utf-8').includes(SHIM_MARKER)) {
          rmSync(full);
          removed.push(name);
        }
      } catch {
        // A shim we cannot read is a shim we must not delete.
      }
    }
  }

  if (wanted.size === 0) return { written, removed };
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of wanted) {
    const full = join(dir, name);
    try {
      if (existsSync(full) && readFileSync(full, 'utf-8') === body) continue;
    } catch {
      // Unreadable — fall through and rewrite it.
    }
    writeFileSync(full, body, 'utf-8');
    written.push(name);
  }
  return { written, removed };
}


// ─── Injection ──────────────────────────────────────────────────────────────

/**
 * How many characters of pattern prose one prompt may carry.
 *
 * Patterns are only injected when they actually matched, which on the measured
 * traffic is a minority of prompts — so this budget is not paid per turn, it is
 * paid per RELEVANT turn. At the vault's median pattern size (~5.5k chars) it
 * admits two patterns whole plus pointers to the rest.
 *
 * Override with DREAMCONTEXT_PATTERN_BUDGET (0 disables injection and falls back
 * to pointers, which is the pre-injection behaviour).
 */
export const DEFAULT_INJECTION_BUDGET = 12000;

/** A shim sync that has not finished in this long left a dead lock behind. */
const SHIM_LOCK_STALE_MS = 30_000;

export function injectionBudget(): number {
  const raw = process.env.DREAMCONTEXT_PATTERN_BUDGET;
  if (raw === undefined) return DEFAULT_INJECTION_BUDGET;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_INJECTION_BUDGET;
}

export interface InjectionPlan {
  /** Patterns whose full prose goes into the prompt. */
  inline: Array<{ match: PatternMatch; body: string }>;
  /** Matched patterns that did not fit — named, for the agent to read. */
  pointers: PatternMatch[];
}

/**
 * Decide which matched patterns get injected whole and which stay pointers.
 *
 * The top match is ALWAYS injected in full, even when it alone overruns the
 * budget: a pattern is an argued position, and half of one is worse than a
 * pointer to all of it — but the single most relevant one is precisely what the
 * user asked to stop having to fetch by hand. Everything after it is admitted
 * only while the running total stays inside the budget, so a long tail degrades
 * to pointers instead of flooding the turn.
 */
/**
 * Absolute ceiling for the top match, which is otherwise exempt from the
 * budget. "Exempt" was written to mean "a whole pattern always gets in", but as
 * code it meant "no limit at all": one oversized file would flood every
 * matching turn forever. A multiple of the budget keeps the intent (a normal
 * pattern is never truncated — the vault's largest is ~15k) while capping the
 * pathological case.
 */
export const FIRST_MATCH_CEILING_FACTOR = 3;

export function selectForInjection(
  matches: PatternMatch[],
  budget = injectionBudget(),
): InjectionPlan {
  const inline: InjectionPlan['inline'] = [];
  const pointers: PatternMatch[] = [];
  let used = 0;

  for (const [i, match] of matches.entries()) {
    let body: string;
    try {
      body = readFileSync(match.pattern.file, 'utf-8');
    } catch {
      pointers.push(match);
      continue;
    }
    // Strip frontmatter — the agent needs the argument, not the bookkeeping.
    body = body.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    if (!body) { pointers.push(match); continue; }

    const first = i === 0 && budget > 0;
    if (!first && used + body.length > budget) { pointers.push(match); continue; }
    if (first) {
      const ceiling = budget * FIRST_MATCH_CEILING_FACTOR;
      if (body.length > ceiling) {
        // Truncation is a last resort, so it says so rather than pretending the
        // pattern ended — a silently halved argument is how a rule gets
        // misapplied.
        body = `${body.slice(0, ceiling)}\n\n[… truncated — read ${match.pattern.relPath} in full before relying on this pattern]`;
      }
    }
    inline.push({ match, body });
    used += body.length;
  }

  return { inline, pointers };
}

/**
 * A stable fingerprint of the vault's pattern set.
 *
 * Used to regenerate the `/` entries only when they are actually out of date.
 * Filename plus mtime is enough: a renamed, added, or deleted pattern changes
 * the set, and an edited one changes its own mtime (which matters because the
 * shim carries the pattern's name and description).
 */
export function patternsFingerprint(contextRoot: string, projectRoot?: string): string {
  const dir = patternsDir(contextRoot);
  const parts: string[] = [];
  if (existsSync(dir)) {
    const files = fg.sync('**/*.md', { cwd: dir, absolute: true, ignore: ['**/*.excalidraw.md'] }).sort();
    for (const f of files) {
      try { parts.push(`${basename(f)}:${Math.round(statSync(f).mtimeMs)}`); } catch { /* skipped */ }
    }
  }
  // The OUTPUT side belongs in the fingerprint too. Hashing only the pattern
  // sources meant that deleting a shim by hand — or a `git clean`, or restoring
  // a checkout without `.claude/` — left the cache saying "in sync" while the
  // menu stayed broken, with no self-healing path and nothing to tell the user.
  // Since the whole promise of this cache is "you never run a command", the
  // cache has to notice when its own output went missing.
  if (projectRoot) {
    const cmds = commandsDir(projectRoot);
    if (existsSync(cmds)) {
      try {
        parts.push(`|shims:${readdirSync(cmds).filter((n) => n.startsWith('pattern-') && n.endsWith('.md')).sort().join(',')}`);
      } catch { /* unreadable — treated as absent, which forces a re-sync */ }
    } else {
      parts.push('|shims:none');
    }
  }
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

/**
 * Regenerate the `/` entries IF the pattern set changed since last time.
 *
 * This is what makes the feature per-project and self-maintaining: the owner
 * asked whether they would have to re-run a command in every project, and the
 * answer has to be no. The fingerprint is cached next to the other machine-local
 * state, so the common case is one `stat` per pattern and no writes at all.
 */
export function syncPatternShimsIfStale(projectRoot: string, contextRoot: string): ShimSyncResult | null {
  const cachePath = join(contextRoot, 'state', '.patterns-shims.json');
  const fingerprint = patternsFingerprint(contextRoot, projectRoot);
  try {
    const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as { fingerprint?: string };
    if (cached.fingerprint === fingerprint) return null;
  } catch {
    // No cache, or an unreadable one — fall through and sync.
  }

  // Two Claude sessions in one checkout both hit SessionStart, and this is a
  // read-compare-write over shared files. `knowledge/patterns/
  // pid-lockfile-concurrent-json.md` is this project's decided answer to that
  // exact shape and records having been needed three times already; the first
  // version of this function ignored it, which a review caught. Losing the race
  // is harmless here (the loser simply re-syncs next session), so a failed
  // acquire returns rather than spins.
  const lockPath = `${cachePath}.lock`;
  if (!acquireFileLock(lockPath, Date.now(), SHIM_LOCK_STALE_MS)) return null;
  try {
    // Re-read INSIDE the lock: the holder we queued behind may have just done
    // the work, and redoing it would rewrite files for nothing.
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as { fingerprint?: string };
      if (cached.fingerprint === fingerprint) return null;
    } catch { /* still no usable cache */ }

    const result = syncPatternShims(projectRoot, contextRoot);
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      // Recomputed AFTER the sync, not reused from above: the fingerprint now
      // covers the generated shims too, so the pre-sync value describes a state
      // that no longer exists and every later session would re-sync once for
      // nothing. (Caught by the M6 regression test, which is the point of it.)
      const settled = patternsFingerprint(contextRoot, projectRoot);
      // Write-then-rename so a concurrent reader never sees a half-written file.
      const tmp = `${cachePath}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ fingerprint: settled }, null, 2)}\n`, 'utf-8');
      renameSync(tmp, cachePath);
    } catch {
      // A vault we cannot write to still got its shims; it re-checks next time.
    }
    return result;
  } finally {
    releaseFileLock(lockPath);
  }
}
