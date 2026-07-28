import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, basename, dirname, relative } from 'node:path';
import fg from 'fast-glob';
import { readFrontmatter } from './frontmatter.js';
import { expandQueryTerms } from './recall-synonyms.js';
import { loadDigestDocs } from './session-digest.js';
import { tagIndexValue } from './taxonomy.js';
import { featuresDir, featureProductFromRelPath } from './features-path.js';
import {
  isExcalidrawPath,
  extractExcalidrawText,
  diagramFolderDirs,
  isDarkDiagramSibling,
} from './excalidraw-text.js';

// 'skill' docs are produced ONLY by loadSkillDocs (called directly by the hook);
// intentionally excluded from buildCorpus defaults to avoid polluting haikuRecall.
export type CorpusType = 'knowledge' | 'feature' | 'task' | 'memory' | 'changelog' | 'skill' | 'objective' | 'insight' | 'thesis' | 'automation';

/**
 * Every corpus type `buildCorpus` can produce, in snapshot/report order. The
 * single source of truth for "which channels does recall span" — the CLI's
 * `--types` parser, the HTTP route's filter, `memory list`/`memory status`, and
 * the dedup allow-list all derive from this instead of re-listing the union
 * (each re-listing was a place a new channel got silently dropped: `objective`,
 * `insight` and `thesis` were live in the engine for weeks while
 * `/api/recall` still filtered them out).
 */
export const CORPUS_TYPES: readonly CorpusType[] = [
  'knowledge', 'feature', 'task', 'memory', 'changelog',
  'objective', 'insight', 'thesis', 'automation',
];

/**
 * Derived importance of a doc, 1–3, mirroring the project's own ★/★★/★★★
 * salience convention:
 *
 *   3 = explicitly marked important (pinned knowledge, ★★/★★★ decisions,
 *       high-priority tasks, high-impact objectives, a settled thesis,
 *       an insight wired to a roadmap KR, a salience-3 bookmark)
 *   2 = normal curated content (the default — most knowledge, features, tasks)
 *   1 = low-signal pointers and logs (changelog entries, automation run outputs,
 *       draft/retired theses, low-priority tasks, disabled automations)
 *
 * A FILTER signal only (`--level`/`?level=`), never a ranking input: the
 * score/rankScore decoupling invariant means nothing derived may touch
 * `hit.score`, and level would be a second, undocumented re-ranker if it fed
 * `rankScore`. Filtering happens on the corpus before scoring — exactly like
 * `--types` — so a level-scoped search is an honest search of a smaller corpus.
 */
export type DocLevel = 1 | 2 | 3;

/** The level assigned when a doc carries no explicit importance marker. */
export const DEFAULT_DOC_LEVEL: DocLevel = 2;

export interface CorpusDoc {
  type: CorpusType;
  path: string;          // absolute path on disk
  relPath: string;       // path relative to context root
  slug: string;          // basename without .md
  title: string;         // human-readable
  description: string;   // frontmatter description (if any)
  tags: string[];        // frontmatter tags (if any)
  body: string;          // raw body text
  tokens: string[];      // tokenized body+title+description+tags
  tokenSet: Set<string>; // for DF lookup
  termFreq: Map<string, number>;
  // ── B1/B2/B3/B5 ranking metadata (all optional so external CorpusDoc
  //    literals stay valid). Defaults keep behaviour identical to pre-uplift. ──
  product?: string;                       // B1: path-derived — knowledge/products/<name>/… or knowledge/features/<product>/…
  fieldFreq?: Map<string, number>;        // B2: BM25F field-weighted term frequency (for rankScore)
  fieldLen?: number;                      // B2: unweighted union token length (dl for BM25F)
  status?: string;                        // B3: frontmatter status (e.g. completed/in_progress)
  updatedAt?: string;                     // B3: ISO-ish date string (updated/updated_at/date)
  links?: string[];                       // B5: slugs referenced via [[slug]] wikilinks
  identityTokens?: string[];              // stemmed slug+title tokens (exact-identity boost)
  // C2/C3 continuous-capture guard: auto-generated session digests + bookmarks
  // are flagged so the CAPTURE_RANK_PENALTY can down-weight them in rankScore
  // ONLY (never the raw `score` the hook gates on). Default/absent = false =
  // curated knowledge, no penalty.
  capture?: boolean;
  // Federation (issue #25): set from frontmatter `federated: true` on docs that
  // were INGESTED from a peer vault's inbox. Such docs are first-class LOCALLY
  // (still surfaced by single-vault recall, OQ3) but are EXCLUDED from BOTH
  // cross-vault recall serving AND digest computation — so a third vault never
  // sees content that merely passed through this one (transitive-leak guard).
  // Default/absent = false = native local doc.
  federated?: boolean;
  // Derived importance 1–3 (see DocLevel). Optional so external CorpusDoc
  // literals stay valid; absent reads as DEFAULT_DOC_LEVEL everywhere.
  level?: DocLevel;
}

/** A doc's importance level, defaulting when the loader set none. */
export function docLevel(doc: CorpusDoc): DocLevel {
  return doc.level ?? DEFAULT_DOC_LEVEL;
}

// ─── Importance level derivation ────────────────────────────────────────────

/**
 * The project's own salience notation, used in `2.memory.md` decisions, bookmark
 * summaries and knowledge bodies: `★★★` critical, `★★` reusable, `★` noted.
 * Read the HIGHEST marker present, so one ★★★ bullet lifts the whole section.
 */
function starLevel(text: string): DocLevel | undefined {
  if (text.includes('★★★')) return 3;
  if (text.includes('★★')) return 3;
  if (text.includes('★')) return 2;
  return undefined;
}

/**
 * Task priority as a level signal — it can only DEMOTE (`low` → 1), never
 * promote. Measured on this project's own brain: 151 of 340 tasks carry
 * `priority: high`, so mapping high → 3 turned `--level 3` into a high-priority
 * task list (151 of 172 level-3 docs) and buried the 12 pinned/starred knowledge
 * docs the filter exists to surface. Priority is scheduling urgency — "do this
 * next" — not durable importance, and the two are not the same axis. A task that
 * IS durably important still reaches level 3 through a ★★/★★★ marker in its body.
 */
function priorityLevel(value: unknown): DocLevel | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim().toLowerCase() === 'low' ? 1 : undefined;
}

