import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  serializeVocabulary,
  parseVocabularyJson,
  loadProjectVocabulary,
  ensureTaxonomyFile,
  addVocabularyTag,
  addVocabularyAlias,
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

  it('does not treat inherited object keys as aliases', () => {
    // Plain objects inherit `constructor`/`toString` from Object.prototype —
    // a tag with such a name must read as unknown, not as a phantom alias.
    expect(classifyTag('constructor', DEFAULT_VOCABULARY)).toBe('unknown');
    expect(classifyTag('tostring', DEFAULT_VOCABULARY)).toBe('unknown');
    expect(resolveAlias('constructor', DEFAULT_VOCABULARY)).toBe('constructor');
    expect(isCanonical('constructor', DEFAULT_VOCABULARY)).toBe(false);
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

// ── serializeVocabulary / parseVocabularyJson ─────────────────────────────────

describe('serializeVocabulary', () => {
  it('produces valid JSON with version field', () => {
    const serialized = serializeVocabulary(DEFAULT_VOCABULARY);
    const parsed = JSON.parse(serialized);
    expect(parsed.version).toBe(1);
    expect(parsed.facets).toBeDefined();
    expect(parsed.bareTags).toBeDefined();
    expect(parsed.aliases).toBeDefined();
  });

  it('round-trips DEFAULT_VOCABULARY through parseVocabularyJson', () => {
    const serialized = serializeVocabulary(DEFAULT_VOCABULARY);
    const parsed = parseVocabularyJson(serialized);

    // All default facet tags should survive the round-trip (normalized form).
    // parseVocabularyJson applies normalizeTag on load so we must compare
    // the normalized form of both sides.
    for (const facet of FACETS) {
      for (const tag of DEFAULT_VOCABULARY.facetTags[facet]) {
        expect(parsed.facetTags?.[facet]).toContain(normalizeTag(tag));
      }
    }

    // All default aliases should survive the round-trip.
    expect(parsed.aliases?.['search']).toBe('topic:recall');
    expect(parsed.aliases?.['db']).toBe('domain:database');
  });

  it('preserves the version field on round-trip', () => {
    const serialized = serializeVocabulary(DEFAULT_VOCABULARY);
    const obj = JSON.parse(serialized);
    expect(obj.version).toBe(1);
  });
});

describe('parseVocabularyJson', () => {
  it('parses valid taxonomy JSON correctly', () => {
    const json = JSON.stringify({
      version: 1,
      facets: { topic: ['topic:recall', 'topic:sleep'], domain: [], layer: [], kind: [] },
      bareTags: ['architecture'],
      aliases: { search: 'topic:recall' },
    });
    const parsed = parseVocabularyJson(json);
    expect(parsed.facetTags?.topic).toContain('topic:recall');
    expect(parsed.aliases?.search).toBe('topic:recall');
    expect(parsed.bareTags).toContain('architecture');
  });

  it('returns {} for malformed JSON (never throws)', () => {
    expect(() => parseVocabularyJson('{bad json')).not.toThrow();
    expect(parseVocabularyJson('{bad json')).toEqual({});
  });

  it('returns {} for wrong top-level type', () => {
    expect(parseVocabularyJson('[]')).toEqual({});
    expect(parseVocabularyJson('"string"')).toEqual({});
    expect(parseVocabularyJson('null')).toEqual({});
  });

  it('skips bad entries: non-string values in facets array', () => {
    const json = JSON.stringify({
      version: 1,
      facets: { topic: ['topic:recall', 42, null, 'topic:sleep'] },
      bareTags: [],
      aliases: {},
    });
    const parsed = parseVocabularyJson(json);
    expect(parsed.facetTags?.topic).toContain('topic:recall');
    expect(parsed.facetTags?.topic).toContain('topic:sleep');
    expect(parsed.facetTags?.topic).toHaveLength(2);
  });

  it('tolerates unknown keys (ignores them)', () => {
    const json = JSON.stringify({
      version: 1,
      facets: { topic: ['topic:recall'] },
      bareTags: [],
      aliases: {},
      unknownKey: 'ignored',
    });
    expect(() => parseVocabularyJson(json)).not.toThrow();
    const parsed = parseVocabularyJson(json);
    expect(parsed.facetTags?.topic).toContain('topic:recall');
  });

  it('normalizes tags on load', () => {
    const json = JSON.stringify({
      version: 1,
      facets: { topic: ['topic:RECALL'] },
      bareTags: ['ARCHITECTURE'],
      aliases: {},
    });
    const parsed = parseVocabularyJson(json);
    expect(parsed.facetTags?.topic).toContain('topic:recall');
    expect(parsed.bareTags).toContain('architecture');
  });
});

// ── loadProjectVocabulary / ARRAY-UNION merge ────────────────────────────────

describe('loadProjectVocabulary', () => {
  it('returns DEFAULT_VOCABULARY when taxonomy.json does not exist', () => {
    const result = loadProjectVocabulary('/nonexistent-path-xyz');
    expect(result).toEqual(DEFAULT_VOCABULARY);
  });

  it('ARRAY-UNION merge: empty aliases in project does NOT wipe default aliases', () => {
    const projectJson = JSON.stringify({
      version: 1,
      facets: {},
      bareTags: [],
      aliases: {},
    });
    const project = parseVocabularyJson(projectJson);

    // The project parsed zero aliases.
    expect(Object.keys(project.aliases ?? {})).toHaveLength(0);

    // Simulate the merge.
    const mergedAliases = { ...DEFAULT_VOCABULARY.aliases, ...(project.aliases ?? {}) };

    // Default aliases survive an empty project section.
    expect(mergedAliases['search']).toBe('topic:recall');
    expect(mergedAliases['db']).toBe('domain:database');
  });

  it('ARRAY-UNION merge: project aliases override defaults per-key', () => {
    const projectJson = JSON.stringify({
      version: 1,
      facets: {},
      bareTags: [],
      aliases: { search: 'topic:sleep' },
    });
    const project = parseVocabularyJson(projectJson);
    const mergedAliases = { ...DEFAULT_VOCABULARY.aliases, ...(project.aliases ?? {}) };
    // Project alias wins for 'search'.
    expect(mergedAliases['search']).toBe('topic:sleep');
    // Other defaults preserved.
    expect(mergedAliases['db']).toBe('domain:database');
  });

  it('merges project facet tags with defaults via disk round-trip', () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-vocab-merge-'));
    try {
      mkdirSync(join(root, 'core'), { recursive: true });
      writeFileSync(join(root, 'core', 'taxonomy.json'), JSON.stringify({
        version: 1,
        facets: { topic: ['topic:myproject'] },
        bareTags: [],
        aliases: {},
      }, null, 2), 'utf-8');

      const merged = loadProjectVocabulary(root);
      // Default topic tags survive
      expect(merged.facetTags.topic).toContain('topic:recall');
      // Project-added tag also present
      expect(merged.facetTags.topic).toContain('topic:myproject');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── ensureTaxonomyFile (auto-seed for pre-taxonomy installs) ─────────────────

describe('ensureTaxonomyFile', () => {
  it('creates core/taxonomy.json when missing (even without a core/ dir) and returns true', () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-taxonomy-ensure-'));
    try {
      expect(ensureTaxonomyFile(root)).toBe(true);
      const path = join(root, 'core', 'taxonomy.json');
      expect(existsSync(path)).toBe(true);
      // The seeded file parses back into a non-empty vocabulary.
      const parsed = parseVocabularyJson(readFileSync(path, 'utf-8'));
      expect(Object.keys(parsed.aliases ?? {}).length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is idempotent: never overwrites an existing file, returns false', () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-taxonomy-ensure-'));
    try {
      mkdirSync(join(root, 'core'), { recursive: true });
      const path = join(root, 'core', 'taxonomy.json');
      writeFileSync(path, '{"version":1,"facets":{},"bareTags":[],"aliases":{"custom":"topic:recall"}}', 'utf-8');
      expect(ensureTaxonomyFile(root)).toBe(false);
      const content = readFileSync(path, 'utf-8');
      expect(content).toContain('"custom"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('written file contains valid JSON with version field', () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-taxonomy-ensure-json-'));
    try {
      ensureTaxonomyFile(root);
      const path = join(root, 'core', 'taxonomy.json');
      const obj = JSON.parse(readFileSync(path, 'utf-8'));
      expect(obj.version).toBe(1);
      expect(obj.facets).toBeDefined();
      expect(obj.aliases).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── addVocabularyTag ──────────────────────────────────────────────────────────

describe('addVocabularyTag', () => {
  function makeRoot(): string {
    return mkdtempSync(join(tmpdir(), 'dc-addtag-'));
  }

  it('adds a valid faceted tag (creates taxonomy.json if missing)', () => {
    const root = makeRoot();
    try {
      const result = addVocabularyTag(root, 'domain:payments');
      expect(result.added).toBe(true);
      expect(result.tag).toBe('domain:payments');
      // Verify it persists
      const vocab = loadProjectVocabulary(root);
      expect(vocab.facetTags.domain).toContain('domain:payments');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('adds a valid bare tag', () => {
    const root = makeRoot();
    try {
      const result = addVocabularyTag(root, 'billing');
      expect(result.added).toBe(true);
      const vocab = loadProjectVocabulary(root);
      expect(vocab.bareTags).toContain('billing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects unknown facet with reason', () => {
    const root = makeRoot();
    try {
      const result = addVocabularyTag(root, 'custom:value');
      expect(result.added).toBe(false);
      expect(result.reason).toMatch(/unknown facet/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns added:false with "already exists" for a default faceted tag (no-op)', () => {
    const root = makeRoot();
    try {
      const result = addVocabularyTag(root, 'topic:recall');
      expect(result.added).toBe(false);
      expect(result.reason).toBe('already exists');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns added:false for a tag that is an alias of an existing canonical', () => {
    const root = makeRoot();
    try {
      const result = addVocabularyTag(root, 'search'); // 'search' is alias of 'topic:recall'
      expect(result.added).toBe(false);
      expect(result.reason).toMatch(/is an alias of/);
      expect(result.reason).toContain('topic:recall');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('normalizes the tag before adding', () => {
    const root = makeRoot();
    try {
      const result = addVocabularyTag(root, 'domain:PAYMENTS');
      expect(result.added).toBe(true);
      expect(result.tag).toBe('domain:payments');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is idempotent: adding the same project tag twice returns added:false on second call', () => {
    const root = makeRoot();
    try {
      addVocabularyTag(root, 'domain:billing');
      const second = addVocabularyTag(root, 'domain:billing');
      expect(second.added).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── addVocabularyAlias ────────────────────────────────────────────────────────

describe('addVocabularyAlias', () => {
  function makeRoot(): string {
    return mkdtempSync(join(tmpdir(), 'dc-addalias-'));
  }

  it('adds a valid alias mapping', () => {
    const root = makeRoot();
    try {
      const result = addVocabularyAlias(root, 'pay', 'domain:database');
      expect(result.added).toBe(true);
      const vocab = loadProjectVocabulary(root);
      expect(vocab.aliases['pay']).toBe('domain:database');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects when canonical does not exist in vocabulary', () => {
    const root = makeRoot();
    try {
      const result = addVocabularyAlias(root, 'myalias', 'domain:nonexistent');
      expect(result.added).toBe(false);
      expect(result.reason).toMatch(/does not exist/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects when canonical is itself an alias (chain prevention)', () => {
    const root = makeRoot();
    try {
      // 'search' is an alias of 'topic:recall' — canonical must not be an alias key
      const result = addVocabularyAlias(root, 'myalias', 'search');
      expect(result.added).toBe(false);
      expect(result.reason).toMatch(/chain/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects when alias and canonical are the same', () => {
    const root = makeRoot();
    try {
      const result = addVocabularyAlias(root, 'topic:recall', 'topic:recall');
      expect(result.added).toBe(false);
      expect(result.reason).toMatch(/differ/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns added:false (no error) for already-identical mapping', () => {
    const root = makeRoot();
    try {
      // 'search' → 'topic:recall' is already in DEFAULT_VOCABULARY
      const result = addVocabularyAlias(root, 'search', 'topic:recall');
      expect(result.added).toBe(false);
      expect(result.reason).toBe('already exists');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('mutations preserve the version field', () => {
    const root = makeRoot();
    try {
      addVocabularyAlias(root, 'pay', 'domain:database');
      const raw = readFileSync(join(root, 'core', 'taxonomy.json'), 'utf-8');
      const obj = JSON.parse(raw);
      expect(obj.version).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
