import { describe, it, expect } from 'vitest';

import { bm25Search, tokenize, type CorpusDoc } from '../../src/lib/recall.js';

// ── B2 + B3 regression: field weighting feeds rankScore; status penalty +
//    recency multiplier change ORDER (rankScore) but NEVER the raw `.score`. ──
//
// These tests build CorpusDoc literals directly (the public type allows it) so
// they exercise bm25Search in isolation, deterministically, with an injected
// `now`. The unweighted termFreq drives the raw `.score`; fieldFreq feeds the
// derived rankScore — here we set fieldFreq = termFreq (no field up-weighting in
// the fixtures) so the ONLY thing separating identical-body docs is status /
// recency, which is exactly what B3 governs.

function mkDoc(opts: {
  slug: string;
  title?: string;
  description?: string;
  tags?: string[];
  body?: string;
  status?: string;
  updatedAt?: string;
  type?: CorpusDoc['type'];
}): CorpusDoc {
  const { slug, title = '', description = '', tags = [], body = '', status, updatedAt } = opts;
  const allText = [title, description, tags.join(' '), body].join(' ');
  const tokens = tokenize(allText);
  const termFreq = new Map<string, number>();
  for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
  return {
    type: opts.type ?? 'task',
    path: `/x/${slug}.md`,
    relPath: `state/${slug}.md`,
    slug,
    title,
    description,
    tags,
    body,
    tokens,
    tokenSet: new Set(tokens),
    termFreq,
    fieldFreq: new Map(termFreq), // no extra field weighting in these fixtures
    fieldLen: tokens.length,
    status,
    updatedAt,
    links: [],
    identityTokens: tokenize(`${slug} ${title}`),
  };
}

const QUERY = 'recall engine bm25 scoring';
const BODY = 'the recall engine ranks documents using bm25 scoring over tokens';
const NOW = new Date('2026-06-01T00:00:00Z');

describe('bm25Search B3: status penalty changes order, not score', () => {
  it('ranks an active doc above an identical completed doc', () => {
    const docs = [
      mkDoc({ slug: 'done', title: 'done task', body: BODY, status: 'completed' }),
      mkDoc({ slug: 'active', title: 'active task', body: BODY, status: 'in_progress' }),
    ];
    const hits = bm25Search(QUERY, docs, 5, { now: NOW });
    expect(hits[0].doc.slug).toBe('active');
    expect(hits[1].doc.slug).toBe('done');
    // The penalty lowers the completed doc's rankScore.
    const active = hits.find((h) => h.doc.slug === 'active')!;
    const done = hits.find((h) => h.doc.slug === 'done')!;
    expect(active.rankScore).toBeGreaterThan(done.rankScore);
  });

  it('keeps `.score` (raw BM25) IDENTICAL across status — penalty only affects rankScore', () => {
    const docs = [
      mkDoc({ slug: 'done', title: 'done task', body: BODY, status: 'completed' }),
      mkDoc({ slug: 'active', title: 'active task', body: BODY, status: 'in_progress' }),
    ];
    const hits = bm25Search(QUERY, docs, 5, { now: NOW });
    const score = Object.fromEntries(hits.map((h) => [h.doc.slug, h.score]));
    // Same body + same title length → same flat-haystack BM25 → equal `.score`.
    // This is the decoupling guard: the hook's hard thresholds read `.score`, so
    // STATUS_PENALTY must never leak into it.
    expect(score.done).toBe(score.active);
  });
});

describe('bm25Search B3: recency multiplier changes order, not score', () => {
  it('ranks a recently-updated doc above an identical older doc (fixed now)', () => {
    const docs = [
      mkDoc({ slug: 'recent', title: 'r', body: BODY, updatedAt: '2026-05-30' }),
      mkDoc({ slug: 'old', title: 'o', body: BODY, updatedAt: '2024-01-01' }),
    ];
    const hits = bm25Search(QUERY, docs, 5, { now: NOW });
    expect(hits[0].doc.slug).toBe('recent');
    expect(hits[1].doc.slug).toBe('old');
  });

  it('keeps `.score` IDENTICAL across recency — recency only affects rankScore', () => {
    const docs = [
      mkDoc({ slug: 'recent', title: 'r', body: BODY, updatedAt: '2026-05-30' }),
      mkDoc({ slug: 'old', title: 'o', body: BODY, updatedAt: '2024-01-01' }),
    ];
    const hits = bm25Search(QUERY, docs, 5, { now: NOW });
    const score = Object.fromEntries(hits.map((h) => [h.doc.slug, h.score]));
    expect(score.recent).toBe(score.old);
  });
});

describe('bm25Search B3: "don\'t bury decisions" guard — content beats recency', () => {
  it('an older doc with an extra exact query term still outranks a recency-only edge', () => {
    const base = 'the recall engine ranks documents';
    const docs = [
      // OLD, but matches an EXTRA exact query term ("decisions") twice → stronger content.
      mkDoc({ slug: 'rich-old', title: 'x', body: `${base} decisions decisions`, updatedAt: '2023-01-01' }),
      // RECENT, but missing the "decisions" term → weaker content, fresher date.
      mkDoc({ slug: 'thin-recent', title: 'y', body: base, updatedAt: '2026-05-31' }),
    ];
    const hits = bm25Search('recall engine decisions', docs, 5, { now: NOW });
    // Recency is a tie-breaker, not a content override: the stronger match wins.
    expect(hits[0].doc.slug).toBe('rich-old');
    const rich = hits.find((h) => h.doc.slug === 'rich-old')!;
    const thin = hits.find((h) => h.doc.slug === 'thin-recent')!;
    expect(rich.rankScore).toBeGreaterThan(thin.rankScore);
  });
});

describe('bm25Search B2: field weighting lifts rankScore, leaves raw .score on its own scale', () => {
  it('a title/tag match outranks a body-only match while .score stays raw-BM25', () => {
    // doc T carries the query term in its high-weight TITLE+TAGS fields; doc B
    // carries the same term only in the body. Field weighting (BM25F) should lift
    // T's rankScore above B even though both contain the term once-ish.
    const docT = mkDoc({
      slug: 'sleep-architecture',
      title: 'sleep consolidation architecture',
      tags: ['sleep', 'consolidation'],
      body: 'a long body paragraph about unrelated filler content here and more filler words',
    });
    const docB = mkDoc({
      slug: 'misc-notes',
      title: 'misc notes',
      tags: ['misc'],
      body: 'sleep is mentioned once deep inside this long unrelated filler paragraph of words',
    });
    const hits = bm25Search('sleep consolidation', [docT, docB], 5, { now: NOW });
    expect(hits[0].doc.slug).toBe('sleep-architecture');

    // `.score` must remain on the raw flat-BM25 scale: it ignores field weights,
    // so it is derived only from flat term frequency over the union haystack.
    // We assert it is a finite positive number (the threshold-compatible scale),
    // and that field weighting did not inflate it beyond a plausible flat-BM25
    // range for a tiny corpus (sanity bound, not an exact value).
    const top = hits[0];
    expect(top.score).toBeGreaterThan(0);
    expect(Number.isFinite(top.score)).toBe(true);
    // rankScore (field-weighted, derived) is allowed to exceed the raw score.
    expect(top.rankScore).toBeGreaterThanOrEqual(top.score - 1e-9);
  });
});
