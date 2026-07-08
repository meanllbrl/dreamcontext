import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chunkDoc } from '../../src/lib/embeddings/chunker.js';
import { refreshEmbeddings, embeddingCacheExists, embeddingCacheUsable, embeddingCacheChunkCount } from '../../src/lib/embeddings/store.js';
import { rrfFuse, relativeFuse, denseRank, hybridSearch, ADAPTIVE_RAW_CUTOFF } from '../../src/lib/embeddings/hybrid.js';
import { buildFields, type CorpusDoc } from '../../src/lib/recall.js';

// The embedder is mocked module-wide: unit tests must never load the ONNX
// model. Individual tests steer behaviour via these fns.
vi.mock('../../src/lib/embeddings/embedder.js', () => ({
  EMBED_MODEL: 'test-model',
  EMBED_DIMS: 4,
  embeddingsAvailable: vi.fn(async () => true),
  embedPassages: vi.fn(),
  embedQuery: vi.fn(),
}));
import { embedPassages, embedQuery } from '../../src/lib/embeddings/embedder.js';

/** Deterministic fake embedding: 4 dims derived from text length + first chars. */
function fakeVec(text: string): Float32Array {
  const v = new Float32Array([
    1,
    (text.length % 97) / 97,
    (text.charCodeAt(0) % 31) / 31,
    (text.charCodeAt(text.length - 1) % 13) / 13,
  ]);
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  return v.map((x) => x / norm) as Float32Array;
}

const fakeEmbed = async (texts: string[]): Promise<Float32Array[]> => texts.map(fakeVec);

function makeDoc(overrides: Partial<CorpusDoc> & { slug: string; path: string }): CorpusDoc {
  const title = overrides.title ?? overrides.slug;
  const body = overrides.body ?? '';
  const fields = buildFields({ slug: overrides.slug, title, description: '', tags: [], body });
  return {
    type: 'knowledge',
    relPath: `knowledge/${overrides.slug}.md`,
    title,
    description: '',
    tags: [],
    tokens: fields.tokens,
    tokenSet: new Set(fields.tokens),
    termFreq: fields.termFreq,
    fieldFreq: fields.fieldFreq,
    fieldLen: fields.fieldLen,
    links: fields.links,
    identityTokens: fields.identityTokens,
    ...overrides,
    body,
  } as CorpusDoc;
}

describe('embeddings chunker', () => {
  it('is deterministic: same input yields identical hashes', () => {
    const body = '# One\n\n' + 'alpha beta gamma '.repeat(60) + '\n\n## Two\n\n' + 'delta '.repeat(150);
    const a = chunkDoc('Doc', body);
    const b = chunkDoc('Doc', body);
    expect(a.map((c) => c.hash)).toEqual(b.map((c) => c.hash));
    expect(a.length).toBeGreaterThan(0);
  });

  it('splits on heading boundaries and prepends the title to every chunk', () => {
    const sectionA = 'alpha '.repeat(120);
    const sectionB = 'beta '.repeat(120);
    const chunks = chunkDoc('My Title', `# A\n\n${sectionA}\n\n# B\n\n${sectionB}`);
    expect(chunks.length).toBe(2);
    for (const c of chunks) expect(c.text.startsWith('My Title\n')).toBe(true);
    expect(chunks[0].text).toContain('alpha');
    expect(chunks[1].text).toContain('beta');
  });

  it('never emits a whole-doc chunk for long multi-section bodies', () => {
    const body = Array.from({ length: 6 }, (_, i) => `## S${i}\n\n${'word '.repeat(300)}`).join('\n\n');
    const chunks = chunkDoc('Doc', body);
    expect(chunks.length).toBeGreaterThanOrEqual(6);
    for (const c of chunks) {
      const words = c.text.split(/\s+/).length;
      expect(words).toBeLessThanOrEqual(420); // MAX_WORDS + title slack
    }
  });

  it('merges runt sections instead of emitting tiny chunks', () => {
    const body = '## A\n\nshort one\n\n## B\n\nshort two\n\n## C\n\nshort three';
    const chunks = chunkDoc('Doc', body);
    expect(chunks.length).toBe(1);
  });

  it('falls back to a title chunk for an empty body', () => {
    const chunks = chunkDoc('Only Title', '', 'a description');
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toContain('Only Title');
  });
});

