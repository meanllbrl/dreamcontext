import { describe, it, expect } from 'vitest';

import {
  bm25Search,
  tokenize,
  isBoardDoc,
  BOARD_RANK_FACTOR,
  type CorpusDoc,
} from '../../src/lib/recall.js';

// ── Label-only boards must not out-rank prose docs on a shared term. ──
// A board's indexed text is just the labels drawn on it: short and dense with the topic's
// vocabulary, so BM25F length normalisation over-ranks it (measured: it took top-1 from the
// canonical feature doc on six train queries). BOARD_RANK_FACTOR corrects the ORDER (rankScore)
// and never the raw `.score` the hook thresholds against (decoupling invariant).

function mkDoc(opts: {
  slug: string;
  type?: CorpusDoc['type'];
  body: string;
  title?: string;
}): CorpusDoc {
  const { slug, body, title = '' } = opts;
  const tokens = tokenize([title, body].join(' '));
  const termFreq = new Map<string, number>();
  for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
  return {
    type: opts.type ?? 'knowledge',
    path: `/x/${slug}.md`,
    relPath: `knowledge/${slug}.md`,
    slug,
    title,
    description: '',
    tags: [],
    body,
    tokens,
    tokenSet: new Set(tokens),
    termFreq,
    fieldFreq: new Map(termFreq),
    fieldLen: tokens.length,
    links: [],
    identityTokens: tokenize(`${slug} ${title}`),
  };
}

const NOW = new Date('2026-06-01T00:00:00Z');
const QUERY = 'threshold alert drowsy scale';
const LABELS = 'Alert\nDrowsy\nSleepy\nthreshold\nscale';
// Close enough to the labels that a non-board twin of the labels wins by LESS than 1 / BOARD_RANK_FACTOR
// (~1.36x vs 1.67x): the factor is what decides this near-tie, not a lopsided fixture.
const PROSE = 'Debt scale: every level has a threshold, from the alert level up to the drowsy level.';

const filler = (): CorpusDoc[] => [
  mkDoc({ slug: 'filler-one', body: 'unrelated notes about deployment pipelines and release trains' }),
  mkDoc({ slug: 'filler-two', body: 'another unrelated page on font loading and image formats' }),
  mkDoc({ slug: 'filler-three', body: 'a third page about calendar sync and webhook retries' }),
];

function hitFor(corpus: CorpusDoc[], slug: string) {
  const hit = bm25Search(QUERY, corpus, 10, { now: NOW }).find((h) => h.doc.slug === slug);
  if (!hit) throw new Error(`no hit for ${slug}`);
  return hit;
}

describe('isBoardDoc', () => {
  it('flags knowledge boards by their .excalidraw slug and every whiteboard', () => {
    expect(isBoardDoc(mkDoc({ slug: 'sleep-debt.excalidraw', body: LABELS }))).toBe(true);
    expect(isBoardDoc(mkDoc({ slug: 'control-panel', type: 'whiteboard', body: LABELS }))).toBe(true);
  });

  it('leaves prose docs alone, even when the slug mentions excalidraw', () => {
    expect(isBoardDoc(mkDoc({ slug: 'sleep-debt', body: PROSE }))).toBe(false);
    expect(isBoardDoc(mkDoc({ slug: 'excalidraw-skill-notes', type: 'feature', body: PROSE }))).toBe(false);
  });
});

describe('BOARD_RANK_FACTOR: a label-only board does not outrank prose', () => {
  it('premise: the same labels in a non-board doc DO beat the prose doc (length normalisation)', () => {
    const corpus = [
      mkDoc({ slug: 'labels-note', body: LABELS }),
      mkDoc({ slug: 'debt-feature', type: 'feature', body: PROSE }),
      ...filler(),
    ];
    const top = bm25Search(QUERY, corpus, 3, { now: NOW })[0];
    expect(top.doc.slug).toBe('labels-note');
  });

  it('a board with the same labels ranks below the prose doc', () => {
    const corpus = [
      mkDoc({ slug: 'labels-note.excalidraw', body: LABELS }),
      mkDoc({ slug: 'debt-feature', type: 'feature', body: PROSE }),
      ...filler(),
    ];
    const hits = bm25Search(QUERY, corpus, 3, { now: NOW });
    expect(hits[0].doc.slug).toBe('debt-feature');
    expect(hits[1].doc.slug).toBe('labels-note.excalidraw');
  });

  it('applies the factor to rankScore only: the raw score is the same as the same text in a non-board doc', () => {
    const board = mkDoc({ slug: 'labels-note.excalidraw', body: LABELS });
    const twin = mkDoc({ slug: 'labels-note', body: LABELS });
    const withBoard = hitFor([board, ...filler()], 'labels-note.excalidraw');
    const withTwin = hitFor([twin, ...filler()], 'labels-note');
    expect(withBoard.score).toBeGreaterThan(0);
    expect(withBoard.score).toBeCloseTo(withTwin.score, 10);
    expect(withBoard.rankScore).toBeCloseTo(withTwin.rankScore * BOARD_RANK_FACTOR, 10);
  });

  it('treats a whiteboard like a board', () => {
    const board = mkDoc({ slug: 'labels-note', type: 'whiteboard', body: LABELS });
    const twin = mkDoc({ slug: 'labels-note', type: 'knowledge', body: LABELS });
    const a = hitFor([board, ...filler()], 'labels-note');
    const b = hitFor([twin, ...filler()], 'labels-note');
    expect(a.score).toBeCloseTo(b.score, 10);
    expect(a.rankScore).toBeCloseTo(b.rankScore * BOARD_RANK_FACTOR, 10);
  });

  it('still surfaces a board when it is the only doc that matches', () => {
    const corpus = [mkDoc({ slug: 'labels-note.excalidraw', body: LABELS }), ...filler()];
    const hits = bm25Search(QUERY, corpus, 3, { now: NOW });
    expect(hits[0].doc.slug).toBe('labels-note.excalidraw');
    expect(hits[0].score).toBeGreaterThan(0);
  });
});
