import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ADAPTIVE_RAW_CUTOFF,
  ADAPTIVE_RELATIVE_LAMBDA,
  DENSE_GATE_MARGIN,
  DENSE_GATE_RAW,
  bm25Confident,
  fuseRankings,
  hybridSearch,
  type DenseHit,
} from '../../src/lib/embeddings/hybrid.js';
import { bm25Search, buildFields, docKey, type CorpusDoc, type RecallHit } from '../../src/lib/recall.js';

// Never load the real ONNX model in unit tests.
vi.mock('../../src/lib/embeddings/embedder.js', () => ({
  EMBED_MODEL: 'test-model',
  EMBED_DIMS: 4,
  embeddingsAvailable: vi.fn(async () => true),
  embedPassages: vi.fn(),
  embedQuery: vi.fn(),
}));
import { embedPassages, embedQuery } from '../../src/lib/embeddings/embedder.js';

function fakeVec(text: string): Float32Array {
  const v = new Float32Array([1, (text.length % 97) / 97, (text.charCodeAt(0) % 31) / 31, 0.5]);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm) as Float32Array;
}

function makeDoc(slug: string, body: string, path = `/virtual/${slug}.md`): CorpusDoc {
  const title = slug.replace(/-/g, ' ');
  const fields = buildFields({ slug, title, description: '', tags: [], body });
  return {
    type: 'knowledge', path, relPath: `knowledge/${slug}.md`, slug, title, description: '', tags: [], body,
    tokens: fields.tokens, tokenSet: new Set(fields.tokens), termFreq: fields.termFreq,
    fieldFreq: fields.fieldFreq, fieldLen: fields.fieldLen, links: fields.links, identityTokens: fields.identityTokens,
  } as CorpusDoc;
}

const hit = (doc: CorpusDoc, score: number, rankScore: number): RecallHit => ({ doc, score, rankScore, snippet: '' });

describe('bm25Confident (the dense gate predicate)', () => {
  const doc = makeDoc('some-doc', 'body');
  const other = makeDoc('other-doc', 'body');
  /** Two hits whose top-1 / top-2 rankScore ratio is `lead`. */
  const lead = (raw: number, ratio: number): RecallHit[] => [hit(doc, raw, ratio * 10), hit(other, raw / 2, 10)];

  it('raw score: true from DENSE_GATE_RAW up, however thin the lead', () => {
    expect(bm25Confident(lead(DENSE_GATE_RAW, 1.0))).toBe(true);
    expect(bm25Confident(lead(DENSE_GATE_RAW + 6, 1.0))).toBe(true);
    expect(bm25Confident(lead(DENSE_GATE_RAW - 0.1, 1.0))).toBe(false);
  });

  it('a decisive top-1 lead also counts, once the match is past the weak zone', () => {
    expect(bm25Confident(lead(ADAPTIVE_RAW_CUTOFF + 2, DENSE_GATE_MARGIN))).toBe(true);
    expect(bm25Confident(lead(ADAPTIVE_RAW_CUTOFF + 2, DENSE_GATE_MARGIN - 0.01))).toBe(false);
  });

  it('...but never in the weak zone (below the fusion cutoff), where dense earns its keep', () => {
    expect(bm25Confident(lead(ADAPTIVE_RAW_CUTOFF - 0.1, 5))).toBe(false);
    // a one-hit result there has an unbounded "lead" — exactly the weak lexical match dense rescues
    expect(bm25Confident([hit(doc, ADAPTIVE_RAW_CUTOFF - 0.1, 50)])).toBe(false);
  });

  it('a single strong hit (nothing to lead over) is confident past the weak zone', () => {
    expect(bm25Confident([hit(doc, ADAPTIVE_RAW_CUTOFF + 1, 5)])).toBe(true);
  });

  it('reads the RAW score for the gate, never the derived rankScore (decoupling invariant)', () => {
    expect(bm25Confident([hit(doc, 3, 500), hit(other, 2, 499)])).toBe(false);
    expect(bm25Confident([hit(doc, 40, 1), hit(other, 39, 1)])).toBe(true);
  });

  it('uses the best raw score in the list, wherever it sits', () => {
    expect(bm25Confident([hit(doc, 5, 9), hit(other, DENSE_GATE_RAW + 2, 1)])).toBe(true);
  });

  it('is false for no hits; thresholds are overridable per call', () => {
    expect(bm25Confident([])).toBe(false);
    expect(bm25Confident(lead(15, 1.0), 14)).toBe(true);
    expect(bm25Confident(lead(15, 1.1), 99, 1.05)).toBe(true);
    expect(bm25Confident(lead(15, 1.1), 99, 1.2)).toBe(false);
  });

  it('the raw gate sits at or above the fusion cutoff — dense is skipped only where fusion would be score-based', () => {
    expect(DENSE_GATE_RAW).toBeGreaterThanOrEqual(ADAPTIVE_RAW_CUTOFF);
  });
});

