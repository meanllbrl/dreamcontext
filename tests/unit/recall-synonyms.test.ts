import { describe, it, expect } from 'vitest';
import { expandQueryTerms, SYNONYM_WEIGHT } from '../../src/lib/recall-synonyms.js';
import { stemToken } from '../../src/lib/recall.js';

// Identity stem helper for clarity in tests that don't need real stemming.
const id = (t: string) => t;

describe('expandQueryTerms — extraGroups parameter', () => {
  it('no-third-arg and explicit empty array [] produce identical results', () => {
    const terms = ['recall', 'search'];
    const withoutArg = expandQueryTerms(terms, stemToken);
    const withEmptyArg = expandQueryTerms(terms, stemToken, []);
    expect([...withoutArg.entries()]).toEqual([...withEmptyArg.entries()]);
  });

  it('a term present ONLY in extraGroups expands at SYNONYM_WEIGHT', () => {
    // 'myalias' is not in SYNONYM_GROUPS or DIRECTED_BRIDGES.
    // We pass it as an extraGroup pointing to 'mycanonical'.
    const terms = [id('myalias')];
    const result = expandQueryTerms(terms, id, [['myalias', 'mycanonical']]);
    expect(result.get('mycanonical')).toBe(SYNONYM_WEIGHT);
  });

  it('extraGroups: term expands to all OTHER members, skipping itself', () => {
    const terms = [id('a')];
    const result = expandQueryTerms(terms, id, [['a', 'b', 'c']]);
    expect(result.get('b')).toBe(SYNONYM_WEIGHT);
    expect(result.get('c')).toBe(SYNONYM_WEIGHT);
    // 'a' is already primary — should NOT appear in expansions.
    expect(result.has('a')).toBe(false);
  });

  it('extraGroups: primary terms are never added to expansions', () => {
    // If 'b' is already a primary term, it must not be re-added from extraGroups.
    const terms = [id('a'), id('b')];
    const result = expandQueryTerms(terms, id, [['a', 'b', 'c']]);
    expect(result.has('b')).toBe(false);
    expect(result.get('c')).toBe(SYNONYM_WEIGHT);
  });

  it('extraGroups: stems are applied at call time (not pre-stemmed)', () => {
    // 'databases' stems to 'databas' via stemToken (same stem as 'database').
    // extraGroups member 'databases' should match a query term stemmed to 'databas'.
    const terms = [stemToken('databases')]; // 'databas'
    const result = expandQueryTerms(terms, stemToken, [['databases', 'myexpansion']]);
    // 'databases' should be found because stem('databases') === stem('databases') === 'databas'
    // and primary has 'databas'.
    expect(result.has(stemToken('myexpansion'))).toBe(true);
  });

  it('extraGroups with single-element group do nothing', () => {
    // A group of one member has nobody to expand to.
    const terms = [id('alone')];
    const result = expandQueryTerms(terms, id, [['alone']]);
    expect(result.size).toBe(0);
  });

  it('empty extraGroups leaves existing SYNONYM_GROUPS behavior intact', () => {
    // 'recall' is in SYNONYM_GROUPS with 'search'; passing [] must not disrupt.
    const terms = [stemToken('recall')];
    const withEmpty = expandQueryTerms(terms, stemToken, []);
    const without = expandQueryTerms(terms, stemToken);
    expect([...withEmpty.entries()].sort()).toEqual([...without.entries()].sort());
  });
});