/**
 * Importance level for a frontmatter-bearing markdown doc, from the markers the
 * brain ALREADY stores — nothing new to maintain, and no guessing: a doc with no
 * marker stays at the default rather than being invented up or down.
 *
 * Per type, highest-confidence signal first:
 *  - any type      `level: 1|2|3` frontmatter — an explicit override always wins
 *  - knowledge     `pinned: true` → 3 (it loads in full every session by choice)
 *  - task          `priority: low` → 1 (priority NEVER promotes — see priorityLevel)
 *  - objective     `impact: 5` → 3, ≤ 1 → 1 (the PO's own RICE impact score)
 *  - thesis        `status`: validated/invalidated → 3 (settled learning is the
 *                  point of the layer), open → 2, draft/retired → 1
 *  - insight       bound to an objective's KR → 3 (it moves the roadmap)
 *  - automation    enabled → 2, disabled → 1
 *  - feature       no marker → default
 *
 * Level 3 is meant to be RARE — "someone deliberately marked this", not "this
 * type is usually important". Any signal that fires on most docs of its type
 * makes the filter useless, so type-wide promotions are deliberately absent.
 * Then, for every type, a ★ marker in title/description/body can only RAISE the
 * result — a ★★★ note inside an unpinned knowledge file is still a ★★★ note.
 */
function deriveLevel(
  type: CorpusType,
  data: Record<string, unknown>,
  text: string,
): DocLevel {
  const explicit = data.level;
  if (explicit === 1 || explicit === 2 || explicit === 3) return explicit;

  let base: DocLevel | undefined;
  switch (type) {
    case 'knowledge':
      if (data.pinned === true) base = 3;
      break;
    case 'task':
      base = priorityLevel(data.priority);
      break;
    case 'objective': {
      // Top of the PO's 1-5 impact scale only. `>= 4` promoted 4 of this
      // project's 7 objectives — a majority, which is the dilution this scale
      // must avoid.
      const impact = typeof data.impact === 'number' ? data.impact : undefined;
      if (impact !== undefined) base = impact >= 5 ? 3 : impact <= 1 ? 1 : 2;
      break;
    }
    case 'thesis': {
      const status = typeof data.status === 'string' ? data.status.trim().toLowerCase() : '';
      if (status === 'validated' || status === 'invalidated') base = 3;
      else if (status === 'open') base = 2;
      else if (status === 'draft' || status === 'retired') base = 1;
      break;
    }
    case 'insight': {
      const binding = data.binding;
      const bound = !!binding && typeof binding === 'object'
        && typeof (binding as Record<string, unknown>).objective === 'string'
        && ((binding as Record<string, unknown>).objective as string).trim() !== '';
      if (bound) base = 3;
      break;
    }
    case 'automation':
      base = data.enabled === false ? 1 : 2;
      break;
    default:
      break;
  }

  const stars = starLevel(text);
  const resolved = base ?? DEFAULT_DOC_LEVEL;
  // Stars raise, never lower: a disabled automation whose playbook holds a ★★★
  // lesson is still worth surfacing at --level 3.
  return stars !== undefined && stars > resolved ? stars : resolved;
}

/**
 * Shared predicate for the federation serving + digest exclusion. A doc counts
 * as federated iff its frontmatter set `federated: true`. Used by BOTH the
 * cross-vault recall serving path and the digest computation path so the two
 * can never drift (one source of truth for the transitive-leak invariant).
 */
export function isFederated(doc: CorpusDoc): boolean {
  return doc.federated === true;
}

export interface RecallHit {
  doc: CorpusDoc;
  // RAW flat-haystack BM25 score — SAME SCALE as the pre-uplift implementation.
  // The hook gates on this (BM25 fallback `>= 2.0`, skill gate `>= 1.0`); field
  // weighting / recency / synonyms must NEVER touch it. Do not sort by this.
  score: number;
  // DERIVED ranking signal: BM25F (field-weighted) × status × recency, plus
  // synonym + (optional) link contributions. This is what hits are SORTED by.
  // Higher = more relevant. Not threshold-compatible with `score`.
  rankScore: number;
  snippet: string;       // ~3 lines around the best match
}

/** Stable identity for a corpus doc: `type/slug` (e.g. `knowledge/haiku-recall-architecture`). */
export function docKey(doc: CorpusDoc): string { return `${doc.type}/${doc.slug}`; }

// ─── Tokenization ──────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  // English
  'the','a','an','is','are','was','were','be','been','being','to','of','in','on',
  'at','for','with','by','from','as','that','this','it','its','and','or','but',
  'if','then','else','so','not','no','yes','do','does','did','have','has','had',
  'will','would','could','should','can','may','might','must','i','you','he','she',
  'we','they','them','their','our','your','my','me','us','him','her',
  // Turkish (light)
  've','veya','ile','bir','bu','şu','o','ne','ki','de','da','mı','mi','mu','mü',
  'için','gibi','ama','ya','ben','sen','biz','siz','onlar',
  // Turkish question/filler words — carry no content signal but inflect freely,
  // so they survive suffix folding as noise terms in natural TR queries
  // ("güvenlik açıkları NELERDİ", "NASIL hesaplanıyor"). Filtering them keeps
  // TR query vectors as clean as their EN equivalents (where "what/how" are
  // already stopwords).
  'nasıl','neden','niye','nedir','neler','nelerdi','nelerdir','hangi','hangisi',
  'nerede','nereye','nereden','şey','şeyi','eden','olan','olarak','bunu','bunun',
  'şunu','onun','yapan','midir','mıdır',
]);

// ── B4: conservative morphological folding ──────────────────────────────────
// Applied to BOTH index and query (so the base flat-haystack BM25 also benefits
// — this only collapses inflections to a shared stem, it does NOT change the
// MEANING of the hard `.score` thresholds the hook reads; identical text still
// scores identically, we just merge `databases`→`database`-class variants).
//
// Turkish suffix folding (agglutinative): strip up to TWO common case/plural/
// possessive suffixes from long tokens (e.g. `sunucusunda` → `sunucusu` →
// `sunucu`). Kept conservative (len gate > 4, stripped base must stay > 2
// chars, second hop only fires when the first stripped) to protect precision.
// The list is sorted longest-first at module load so `lerinden` wins over `den`.
const TR_SUFFIXES = [
  'lerinden', 'larından', 'lerinde', 'larında', 'lerine', 'larına',
  'leri', 'ları', 'ler', 'lar',
  // locative (+possessive buffer): oturumda / başında / içinde / sunucusunda
  'ında', 'inde', 'unda', 'ünde', 'nda', 'nde', 'de', 'da',
  // ablative: sunucudan / sistemden (+ voiceless variants)
  'den', 'dan', 'ten', 'tan',
  // genitive: projenin / sunucunun
  'nin', 'nın', 'nun', 'nün',
  // 3sg possessive after vowel: sunucusu / kutusu / seviyesi
  'sı', 'si', 'su', 'sü',
  // possessive+locative / +genitive / +accusative compounds: sunucusunda /
  // kutusunun / seviyesini. Listed as compounds because the bare locative
  // ('unda') would otherwise eat into the possessive and strand an orphan 's'.
  'sında', 'sinde', 'sunda', 'sünde',
  'sının', 'sinin', 'sunun', 'sünün',
  'sını', 'sini', 'sunu', 'sünü',
  // accusative after vowel (y buffer): makaleyi / kapıyı. (Bare-n buffer
  // variants 'nı/ni/nu/nü' were tried and removed: they mis-segment
  // consonant-final loanwords — `konsolidasyonu` → `konsolidasyo` — and their
  // only wins are already covered by synonym surface forms.)
  'yi', 'yı', 'yu', 'yü',
  // relative -ki on locative: oturumdaki / eldeki
  'daki', 'deki', 'taki', 'teki',
  // instrumental: hook'la → hookla / sunucuyla
  'yla', 'yle',
].sort((a, b) => b.length - a.length);

