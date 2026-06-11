import { existsSync, readFileSync } from 'node:fs';
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
export function resolveAlias(tag: string, vocab: Vocabulary): string {
  const canonical = vocab.aliases[tag];
  if (!canonical || canonical === tag) return tag;
  // Guard cycle: if the canonical also has an alias that leads back, stop.
  const second = vocab.aliases[canonical];
  if (second && second !== canonical && second === tag) return tag; // cycle guard
  return canonical;
}

/**
 * Return true if tag is canonical (exists in facetTags or bareTags, and is
 * NOT an alias key pointing elsewhere).
 */
export function isCanonical(tag: string, vocab: Vocabulary): boolean {
  // Must not be an alias that points somewhere else.
  const alias = vocab.aliases[tag];
  if (alias && alias !== tag) return false;
  const allFacetTags = (Object.values(vocab.facetTags) as string[][]).flat();
  return allFacetTags.includes(tag) || vocab.bareTags.includes(tag);
}

/**
 * Classify a tag as 'faceted', 'bare', or 'unknown' relative to the vocabulary.
 */
export function classifyTag(tag: string, vocab: Vocabulary): 'faceted' | 'bare' | 'alias' | 'unknown' {
  if (vocab.aliases[tag] && vocab.aliases[tag] !== tag) return 'alias';
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

// ─── Vocabulary Markdown I/O ─────────────────────────────────────────────────

/**
 * Parse a taxonomy.md file into a partial Vocabulary. Fail-soft: skip malformed
 * rows, never throw. The result is merged OVER the default in loadProjectVocabulary.
 *
 * Recognised sections:
 *   ## Facets      — code blocks with `facet:value` lines (one per line)
 *   ## Aliases     — markdown table  | alias | canonical |
 *   ## Domain Vocabulary — bare tag lines (one per line)
 */
export function parseVocabularyMarkdown(markdown: string): Partial<Vocabulary> {
  const result: Partial<Vocabulary> = {};

  // Split into H2 sections.
  const sections = markdown.split(/^## /m);

  for (const section of sections) {
    const titleEnd = section.indexOf('\n');
    if (titleEnd === -1) continue;
    const title = section.slice(0, titleEnd).trim().toLowerCase();
    const body = section.slice(titleEnd + 1);

    if (title === 'facets') {
      // Parse code-block lines of the form `facet:value`.
      const facetTags: Record<Facet, string[]> = { domain: [], layer: [], kind: [], topic: [] };
      const codeBlockMatches = body.matchAll(/```[^\n]*\n([\s\S]*?)```/g);
      for (const m of codeBlockMatches) {
        for (const line of m[1].split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const colonIdx = trimmed.indexOf(':');
          if (colonIdx === -1) continue;
          const facet = trimmed.slice(0, colonIdx) as Facet;
          if (!FACET_SET.has(facet)) continue;
          facetTags[facet].push(trimmed);
        }
      }
      // Also accept bare `facet:value` lines outside code blocks.
      for (const line of body.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('`') || trimmed.startsWith('#')) continue;
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx === -1) continue;
        const facet = trimmed.slice(0, colonIdx) as Facet;
        if (!FACET_SET.has(facet)) continue;
        if (!facetTags[facet].includes(trimmed)) facetTags[facet].push(trimmed);
      }
      result.facetTags = facetTags;
    } else if (title === 'aliases') {
      // Parse markdown table rows: | alias | canonical |
      const aliases: Record<string, string> = {};
      for (const line of body.split('\n')) {
        if (!line.includes('|')) continue;
        const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
        if (cells.length < 2) continue;
        if (cells[0].toLowerCase() === 'alias' || cells[0].startsWith('-')) continue;
        const alias = cells[0];
        const canonical = cells[1];
        if (!alias || !canonical || alias === canonical) continue;
        // Basic sanity: no spaces allowed in tag tokens.
        if (alias.includes(' ') || canonical.includes(' ')) continue;
        aliases[alias] = canonical;
      }
      result.aliases = aliases;
    } else if (title === 'domain vocabulary' || title === 'naming rules') {
      // Parse bare-tag lines (dash-list or plain lines).
      const bareTags: string[] = [];
      for (const line of body.split('\n')) {
        const trimmed = line.replace(/^[-*]\s*/, '').trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('|')) continue;
        // Skip lines that look like headings or code.
        if (trimmed.startsWith('`') || trimmed.startsWith('>')) continue;
        // Simple kebab-case check.
        if (/^[a-z][a-z0-9-]*$/.test(trimmed)) bareTags.push(trimmed);
      }
      if (bareTags.length > 0) result.bareTags = bareTags;
    }
  }

  return result;
}

/**
 * Load the project's taxonomy.md (core/taxonomy.md) if present, merge it over
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
  const taxonomyPath = join(contextRoot, 'core', 'taxonomy.md');
  if (!existsSync(taxonomyPath)) return DEFAULT_VOCABULARY;

  let raw = '';
  try {
    raw = readFileSync(taxonomyPath, 'utf-8');
  } catch {
    return DEFAULT_VOCABULARY;
  }

  const project = parseVocabularyMarkdown(raw);

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

// ─── Render default taxonomy markdown ────────────────────────────────────────

/**
 * Render the default vocabulary as a taxonomy.md file body.
 * Used both by `taxonomy init` and to seed the init template.
 */
export function renderDefaultTaxonomyMarkdown(vocab: Vocabulary): string {
  const lines: string[] = [
    '<!--',
    '  core/taxonomy.md — project vocabulary for faceted tags.',
    '  DO NOT rename this file or move it out of core/: a leading-digit prefix',
    '  would pull it into the core-index glob; keeping it here but without a',
    '  numeric prefix keeps it out of the snapshot while remaining parseable.',
    '  Managed by: dreamcontext taxonomy init / dreamcontext taxonomy vocab',
    '-->',
    '',
    '# Taxonomy',
    '',
    '## Naming Rules',
    '',
    '- Tags are lowercase kebab-case.',
    '- Faceted tags use the form `facet:value` (e.g. `topic:recall`, `domain:database`).',
    '- Bare tags are plain lowercase words (e.g. `architecture`, `testing`).',
    '- Prefer the canonical form; add aliases below for common shorthands.',
    '- Run `dreamcontext taxonomy vocab` to see the full resolved vocabulary.',
    '',
    '## Facets',
    '',
    '```',
  ];

  for (const facet of FACETS) {
    for (const tag of vocab.facetTags[facet]) {
      lines.push(tag);
    }
  }

  lines.push('```', '', '## Aliases', '', '| alias | canonical |', '|-------|-----------|');

  for (const [alias, canonical] of Object.entries(vocab.aliases)) {
    lines.push(`| ${alias} | ${canonical} |`);
  }

  lines.push('', '## Domain Vocabulary', '');

  for (const tag of vocab.bareTags) {
    lines.push(`- ${tag}`);
  }

  lines.push('');

  return lines.join('\n');
}
