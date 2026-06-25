import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STANDARD_TAGS } from './knowledge-index.js';

// ─── Facets ──────────────────────────────────────────────────────────────────

/** Known facet prefixes. Tags of the form `<facet>:<value>` are faceted. */
export const FACETS = ['domain', 'layer', 'kind', 'topic'] as const;
export type Facet = typeof FACETS[number];

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export interface Vocabulary {
  /** Tags grouped by facet (facet:value form). */
  facetTags: Record<Facet, string[]>;
  /** Alias map: alias -> canonical tag (one-hop). */
  aliases: Record<string, string>;
  /** Non-faceted (bare) tags. */
  bareTags: string[];
}

/** Shape of core/taxonomy.json on disk. */
interface TaxonomyJson {
  version: number;
  facets: Record<string, string[]>;
  bareTags: string[];
  aliases: Record<string, string>;
  [key: string]: unknown;
}

// ─── Default Vocabulary ──────────────────────────────────────────────────────

/**
 * DEFAULT_VOCABULARY: seeded from STANDARD_TAGS (knowledge-index) as bareTags
 * plus a tight set of dogfood aliases bridging common shorthands to faceted
 * canonicals. Keeps the map small — every alias here is a real term that appears
 * in this project's corpus.
 */
export const DEFAULT_VOCABULARY: Vocabulary = {
  facetTags: {
    domain: [
      'domain:database',
      'domain:security',
      'domain:knowledge',
      'domain:recall',
    ],
    layer: [
      'layer:frontend',
      'layer:backend',
      'layer:devops',
    ],
    kind: [
      'kind:architecture',
      'kind:api',
      'kind:testing',
      'kind:design',
      'kind:decisions',
      'kind:onboarding',
    ],
    topic: [
      'topic:recall',
      'topic:sleep',
      'topic:taxonomy',
      'topic:domain',
    ],
  },
  aliases: {
    // Tight shorthands → faceted canonicals (real corpus shorthands only).
    // STANDARD_TAGS (architecture, testing, api, etc.) are canonical bare tags —
    // they must NOT be aliased here or classifyTag will misclassify them as aliases
    // and resolveAlias will incorrectly redirect bare canonical lookups.
    search: 'topic:recall',
    retrieval: 'topic:recall',
    db: 'domain:database',
    auth: 'domain:security',
    consolidation: 'topic:sleep',
  },
  // STANDARD_TAGS are kept as bare fallback for backward-compat searches.
  bareTags: [...STANDARD_TAGS],
};

// ─── Tag helpers ──────────────────────────────────────────────────────────────

/**
 * Slugify the VALUE side of a faceted tag, or the whole bare tag.
 * E.g. `topic:My Feature` -> `topic:my-feature`; `My Tag` -> `my-tag`.
 */