// English suffix strip: only the safest plural/verb inflections, len gate > 4.
// v3 fix: the old `-es` rule made e-final words unfindable from their plural
// (`databases`→`databas` vs `database`→`database` NEVER matched; same for
// releases/release, features/feature). Now: strip `-s` first, then fold a
// trailing `-e` on long tokens, so the whole family merges on one stem
// (`databases`→`database`→`databas` ←`database`). Tech vocabulary is dominated
// by e-final nouns, which is why `-e` folding wins over sibilant `-es` plurals
// (only ≤4-char bases like box/boxes lose, and they never matched before either).
function stemEn(token: string): string {
  if (token.length <= 4) return token;
  if (token.endsWith('ing') && token.length > 5) return token.slice(0, -3);
  if (token.endsWith('ed') && token.length > 4) return token.slice(0, -2);
  let t = token;
  if (t.endsWith('s') && !t.endsWith('ss') && t.length > 4) t = t.slice(0, -1);
  if (t.endsWith('e') && t.length > 5) t = t.slice(0, -1);
  return t;
}

function stemTrOnce(token: string): string {
  if (token.length <= 4) return token;
  for (const suf of TR_SUFFIXES) {
    if (token.length - suf.length > 2 && token.endsWith(suf)) {
      return token.slice(0, -suf.length);
    }
  }
  return token;
}

function stemTr(token: string): string {
  // Up to two hops: agglutination stacks plural/possessive/case suffixes
  // (`seviye-ler-i`, `sunucu-su-nda`). The second hop only fires when the first
  // actually stripped, so plain English tokens take at most the one (pre-existing)
  // strip and never get double-mangled.
  const once = stemTrOnce(token);
  if (once === token) return token;
  return stemTrOnce(once);
}

/**
 * Fold a single already-lowercased token to its conservative stem. Exported so
 * the synonym expander can stem its surface terms through the SAME pipeline used
 * for the index/query, keeping them aligned.
 */
export function stemToken(token: string): string {
  const t = stemTr(stemEn(token));
  // If the TR strip exposed a trailing `e`, apply the same final-e fold stemEn
  // applies to uninflected forms — otherwise `seviyeleri` → `seviye` while the
  // doc's `seviye` → `seviy`, splitting the family across index and query.
  if (t !== token && t.endsWith('e') && t.length > 5) return t.slice(0, -1);
  return t;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9çğıöşü_\-\s]/g, ' ')
    .split(/[\s_\-]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stemToken)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// ─── Field weighting (B2: BM25F) ─────────────────────────────────────────────
// Title/tags/description are short, high-signal fields → up-weight them. The
// weighted frequencies feed the DERIVED `rankScore` (sorting), NOT the raw
// `.score` field the hook's hard thresholds read.
export const FIELD_WEIGHTS = { title: 3, tags: 2, description: 2, body: 1 } as const;

export interface DocFields {
  slug?: string;
  title: string;
  description: string;
  tags: string[];
  body: string;
}

export interface BuiltFields {
  tokens: string[];                 // flat union tokens (unweighted) — base BM25 `.score` source
  termFreq: Map<string, number>;    // unweighted tf — base BM25 `.score` source (unchanged scale)
  fieldFreq: Map<string, number>;   // B2: field-weighted tf — feeds rankScore (BM25F numerator)
  fieldLen: number;                 // B2: unweighted union token count — dl for BM25F
  links: string[];                  // B5: [[slug]] references parsed from body
  identityTokens: string[];         // stemmed slug+title tokens — exact-identity boost
}

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

function parseLinks(body: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(body)) !== null) {
    const slug = m[1].trim().split('|')[0].split('#')[0].trim();
    if (slug) out.push(slug);
  }
  return out;
}

/**
 * Shared field-building helper used by ALL corpus loaders (DRY).
 *
 * - `tokens` / `termFreq` are the UNWEIGHTED flat union (title+desc+tags+body),
 *   IDENTICAL in shape/scale to the pre-uplift loaders. These drive the raw
 *   BM25 `.score` the hook thresholds against — that scale must NOT change.
 * - `fieldFreq` is the BM25F field-weighted term frequency: each term's count in
 *   a field is multiplied by FIELD_WEIGHTS[field] and summed. This feeds the
 *   DERIVED `rankScore` only.
 * - `fieldLen` is the unweighted union token length — used as the document
 *   length `dl` for BM25F normalisation (documented choice: union length keeps
 *   short high-weight fields from arbitrarily shrinking the effective dl).
 */
export function buildFields(f: DocFields): BuiltFields {
  const titleToks = tokenize(f.title);
  const descToks = tokenize(f.description);
  // Index tags by value only: strip known-facet prefixes (topic:recall→recall)
  // so high-df prefix tokens ('topic', 'domain') don't pollute BM25 DF counts.
  const tagToks = tokenize(f.tags.map(tagIndexValue).join(' '));
  const bodyToks = tokenize(f.body);

  const tokens = [...titleToks, ...descToks, ...tagToks, ...bodyToks];

  const termFreq = new Map<string, number>();
  for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);

  const fieldFreq = new Map<string, number>();
  const addWeighted = (toks: string[], w: number): void => {
    for (const t of toks) fieldFreq.set(t, (fieldFreq.get(t) ?? 0) + w);
  };
  addWeighted(titleToks, FIELD_WEIGHTS.title);
  addWeighted(descToks, FIELD_WEIGHTS.description);
  addWeighted(tagToks, FIELD_WEIGHTS.tags);
  addWeighted(bodyToks, FIELD_WEIGHTS.body);

  // Identity = stemmed tokens from the slug + title (deduped). The slug carries
  // the canonical hyphenated identity (`context-snapshot`); the title often
  // mirrors it. Used by the field-match identity boost in bm25Search.
  const identityTokens = Array.from(
    new Set([...tokenize(f.slug ?? ''), ...titleToks]),
  );

  return {
    tokens,
    termFreq,
    fieldFreq,
    fieldLen: tokens.length,
    links: parseLinks(f.body),
    identityTokens,
  };
}

