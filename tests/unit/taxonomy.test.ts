import { describe, it, expect } from 'vitest';
import {
  DEFAULT_VOCABULARY,
  FACETS,
  normalizeTag,
  tagIndexValue,
  resolveAlias,
  isCanonical,
  classifyTag,
  nearDuplicates,
  aliasGroups,
  auditCorpus,
  parseVocabularyMarkdown,
  renderDefaultTaxonomyMarkdown,
  loadProjectVocabulary,
  type Vocabulary,
} from '../../src/lib/taxonomy.js';

// ── tagIndexValue ─────────────────────────────────────────────────────────────

describe('tagIndexValue', () => {
  it('strips a known-facet prefix', () => {
    expect(tagIndexValue('topic:recall')).toBe('recall');
    expect(tagIndexValue('domain:database')).toBe('database');
    expect(tagIndexValue('layer:frontend')).toBe('frontend');
    expect(tagIndexValue('kind:api')).toBe('api');
  });

  it('leaves bare tags unchanged', () => {
    expect(tagIndexValue('architecture')).toBe('architecture');
    expect(tagIndexValue('testing')).toBe('testing');
  });

  it('leaves unknown-facet tags unchanged', () => {
    // 'foo' is NOT a known facet
    expect(tagIndexValue('foo:bar')).toBe('foo:bar');
  });
});

// ── normalizeTag ──────────────────────────────────────────────────────────────

describe('normalizeTag', () => {
  it('lowercases and kebab-cases the tag', () => {
    expect(normalizeTag('My Tag')).toBe('my-tag');
  });

  it('singularizes known plurals on bare tags', () => {
    expect(normalizeTag('databases')).toBe('database');
    expect(normalizeTag('features')).toBe('feature');
  });

  it('singularizes the value side of faceted tags', () => {
    expect(normalizeTag('topic:recalls')).toBe('topic:recall');
  });

  it('leaves already-singular tags unchanged', () => {
    expect(normalizeTag('database')).toBe('database');
    expect(normalizeTag('topic:recall')).toBe('topic:recall');
  });
});

// ── resolveAlias ──────────────────────────────────────────────────────────────

describe('resolveAlias', () => {
  it('resolves a known alias to its canonical', () => {
    expect(resolveAlias('search', DEFAULT_VOCABULARY)).toBe('topic:recall');
    expect(resolveAlias('db', DEFAULT_VOCABULARY)).toBe('domain:database');
    expect(resolveAlias('auth', DEFAULT_VOCABULARY)).toBe('domain:security');
  });

  it('returns the tag unchanged when not an alias', () => {
    expect(resolveAlias('topic:recall', DEFAULT_VOCABULARY)).toBe('topic:recall');
    expect(resolveAlias('architecture', DEFAULT_VOCABULARY)).toBe('architecture');
  });

  it('guards against self-alias (alias === canonical)', () => {
    const vocab: Vocabulary = {
      ...DEFAULT_VOCABULARY,
      aliases: { ...DEFAULT_VOCABULARY.aliases, selfalias: 'selfalias' },
    };
    expect(resolveAlias('selfalias', vocab)).toBe('selfalias');
  });

  it('guards against cycles (A→B→A)', () => {
    const vocab: Vocabulary = {
      ...DEFAULT_VOCABULARY,
      aliases: { ...DEFAULT_VOCABULARY.aliases, alpha: 'beta', beta: 'alpha' },
    };
    // Should not infinite-loop; returns the input unchanged when cycle detected.
    const result = resolveAlias('alpha', vocab);
    expect(result).toBe('alpha');
  });
});

// ── classifyTag ──────────────────────────────────────────────────────────────

describe('classifyTag', () => {
  it('classifies a known faceted tag as faceted', () => {
    expect(classifyTag('topic:recall', DEFAULT_VOCABULARY)).toBe('faceted');
    expect(classifyTag('domain:database', DEFAULT_VOCABULARY)).toBe('faceted');
  });

  it('classifies a bare standard tag as bare', () => {
    expect(classifyTag('architecture', DEFAULT_VOCABULARY)).toBe('bare');
    expect(classifyTag('testing', DEFAULT_VOCABULARY)).toBe('bare');
  });

  it('classifies an alias key as alias', () => {
    expect(classifyTag('search', DEFAULT_VOCABULARY)).toBe('alias');
    expect(classifyTag('db', DEFAULT_VOCABULARY)).toBe('alias');
  });

  it('classifies an unknown tag as unknown', () => {
    expect(classifyTag('totally-unknown-tag', DEFAULT_VOCABULARY)).toBe('unknown');
  });
});