describe('hybridSearch dense gate', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-gate-'));
    vi.mocked(embedPassages).mockImplementation(async (texts: string[]) => texts.map(fakeVec));
    vi.mocked(embedQuery).mockImplementation(async (text: string) => fakeVec(text));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.mocked(embedPassages).mockReset();
    vi.mocked(embedQuery).mockReset();
  });

  function corpusOnDisk(): CorpusDoc[] {
    const mk = (slug: string, body: string): CorpusDoc => {
      const path = join(root, `${slug}.md`);
      writeFileSync(path, body);
      return makeDoc(slug, body, path);
    };
    return [
      mk('alpha-engine', 'The alpha engine handles BM25 ranking and scoring. ' + 'ranking detail '.repeat(60)),
      mk('beta-cache', 'The beta cache stores content hashes for chunks. ' + 'cache detail '.repeat(60)),
      mk('gamma-notes', 'Unrelated notes about deployment pipelines and release ranking. ' + 'deploy detail '.repeat(60)),
    ];
  }
  const QUERY = 'alpha engine bm25 ranking';

  it("auto: a confident BM25 answers alone — no query embedding, no index refresh, no cache written", async () => {
    const corpus = corpusOnDisk();
    const bm25 = bm25Search(QUERY, corpus, 10);
    expect(bm25[0].score).toBeGreaterThan(0.5);

    const out = await hybridSearch(QUERY, corpus, root, 10, { denseGate: 'auto', denseGateRaw: 0.5 });

    expect(out.map((h) => docKey(h.doc))).toEqual(bm25.map((h) => docKey(h.doc)));
    expect(out.map((h) => h.rankScore)).toEqual(bm25.map((h) => h.rankScore));
    expect(embedQuery).not.toHaveBeenCalled();
    expect(embedPassages).not.toHaveBeenCalled();
    expect(existsSync(join(root, '.embeddings'))).toBe(false);
  });

  it('auto is the default', async () => {
    const corpus = corpusOnDisk();
    await hybridSearch(QUERY, corpus, root, 10, { denseGateRaw: 0.5 });
    expect(embedQuery).not.toHaveBeenCalled();
  });

  it('auto: an unsure BM25 (below the gate) still runs the dense channel', async () => {
    const corpus = corpusOnDisk();
    await hybridSearch(QUERY, corpus, root, 10, { denseGateRaw: 1e9 });
    expect(embedQuery).toHaveBeenCalledTimes(1);
    expect(embedPassages).toHaveBeenCalled();
  });

  it("always: the dense channel runs even when BM25 is confident", async () => {
    const corpus = corpusOnDisk();
    await hybridSearch(QUERY, corpus, root, 10, { denseGate: 'always', denseGateRaw: 0.5 });
    expect(embedQuery).toHaveBeenCalledTimes(1);
    expect(existsSync(join(root, '.embeddings', 'cache.json'))).toBe(true);
  });

  it('a gated query still honours topK', async () => {
    const corpus = corpusOnDisk();
    const out = await hybridSearch(QUERY, corpus, root, 1, { denseGateRaw: 0.5 });
    expect(out).toHaveLength(1);
  });
});

describe('fuseRankings', () => {
  const target = makeDoc('publish-checklist', 'how to publish');
  const sibling = makeDoc('release-publish-checklist', 'how to publish a release');
  const corpus = [target, sibling];
  // BM25 has the exact-slug doc first by a hair; dense (the larger the model, the more so)
  // prefers the longer-named sibling. Raw scores sit in the score-fusion zone.
  const bm25 = [hit(target, 20, 22.0), hit(sibling, 19.9, 21.99)];
  const dense: DenseHit[] = [
    { docKey: docKey(sibling), sim: 0.9 },
    { docKey: docKey(target), sim: 0.1 },
  ];

  it('navigational pin: a query that spells the top BM25 doc\'s slug keeps it first against dense', () => {
    const out = fuseRankings('publish checklist', bm25, dense, corpus, 10);
    expect(docKey(out[0].doc)).toBe(docKey(target));
  });

  it('...but only when the query SPELLS the slug: any other wording lets dense decide', () => {
    const out = fuseRankings('publish checklist for the release', bm25, dense, corpus, 10);
    expect(docKey(out[0].doc)).toBe(docKey(sibling));
  });

  it('the pin ignores word order and inflection, like the BM25 tokenizer does', () => {
    const out = fuseRankings('Checklist PUBLISH', bm25, dense, corpus, 10);
    expect(docKey(out[0].doc)).toBe(docKey(target));
  });

  it('does not pin a doc BM25 itself did not put first', () => {
    const swapped = [hit(sibling, 20, 22.0), hit(target, 19.9, 21.99)];
    const out = fuseRankings('publish checklist', swapped, dense, corpus, 10);
    expect(docKey(out[0].doc)).toBe(docKey(sibling));
  });

  it('decoupling invariant: raw `score` is BM25\'s verbatim, 0 for dense-only hits', () => {
    const extra = makeDoc('dense-only-doc', 'something else entirely');
    const out = fuseRankings('release notes', bm25, [...dense, { docKey: docKey(extra), sim: 0.8 }], [...corpus, extra], 10);
    const byKey = new Map(out.map((h) => [docKey(h.doc), h]));
    expect(byKey.get(docKey(target))?.score).toBe(20);
    expect(byKey.get(docKey(sibling))?.score).toBe(19.9);
    expect(byKey.get(docKey(extra))?.score).toBe(0);
  });

  it('the confident-zone dense share is ADAPTIVE_RELATIVE_LAMBDA, and adaptiveLambda overrides it', () => {
    // λ = 0 → BM25's own order; the default λ lets a strong dense preference through.
    const bm25Only = fuseRankings('publish checklist for the release', bm25, dense, corpus, 10, { adaptiveLambda: 0 });
    expect(docKey(bm25Only[0].doc)).toBe(docKey(target));
    expect(ADAPTIVE_RELATIVE_LAMBDA).toBeGreaterThan(0.5);
    const dflt = fuseRankings('publish checklist for the release', bm25, dense, corpus, 10);
    expect(docKey(dflt[0].doc)).toBe(docKey(sibling));
  });

  it('respects topK', () => {
    expect(fuseRankings('release', bm25, dense, corpus, 1)).toHaveLength(1);
  });
});