/** Normalise a frontmatter date-ish field to a string, or undefined. */
function readUpdatedAt(data: Record<string, unknown>): string | undefined {
  const v = data.updated_at ?? data.updated ?? data.date;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function readStatus(data: Record<string, unknown>): string | undefined {
  const v = data.status;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Extract `<name>` from a path under `knowledge/products/<name>/…` (B1). */
function productFromRelPath(relPath: string): string | undefined {
  const m = relPath.replace(/\\/g, '/').match(/(?:^|\/)knowledge\/products\/([^/]+)\//);
  return m ? m[1] : undefined;
}

// ─── Corpus Loader ─────────────────────────────────────────────────────────

function loadMarkdownDocs(
  dir: string,
  type: CorpusType,
  contextRoot: string,
  ignore?: string[],
): CorpusDoc[] {
  if (!existsSync(dir)) return [];
  // B1: recurse into nested dirs (e.g. knowledge/products/<name>/…).
  // `ignore` (e.g. ['features/**']) excludes typed subtrees that are loaded as
  // their own corpus type, so they are never double-counted (feature vs knowledge).
  const files = fg.sync('**/*.md', { cwd: dir, absolute: true, ignore });
  // Compute dark-sibling set once for the whole directory scan.
  // Dark siblings: non-board .md files inside a diagram folder that should
  // not enter the BM25 corpus (generator scripts, spec notes, etc.).
  const boardDirs = diagramFolderDirs(files);
  const out: CorpusDoc[] = [];
  for (const file of files) {
    try {
      const { data, content } = readFrontmatter(file);
      // Exclude dark siblings — tooling beside a board — UNLESS the .md declares
      // itself as knowledge via `name:` frontmatter (a co-located teardown).
      const isIndexableKnowledge =
        typeof data.name === 'string' && data.name.trim() !== '';
      if (isDarkDiagramSibling(file, boardDirs, isIndexableKnowledge)) continue;

      const slug = basename(file, '.md');
      // `claim` is the thesis identity field (theses/<slug>.md have no name/title) —
      // additive fallback so a thesis indexes under its claim text.
      const title = String(data.name ?? data.title ?? data.claim ?? slug);
      const description = String(data.description ?? data.summary ?? '');
      const tags = Array.isArray(data.tags) ? data.tags.map(String) : [];
      // For Excalidraw boards: extract only Text Elements text for the BM25
      // corpus (body). This covers the BM25 scoring path (buildFields tokenizes
      // body) AND transitively the reflection corpus. The raw scene JSON is
      // never tokenized, so JSON-only terms never score.
      // BOTH this path (BM25 corpus) AND knowledge-index.ts (entry.content)
      // apply extraction — neither alone closes all memory surfaces.
      const body = isExcalidrawPath(file)
        ? extractExcalidrawText(content)
        : content.trim();
      const relPath = file.replace(contextRoot + '/', '');
      const fields = buildFields({ slug, title, description, tags, body });
      out.push({
        type,
        path: file,
        relPath,
        slug,
        title,
        description,
        tags,
        body,
        tokens: fields.tokens,
        tokenSet: new Set(fields.tokens),
        termFreq: fields.termFreq,
        fieldFreq: fields.fieldFreq,
        fieldLen: fields.fieldLen,
        links: fields.links,
        identityTokens: fields.identityTokens,
        status: readStatus(data as Record<string, unknown>),
        updatedAt: readUpdatedAt(data as Record<string, unknown>),
        // Product facet is path-derived (single source of truth): a per-product
        // knowledge file (knowledge/products/<name>/…) or a feature nested under
        // knowledge/features/<product>/… . Never read from frontmatter.
        product: productFromRelPath(relPath) ?? featureProductFromRelPath(relPath),
        // Federation: a doc ingested from a peer carries `federated: true`.
        federated: data.federated === true,
        level: deriveLevel(type, data as Record<string, unknown>, `${title} ${description} ${body}`),
      });
    } catch {
      // skip malformed
    }
  }
  return out;
}

function loadChangelogEntries(contextRoot: string): CorpusDoc[] {
  const path = join(contextRoot, 'core', 'CHANGELOG.json');
  if (!existsSync(path)) return [];
  let entries: Array<Record<string, unknown>> = [];
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) entries = parsed;
  } catch {
    return [];
  }
  const out: CorpusDoc[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const date = String(e.date ?? '');
    const type = String(e.type ?? '');
    const scope = String(e.scope ?? '');
    const description = String(e.description ?? '');
    const summary = typeof e.summary === 'string' ? e.summary : '';
    const refs = Array.isArray(e.references) ? e.references.map(String) : [];
    const authors = Array.isArray(e.authors) ? e.authors.map(String) : [];
    if (!description && !summary) continue;
    const slug = `changelog#${date}-${scope || type}-${i}`;
    const title = `${date} [${type}] ${scope}${summary ? ` — ${summary}` : ''}`.trim();
    // description-field carries summary; tags carry type/scope/authors; refs fold
    // into body. Indexing `authors` as a tag (field-weight 2) makes person
    // attribution searchable — recall surfaces an entry by the person's name.
    const tags = [type, scope, ...authors].filter(Boolean);
    // No slug passed: a changelog's `changelog#…` slug + date-prefixed title are
    // synthetic, not a canonical identity — excluding them keeps the identity
    // boost from spuriously lifting changelogs on field-match queries.
    const fields = buildFields({
      title,
      description: summary,
      tags,
      body: [description, refs.join(' ')].join(' ').trim(),
    });
    out.push({
      type: 'changelog',
      path,
      relPath: 'core/CHANGELOG.json',
      slug,
      title,
      description: summary || description.slice(0, 200),
      tags,
      body: description,
      tokens: fields.tokens,
      tokenSet: new Set(fields.tokens),
      termFreq: fields.termFreq,
      fieldFreq: fields.fieldFreq,
      fieldLen: fields.fieldLen,
      links: fields.links,
      identityTokens: [],
      updatedAt: date || undefined,
      // A changelog entry is a one-line POINTER to work whose canonical doc sits
      // elsewhere (same reasoning as CHANGELOG_RANK_FACTOR) — level 1, unless the
      // entry itself is star-marked.
      level: starLevel(`${summary} ${description}`) ?? 1,
    });
  }
  return out;
}

function loadMemoryFile(contextRoot: string): CorpusDoc[] {
  const path = join(contextRoot, 'core', '2.memory.md');
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  // Split LIFO sections by H2 headings; each becomes its own doc.
  const sections = raw.split(/^##\s+/m).slice(1); // skip preamble
  const out: CorpusDoc[] = [];
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const firstNl = sec.indexOf('\n');
    const heading = (firstNl >= 0 ? sec.slice(0, firstNl) : sec).trim();
    const body = (firstNl >= 0 ? sec.slice(firstNl + 1) : '').trim();
    if (!body) continue;
    const title = heading || `memory entry ${i + 1}`;
    const fields = buildFields({ title, description: '', tags: [], body });
    out.push({
      type: 'memory',
      path,
      relPath: 'core/2.memory.md',
      slug: `memory#${i}`,
      title,
      description: '',
      tags: [],
      body,
      tokens: fields.tokens,
      tokenSet: new Set(fields.tokens),
      termFreq: fields.termFreq,
      fieldFreq: fields.fieldFreq,
      fieldLen: fields.fieldLen,
      links: fields.links,
      identityTokens: fields.identityTokens,
      // `2.memory.md` sections hold the ★/★★/★★★ technical decisions — the
      // highest marker in the section sets its level.
      level: starLevel(`${title} ${body}`) ?? DEFAULT_DOC_LEVEL,
    });
  }
  return out;
}

/**
 * Load `.sleep.json` bookmarks as corpus docs (type `memory`, slug
 * `bookmark#<id>`) so salient moments tagged during a session are recallable
 * BEFORE the next sleep consolidation folds them into knowledge/tasks. Reads the
 * raw JSON directly (no commander dependency) and reuses `buildFields` so the
 * field/termFreq construction matches the other loaders exactly.
 */
export function loadBookmarkDocs(contextRoot: string): CorpusDoc[] {
  const path = join(contextRoot, 'state', '.sleep.json');
  if (!existsSync(path)) return [];
  let bookmarks: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).bookmarks)) {
      bookmarks = (parsed as Record<string, unknown>).bookmarks as Array<Record<string, unknown>>;
    }
  } catch {
    return [];
  }
  const out: CorpusDoc[] = [];
  for (const b of bookmarks) {
    const id = typeof b.id === 'string' ? b.id : '';
    const message = typeof b.message === 'string' ? b.message.trim() : '';
    if (!id || !message) continue;
    const slug = `bookmark#${id}`;
    const title = message.length > 80 ? message.slice(0, 80) : message;
    const tags = typeof b.task_slug === 'string' && b.task_slug ? [b.task_slug] : [];
    const fields = buildFields({ title, description: '', tags, body: message });
    out.push({
      type: 'memory',
      path,
      relPath: 'state/.sleep.json',
      slug,
      title,
      description: '',
      tags,
      body: message,
      tokens: fields.tokens,
      tokenSet: new Set(fields.tokens),
      termFreq: fields.termFreq,
      fieldFreq: fields.fieldFreq,
      fieldLen: fields.fieldLen,
      links: fields.links,
      // Synthetic `bookmark#…` slug is not a canonical identity — exclude from
      // the identity boost (mirrors the changelog loader's choice).
      identityTokens: [],
      updatedAt: typeof b.created_at === 'string' ? b.created_at : undefined,
      // C2/C3: auto/explicit bookmarks are continuous captures → rank-penalised.
      capture: true,
      // A bookmark's `salience` (1 noted / 2 decision / 3 critical) IS the level
      // signal this scale was modelled on — read it straight through.
      level: b.salience === 1 || b.salience === 2 || b.salience === 3
        ? b.salience
        : starLevel(message) ?? DEFAULT_DOC_LEVEL,
    });
  }
  return out;
}