describe('embeddings store (incremental refresh)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-embed-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeDocFile(slug: string, body: string): string {
    const path = join(root, `${slug}.md`);
    writeFileSync(path, body);
    return path;
  }

  it('embeds everything on first refresh, nothing on the second (mtime pre-filter)', async () => {
    const p1 = writeDocFile('a', 'alpha '.repeat(150));
    const p2 = writeDocFile('b', 'beta '.repeat(150));
    const corpus = [
      makeDoc({ slug: 'a', path: p1, body: 'alpha '.repeat(150) }),
      makeDoc({ slug: 'b', path: p2, body: 'beta '.repeat(150) }),
    ];

    const first = await refreshEmbeddings(root, corpus, fakeEmbed);
    expect(first).not.toBeNull();
    expect(first!.stats.embedded).toBeGreaterThan(0);
    expect(first!.index.chunks.length).toBe(first!.stats.embedded);

    const second = await refreshEmbeddings(root, corpus, fakeEmbed);
    expect(second!.stats.embedded).toBe(0);
    expect(second!.index.chunks.length).toBe(first!.index.chunks.length);
  });

  it('cache readiness: exists vs USABLE (model/version gate) + chunk count', async () => {
    const p1 = writeDocFile('a', 'alpha '.repeat(150));
    const corpus = [makeDoc({ slug: 'a', path: p1, body: 'alpha '.repeat(150) })];

    // Cold vault: no cache → neither exists nor usable, 0 chunks.
    expect(embeddingCacheExists(root)).toBe(false);
    expect(embeddingCacheUsable(root)).toBe(false);
    expect(embeddingCacheChunkCount(root)).toBe(0);

    const first = await refreshEmbeddings(root, corpus, fakeEmbed);
    expect(embeddingCacheExists(root)).toBe(true);
    expect(embeddingCacheUsable(root)).toBe(true);
    expect(embeddingCacheChunkCount(root)).toBe(first!.index.chunks.length);

    // Stale cache from a PRIOR model: the file still exists, but it is NOT usable
    // (hybridReady must fall back to BM25 instead of forcing a full inline re-index).
    const cachePath = join(root, '.embeddings', 'cache.json');
    const parsed = JSON.parse(readFileSync(cachePath, 'utf-8'));
    parsed.model = 'OLD/stale-model';
    writeFileSync(cachePath, JSON.stringify(parsed));
    // Bump mtime so the mtime-keyed usability memo re-evaluates.
    const now = Date.now() / 1000 + 5;
    utimesSync(cachePath, now, now);
    expect(embeddingCacheExists(root)).toBe(true);   // still on disk
    expect(embeddingCacheUsable(root)).toBe(false);  // but not usable → BM25 fallback
  });

  it('additive refresh (recall) never evicts out-of-scope vectors; prune (default) does', async () => {
    const pA = writeDocFile('a', 'alpha '.repeat(150));
    const pB = writeDocFile('b', 'beta '.repeat(150));
    const docA = makeDoc({ slug: 'a', path: pA, body: 'alpha '.repeat(150) });
    const docB = makeDoc({ slug: 'b', path: pB, body: 'beta '.repeat(150) });
    const full = [docA, docB];

    // Warm the full cache.
    const warm = await refreshEmbeddings(root, full, fakeEmbed);
    const fullChunks = warm!.index.chunks.length;
    expect(warm!.stats.embedded).toBeGreaterThan(0);

    // Recall with a TYPE-SCOPED corpus (only docA) in ADDITIVE mode: docB's vectors
    // must survive, so the next full query re-embeds NOTHING (no inline thrash).
    const scoped = await refreshEmbeddings(root, [docA], fakeEmbed, { additive: true });
    expect(scoped!.stats.embedded).toBe(0);
    expect(scoped!.stats.evicted).toBe(0);
    const afterScoped = await refreshEmbeddings(root, full, fakeEmbed, { additive: true });
    expect(afterScoped!.stats.embedded).toBe(0);            // ← no re-embed: cache intact
    expect(afterScoped!.index.chunks.length).toBe(fullChunks);

    // Contrast — the OLD behavior: a scoped PRUNE refresh evicts docB, so the next
    // full refresh must re-embed it (the exact thrash the additive fix prevents).
    const pruned = await refreshEmbeddings(root, [docA], fakeEmbed); // default = prune
    expect(pruned!.stats.evicted).toBeGreaterThan(0);
    const afterPrune = await refreshEmbeddings(root, full, fakeEmbed, { additive: true });
    expect(afterPrune!.stats.embedded).toBeGreaterThan(0);  // docB had to be re-embedded
  });

  it('re-embeds ONLY the changed doc; deleted docs are evicted', async () => {
    const p1 = writeDocFile('a', 'alpha '.repeat(150));
    const p2 = writeDocFile('b', 'beta '.repeat(150));
    const docA = makeDoc({ slug: 'a', path: p1, body: 'alpha '.repeat(150) });
    const docB = makeDoc({ slug: 'b', path: p2, body: 'beta '.repeat(150) });
    await refreshEmbeddings(root, [docA, docB], fakeEmbed);

    // Change doc a's content (and bump mtime); drop doc b entirely.
    const newBody = 'gamma '.repeat(150);
    writeFileSync(p1, newBody);
    const future = new Date(Date.now() + 5000);
    utimesSync(p1, future, future);
    const docA2 = makeDoc({ slug: 'a', path: p1, body: newBody });

    const res = await refreshEmbeddings(root, [docA2], fakeEmbed);
    expect(res!.stats.embedded).toBeGreaterThan(0); // a's new chunks
    expect(res!.stats.evicted).toBeGreaterThan(0);  // a's old + b's chunks
    expect(res!.index.chunks.every((c) => c.docKey === 'knowledge/a')).toBe(true);
  });

  it('content hash is the cache key: same content at a new mtime embeds nothing', async () => {
    const body = 'alpha '.repeat(150);
    const p1 = writeDocFile('a', body);
    const doc = makeDoc({ slug: 'a', path: p1, body });
    await refreshEmbeddings(root, [doc], fakeEmbed);

    // Touch the file (mtime pre-filter misses) without changing content — the
    // hash check must still find every vector (survives git checkout).
    const future = new Date(Date.now() + 5000);
    utimesSync(p1, future, future);
    const res = await refreshEmbeddings(root, [doc], fakeEmbed);
    expect(res!.stats.embedded).toBe(0);
  });

  it('writes a self-ignoring .gitignore into .embeddings/', async () => {
    const p1 = writeDocFile('a', 'alpha '.repeat(150));
    await refreshEmbeddings(root, [makeDoc({ slug: 'a', path: p1, body: 'alpha '.repeat(150) })], fakeEmbed);
    const ignore = join(root, '.embeddings', '.gitignore');
    expect(existsSync(ignore)).toBe(true);
    expect(readFileSync(ignore, 'utf-8').trim()).toBe('*');
  });

  it('returns null (BM25-only fallback) when the embedder is unavailable', async () => {
    const p1 = writeDocFile('a', 'alpha '.repeat(150));
    const res = await refreshEmbeddings(root, [makeDoc({ slug: 'a', path: p1, body: 'alpha '.repeat(150) })], async () => null);
    expect(res).toBeNull();
  });
});

