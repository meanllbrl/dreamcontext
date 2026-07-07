import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, utimesSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chunkDoc } from '../../src/lib/embeddings/chunker.js';
import { refreshEmbeddings, embeddingCacheExists } from '../../src/lib/embeddings/store.js';
import { hybridSearch } from '../../src/lib/embeddings/hybrid.js';
import { buildFields, type CorpusDoc } from '../../src/lib/recall.js';

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
  const v = new Float32Array([
    1,
    (text.length % 97) / 97,
    (text.charCodeAt(0) % 31) / 31,
    (text.charCodeAt(Math.max(0, text.length - 1)) % 13) / 13,
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

// ─── Chunker edge cases ──────────────────────────────────────────────────────

describe('chunker edge cases', () => {
  it('handles CRLF line endings (headings still split)', () => {
    const body = `# A\r\n${'alpha '.repeat(120)}\r\n# B\r\n${'beta '.repeat(120)}`;
    const chunks = chunkDoc('Doc', body);
    expect(chunks.length).toBe(2);
  });

  it('a # line inside a fenced code block is NOT a heading boundary', () => {
    const fenced = '```bash\n# this is a shell comment\necho hi\n```';
    const body = `intro text here\n${fenced}\noutro text`;
    const chunks = chunkDoc('Doc', body);
    expect(chunks.length).toBe(1); // small doc, no split — the fence didn't fool it
    expect(chunks[0].text).toContain('shell comment');
  });

  it('fenced heading does not split even in a large doc', () => {
    const fenced = '```md\n# fake heading in fence\n```';
    const body = `${'alpha '.repeat(200)}\n${fenced}\n${'beta '.repeat(200)}`;
    // One logical section (no real headings): splits by size only, and no
    // chunk starts at the fenced fake heading.
    const chunks = chunkDoc('Doc', body);
    for (const c of chunks) {
      expect(c.text.startsWith('Doc\n# fake heading')).toBe(false);
    }
  });

  it('Turkish/unicode content hashes are stable and unique', () => {
    const a = chunkDoc('Başlık', 'Türkçe içerik: güvenlik açıkları ve öneriler. '.repeat(30));
    const b = chunkDoc('Başlık', 'Türkçe içerik: güvenlik açıkları ve öneriler. '.repeat(30));
    const c = chunkDoc('Başlık', 'Türkçe içerik: güvenlik açıklari ve öneriler. '.repeat(30)); // ı→i
    expect(a[0].hash).toBe(b[0].hash);
    expect(a[0].hash).not.toBe(c[0].hash);
  });

  it('single giant paragraph is one chunk (no mid-sentence split)', () => {
    const body = 'word '.repeat(900); // no headings, no paragraph breaks
    const chunks = chunkDoc('Doc', body);
    expect(chunks.length).toBe(1);
  });

  it('empty everything yields no chunks (and no crash)', () => {
    expect(chunkDoc('', '', '')).toEqual([]);
  });

  it('whitespace-only body falls back to title chunk', () => {
    const chunks = chunkDoc('Title Here', '   \n\n  \n');
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toContain('Title Here');
  });
});

// ─── Store / freshness edge cases ────────────────────────────────────────────

describe('store freshness + corruption edge cases', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-edge-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const T = new Date(1700000000000); // integer-ms mtime → exact stat equality

  function writeDocFile(slug: string, body: string, stamp: Date | null = T): string {
    const path = join(root, `${slug}.md`);
    writeFileSync(path, body);
    if (stamp) utimesSync(path, stamp, stamp);
    return path;
  }

  it('embeddingCacheExists flips only after a refresh ran', async () => {
    expect(embeddingCacheExists(root)).toBe(false);
    const p = writeDocFile('a', 'alpha '.repeat(150));
    await refreshEmbeddings(root, [makeDoc({ slug: 'a', path: p, body: 'alpha '.repeat(150) })], fakeEmbed);
    expect(embeddingCacheExists(root)).toBe(true);
  });

  it('corrupted cache.json rebuilds from scratch without throwing', async () => {
    mkdirSync(join(root, '.embeddings'), { recursive: true });
    writeFileSync(join(root, '.embeddings', 'cache.json'), '{not json!!!');
    const p = writeDocFile('a', 'alpha '.repeat(150));
    const res = await refreshEmbeddings(root, [makeDoc({ slug: 'a', path: p, body: 'alpha '.repeat(150) })], fakeEmbed);
    expect(res).not.toBeNull();
    expect(res!.stats.embedded).toBeGreaterThan(0);
    // And the rebuilt cache is valid JSON.
    expect(() => JSON.parse(readFileSync(join(root, '.embeddings', 'cache.json'), 'utf-8'))).not.toThrow();
  });

  it('no .tmp file is left behind by the atomic write', async () => {
    const p = writeDocFile('a', 'alpha '.repeat(150));
    await refreshEmbeddings(root, [makeDoc({ slug: 'a', path: p, body: 'alpha '.repeat(150) })], fakeEmbed);
    const files = readdirSync(join(root, '.embeddings'));
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('a model change invalidates every cached vector', async () => {
    const p = writeDocFile('a', 'alpha '.repeat(150));
    const doc = makeDoc({ slug: 'a', path: p, body: 'alpha '.repeat(150) });
    const first = await refreshEmbeddings(root, [doc], fakeEmbed);
    // Rewrite the cache as if produced by a different model.
    const cachePath = join(root, '.embeddings', 'cache.json');
    const cache = JSON.parse(readFileSync(cachePath, 'utf-8'));
    cache.model = 'some-other-model';
    writeFileSync(cachePath, JSON.stringify(cache));
    const second = await refreshEmbeddings(root, [doc], fakeEmbed);
    expect(second!.stats.embedded).toBe(first!.stats.embedded); // fully re-embedded
  });

  it('a missing vector for a cached hash forces re-embed even with unchanged stat', async () => {
    const p = writeDocFile('a', 'alpha '.repeat(150));
    const doc = makeDoc({ slug: 'a', path: p, body: 'alpha '.repeat(150) });
    await refreshEmbeddings(root, [doc], fakeEmbed);
    const cachePath = join(root, '.embeddings', 'cache.json');
    const cache = JSON.parse(readFileSync(cachePath, 'utf-8'));
    cache.vectors = {}; // partial corruption: doc entries intact, vectors gone
    writeFileSync(cachePath, JSON.stringify(cache));
    const res = await refreshEmbeddings(root, [doc], fakeEmbed);
    expect(res!.stats.embedded).toBeGreaterThan(0);
    expect(res!.index.chunks.length).toBeGreaterThan(0);
  });

  it('identical content in two docs shares one vector; evicting one doc keeps it', async () => {
    const body = 'shared content '.repeat(60);
    const p1 = writeDocFile('a', body);
    const p2 = writeDocFile('b', body);
    // Same TITLE too, so chunk texts (title-prefixed) are byte-identical.
    const docA = makeDoc({ slug: 'a', path: p1, body, title: 'Same Title' });
    const docB = makeDoc({ slug: 'b', path: p2, body, title: 'Same Title' });
    const first = await refreshEmbeddings(root, [docA, docB], fakeEmbed);
    // Hash-dedup: two docs, ONE embedded vector.
    expect(first!.stats.embedded).toBe(1);
    expect(first!.index.chunks.length).toBe(2); // both docs still indexed

    // Dropping doc B must NOT evict the vector doc A still references.
    const second = await refreshEmbeddings(root, [docA], fakeEmbed);
    expect(second!.stats.evicted).toBe(0);
    expect(second!.stats.embedded).toBe(0);
    expect(second!.index.chunks.length).toBe(1);
  });

  it('BLIND SPOT + CURE: same-mtime same-size edit — quick refresh misses, force catches', async () => {
    const bodyV1 = 'alpha '.repeat(150);
    const p = writeDocFile('a', bodyV1); // mtime pinned to T
    const docV1 = makeDoc({ slug: 'a', path: p, body: bodyV1 });
    await refreshEmbeddings(root, [docV1], fakeEmbed);

    // Same byte length, different content, mtime pinned back to T.
    const bodyV2 = 'alpho '.repeat(150);
    expect(Buffer.byteLength(bodyV2)).toBe(Buffer.byteLength(bodyV1));
    writeDocFile('a', bodyV2);
    expect(statSync(p).mtimeMs).toBe(1700000000000); // stat really is identical
    const docV2 = makeDoc({ slug: 'a', path: p, body: bodyV2 });

    // Quick refresh: pre-filter sees identical stat → skips (the documented
    // blind spot — this is WHY eager triggers use force).
    const quick = await refreshEmbeddings(root, [docV2], fakeEmbed);
    expect(quick!.stats.embedded).toBe(0);

    // Force refresh: content hash authoritative → change detected.
    const forced = await refreshEmbeddings(root, [docV2], fakeEmbed, { force: true });
    expect(forced!.stats.embedded).toBeGreaterThan(0);
  });

  it('same-mtime DIFFERENT-size edit is caught WITHOUT force (size pre-filter)', async () => {
    const p = writeDocFile('a', 'alpha '.repeat(150));
    const doc1 = makeDoc({ slug: 'a', path: p, body: 'alpha '.repeat(150) });
    await refreshEmbeddings(root, [doc1], fakeEmbed);

    const bodyV2 = 'alpha '.repeat(150) + 'extra tail';
    writeDocFile('a', bodyV2); // mtime pinned back to T, size differs
    const doc2 = makeDoc({ slug: 'a', path: p, body: bodyV2 });
    const res = await refreshEmbeddings(root, [doc2], fakeEmbed);
    expect(res!.stats.embedded).toBeGreaterThan(0);
  });

  it('empty corpus empties the index without crashing', async () => {
    const p = writeDocFile('a', 'alpha '.repeat(150));
    await refreshEmbeddings(root, [makeDoc({ slug: 'a', path: p, body: 'alpha '.repeat(150) })], fakeEmbed);
    const res = await refreshEmbeddings(root, [], fakeEmbed);
    expect(res!.index.chunks.length).toBe(0);
    expect(res!.stats.evicted).toBeGreaterThan(0);
  });

  it('a doc whose file vanished from disk still gets embedded from its body', async () => {
    const ghost = makeDoc({ slug: 'ghost', path: join(root, 'never-existed.md'), body: 'ghost content '.repeat(60) });
    const res = await refreshEmbeddings(root, [ghost], fakeEmbed);
    expect(res!.stats.embedded).toBeGreaterThan(0);
    expect(res!.index.chunks[0].docKey).toBe('knowledge/ghost');
    // And it does not thrash: second run embeds nothing (hash present; stat
    // stays -1 on both sides).
    const again = await refreshEmbeddings(root, [ghost], fakeEmbed);
    expect(again!.stats.embedded).toBe(0);
  });
});

// ─── Hybrid degenerate inputs ────────────────────────────────────────────────

describe('hybrid degenerate inputs', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-hedge-'));
    vi.mocked(embedPassages).mockImplementation(async (texts: string[]) => texts.map(fakeVec));
    vi.mocked(embedQuery).mockImplementation(async (text: string) => fakeVec(text));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.mocked(embedPassages).mockReset();
    vi.mocked(embedQuery).mockReset();
  });

  function corpusOnDisk(): CorpusDoc[] {
    const mk = (slug: string, body: string, type = 'knowledge' as CorpusDoc['type']): CorpusDoc => {
      const path = join(root, `${slug.replace(/[#/]/g, '_')}.md`);
      writeFileSync(path, body);
      return makeDoc({ slug, path, body, title: slug.replace(/-/g, ' '), type });
    };
    return [
      mk('alpha-engine', 'The alpha engine handles ranking and scoring. ' + 'ranking detail '.repeat(60)),
      mk('beta-cache', 'The beta cache stores content hashes. ' + 'cache detail '.repeat(60)),
      mk('changelog#2026-01-01-x-1', 'alpha engine ranking pointer entry. ', 'changelog'),
    ];
  }

  it('stopword-only query does not crash; returns dense-driven or empty results', async () => {
    const corpus = corpusOnDisk();
    const hits = await hybridSearch('the and of', corpus, root, 5);
    expect(Array.isArray(hits)).toBe(true);
    // Whatever comes back is well-formed and rank-sorted.
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].rankScore).toBeGreaterThanOrEqual(hits[i].rankScore);
    }
  });

  it('respects topK and sorts by rankScore descending', async () => {
    const corpus = corpusOnDisk();
    const hits = await hybridSearch('alpha engine ranking cache', corpus, root, 2);
    expect(hits.length).toBeLessThanOrEqual(2);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].rankScore).toBeGreaterThanOrEqual(hits[i].rankScore);
    }
  });

  it('changelog docs can still surface via the BM25 channel in hybrid mode', async () => {
    const corpus = corpusOnDisk();
    const hits = await hybridSearch('alpha engine ranking pointer entry', corpus, root, 10);
    const types = hits.map((h) => h.doc.type);
    expect(types).toContain('changelog'); // dense excluded it; BM25 kept it
  });

  it('pinMargin 0 disables the pin guard', async () => {
    // Three knowledge docs sharing the query term so RRF has real dense
    // candidates; dense adversarially buries BM25's decisive winner at rank 3.
    const mk = (slug: string, body: string): CorpusDoc => {
      const path = join(root, `${slug}.md`);
      writeFileSync(path, body);
      return makeDoc({ slug, path, body, title: slug.replace(/-/g, ' ') });
    };
    const corpus = [
      mk('alpha-engine', 'The alpha engine handles ranking and scoring. ' + 'ranking detail '.repeat(60)),
      mk('delta-notes', 'Notes mentioning ranking once. ' + 'delta filler '.repeat(60)),
      mk('epsilon-notes', 'Other notes mentioning ranking once. ' + 'epsilon filler '.repeat(60)),
    ];
    const vecFor = (text: string): Float32Array => {
      if (text.includes('alpha')) return new Float32Array([0, 0, 1, 0]);
      if (text.includes('delta')) return new Float32Array([1, 0, 0, 0]);
      return new Float32Array([0.9950372, 0.0995037, 0, 0]); // epsilon ≈ query
    };
    vi.mocked(embedPassages).mockImplementation(async (texts: string[]) => texts.map(vecFor));
    vi.mocked(embedQuery).mockResolvedValue(new Float32Array([1, 0, 0, 0])); // far from alpha

    const { bm25Search, docKey } = await import('../../src/lib/recall.js');
    const query = 'alpha engine ranking';
    const bm25 = bm25Search(query, corpus, 10);
    expect(docKey(bm25[0].doc)).toBe('knowledge/alpha-engine');
    expect(bm25[0].rankScore / bm25[1].rankScore).toBeGreaterThanOrEqual(1.35); // pin-eligible

    const pinned = await hybridSearch(query, corpus, root, 10);
    const unpinned = await hybridSearch(query, corpus, root, 10, { pinMargin: 0 });
    expect(docKey(pinned[0].doc)).toBe('knowledge/alpha-engine');
    expect(docKey(unpinned[0].doc)).not.toBe('knowledge/alpha-engine');
  });

  it('cold cache + unavailable passage embedder falls back to BM25 order', async () => {
    const corpus = corpusOnDisk();
    vi.mocked(embedPassages).mockResolvedValue(null); // refresh returns null
    const { bm25Search, docKey } = await import('../../src/lib/recall.js');
    const bm25 = bm25Search('alpha engine ranking', corpus, 10);
    const hybrid = await hybridSearch('alpha engine ranking', corpus, root, 10);
    expect(hybrid.map((h) => docKey(h.doc))).toEqual(bm25.map((h) => docKey(h.doc)));
  });
});