/**
 * Only the N most-recent automation run outputs are indexed per corpus build.
 * Mirrors MAX_INDEXED_DIGESTS (session-digest.ts): a daily automation writes one
 * output file per run forever, so without a cap the corpus grows without bound
 * and old run logs dilute IDF against the curated brain. The newest runs are the
 * ones a session asks about ("what did the digest find yesterday?"); older ones
 * stay on disk and remain readable by path, just not indexed.
 */
export const MAX_INDEXED_AUTOMATION_RUNS = 30;

/**
 * Load automation run outputs (`automations/output/<slug>/<date>.md`) as
 * `automation` corpus docs so "what did the daily digest actually find?" is
 * recallable — the output IS the automation's product, and before this it was
 * write-only: a file the notifier pointed at and nothing ever read back.
 *
 * Flagged `capture: true` (like session digests and auto-bookmarks): a run log is
 * machine-generated, unreviewed output, so on an equal content match the curated
 * manifest or knowledge file must win. Level 1 for the same reason.
 *
 * Newest-first by mtime, capped at MAX_INDEXED_AUTOMATION_RUNS.
 */
function loadAutomationRunDocs(contextRoot: string): CorpusDoc[] {
  const outputRoot = join(contextRoot, 'automations', 'output');
  if (!existsSync(outputRoot)) return [];
  let files: string[];
  try {
    files = fg.sync('*/*.md', { cwd: outputRoot, absolute: true });
  } catch {
    return [];
  }
  // Sort newest-first before the cap so the cap keeps the RECENT runs.
  const dated = files
    .map((file) => {
      try { return { file, mtime: statSync(file).mtimeMs }; } catch { return null; }
    })
    .filter((e): e is { file: string; mtime: number } => e !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_INDEXED_AUTOMATION_RUNS);

  const out: CorpusDoc[] = [];
  for (const { file, mtime } of dated) {
    try {
      const { data, content } = readFrontmatter(file);
      const body = content.trim();
      if (!body) continue;
      const automationSlug = basename(dirname(file));
      const runId = basename(file, '.md');
      // Synthetic `run#<automation>-<date>` slug, namespaced like `digest#…` so
      // the capture-free eval baselines can recognise and strip it.
      const slug = `run#${automationSlug}-${runId}`;
      const title = String(data.title ?? `${automationSlug} run ${runId}`);
      const fields = buildFields({ title, description: '', tags: [automationSlug], body });
      out.push({
        type: 'automation',
        path: file,
        relPath: file.replace(contextRoot + '/', ''),
        slug,
        title,
        description: '',
        tags: [automationSlug],
        body,
        tokens: fields.tokens,
        tokenSet: new Set(fields.tokens),
        termFreq: fields.termFreq,
        fieldFreq: fields.fieldFreq,
        fieldLen: fields.fieldLen,
        links: fields.links,
        // Synthetic slug is not a canonical identity (mirrors changelog/bookmark).
        identityTokens: [],
        updatedAt: readUpdatedAt(data as Record<string, unknown>) ?? new Date(mtime).toISOString(),
        capture: true,
        level: 1,
      });
    } catch {
      // skip malformed
    }
  }
  return out;
}

