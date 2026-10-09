import { describe, it, expect } from 'vitest';

import { bm25Search, stemToken, tokenize, type CorpusDoc } from '../../src/lib/recall.js';
import { DIRECTED_BRIDGES, TR_EN_BRIDGE_ROWS, expandQueryTerms } from '../../src/lib/recall-synonyms.js';

// ── Turkish → English bridges: a Turkish query reaches the English canonical doc. ──
// ~370 docs across the real brains are Turkish tasks, so a Turkish query matches OTHER Turkish
// tasks on shared Turkish words and never the English doc that answers it. The bridges expand
// a Turkish term into the English words the canonical docs use — rankScore only, never the raw
// `.score`, query-side only.

function mkDoc(slug: string, body: string, type: CorpusDoc['type'] = 'knowledge'): CorpusDoc {
  const tokens = tokenize(body);
  const termFreq = new Map<string, number>();
  for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
  return {
    type,
    path: `/x/${slug}.md`,
    relPath: `knowledge/${slug}.md`,
    slug,
    title: '',
    description: '',
    tags: [],
    body,
    tokens,
    tokenSet: new Set(tokens),
    termFreq,
    fieldFreq: new Map(termFreq),
    fieldLen: tokens.length,
    links: [],
    identityTokens: tokenize(slug),
  };
}

const NOW = new Date('2026-06-01T00:00:00Z');

const canonical = (): CorpusDoc =>
  mkDoc('canonical-doc', 'The screen shows a card with the message and the search results for the report.', 'feature');
const turkishTask = (): CorpusDoc =>
  mkDoc('turkce-gorev', 'ekranı yeniden çiz ve açılışta bekleyen işi bitir, bunu bir sonraki oturuma bırak', 'task');
const filler = (): CorpusDoc[] => [
  mkDoc('filler-one', 'unrelated notes about deployment pipelines and release trains'),
  mkDoc('filler-two', 'another unrelated page on font loading and image formats'),
  mkDoc('filler-three', 'a third page about calendar sync and webhook retries'),
];

describe('TR→EN bridge table', () => {
  const keys = TR_EN_BRIDGE_ROWS.flatMap(([turkish]) => turkish.split(' '));

  it('every key is one token whose stem is stable (the lookup stems the key again)', () => {
    const unstable = keys.filter((k) => {
      const t = tokenize(k);
      return t.length !== 1 || stemToken(t[0]) !== t[0];
    });
    expect(unstable).toEqual([]);
  });

  it('every row has at least one target and every target is a real word', () => {
    for (const [turkish, english] of TR_EN_BRIDGE_ROWS) {
      expect(turkish.trim()).not.toBe('');
      const targets = english.split(' ');
      expect(targets.length).toBeGreaterThan(0);
      for (const t of targets) expect(t).toMatch(/^[a-z]+$/);
    }
  });

  it('leaves out targets so common they cannot tell docs apart', () => {
    const generic = ['file', 'user', 'live', 'decision', 'status', 'state', 'code', 'check', 'list', 'project', 'app', 'cost'];
    const targets = new Set(TR_EN_BRIDGE_ROWS.flatMap(([, english]) => english.split(' ')));
    expect(generic.filter((g) => targets.has(g))).toEqual([]);
  });

  it('registers the keys as directed bridges', () => {
    for (const key of keys) expect(DIRECTED_BRIDGES[key]?.length).toBeGreaterThan(0);
  });
});

describe('TR→EN bridge in bm25Search', () => {
  it('expands a Turkish term into its English targets at SYNONYM_WEIGHT', () => {
    const terms = expandQueryTerms(tokenize('ekranı'), stemToken);
    expect(terms.has(stemToken('screen'))).toBe(true);
  });

  it('reaches an English doc that has no Turkish term, with the raw score untouched', () => {
    const corpus = [canonical(), ...filler()];
    const hits = bm25Search('ekranı', corpus, 5, { now: NOW });
    expect(hits.map((h) => h.doc.slug)).toContain('canonical-doc');
    const hit = hits.find((h) => h.doc.slug === 'canonical-doc')!;
    expect(hit.score).toBe(0);
    expect(hit.rankScore).toBeGreaterThan(0);
  });

  it('lets the English canonical doc beat a Turkish task that only shares one Turkish word', () => {
    const corpus = [canonical(), turkishTask(), ...filler()];
    const hits = bm25Search('ekranı mesaj kartı arama', corpus, 5, { now: NOW });
    expect(hits[0].doc.slug).toBe('canonical-doc');
    // the Turkish task still matches on its own word, with a real raw score
    const task = hits.find((h) => h.doc.slug === 'turkce-gorev')!;
    expect(task.score).toBeGreaterThan(0);
  });

  it('matches the inflection the stemmer leaves unmerged (ekranda → ekra)', () => {
    const corpus = [canonical(), ...filler()];
    const hits = bm25Search('ekranda', corpus, 5, { now: NOW });
    expect(hits[0].doc.slug).toBe('canonical-doc');
  });

  it('is directed: an English query does not expand into Turkish', () => {
    const corpus = [turkishTask(), ...filler()];
    expect(bm25Search('screen', corpus, 5, { now: NOW })).toEqual([]);
  });

  it('does not change the raw score of a doc the Turkish term already matches', () => {
    const doc = turkishTask();
    const [hit] = bm25Search('ekranı', [doc, ...filler()], 3, { now: NOW });
    expect(hit.doc.slug).toBe('turkce-gorev');
    const [again] = bm25Search('ekranı', [doc, ...filler()], 3, { now: NOW, aliasGroups: [] });
    expect(again.score).toBeCloseTo(hit.score, 10);
  });
});