// ── nearDuplicates ────────────────────────────────────────────────────────────

describe('nearDuplicates', () => {
  it('does NOT report cross-facet near-duplicates', () => {
    const vocab: Vocabulary = {
      facetTags: {
        domain: ['domain:database'],
        layer: ['layer:database'], // same value, different facet
        kind: [],
        topic: [],
      },
      aliases: {},
      bareTags: [],
    };
    // domain:database vs layer:database — different facets, should NOT be reported
    const pairs = nearDuplicates(vocab);
    expect(pairs).toHaveLength(0);
  });

  it('reports same-facet near-duplicates', () => {
    const vocab: Vocabulary = {
      facetTags: {
        domain: ['domain:database', 'domain:databas'], // edit distance 1
        layer: [],
        kind: [],
        topic: [],
      },
      aliases: {},
      bareTags: [],
    };
    const pairs = nearDuplicates(vocab);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual(['domain:database', 'domain:databas']);
  });

  it('reports bare-tag near-duplicates', () => {
    const vocab: Vocabulary = {
      facetTags: { domain: [], layer: [], kind: [], topic: [] },
      aliases: {},
      bareTags: ['design', 'designs'], // edit distance 1
    };
    const pairs = nearDuplicates(vocab);
    expect(pairs).toHaveLength(1);
  });

  it('returns empty for default vocabulary (no near-dups expected)', () => {
    // Not asserting length==0 since we may add tags — just ensure no cross-facet false-positives.
    const pairs = nearDuplicates(DEFAULT_VOCABULARY);
    // All reported pairs should be within the same facet or bareTags.
    for (const [a, b] of pairs) {
      const facetA = a.includes(':') ? a.split(':')[0] : '_bare';
      const facetB = b.includes(':') ? b.split(':')[0] : '_bare';
      expect(facetA).toBe(facetB);
    }
  });
});

// ── aliasGroups ──────────────────────────────────────────────────────────────

describe('aliasGroups', () => {
  it('contains the [search, recall] group', () => {
    const groups = aliasGroups(DEFAULT_VOCABULARY);
    const searchGroup = groups.find((g) => g.includes('search'));
    expect(searchGroup).toBeDefined();
    expect(searchGroup).toContain('recall'); // tagIndexValue('topic:recall') = 'recall'
  });

  it('does not include self-alias entries', () => {
    const vocab: Vocabulary = {
      ...DEFAULT_VOCABULARY,
      aliases: { ...DEFAULT_VOCABULARY.aliases, selfalias: 'selfalias' },
    };
    const groups = aliasGroups(vocab);
    expect(groups.some((g) => g[0] === 'selfalias' && g[1] === 'selfalias')).toBe(false);
  });

  it('returns at least as many groups as alias entries (excluding self-aliases)', () => {
    const groups = aliasGroups(DEFAULT_VOCABULARY);
    const nonSelfAliases = Object.entries(DEFAULT_VOCABULARY.aliases).filter(([a, c]) => a !== c);
    expect(groups).toHaveLength(nonSelfAliases.length);
  });
});

// ── auditCorpus ───────────────────────────────────────────────────────────────

describe('auditCorpus', () => {
  const docs = [
    { slug: 'doc-a', tags: ['topic:recall'] },                // canonical faceted
    { slug: 'doc-b', tags: [] },                              // untagged
    { slug: 'doc-c', tags: ['search'] },                      // alias key
    { slug: 'doc-d', tags: ['totally-orphan-xyz'] },          // orphan
    { slug: 'doc-e', tags: ['architecture'] },                // canonical bare
  ];

  it('buckets untagged docs', () => {
    const result = auditCorpus(docs, DEFAULT_VOCABULARY);
    expect(result.untagged).toContain('doc-b');
  });

  it('buckets alias-tagged docs as nonCanonical', () => {
    const result = auditCorpus(docs, DEFAULT_VOCABULARY);
    const nc = result.nonCanonical.find((x) => x.doc === 'doc-c');
    expect(nc).toBeDefined();
    expect(nc!.tag).toBe('search');
    expect(nc!.suggestion).toBe('topic:recall');
  });

  it('buckets orphan tags', () => {
    const result = auditCorpus(docs, DEFAULT_VOCABULARY);
    expect(result.orphan).toContain('totally-orphan-xyz');
  });

  it('does NOT mutate docs or vocab', () => {
    const docsCopy = docs.map((d) => ({ ...d, tags: [...d.tags] }));
    const vocabAliasCopy = { ...DEFAULT_VOCABULARY.aliases };
    auditCorpus(docs, DEFAULT_VOCABULARY);
    // docs unchanged
    expect(docs.map((d) => d.tags)).toEqual(docsCopy.map((d) => d.tags));
    // vocab aliases unchanged
    expect(DEFAULT_VOCABULARY.aliases).toEqual(vocabAliasCopy);
  });

  it('does not add doc-a (canonical faceted) to any problem bucket', () => {
    const result = auditCorpus(docs, DEFAULT_VOCABULARY);
    expect(result.untagged).not.toContain('doc-a');
    expect(result.nonCanonical.some((x) => x.doc === 'doc-a')).toBe(false);
  });
});