/**
 * Load top-level skill packs as corpus docs for related-skill recall.
 *
 * Only scans `<pack>/SKILL.md` (the `*\/SKILL.md` glob does NOT recurse into
 * nested sub-skill dirs). Skills with `alwaysApply: true` are excluded — they're
 * already loaded, so surfacing them is noise. Produces `type: 'skill'` docs that
 * are intentionally NOT part of buildCorpus (haikuRecall must stay unchanged).
 */
export function loadSkillDocs(skillsRoot: string): CorpusDoc[] {
  if (!existsSync(skillsRoot)) return [];
  const files = fg.sync('*/SKILL.md', { cwd: skillsRoot, absolute: true });
  const out: CorpusDoc[] = [];
  for (const file of files) {
    try {
      const { data, content } = readFrontmatter(file);
      // EXCLUDE always-apply skills — already loaded, surfacing them is noise.
      if (data.alwaysApply === true) continue;
      const slug = (typeof data.name === 'string' && data.name)
        ? data.name
        : basename(dirname(file));
      const title = slug;
      const description = (typeof data.description === 'string') ? data.description : '';
      const tags = Array.isArray(data.tags) ? data.tags.map(String) : [];
      const body = content.trim();
      const fields = buildFields({ slug, title, description, tags, body });
      out.push({
        type: 'skill',
        path: file,
        relPath: relative(skillsRoot, file),
        slug,
        title,
        description,
        tags,
        body,
        tokens: fields.tokens,
        tokenSet: new Set(fields.tokens),
        termFreq: fields.termFreq,
        fieldFreq: fields.fieldFreq,
        fieldLen: fields.fieldLen,
        links: fields.links,
        identityTokens: fields.identityTokens,
      });
    } catch {
      // skip malformed
    }
  }
  return out;
}

export interface BuildCorpusOptions {
  types?: CorpusType[];
  /**
   * Keep only docs whose derived importance is >= this (see DocLevel). Applied to
   * the corpus BEFORE scoring, exactly like `types` — so a level-scoped query is
   * an honest BM25 search of a smaller corpus, not a re-ranked full one, and the
   * score/rankScore decoupling invariant is untouched.
   *
   * Undefined (the default) = no filter, so every existing caller — including the
   * hook's `score >= 2.0` gate and the eval harness — is byte-identical.
   */
  minLevel?: number;
}

export function buildCorpus(
  contextRoot: string,
  opts: BuildCorpusOptions = {},
): CorpusDoc[] {
  const types = new Set(opts.types ?? CORPUS_TYPES);
  const docs: CorpusDoc[] = [];
  if (types.has('knowledge')) {
    // Exclude knowledge/features/** — features are their own corpus type and are
    // loaded below, so a migrated feature is never double-counted as knowledge.
    docs.push(...loadMarkdownDocs(join(contextRoot, 'knowledge'), 'knowledge', contextRoot, ['features/**']));
  }
  if (types.has('feature')) {
    docs.push(...loadMarkdownDocs(featuresDir(contextRoot), 'feature', contextRoot));
  }
  if (types.has('objective')) {
    // PO-authored roadmap objectives (core/objectives/*.md) — first-class recall
    // docs so "what are we driving toward" surfaces in per-prompt recall too.
    docs.push(...loadMarkdownDocs(join(contextRoot, 'core', 'objectives'), 'objective', contextRoot));
  }
  if (types.has('insight')) {
    // Lab insight manifests (lab/insights/*.md) — the `## Meaning` prose is
    // first-class recall so "what do we measure / what does <metric> mean"
    // surfaces the curated insight, not raw numbers.
    docs.push(...loadMarkdownDocs(join(contextRoot, 'lab', 'insights'), 'insight', contextRoot));
  }
  if (types.has('thesis')) {
    // Proactive-learning-layer theses (theses/<slug>.md) — the claim prose is
    // first-class recall so "what are we testing / do we have a thesis about X"
    // surfaces the hypothesis, not just its downstream evidence.
    docs.push(...loadMarkdownDocs(join(contextRoot, 'theses'), 'thesis', contextRoot));
  }
  if (types.has('task')) {
    docs.push(...loadMarkdownDocs(join(contextRoot, 'state'), 'task', contextRoot));
    // Session digests fold under the task channel (continuous capture, C1/C3).
    docs.push(...loadDigestDocs(contextRoot));
  }
  if (types.has('memory')) {
    docs.push(...loadMemoryFile(contextRoot));
    // Auto/explicit bookmarks fold under the memory channel (C2/C3) so salient
    // moments are recallable before the next sleep consolidation.
    docs.push(...loadBookmarkDocs(contextRoot));
  }
  if (types.has('changelog')) {
    docs.push(...loadChangelogEntries(contextRoot));
  }
  if (types.has('automation')) {
    // Automation manifests are FLAT at `automations/<slug>.md` — the sibling
    // `cache/` (machine-local run state) and `output/` (run products, loaded
    // separately below with a recency cap) are excluded so a manifest is never
    // double-counted and raw JSON cache never enters the corpus.
    docs.push(...loadMarkdownDocs(
      join(contextRoot, 'automations'),
      'automation',
      contextRoot,
      ['cache/**', 'output/**'],
    ));
    docs.push(...loadAutomationRunDocs(contextRoot));
  }
  if (opts.minLevel !== undefined) {
    const floor = opts.minLevel;
    return docs.filter((doc) => docLevel(doc) >= floor);
  }
  return docs;
}

// ─── BM25 Scoring ──────────────────────────────────────────────────────────

const K1 = 1.5;
const B = 0.75;

// ── Rank composition weights (tuned on the eval harness, see eval/BASELINE) ──
// FIELD_WEIGHT_BONUS scales the EXTRA signal BM25F adds over flat BM25 — kept
// modest so the ranking stays anchored to the proven raw ordering (precision).
const FIELD_WEIGHT_BONUS = 0.5;
// IDENTITY_BOOST rewards query-term coverage of a doc's slug/title (restores
// field-match precision: a query that IS the slug should win decisively).
const IDENTITY_BOOST = 1.5;

