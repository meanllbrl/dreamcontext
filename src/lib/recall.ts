import { existsSync, readFileSync } from 'node:fs';
import { join, basename, dirname, relative } from 'node:path';
import fg from 'fast-glob';
import { readFrontmatter } from './frontmatter.js';
import { expandQueryTerms } from './recall-synonyms.js';
import { loadDigestDocs } from './session-digest.js';
import { tagIndexValue } from './taxonomy.js';
import {
  isExcalidrawPath,
  extractExcalidrawText,
  diagramFolderDirs,
  isDarkDiagramSibling,
} from './excalidraw-text.js';

// 'skill' docs are produced ONLY by loadSkillDocs (called directly by the hook);
// intentionally excluded from buildCorpus defaults to avoid polluting haikuRecall.
export type CorpusType = 'knowledge' | 'feature' | 'task' | 'memory' | 'changelog' | 'skill' | 'objective';

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
  product?: string;                       // B1: derived from knowledge/products/<name>/…
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
): CorpusDoc[] {
  if (!existsSync(dir)) return [];
  // B1: recurse into nested dirs (e.g. knowledge/products/<name>/…).
  const files = fg.sync('**/*.md', { cwd: dir, absolute: true });
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
      const title = String(data.name ?? data.title ?? slug);
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
        product: productFromRelPath(relPath),
        // Federation: a doc ingested from a peer carries `federated: true`.
        federated: data.federated === true,
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
    });
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
}

export function buildCorpus(
  contextRoot: string,
  opts: BuildCorpusOptions = {},
): CorpusDoc[] {
  const types = new Set(opts.types ?? ['knowledge', 'feature', 'task', 'memory', 'changelog', 'objective']);
  const docs: CorpusDoc[] = [];
  if (types.has('knowledge')) {
    docs.push(...loadMarkdownDocs(join(contextRoot, 'knowledge'), 'knowledge', contextRoot));
  }
  if (types.has('feature')) {
    docs.push(...loadMarkdownDocs(join(contextRoot, 'core', 'features'), 'feature', contextRoot));
  }
  if (types.has('objective')) {
    // PO-authored roadmap objectives (core/objectives/*.md) — first-class recall
    // docs so "what are we driving toward" surfaces in per-prompt recall too.
    docs.push(...loadMarkdownDocs(join(contextRoot, 'core', 'objectives'), 'objective', contextRoot));
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