describe('fusion math', () => {
  it('rrfFuse: plain RRF sums 1/(k+rank) across lists', () => {
    const fused = rrfFuse([['a', 'b'], ['b', 'a']], 60);
    expect(fused.get('a')).toBeCloseTo(1 / 61 + 1 / 62);
    expect(fused.get('b')).toBeCloseTo(1 / 62 + 1 / 61);
  });

  it('rrfFuse: weights scale each list contribution', () => {
    const fused = rrfFuse([['a'], ['b']], 60, [0.6, 0.4]);
    expect(fused.get('a')).toBeCloseTo(0.6 / 61);
    expect(fused.get('b')).toBeCloseTo(0.4 / 61);
  });

  it('relativeFuse: preserves margins — a decisive channel winner stays on top', () => {
    // BM25 sees a decisive winner (10 vs 1); dense mildly prefers the loser.
    const fused = relativeFuse(
      new Map([['winner', 10], ['loser', 1]]),
      new Map([['loser', 0.9], ['winner', 0.85]]),
      0.1,
    );
    expect(fused.get('winner')!).toBeGreaterThan(fused.get('loser')!);
  });

  it('denseRank: doc score is the MAX over its chunk vectors', () => {
    const q = new Float32Array([1, 0, 0, 0]);
    const index = {
      dims: 4,
      chunks: [
        { docKey: 'k/a', seq: 0, hash: 'h1', vector: new Float32Array([0.2, 0.9, 0, 0]) },
        { docKey: 'k/a', seq: 1, hash: 'h2', vector: new Float32Array([0.95, 0.1, 0, 0]) },
        { docKey: 'k/b', seq: 0, hash: 'h3', vector: new Float32Array([0.5, 0.5, 0, 0]) },
      ],
    };
    const ranked = denseRank(q, index, 10);
    expect(ranked[0].docKey).toBe('k/a');
    expect(ranked[0].sim).toBeCloseTo(0.95);
  });
});