// ── C2/C3: continuous-capture rank penalty ──────────────────────────────────
// Auto-generated session digests (type `task`, slug `digest#…`) and bookmarks
// (type `memory`, slug `bookmark#…`) are indexed with EQUAL raw-BM25 standing to
// curated knowledge. Measured (tests/unit/recall-capture-stress.test.ts): a flood
// of 200 each degraded recall@3 by ~3.3pts and recall@1 by ~8.3pts vs a
// capture-free corpus — mediocre auto-captures were crowding out real knowledge.
//
// This 0.4× multiplier applies to capture docs in the DERIVED `rankScore` ONLY
// (NEVER the raw `score` the hook thresholds against — the decoupling is sacred).
// Effect: on an equal content match a curated doc beats a capture doc, but a
// capture doc whose match is clearly the strongest/only one still wins (0.4× of a
// big number still tops 1× of a small one — the e2e loop test proves a genuine
// captured decision still surfaces in the top-3). The GUARD PROOF
// (recall-capture-stress.test.ts) verifies that under a worst-case capture flood,
// ZERO gold targets that ranked in the top-3 on the capture-free corpus are
// knocked out of it by a capture. (A weak-match gold doc that already missed the
// top-3 without any captures is not "displaced" — that is a recall limit of the
// query itself, not capture crowding.)
//
// Tuned 0.5 → 0.4 (task capture-guard-q030): at 0.5× a 400-doc flood whose bodies
// are stuffed with the Turkish gold-query vocabulary out-ranked knowledge/positioning
// for q030 ("projenin ürün konumlandırması ve sloganı") — an English doc that scores
// raw-BM25 0 on that query and therefore holds a fragile rank-3 on derived signals
// alone. A displacement sweep showed the guard holds at every p ≤ 0.45; 0.4 sits
// just below that cliff with a ~16% margin so the proof stays green across the IDF
// wobble from buildCorpus reading a live, dogfooded working tree. Lowering the
// penalty is monotonically safe for the guard and for the recall@3 degradation
// bound (it only pushes captures down, toward the capture-free baseline).
export const CAPTURE_RANK_PENALTY = 0.4;

// ── B3: recency + status ranking multipliers ────────────────────────────────
// Down-rank completed/archived docs (still findable, just not top of the pile).
// Tuned to 0.85 (not 0.6): a 0.6 penalty was burying completed tasks that were
// the CLEAR raw-BM25 winner for topical queries (R3 — "recency/status burying
// decisions"). 0.85 still breaks ties toward active work without overriding a
// strong content match.
export const STATUS_PENALTY: Record<string, number> = { completed: 0.85 };

// ── Canonical-first type factor ──────────────────────────────────────────────
// Changelog entries are one-line POINTERS to work; knowledge/feature/task docs
// are the canonical context. Because entries are short, BM25F length
// normalisation systematically over-ranks them: measured on BOTH gold sets
// (train q027/q039, held-out h001/h006/h010/h026), changelog summaries were
// outranking the canonical doc that actually answers the query. This modest
// rankScore-only factor (raw `score` untouched — decoupling invariant) breaks
// near-ties toward the canonical doc while a changelog whose match is clearly
// strongest still surfaces.
export const CHANGELOG_RANK_FACTOR = 0.85;

/**
 * Recency multiplier in [minMult, 1] from an exponential half-life decay.
 * A doc updated `halfLifeDays` ago scores ~0.875 (midway), older docs floor at
 * `minMult` (0.75) so recency is a tie-breaker, NOT a content override.
 */
export function recencyMultiplier(
  updatedAt: string | undefined,
  now: Date,
  halfLifeDays = 120,
): number {
  // Floor 0.85 (a gentle tie-breaker). A wider [0.75,1] spread let recent docs
  // override strong-but-older content matches on topical queries (R3); 0.85
  // keeps recency as a nudge, not a content override.
  const minMult = 0.85;
  if (!updatedAt) return minMult + (1 - minMult) * 0.5; // unknown date → neutral
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return minMult + (1 - minMult) * 0.5;
  const ageDays = Math.max(0, (now.getTime() - t) / 86_400_000);
  const decay = Math.pow(0.5, ageDays / halfLifeDays); // 1 (fresh) → 0 (ancient)
  return minMult + (1 - minMult) * decay;
}

function statusMultiplier(status: string | undefined): number {
  if (!status) return 1;
  return STATUS_PENALTY[status.toLowerCase()] ?? 1;
}

// ── B5: link-aware 2-hop boost (DEFAULT OFF) ────────────────────────────────
const LINK_DECAY = 0.3; // per-hop boost factor applied to a neighbour's rankScore

