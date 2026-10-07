import { describe, it, expect } from 'vitest';

import { bm25Search, buildFields, tokenize, type CorpusDoc } from '../../src/lib/recall.js';

// ── T4 latency work must not change a single result. ──
//
// bm25Search builds a snippet only for the hits it RETURNS (extracting one
// re-tokenizes every line of the doc, which was ~90% of search time when done for
// every match). These tests pin the contract that makes that safe: a hit's
// snippet, score and rankScore depend on the query and the doc alone — never on
// how many hits the caller asked for or on where the hit sat in the match list.

const NOW = new Date('2026-10-07T00:00:00Z');

function mkDoc(slug: string, title: string, body: string, status?: string): CorpusDoc {
  const fields = buildFields({ slug, title, description: '', tags: [], body });
  return {
    type: 'knowledge',
    path: `/x/${slug}.md`,
    relPath: `knowledge/${slug}.md`,
    slug,
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
    status,
    updatedAt: '2026-09-01',
  };
}

const MULTILINE = (marker: string): string =>
  [
    'Intro paragraph with nothing relevant at all.',
    `The ${marker} subsystem is configured here and tuned for speed.`,
    'Filler line about unrelated matters.',
    'Another filler line.',
  ].join('\n');

function corpus(): CorpusDoc[] {
  const docs: CorpusDoc[] = [];
  for (let i = 0; i < 12; i++) {
    docs.push(mkDoc(`widget-${i}`, `Widget ${i}`, MULTILINE(i % 3 === 0 ? 'scheduler' : 'gateway')));
  }
  docs.push(mkDoc('scheduler-guide', 'Scheduler guide', MULTILINE('scheduler'), 'completed'));
  docs.push(mkDoc('turkish-note', 'Sunucu notu', 'Sunucusunda zamanlayıcı ayarları burada.\nBaşka satır.'));
  return docs;
}

describe('bm25Search snippets are filled for returned hits only, and are topK-independent', () => {
  const docs = corpus();
  const queries = ['scheduler configured', 'gateway tuned speed', 'sunucu zamanlayıcı', 'widget'];

  for (const query of queries) {
    it(`"${query}": the top-3 of a small call equals the top-3 of the exhaustive call`, () => {
      const all = bm25Search(query, docs, docs.length, { now: NOW });
      const top3 = bm25Search(query, docs, 3, { now: NOW });
      expect(top3.map((h) => h.doc.slug)).toEqual(all.slice(0, 3).map((h) => h.doc.slug));
      for (let i = 0; i < top3.length; i++) {
        expect(top3[i].snippet).toBe(all[i].snippet);
        expect(top3[i].score).toBe(all[i].score);
        expect(top3[i].rankScore).toBe(all[i].rankScore);
      }
    });
  }

  it('a returned hit carries the best-matching line, never an empty snippet', () => {
    const [hit] = bm25Search('scheduler configured', docs, 1, { now: NOW });
    expect(hit.snippet).toContain('scheduler');
    expect(hit.snippet).toContain('configured');
  });

  it('every returned hit has a non-empty snippet at every topK', () => {
    for (const topK of [1, 3, 10, docs.length]) {
      for (const hit of bm25Search('widget', docs, topK, { now: NOW })) {
        expect(hit.snippet.length).toBeGreaterThan(0);
      }
    }
  });

  it('is deterministic for a pinned clock', () => {
    const a = bm25Search('gateway tuned', docs, 5, { now: NOW });
    const b = bm25Search('gateway tuned', docs, 5, { now: NOW });
    expect(b).toEqual(a);
  });

  it('keeps the raw score decoupled from rankScore (hook gate input unchanged)', () => {
    const tokensOfQuery = tokenize('scheduler configured');
    expect(tokensOfQuery.length).toBeGreaterThan(0);
    const [hit] = bm25Search('scheduler configured', docs, 1, { now: NOW });
    expect(hit.score).toBeGreaterThan(0);
    expect(Number.isFinite(hit.rankScore)).toBe(true);
  });
});