describe('hybridSearch invariants', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-hybrid-'));
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
      return makeDoc({ slug, path, body, title: slug.replace(/-/g, ' ') });
    };
    return [
      mk('alpha-engine', 'The alpha engine handles BM25 ranking and scoring. ' + 'ranking detail '.repeat(60)),
      mk('beta-cache', 'The beta cache stores content hashes for chunks. ' + 'cache detail '.repeat(60)),
      // Weak one-off term overlap ("ranking") so pin-guard tests get a scored
      // runner-up while alpha-engine stays the decisive winner.
      mk('gamma-notes', 'Unrelated notes about deployment pipelines and release ranking. ' + 'deploy detail '.repeat(60)),
    ];
  }

  it('raw `score` on every hit is byte-identical to the BM25 value (decoupling invariant)', async () => {
    const corpus = corpusOnDisk();
    const { bm25Search, docKey } = await import('../../src/lib/recall.js');
    const bm25 = bm25Search('alpha engine bm25 ranking', corpus, 10);
    const rawByKey = new Map(bm25.map((h) => [docKey(h.doc), h.score]));

    const hybrid = await hybridSearch('alpha engine bm25 ranking', corpus, root, 10);
    expect(hybrid.length).toBeGreaterThan(0);
    for (const h of hybrid) {
      const raw = rawByKey.get(docKey(h.doc)) ?? 0;
      expect(h.score).toBe(raw);
    }
  });

  it('falls back to plain BM25 order when the query embedder is unavailable', async () => {
    const corpus = corpusOnDisk();
    vi.mocked(embedQuery).mockResolvedValue(null);
    const { bm25Search, docKey } = await import('../../src/lib/recall.js');
    const bm25 = bm25Search('alpha engine ranking', corpus, 10);
    const hybrid = await hybridSearch('alpha engine ranking', corpus, root, 10);
    expect(hybrid.map((h) => docKey(h.doc))).toEqual(bm25.map((h) => docKey(h.doc)));
    expect(hybrid.map((h) => h.rankScore)).toEqual(bm25.map((h) => h.rankScore));
  });

  it('exposes the tuned adaptive cutoff', () => {
    expect(ADAPTIVE_RAW_CUTOFF).toBe(18);
  });

  it('pin guard: a decisive BM25 rankScore margin holds rank 1 in the RRF zone', async () => {
    const corpus = corpusOnDisk();
    const { bm25Search, docKey } = await import('../../src/lib/recall.js');
    // Query in the unconfident zone (short corpus bodies keep raw scores low)
    // where BM25's top-1 margin is decisive.
    const query = 'alpha engine ranking';
    const bm25 = bm25Search(query, corpus, 10);
    // Only meaningful when BM25 is both unconfident (RRF zone) and internally
    // decisive — assert the fixture actually exercises that path.
    const topRaw = Math.max(0, ...bm25.map((h) => h.score));
    expect(topRaw).toBeLessThan(ADAPTIVE_RAW_CUTOFF);
    expect(bm25[0].rankScore / bm25[1].rankScore).toBeGreaterThanOrEqual(1.35);

    // Adversarial dense: the query vector matches the OTHER docs' chunks best.
    const other = corpus.filter((d) => d.slug !== 'alpha-engine');
    vi.mocked(embedQuery).mockImplementation(async () => fakeVec(other[0].body));

    const hybrid = await hybridSearch(query, corpus, root, 10);
    expect(docKey(hybrid[0].doc)).toBe(docKey(bm25[0].doc));
  });

  it('dense channel excludes changelog docs; BM25 still surfaces them', async () => {
    const q = new Float32Array([1, 0, 0, 0]);
    const mkChunk = (dk: string, v: number[]) => ({ docKey: dk, seq: 0, hash: dk, vector: new Float32Array(v) });
    const index = {
      dims: 4,
      chunks: [
        mkChunk('changelog/changelog#2026-01-01-x-1', [1, 0, 0, 0]), // perfect dense match
        mkChunk('knowledge/canonical', [0.9, 0.1, 0, 0]),
      ],
    };
    // denseRank itself is type-blind…
    expect(denseRank(q, index, 10)[0].docKey).toBe('changelog/changelog#2026-01-01-x-1');
    // …the exclusion is applied by hybridSearch/denseSearch via DENSE_EXCLUDED_TYPES.
    const { DENSE_EXCLUDED_TYPES } = await import('../../src/lib/embeddings/hybrid.js');
    expect(DENSE_EXCLUDED_TYPES).toContain('changelog');
  });
});