/** Map slug → adjacency (1-hop neighbour slugs) from [[slug]] wikilinks. */
export function buildLinkAdjacency(corpus: CorpusDoc[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const present = new Set(corpus.map((d) => d.slug));
  for (const d of corpus) {
    const set = adj.get(d.slug) ?? new Set<string>();
    for (const target of d.links ?? []) {
      if (present.has(target) && target !== d.slug) set.add(target);
    }
    adj.set(d.slug, set);
  }
  return adj;
}

export interface Bm25Options {
  /** Reference time for the recency multiplier. Defaults to `new Date()`. */
  now?: Date;
  /** Enable the B5 link-aware 2-hop boost. DEFAULT OFF (does not affect benchmark). */
  linkAware?: boolean;
  /** Alias groups from project taxonomy for query expansion (memory recall path only). */
  aliasGroups?: string[][];
}

export function bm25Search(
  query: string,
  corpus: CorpusDoc[],
  topK = 10,
  opts: Bm25Options = {},
): RecallHit[] {
  if (corpus.length === 0) return [];
  const now = opts.now ?? new Date();
  const queryTerms = Array.from(new Set(tokenize(query)));
  if (queryTerms.length === 0) return [];

  // B4: query-time synonym expansion (rankScore only). Weighted < 1.
  const synonymTerms = expandQueryTerms(queryTerms, stemToken, opts.aliasGroups ?? []);
  // Union of terms whose DF we need (primary + synonyms).
  const allTerms = new Set<string>(queryTerms);
  for (const t of synonymTerms.keys()) allTerms.add(t);

  const N = corpus.length;
  const avgdl = corpus.reduce((s, d) => s + d.tokens.length, 0) / N;
  // B2: separate avg document length for the field-weighted (BM25F) channel.
  const avgFieldLen = corpus.reduce((s, d) => s + (d.fieldLen ?? d.tokens.length), 0) / N;

  const df: Record<string, number> = {};
  for (const term of allTerms) {
    let count = 0;
    for (const d of corpus) if (d.tokenSet.has(term)) count++;
    df[term] = count;
  }

  const idfOf = (term: string): number => {
    const dfT = df[term] ?? 0;
    // BM25+ style epsilon to keep IDF non-negative.
    return Math.log(1 + (N - dfT + 0.5) / (dfT + 0.5));
  };

  // Score one term against a doc on the FIELD-WEIGHTED (BM25F) channel.
  const bm25fTerm = (doc: CorpusDoc, term: string, dl: number): number => {
    const tf = doc.fieldFreq?.get(term) ?? doc.termFreq.get(term) ?? 0;
    if (tf === 0) return 0;
    const num = tf * (K1 + 1);
    const den = tf + K1 * (1 - B + B * (dl / avgFieldLen));
    return idfOf(term) * (num / den);
  };

  // Pre-tokenise the (stemmed) slug + title token sets per doc once, for the
  // exact-identity boost below. Field-match queries target a doc's identity
  // (its slug/title), which BM25F term-spread alone under-rewards.
  const queryTermSet = new Set(queryTerms);

  interface Scratch { hit: RecallHit; rawRank: number; }
  const scored: Scratch[] = [];

  for (const doc of corpus) {
    // ── RAW BM25 on the flat unweighted haystack — UNCHANGED SCALE. ──
    // This is the `.score` the hook thresholds against. NONE of the B2/B3/B4/B5
    // signals may leak into this value (decoupling constraint).
    let rawScore = 0;
    const dlFlat = doc.tokens.length || 1;
    for (const term of queryTerms) {
      const tf = doc.termFreq.get(term) ?? 0;
      if (tf === 0) continue;
      const num = tf * (K1 + 1);
      const den = tf + K1 * (1 - B + B * (dlFlat / avgdl));
      rawScore += idfOf(term) * (num / den);
    }

    // ── DERIVED rankScore — ANCHORED on raw BM25 (precision), with bounded
    //    additive signals so it cannot drift far from the proven ordering:
    //    rank = ( raw + FIELD_BONUS·(bm25f − rawFieldTerms)  [B2]
    //                 + synonym contribution                 [B4]
    //                 + identity boost (slug/title coverage)
    //           ) × status × recency                          [B3]
    const dlField = doc.fieldLen ?? dlFlat;
    // Field-weighted primary-term score and its flat-equivalent on the SAME
    // terms; the difference is the *extra* signal field weighting contributes.
    let fieldPrimary = 0;
    for (const term of queryTerms) fieldPrimary += bm25fTerm(doc, term, dlField || 1);
    const fieldBonus = FIELD_WEIGHT_BONUS * Math.max(0, fieldPrimary - rawScore);

    // B4: synonym contribution (field-weighted, already < 1 per term).
    let synonymContrib = 0;
    for (const [term, w] of synonymTerms) synonymContrib += w * bm25fTerm(doc, term, dlField || 1);

    // Identity boost: reward how completely a doc's slug/title IS the query.
    // Keyed on COVERAGE-OF-IDENTITY (idHits / identityTokens.length), not of the
    // query: a short query that exactly spells a doc's slug covers ~100% of that
    // doc's identity and wins decisively (field-match). A long topical query
    // that merely shares 1-2 words with some doc's slug covers little of that
    // doc's identity AND little of its own length, so the boost stays small —
    // this stops long natural-language queries from being hijacked by docs whose
    // slug coincidentally contains a couple of the query words (topical guard).
    const idToks = doc.identityTokens ?? [];
    let idHits = 0;
    for (const t of idToks) if (queryTermSet.has(t)) idHits++;
    const qCoverage = queryTerms.length > 0 ? idHits / queryTerms.length : 0; // how much of the query the identity covers
    // Square the coverage so it SATURATES: a query that fully spells a slug
    // (coverage 1.0) earns the full boost (field-match wins decisively), while a
    // long topical query incidentally sharing 1-2 slug words (coverage ~0.25)
    // earns only ~0.06× — too little to hijack the genuine content match
    // (topical guard) yet enough partial credit to help paraphrase.
    const identityBoost = IDENTITY_BOOST * qCoverage * qCoverage * Math.max(rawScore, 1);

    const rankBase = rawScore + fieldBonus + synonymContrib + identityBoost;

    // A doc that matched nothing on either channel is not a hit.
    if (rankBase <= 0) continue;

    // B3: status + recency multipliers apply to the DERIVED rank only.
    // C2/C3: down-weight auto-captures (digests/bookmarks) on rankScore ONLY so
    // a curated doc beats a capture on an equal match (raw `score` untouched).
    const rankScore = rankBase
      * statusMultiplier(doc.status)
      * recencyMultiplier(doc.updatedAt, now)
      * (doc.capture ? CAPTURE_RANK_PENALTY : 1)
      * (doc.type === 'changelog' ? CHANGELOG_RANK_FACTOR : 1);

    scored.push({
      hit: { doc, score: rawScore, rankScore, snippet: extractSnippet(doc, queryTerms) },
      rawRank: rankBase,
    });
  }

  // B5: optional bounded 2-hop link boost on rankScore (DEFAULT OFF).
  if (opts.linkAware) {
    const adj = buildLinkAdjacency(corpus);
    // Snapshot pre-boost rank so 2nd-hop boosts derive from 1st-hop seed values.
    const seed = new Map<string, number>();
    for (const s of scored) seed.set(s.hit.doc.slug, s.rawRank);
    for (const s of scored) {
      let boost = 0;
      const neighbours = adj.get(s.hit.doc.slug) ?? new Set();
      for (const n1 of neighbours) {
        boost += LINK_DECAY * (seed.get(n1) ?? 0);
        for (const n2 of adj.get(n1) ?? new Set<string>()) {
          if (n2 === s.hit.doc.slug) continue;
          boost += LINK_DECAY * LINK_DECAY * (seed.get(n2) ?? 0);
        }
      }
      if (boost > 0) {
        s.hit.rankScore += boost
          * statusMultiplier(s.hit.doc.status)
          * recencyMultiplier(s.hit.doc.updatedAt, now)
          * (s.hit.doc.capture ? CAPTURE_RANK_PENALTY : 1)
          * (s.hit.doc.type === 'changelog' ? CHANGELOG_RANK_FACTOR : 1);
      }
    }
  }

  // Sort by the DERIVED rankScore (the eval harness reads this order); `.score`
  // is returned unchanged for the hook's threshold checks.
  const hits = scored.map((s) => s.hit);
  hits.sort((a, b) => b.rankScore - a.rankScore);
  return hits.slice(0, topK);
}

// ─── Snippet Extraction ────────────────────────────────────────────────────

function extractSnippet(doc: CorpusDoc, queryTerms: string[]): string {
  const lines = doc.body.split('\n');
  if (lines.length === 0) return '';

  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < lines.length; i++) {
    const lineTokens = tokenize(lines[i]);
    if (lineTokens.length === 0) continue;
    const lineSet = new Set(lineTokens);
    let hits = 0;
    for (const term of queryTerms) if (lineSet.has(term)) hits++;
    if (hits > bestScore) {
      bestScore = hits;
      bestIdx = i;
    }
  }

  const start = Math.max(0, bestIdx - 1);
  const end = Math.min(lines.length, bestIdx + 2);
  return lines.slice(start, end).join('\n').trim();
}
