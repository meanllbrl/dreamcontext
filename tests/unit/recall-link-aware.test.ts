import { describe, it, expect } from 'vitest';

import {
  bm25Search,
  buildLinkAdjacency,
  tokenize,
  type CorpusDoc,
} from '../../src/lib/recall.js';

// ── B5 regression: link-aware 2-hop boost via [[slug]] wikilinks, DEFAULT OFF. ──
//
// Topology (the strong seed `a` matches the query hard; b/c/d/u match it weakly
// and equally):
//   a --[[b]]--> b --[[c]]--> c --[[d]]--> d        u (unlinked)
// Boost flows OUTWARD from the strongly-scoring seed `a`:
//   b is 1 hop from a  → full 1-hop boost
//   c is 2 hops from a → smaller (LINK_DECAY^2) boost
//   d is 3 hops from a → NO boost (only neighbours + neighbours-of-neighbours)
//   u is unlinked      → NO boost
// So with linkAware ON: b > c > d == u; with it OFF: b == c == d == u.

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

function mkDoc(opts: { slug: string; title?: string; body?: string }): CorpusDoc {
  const { slug, title = '', body = '' } = opts;
  const allText = [title, body].join(' ');
  const tokens = tokenize(allText);
  const termFreq = new Map<string, number>();
  for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
  return {
    type: 'knowledge',
    path: `/x/${slug}.md`,
    relPath: `knowledge/${slug}.md`,
    slug,
    title,
    body,
    description: '',
    tags: [],
    tokens,
    tokenSet: new Set(tokens),
    termFreq,
    fieldFreq: new Map(termFreq),
    fieldLen: tokens.length,
    links: parseLinks(body), // B5: parsed from [[slug]] in the body, as the loader does
    identityTokens: tokenize(`${slug} ${title}`),
  };
}

function corpus(): CorpusDoc[] {
  return [
    mkDoc({ slug: 'a', title: 'alpha', body: 'topic topic topic topic topic core seed [[b]]' }),
    mkDoc({ slug: 'b', title: 'beta', body: 'beta note topic [[c]]' }),
    mkDoc({ slug: 'c', title: 'gamma', body: 'gamma note topic [[d]]' }),
    mkDoc({ slug: 'd', title: 'delta', body: 'delta note topic' }),
    mkDoc({ slug: 'u', title: 'uu', body: 'uu note topic' }),
  ];
}

const NOW = new Date('2026-06-01T00:00:00Z');

describe('buildLinkAdjacency B5', () => {
  it('builds 1-hop adjacency from [[slug]] wikilinks, ignoring dangling/self links', () => {
    const docs = corpus();
    const adj = buildLinkAdjacency(docs);
    expect([...(adj.get('a') ?? [])]).toEqual(['b']);
    expect([...(adj.get('b') ?? [])]).toEqual(['c']);
    expect([...(adj.get('c') ?? [])]).toEqual(['d']);
    expect([...(adj.get('d') ?? [])]).toEqual([]);
    expect([...(adj.get('u') ?? [])]).toEqual([]);
  });
});

describe('bm25Search B5: link-aware boost (opts.linkAware: true)', () => {
  function bySlug(hits: ReturnType<typeof bm25Search>): Record<string, number> {
    return Object.fromEntries(hits.map((h) => [h.doc.slug, h.rankScore]));
  }

  it('OFF (default): all equally-weak docs share the same rankScore', () => {
    const off = bySlug(bm25Search('topic', corpus(), 10, { now: NOW }));
    expect(off.b).toBeCloseTo(off.u, 10);
    expect(off.c).toBeCloseTo(off.u, 10);
    expect(off.d).toBeCloseTo(off.u, 10);
  });

  it('ON: a linked weak doc (1-hop) is boosted above an unlinked equally-weak doc', () => {
    const on = bySlug(bm25Search('topic', corpus(), 10, { now: NOW, linkAware: true }));
    expect(on.b).toBeGreaterThan(on.u);
  });

  it('ON: 2-hop gets LESS boost than 1-hop, and 3-hop gets NONE', () => {
    const on = bySlug(bm25Search('topic', corpus(), 10, { now: NOW, linkAware: true }));
    // 1-hop (b) > 2-hop (c) > 3-hop (d).
    expect(on.b).toBeGreaterThan(on.c);
    expect(on.c).toBeGreaterThan(on.d);
    // 3-hop (d) receives no boost → equal to the unlinked baseline (u).
    expect(on.d).toBeCloseTo(on.u, 10);
  });

  it('linkAware defaults OFF: the default call does NOT apply the boost', () => {
    const docs = corpus();
    const defaultRank = Object.fromEntries(
      bm25Search('topic', docs, 10, { now: NOW }).map((h) => [h.doc.slug, h.rankScore]),
    );
    const explicitOff = Object.fromEntries(
      bm25Search('topic', docs, 10, { now: NOW, linkAware: false }).map((h) => [h.doc.slug, h.rankScore]),
    );
    // Calling with no linkAware === calling with linkAware:false.
    for (const slug of ['a', 'b', 'c', 'd', 'u']) {
      expect(defaultRank[slug]).toBeCloseTo(explicitOff[slug], 10);
    }
    // And under default, the linked weak doc is NOT lifted above the unlinked one.
    expect(defaultRank.b).toBeCloseTo(defaultRank.u, 10);
  });

  it('the strong seed (a) still ranks first regardless of link-aware', () => {
    const onHits = bm25Search('topic', corpus(), 10, { now: NOW, linkAware: true });
    const offHits = bm25Search('topic', corpus(), 10, { now: NOW });
    expect(onHits[0].doc.slug).toBe('a');
    expect(offHits[0].doc.slug).toBe('a');
  });
});