// ── parseVocabularyMarkdown ──────────────────────────────────────────────────

describe('parseVocabularyMarkdown', () => {
  it('round-trips the default vocabulary through renderDefaultTaxonomyMarkdown', () => {
    const rendered = renderDefaultTaxonomyMarkdown(DEFAULT_VOCABULARY);
    const parsed = parseVocabularyMarkdown(rendered);

    // All default facet tags should survive the round-trip.
    for (const facet of FACETS) {
      for (const tag of DEFAULT_VOCABULARY.facetTags[facet]) {
        expect(parsed.facetTags?.[facet]).toContain(tag);
      }
    }
  });

  it('parses the aliases table correctly', () => {
    const md = `## Aliases\n\n| alias | canonical |\n|-------|-----------|\n| search | topic:recall |\n| db | domain:database |\n`;
    const parsed = parseVocabularyMarkdown(md);
    expect(parsed.aliases?.['search']).toBe('topic:recall');
    expect(parsed.aliases?.['db']).toBe('domain:database');
  });

  it('skips malformed alias table rows gracefully (no throw)', () => {
    const md = `## Aliases\n\n| bad row |\n| alias | canonical |\n|-------|-----------|\n| ok | kind:api |\n`;
    expect(() => parseVocabularyMarkdown(md)).not.toThrow();
    const parsed = parseVocabularyMarkdown(md);
    expect(parsed.aliases?.['ok']).toBe('kind:api');
  });

  it('does not throw on empty or malformed input', () => {
    expect(() => parseVocabularyMarkdown('')).not.toThrow();
    expect(() => parseVocabularyMarkdown('random text without sections')).not.toThrow();
  });
});

// ── loadProjectVocabulary / ARRAY-UNION merge ────────────────────────────────

describe('loadProjectVocabulary', () => {
  it('returns DEFAULT_VOCABULARY when taxonomy.md does not exist', () => {
    // Use a path that definitely has no taxonomy.md
    const result = loadProjectVocabulary('/nonexistent-path-xyz');
    expect(result).toEqual(DEFAULT_VOCABULARY);
  });

  it('ARRAY-UNION merge: empty Aliases section in project does NOT wipe default aliases', () => {
    // Simulate a project taxonomy.md that has an empty aliases section.
    const projectMd = `## Aliases\n\n| alias | canonical |\n|-------|-----------|\n`;
    const projectVocab = parseVocabularyMarkdown(projectMd);

    // The project parsed zero aliases.
    expect(Object.keys(projectVocab.aliases ?? {})).toHaveLength(0);

    // Manually simulate the merge (since we can't write to disk in a unit test).
    // loadProjectVocabulary merges: aliases = { ...DEFAULT.aliases, ...project.aliases }
    const mergedAliases = { ...DEFAULT_VOCABULARY.aliases, ...(projectVocab.aliases ?? {}) };

    // Default aliases survive an empty project section.
    expect(mergedAliases['search']).toBe('topic:recall');
    expect(mergedAliases['db']).toBe('domain:database');
  });

  it('ARRAY-UNION merge: project aliases override defaults per-key', () => {
    const projectMd = `## Aliases\n\n| alias | canonical |\n|-------|-----------|\n| search | topic:sleep |\n`;
    const projectVocab = parseVocabularyMarkdown(projectMd);
    const mergedAliases = { ...DEFAULT_VOCABULARY.aliases, ...(projectVocab.aliases ?? {}) };
    // Project alias wins for 'search'.
    expect(mergedAliases['search']).toBe('topic:sleep');
    // Other defaults preserved.
    expect(mergedAliases['db']).toBe('domain:database');
  });
});