describe('fusion and gate are per model', () => {
  async function loadHybrid(selector: string) {
    const prev = process.env.DREAMCONTEXT_EMBED_MODEL;
    process.env.DREAMCONTEXT_EMBED_MODEL = selector;
    vi.resetModules();
    try {
      return await import('../../src/lib/embeddings/hybrid.js');
    } finally {
      if (prev === undefined) delete process.env.DREAMCONTEXT_EMBED_MODEL; else process.env.DREAMCONTEXT_EMBED_MODEL = prev;
    }
  }

  it('Gemma keeps the frozen T10 config', async () => {
    const h = await loadHybrid('embeddinggemma-q8');
    expect([h.ADAPTIVE_RAW_CUTOFF, h.ADAPTIVE_RELATIVE_LAMBDA, h.DENSE_GATE_RAW, h.DENSE_GATE_MARGIN]).toEqual([12, 0.7, 24, 1.25]);
    expect([h.ADAPTIVE_RRF_BM25_WEIGHT, h.ADAPTIVE_PIN_MARGIN]).toEqual([0.6, 1.35]);
  });

  it('e5-small is exactly the pre-2026-10 fusion: cutoff 18, λ 0.1, RRF 0.6, pin 1.35, NO dense gate', async () => {
    const h = await loadHybrid('e5-small');
    expect([h.ADAPTIVE_RAW_CUTOFF, h.ADAPTIVE_RELATIVE_LAMBDA, h.ADAPTIVE_RRF_BM25_WEIGHT, h.ADAPTIVE_PIN_MARGIN]).toEqual([18, 0.1, 0.6, 1.35]);
    expect(h.DENSE_GATE_RAW).toBe(Infinity);
    expect(h.DENSE_GATE_MARGIN).toBe(Infinity);
  });

  it('e5 never skips dense — not on a huge raw score, a decisive lead, or a single hit', async () => {
    const h = await loadHybrid('e5-small');
    const a = makeDoc('doc-a', 'x'), b = makeDoc('doc-b', 'y');
    expect(h.bm25Confident([hit(a, 500, 500), hit(b, 1, 1)])).toBe(false);
    expect(h.bm25Confident([hit(a, 50, 90)])).toBe(false);
  });

  it('e5 under the default options runs the dense channel even for a confident BM25', async () => {
    const h = await loadHybrid('e5-small');
    const root = mkdtempSync(join(tmpdir(), 'dc-gate-e5-'));
    try {
      vi.mocked(embedPassages).mockImplementation(async (texts: string[]) => texts.map(fakeVec));
      vi.mocked(embedQuery).mockImplementation(async (text: string) => fakeVec(text));
      const path = join(root, 'alpha-engine.md');
      writeFileSync(path, 'The alpha engine handles BM25 ranking. ' + 'ranking detail '.repeat(60));
      const corpus = [makeDoc('alpha-engine', 'The alpha engine handles BM25 ranking. ' + 'ranking detail '.repeat(60), path)];
      await h.hybridSearch('alpha engine bm25 ranking', corpus, root, 10);
      expect(embedQuery).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
      vi.mocked(embedPassages).mockReset();
      vi.mocked(embedQuery).mockReset();
    }
  });

  it('e5 fusion uses λ 0.1, so a strong dense preference does NOT overturn BM25 where Gemma\'s λ 0.7 would', async () => {
    const e5 = await loadHybrid('e5-small');
    const target = makeDoc('publish-checklist', 'how to publish');
    const sibling = makeDoc('release-publish-checklist', 'how to publish a release');
    const bm25 = [hit(target, 20, 22.0), hit(sibling, 19.9, 21.99)];
    const dense: DenseHit[] = [{ docKey: docKey(sibling), sim: 0.9 }, { docKey: docKey(target), sim: 0.1 }];
    // raw 20 ≥ e5's cutoff 18 → score fusion at λ 0.1
    const out = e5.fuseRankings('publish checklist for the release', bm25, dense, [target, sibling], 10);
    expect(docKey(out[0].doc)).toBe(docKey(target));
  });
});