export function slugifyTag(tag: string): string {
  const colonIdx = tag.indexOf(':');
  if (colonIdx === -1) {
    return tag
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }
  const facet = tag.slice(0, colonIdx);
  const value = tag.slice(colonIdx + 1)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${facet}:${value}`;
}

/** Small singular normalisations for common tag plurals. */
const PLURAL_MAP: Record<string, string> = {
  databases: 'database',
  features: 'feature',
  decisions: 'decision',
  architectures: 'architecture',
  releases: 'release',
  tasks: 'task',
  recalls: 'recall',
};

/**
 * Normalise a tag: slugify + apply a small known-plural singularization on the
 * value side.
 */
export function normalizeTag(tag: string): string {
  const slugged = slugifyTag(tag);
  const colonIdx = slugged.indexOf(':');
  if (colonIdx === -1) {
    return PLURAL_MAP[slugged] ?? slugged;
  }
  const facet = slugged.slice(0, colonIdx);
  const value = slugged.slice(colonIdx + 1);
  return `${facet}:${PLURAL_MAP[value] ?? value}`;
}

const FACET_SET = new Set<string>(FACETS);

/**
 * Strip the facet prefix from a faceted tag — return ONLY the value portion
 * for index purposes, so high-df prefixes like `topic` don't pollute BM25 DF.
 * A tag whose prefix is NOT a known facet is returned unchanged.
 *
 * Examples:
 *   `topic:recall`   -> `recall`
 *   `domain:database`-> `database`
 *   `foo:bar`        -> `foo:bar`  (foo is not a known facet)
 *   `architecture`   -> `architecture`
 */
export function tagIndexValue(tag: string): string {
  const colonIdx = tag.indexOf(':');
  if (colonIdx === -1) return tag;
  const prefix = tag.slice(0, colonIdx);
  if (!FACET_SET.has(prefix)) return tag;
  return tag.slice(colonIdx + 1);
}

/**
 * Resolve one alias hop. If the tag is itself an alias key, return the
 * canonical. Guards against self-aliases and cycles (returns input unchanged
 * if a cycle is detected on the second hop).
 */
/**
 * Own-property alias lookup. Plain objects inherit keys like `constructor`
 * from Object.prototype — a tag with such a name must NOT read as an alias.
 */
function aliasOf(aliases: Record<string, string>, tag: string): string | undefined {
  return Object.hasOwn(aliases, tag) ? aliases[tag] : undefined;
}

export function resolveAlias(tag: string, vocab: Vocabulary): string {
  const canonical = aliasOf(vocab.aliases, tag);
  if (!canonical || canonical === tag) return tag;
  // Guard cycle: if the canonical also has an alias that leads back, stop.
  const second = aliasOf(vocab.aliases, canonical);
  if (second && second !== canonical && second === tag) return tag; // cycle guard
  return canonical;
}

/**
 * Return true if tag is canonical (exists in facetTags or bareTags, and is
 * NOT an alias key pointing elsewhere).
 */
export function isCanonical(tag: string, vocab: Vocabulary): boolean {
  // Must not be an alias that points somewhere else.
  const alias = aliasOf(vocab.aliases, tag);
  if (alias && alias !== tag) return false;
  const allFacetTags = (Object.values(vocab.facetTags) as string[][]).flat();
  return allFacetTags.includes(tag) || vocab.bareTags.includes(tag);
}

/**
 * Classify a tag as 'faceted', 'bare', or 'unknown' relative to the vocabulary.
 */
export function classifyTag(tag: string, vocab: Vocabulary): 'faceted' | 'bare' | 'alias' | 'unknown' {
  const aliasTarget = aliasOf(vocab.aliases, tag);
  if (aliasTarget && aliasTarget !== tag) return 'alias';
  const colonIdx = tag.indexOf(':');
  if (colonIdx !== -1) {
    const prefix = tag.slice(0, colonIdx);
    if (FACET_SET.has(prefix)) {
      const allFacetTags = (Object.values(vocab.facetTags) as string[][]).flat();
      return allFacetTags.includes(tag) ? 'faceted' : 'unknown';
    }
  }
  return vocab.bareTags.includes(tag) ? 'bare' : 'unknown';
}

/**
 * Find near-duplicate tags within the same facet (or within bareTags).
 * "Near-duplicate" = Levenshtein distance ≤ 1 on the VALUE portion.
 * Cross-facet near-duplicates are NOT reported (domain:database vs layer:database
 * are deliberately different).
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  const dp: number[][] = Array.from({ length: la + 1 }, (_, i) =>
    Array.from({ length: lb + 1 }, (__, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[la][lb];
}

export function nearDuplicates(vocab: Vocabulary): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];

  // Check within each facet group.
  for (const facet of FACETS) {
    const tags = vocab.facetTags[facet];
    for (let i = 0; i < tags.length; i++) {
      for (let j = i + 1; j < tags.length; j++) {
        const va = tagIndexValue(tags[i]);
        const vb = tagIndexValue(tags[j]);
        if (levenshtein(va, vb) <= 1) {
          pairs.push([tags[i], tags[j]]);
        }
      }
    }
  }

  // Check within bareTags.
  const bt = vocab.bareTags;
  for (let i = 0; i < bt.length; i++) {
    for (let j = i + 1; j < bt.length; j++) {
      if (levenshtein(bt[i], bt[j]) <= 1) {
        pairs.push([bt[i], bt[j]]);
      }
    }
  }

  return pairs;
}

/**
 * Produce alias groups for query expansion: [[alias, tagIndexValue(canonical)], ...].
 * Used by bm25Search to expand query terms through project aliases at search time.
 */
export function aliasGroups(vocab: Vocabulary): string[][] {
  const groups: string[][] = [];
  for (const [alias, canonical] of Object.entries(vocab.aliases)) {
    if (alias !== canonical) {
      groups.push([alias, tagIndexValue(canonical)]);
    }
  }
  return groups;
}

// ─── Vocabulary JSON I/O ──────────────────────────────────────────────────────

/**
 * Serialize a vocabulary to canonical pretty-printed JSON string.
 * The output has a `version` field and matches the core/taxonomy.json schema.
 */
export function serializeVocabulary(vocab: Vocabulary): string {
  const facets: Record<string, string[]> = {};
  for (const facet of FACETS) {
    facets[facet] = vocab.facetTags[facet];
  }
  const obj: TaxonomyJson = {
    version: 1,
    facets,
    bareTags: vocab.bareTags,
    aliases: vocab.aliases,
  };
  return JSON.stringify(obj, null, 2) + '\n';
}

/**
 * Parse a taxonomy.json string into a partial Vocabulary. Fail-soft: malformed
 * JSON, wrong-type fields, or unknown keys are silently tolerated — never throws.
 * Values are normalized via normalizeTag on load.
 */
export function parseVocabularyJson(raw: string): Partial<Vocabulary> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const obj = parsed as Record<string, unknown>;
  const result: Partial<Vocabulary> = {};

  // Parse facets
  if (obj.facets !== null && typeof obj.facets === 'object' && !Array.isArray(obj.facets)) {
    const facets = obj.facets as Record<string, unknown>;
    const facetTags: Record<Facet, string[]> = { domain: [], layer: [], kind: [], topic: [] };
    let hadAnyFacet = false;
    for (const facet of FACETS) {
      const vals = facets[facet];
      if (Array.isArray(vals)) {
        facetTags[facet] = vals
          .filter((v): v is string => typeof v === 'string')
          .map((v) => normalizeTag(v));
        hadAnyFacet = true;
      }
    }
    if (hadAnyFacet) result.facetTags = facetTags;
  }

  // Parse bareTags
  if (Array.isArray(obj.bareTags)) {
    result.bareTags = (obj.bareTags as unknown[])
      .filter((v): v is string => typeof v === 'string')
      .map((v) => normalizeTag(v));
  }

  // Parse aliases
  if (obj.aliases !== null && typeof obj.aliases === 'object' && !Array.isArray(obj.aliases)) {
    const aliases: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj.aliases as Record<string, unknown>)) {
      if (typeof k === 'string' && typeof v === 'string' && k !== v) {
        aliases[normalizeTag(k)] = normalizeTag(v);
      }
    }
    result.aliases = aliases;
  }

  return result;
}

/**
 * Load the project's taxonomy.json (core/taxonomy.json) if present, merge it over
 * DEFAULT_VOCABULARY using ARRAY-UNION per key, and return the merged vocab.
 *
 * Merge rules:
 *   - facetTags: union (project values added to default, deduped).
 *   - aliases: object-union; project alias wins per key (project overrides default).
 *   - bareTags: union (project values added, deduped).
 *
 * An empty project section NEVER wipes defaults — union semantics mean the
 * result always contains at least the defaults.
 */
export function loadProjectVocabulary(contextRoot: string): Vocabulary {
  const taxonomyPath = join(contextRoot, 'core', 'taxonomy.json');
  if (!existsSync(taxonomyPath)) return DEFAULT_VOCABULARY;

  let raw = '';
  try {
    raw = readFileSync(taxonomyPath, 'utf-8');
  } catch {
    return DEFAULT_VOCABULARY;
  }

  const project = parseVocabularyJson(raw);

  // Merge: default + project, ARRAY-UNION per collection, project-wins per alias key.
  const merged: Vocabulary = {
    facetTags: {} as Record<Facet, string[]>,
    aliases: { ...DEFAULT_VOCABULARY.aliases, ...(project.aliases ?? {}) },
    bareTags: dedupe([...DEFAULT_VOCABULARY.bareTags, ...(project.bareTags ?? [])]),
  };

  for (const facet of FACETS) {
    merged.facetTags[facet] = dedupe([
      ...DEFAULT_VOCABULARY.facetTags[facet],
      ...(project.facetTags?.[facet] ?? []),
    ]);
  }

  return merged;
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

/**
 * Ensure `core/taxonomy.json` exists, scaffolding it from DEFAULT_VOCABULARY when
 * missing. Idempotent: an existing file is NEVER touched. Returns true only
 * when the file was created by this call.
 *
 * Called from `dreamcontext taxonomy init` and from the SessionStart hook so
 * existing installs are seeded automatically on their first session after
 * upgrading — without waiting for a sleep cycle or any user action.
 */
export function ensureTaxonomyFile(contextRoot: string): boolean {
  const taxonomyPath = join(contextRoot, 'core', 'taxonomy.json');
  if (existsSync(taxonomyPath)) return false;
  mkdirSync(join(contextRoot, 'core'), { recursive: true });
  writeFileSync(taxonomyPath, serializeVocabulary(DEFAULT_VOCABULARY), 'utf-8');
  return true;
}

// ─── Mutation Helpers ─────────────────────────────────────────────────────────

/**
 * Read the project's taxonomy.json as a raw TaxonomyJson (or a fresh default).
 * Does NOT merge with DEFAULT_VOCABULARY — returns only what's on disk.
 * Uses ensureTaxonomyFile first to guarantee the file exists.
 */
function readProjectTaxonomyJson(contextRoot: string): TaxonomyJson {
  ensureTaxonomyFile(contextRoot);
  const taxonomyPath = join(contextRoot, 'core', 'taxonomy.json');
  try {
    const raw = readFileSync(taxonomyPath, 'utf-8');
    const parsed = JSON.parse(raw) as TaxonomyJson;
    // Ensure required shapes
    if (!parsed.facets || typeof parsed.facets !== 'object') parsed.facets = {};
    if (!Array.isArray(parsed.bareTags)) parsed.bareTags = [];
    if (!parsed.aliases || typeof parsed.aliases !== 'object') parsed.aliases = {};
    return parsed;
  } catch {
    return {
      version: 1,
      facets: {},
      bareTags: [],
      aliases: {},
    };
  }
}

/**
 * Write the project's taxonomy.json back to disk.
 */
function writeProjectTaxonomyJson(contextRoot: string, obj: TaxonomyJson): void {
  const taxonomyPath = join(contextRoot, 'core', 'taxonomy.json');
  writeFileSync(taxonomyPath, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

/**
 * Check whether a tag already exists in the MERGED vocabulary (default + project).
 * Returns the classification + canonical form.
 */
function tagExistsInMerged(tag: string, mergedVocab: Vocabulary): boolean {
  const cls = classifyTag(tag, mergedVocab);
  return cls !== 'unknown';
}

/**
 * Add a tag to the project vocabulary file.
 *
 * Rules:
 *   - Normalizes the tag first.
 *   - Faceted tag: the facet prefix must be a known FACET (else rejected).
 *   - Already present in merged vocabulary as a canonical tag → added:false 'already exists'.
 *   - Resolves as an alias of an existing canonical → rejected with 'is an alias of <canonical>'.
 *   - Bare or valid faceted → added to project file, returns added:true.
 */
export function addVocabularyTag(
  contextRoot: string,
  rawTag: string,
): { added: boolean; tag: string; reason?: string } {
  const tag = normalizeTag(rawTag);

  // Faceted tag: validate facet
  const colonIdx = tag.indexOf(':');
  if (colonIdx !== -1) {
    const facetCandidate = tag.slice(0, colonIdx);
    if (!FACET_SET.has(facetCandidate)) {
      return { added: false, tag, reason: `unknown facet '${facetCandidate}'; valid facets: ${FACETS.join(', ')}` };
    }
  }

  const mergedVocab = loadProjectVocabulary(contextRoot);

  // Check if it's an alias of something that exists
  const aliasedCanonical = aliasOf(mergedVocab.aliases, tag);
  if (aliasedCanonical && aliasedCanonical !== tag) {
    return { added: false, tag, reason: `is an alias of ${aliasedCanonical}` };
  }

  // Check if it's already canonical
  if (isCanonical(tag, mergedVocab)) {
    return { added: false, tag, reason: 'already exists' };
  }

  // Add to project file
  const projectJson = readProjectTaxonomyJson(contextRoot);

  if (colonIdx !== -1) {
    const facet = tag.slice(0, colonIdx) as Facet;
    if (!Array.isArray(projectJson.facets[facet])) {
      projectJson.facets[facet] = [];
    }
    if (!projectJson.facets[facet].includes(tag)) {
      projectJson.facets[facet].push(tag);
    }
  } else {
    if (!Array.isArray(projectJson.bareTags)) projectJson.bareTags = [];
    if (!projectJson.bareTags.includes(tag)) {
      projectJson.bareTags.push(tag);
    }
  }

  writeProjectTaxonomyJson(contextRoot, projectJson);
  return { added: true, tag };
}

/**
 * Add an alias mapping to the project vocabulary file.
 *
 * Rules:
 *   - Normalizes both alias and canonical.
 *   - Canonical must exist in the merged vocabulary as a real canonical tag.
 *   - Alias must not equal canonical.
 *   - Alias must not itself be a canonical tag in the merged vocabulary.
 *   - Alias must not create a chain (canonical must not be an alias key in merged vocabulary).
 *   - Already-identical mapping → added:false (no error).
 */
export function addVocabularyAlias(
  contextRoot: string,
  rawAlias: string,
  rawCanonical: string,
): { added: boolean; reason?: string } {
  const alias = normalizeTag(rawAlias);
  const canonical = normalizeTag(rawCanonical);

  if (alias === canonical) {
    return { added: false, reason: 'alias and canonical must differ' };
  }

  const mergedVocab = loadProjectVocabulary(contextRoot);

  // No chains: canonical must not itself be an alias key (check before isCanonical
  // so the error message is clear — "search" is an alias, not just "nonexistent")
  const canonicalAsAlias = aliasOf(mergedVocab.aliases, canonical);
  if (canonicalAsAlias && canonicalAsAlias !== canonical) {
    return { added: false, reason: `'${canonical}' is an alias of '${canonicalAsAlias}'; chains are not allowed` };
  }

  // Canonical must exist as a real canonical tag
  if (!isCanonical(canonical, mergedVocab)) {
    return { added: false, reason: `canonical '${canonical}' does not exist in the vocabulary` };
  }

  // Alias must not itself be a canonical tag
  if (isCanonical(alias, mergedVocab)) {
    return { added: false, reason: `'${alias}' is already a canonical tag; cannot alias a canonical` };
  }

  // Check for already-identical mapping
  if (aliasOf(mergedVocab.aliases, alias) === canonical) {
    return { added: false, reason: 'already exists' };
  }

  // Add to project file
  const projectJson = readProjectTaxonomyJson(contextRoot);
  if (!projectJson.aliases || typeof projectJson.aliases !== 'object') {
    projectJson.aliases = {};
  }
  projectJson.aliases[alias] = canonical;

  writeProjectTaxonomyJson(contextRoot, projectJson);
  return { added: true };
}

// ─── Audit ───────────────────────────────────────────────────────────────────

export interface AuditBuckets {
  untagged: string[];       // docs with no tags
  nonCanonical: Array<{ doc: string; tag: string; suggestion: string }>;
  orphan: string[];         // tags that appear in docs but not in vocab
  nearDups: Array<[string, string]>;
}

/**
 * Audit the corpus (array of {slug, tags[]}) against the vocabulary.
 * Report-only: NEVER mutates docs or vocab.
 */
export function auditCorpus(
  docs: Array<{ slug: string; tags: string[] }>,
  vocab: Vocabulary,
): AuditBuckets {
  const buckets: AuditBuckets = {
    untagged: [],
    nonCanonical: [],
    orphan: [],
    nearDups: nearDuplicates(vocab),
  };

  const allCanonical = new Set([
    ...(Object.values(vocab.facetTags) as string[][]).flat(),
    ...vocab.bareTags,
    ...Object.keys(vocab.aliases),
  ]);

  for (const doc of docs) {
    if (doc.tags.length === 0) {
      buckets.untagged.push(doc.slug);
      continue;
    }
    for (const tag of doc.tags) {
      if (!allCanonical.has(tag)) {
        buckets.orphan.push(tag);
        buckets.nonCanonical.push({
          doc: doc.slug,
          tag,
          suggestion: resolveAlias(tag, vocab),
        });
      } else {
        const cls = classifyTag(tag, vocab);
        if (cls === 'alias') {
          buckets.nonCanonical.push({
            doc: doc.slug,
            tag,
            suggestion: resolveAlias(tag, vocab),
          });
        }
      }
    }
  }

  // Dedup orphans.
  buckets.orphan = [...new Set(buckets.orphan)];

  return buckets;
}

// ─── Bulk tag normalization (audit --fix) ──────────────────────────────────────

export interface TagRewrite {
  from: string;
  to: string;
}

export interface TagFixPlan {
  /** The rewrites to apply (raw tag -> canonical), in document order. */
  rewrites: TagRewrite[];
  /** The resulting tag list: rewritten + deduped, original order preserved. */
  newTags: string[];
  /**
   * Non-canonical tags with NO safe canonical target (orphans / unknowns with
   * no alias and no normalization-to-canonical). Left UNTOUCHED — a human/sleep
   * agent must decide (`taxonomy add` / `taxonomy alias`) before they can be
   * auto-fixed.
   */
  unresolved: string[];
}

/**
 * Plan canonical rewrites for ONE document's tag list, using the vocabulary's
 * normalization + alias map. Pure — never touches disk.
 *
 * A raw tag is rewritten to `target` iff `normalizeTag` → `resolveAlias` yields
 * a DIFFERENT tag that is canonical in the vocab. This covers BOTH:
 *   - alias resolution      (`search` → `topic:recall`, `db` → `domain:database`)
 *   - normalization drift    (`Architecture` → `architecture`, `Topic:Recall` → `topic:recall`)
 *
 * Tags that are already canonical are kept as-is. Orphan/unknown tags with no
 * canonical target are kept as-is and reported in `unresolved` — we NEVER rewrite
 * a tag to a non-canonical form, so the fix is always safe and convergent.
 *
 * Idempotent: running the plan on its own `newTags` output yields zero rewrites.
 */
export function planTagRewrites(tags: string[], vocab: Vocabulary): TagFixPlan {
  const rewrites: TagRewrite[] = [];
  const unresolved: string[] = [];
  const newTags: string[] = [];
  const seen = new Set<string>();
  const pushUnique = (t: string): void => {
    if (!newTags.includes(t)) newTags.push(t);
  };

  for (const raw of tags) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    // Skip a duplicate raw tag in the same doc — process each distinct tag once,
    // so `rewrites`/`totalRewrites` reflect real work and a doc with a repeated
    // tag collapses cleanly instead of double-counting.
    if (seen.has(raw)) continue;
    seen.add(raw);

    // Already-canonical tags are NEVER touched. This is the load-bearing guard:
    // a tag like `decisions` is a canonical bare tag even though `normalizeTag`
    // would singularize it to `decision` (the plural/singular twin is a vocab
    // near-dup, not a per-file fix). Only NON-canonical tags get rewritten, so
    // the fix never churns good tags or fights an established convention.
    if (isCanonical(raw, vocab)) {
      pushUnique(raw);
      continue;
    }

    const norm = normalizeTag(raw);
    const target = resolveAlias(norm, vocab);
    if (target !== raw && isCanonical(target, vocab)) {
      rewrites.push({ from: raw, to: target });
      pushUnique(target);
    } else {
      // Non-canonical with no safe canonical target — leave it, report it.
      if (!unresolved.includes(raw)) unresolved.push(raw);
      pushUnique(raw);
    }
  }

  return { rewrites, newTags, unresolved };
}
