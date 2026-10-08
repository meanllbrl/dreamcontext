import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chunkDoc } from '../../src/lib/embeddings/chunker.js';
import {
  refreshEmbeddings, embeddingCacheExists, embeddingCacheUsable, embeddingCacheChunkCount,
  embeddingCacheCoversType, embeddingCacheLockPath, EmbeddingLockBusyError, HOOK_MAX_INLINE_CHUNKS, TYPE_COVERAGE_MIN,
} from '../../src/lib/embeddings/store.js';
import { rrfFuse, relativeFuse, denseRank, hybridSearch, ADAPTIVE_RAW_CUTOFF } from '../../src/lib/embeddings/hybrid.js';
import { buildFields, type CorpusDoc } from '../../src/lib/recall.js';
import { acquireFileLock, releaseFileLock } from '../../src/lib/file-lock.js';
import { EMBED_PROFILES, embedCacheModelKey } from '../../src/lib/embeddings/profiles.js';

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

  it('the cache is stamped with the ACTIVE profile\'s key: any other model (or quantization) is unusable', async () => {
    const p1 = writeDocFile('a', 'alpha '.repeat(150));
    const corpus = [makeDoc({ slug: 'a', path: p1, body: 'alpha '.repeat(150) })];
    await refreshEmbeddings(root, corpus, fakeEmbed);

    const cachePath = join(root, '.embeddings', 'cache.json');
    const parsed = JSON.parse(readFileSync(cachePath, 'utf-8'));
    expect(parsed.model).toBe(embedCacheModelKey());

    const stampWith = (model: string, bump: number): void => {
      writeFileSync(cachePath, JSON.stringify({ ...parsed, model }));
      const t = Date.now() / 1000 + bump; // fresh mtime so the usability memo re-evaluates
      utimesSync(cachePath, t, t);
    };
    stampWith(embedCacheModelKey(), 5);
    expect(embeddingCacheUsable(root)).toBe(true);
    let bump = 10;
    for (const profile of EMBED_PROFILES) {
      if (embedCacheModelKey(profile) === embedCacheModelKey()) continue;
      stampWith(embedCacheModelKey(profile), (bump += 5));
      expect(embeddingCacheUsable(root)).toBe(false); // e5 ↔ Gemma (and any future quantization) never share an index
    }
  });

  it('a switched model rebuilds the index instead of mixing vector spaces', async () => {
    const p1 = writeDocFile('a', 'alpha '.repeat(150));
    const corpus = [makeDoc({ slug: 'a', path: p1, body: 'alpha '.repeat(150) })];
    const first = await refreshEmbeddings(root, corpus, fakeEmbed);

    const cachePath = join(root, '.embeddings', 'cache.json');
    const other = EMBED_PROFILES.find((p) => embedCacheModelKey(p) !== embedCacheModelKey())!;
    writeFileSync(cachePath, JSON.stringify({ ...JSON.parse(readFileSync(cachePath, 'utf-8')), model: embedCacheModelKey(other) }));
    const t = Date.now() / 1000 + 20;
    utimesSync(cachePath, t, t);

    const rebuilt = await refreshEmbeddings(root, corpus, fakeEmbed);
    expect(rebuilt!.stats.embedded).toBe(first!.stats.embedded); // everything re-embedded
    expect(rebuilt!.stats.reused).toBe(0);
    expect(JSON.parse(readFileSync(cachePath, 'utf-8')).model).toBe(embedCacheModelKey());
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

  it('exposes the active model\'s tuned adaptive cutoff (Gemma: 12)', () => {
    expect(ADAPTIVE_RAW_CUTOFF).toBe(EMBED_PROFILES.find((p) => p.id === 'embeddinggemma-q8')!.adaptiveCutoff);
    expect(ADAPTIVE_RAW_CUTOFF).toBe(12);
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

describe('embeddingCacheCoversType (task-corpus warmth gate)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-cover-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const TASK_BODY = 'task body detail '.repeat(60);

  /** Write `state/<sub>/<slug>.md` and return the matching `task` corpus doc. */
  function taskDoc(slug: string, sub = ''): CorpusDoc {
    const dir = sub ? join(root, 'state', sub) : join(root, 'state');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${slug}.md`);
    writeFileSync(path, TASK_BODY);
    return makeDoc({
      slug, path, body: TASK_BODY, type: 'task',
      relPath: sub ? `state/${sub}/${slug}.md` : `state/${slug}.md`,
    });
  }

  function knowledgeDoc(slug: string): CorpusDoc {
    const path = join(root, `${slug}.md`);
    writeFileSync(path, TASK_BODY);
    return makeDoc({ slug, path, body: TASK_BODY });
  }

  const cacheFile = () => join(root, '.embeddings', 'cache.json');

  /** Bump the cache mtime so the mtime-keyed memo re-evaluates. */
  function touchCache(): void {
    const now = Date.now() / 1000 + 5;
    utimesSync(cacheFile(), now, now);
  }

  it('exposes the tuned coverage bar', () => {
    expect(TYPE_COVERAGE_MIN).toBe(0.8);
  });

  it('no cache at all → false (task files on disk, nothing vectorised)', async () => {
    taskDoc('a'); taskDoc('b'); taskDoc('c');
    expect(embeddingCacheExists(root)).toBe(false);
    expect(embeddingCacheCoversType(root, 'task')).toBe(false);
  });

  it('empty vault → false: nothing on disk to compare against is not "warm"', async () => {
    await refreshEmbeddings(root, [knowledgeDoc('k')], fakeEmbed);
    expect(embeddingCacheUsable(root)).toBe(true);
    expect(embeddingCacheCoversType(root, 'task')).toBe(false);
  });

  it('THE REGRESSION: a knowledge-only cache is USABLE but covers zero tasks', async () => {
    // Exactly what a hybrid recall leaves behind (type-scoped + additive), and
    // exactly the state in which an inline task dedup would cold-build the index.
    const tasks = Array.from({ length: 10 }, (_, i) => taskDoc(`t${i}`));
    expect(tasks).toHaveLength(10);
    await refreshEmbeddings(root, [knowledgeDoc('k1'), knowledgeDoc('k2')], fakeEmbed);
    expect(embeddingCacheUsable(root)).toBe(true);        // model/version fine…
    expect(embeddingCacheCoversType(root, 'task')).toBe(false); // …but stone cold for tasks
  });

  it('a full task-corpus refresh → true', async () => {
    const tasks = Array.from({ length: 10 }, (_, i) => taskDoc(`t${i}`));
    await refreshEmbeddings(root, tasks, fakeEmbed);
    expect(embeddingCacheCoversType(root, 'task')).toBe(true);
  });

  it('archived tasks count on both sides (state/archive/ is in the same corpus)', async () => {
    const docs = [taskDoc('live-1'), taskDoc('live-2'), taskDoc('old-1', 'archive')];
    await refreshEmbeddings(root, docs, fakeEmbed);
    expect(embeddingCacheCoversType(root, 'task')).toBe(true);
  });

  it('8 of 10 cached clears the 0.8 bar', async () => {
    const tasks = Array.from({ length: 10 }, (_, i) => taskDoc(`t${i}`));
    await refreshEmbeddings(root, tasks.slice(0, 8), fakeEmbed);
    expect(embeddingCacheCoversType(root, 'task')).toBe(true);
  });

  it('7 of 10 cached does not', async () => {
    const tasks = Array.from({ length: 10 }, (_, i) => taskDoc(`t${i}`));
    await refreshEmbeddings(root, tasks.slice(0, 7), fakeEmbed);
    expect(embeddingCacheCoversType(root, 'task')).toBe(false);
  });

  it('session digests do NOT count toward coverage', async () => {
    // 3 real task files on disk; the digest is NOT one of them (dot-dir, and the
    // corpus loader never globs it either), so letting it count would fake warmth.
    const real = [taskDoc('t0'), taskDoc('t1'), taskDoc('t2')];
    mkdirSync(join(root, 'state', '.session-digests'), { recursive: true });
    const digestPath = join(root, 'state', '.session-digests', 's1.md');
    writeFileSync(digestPath, TASK_BODY);
    const digest = makeDoc({
      slug: 'digest#s1', path: digestPath, body: TASK_BODY, type: 'task',
      relPath: 'state/.session-digests/s1.md',
    });

    await refreshEmbeddings(root, [real[0], real[1], digest], fakeEmbed);
    // 2 real + 1 digest cached against 3 files on disk: counting the digest would
    // read 3/3 = warm. It must read 2/3 = cold.
    expect(embeddingCacheCoversType(root, 'task')).toBe(false);

    await refreshEmbeddings(root, [...real, digest], fakeEmbed);
    expect(embeddingCacheCoversType(root, 'task')).toBe(true);
  });

  it('a doc whose vector was evicted no longer counts', async () => {
    const tasks = [taskDoc('t0'), taskDoc('t1'), taskDoc('t2')];
    await refreshEmbeddings(root, tasks, fakeEmbed);
    expect(embeddingCacheCoversType(root, 'task')).toBe(true);

    const cache = JSON.parse(readFileSync(cacheFile(), 'utf-8'));
    const victim = cache.docs['task/t0'].hashes[0];
    delete cache.vectors[victim];
    writeFileSync(cacheFile(), JSON.stringify(cache));
    touchCache();

    expect(embeddingCacheCoversType(root, 'task')).toBe(false); // 2 of 3 < ceil(2.4)
  });

  it('the memo re-reads when the cache file changes', async () => {
    const tasks = Array.from({ length: 10 }, (_, i) => taskDoc(`t${i}`));
    await refreshEmbeddings(root, tasks, fakeEmbed);
    expect(embeddingCacheCoversType(root, 'task')).toBe(true);   // memo now holds 10

    const cache = JSON.parse(readFileSync(cacheFile(), 'utf-8'));
    cache.docs = { 'knowledge/k': cache.docs['task/t0'] };
    writeFileSync(cacheFile(), JSON.stringify(cache));
    touchCache();

    expect(embeddingCacheCoversType(root, 'task')).toBe(false);
  });

  it('a stale-model cache covers nothing (loadCache discards it wholesale)', async () => {
    const tasks = [taskDoc('t0'), taskDoc('t1'), taskDoc('t2')];
    await refreshEmbeddings(root, tasks, fakeEmbed);

    const cache = JSON.parse(readFileSync(cacheFile(), 'utf-8'));
    cache.model = 'OLD/stale-model';
    writeFileSync(cacheFile(), JSON.stringify(cache));
    touchCache();

    expect(embeddingCacheUsable(root)).toBe(false);
    expect(embeddingCacheCoversType(root, 'task')).toBe(false);
  });

  it('every non-task type answers false rather than guessing a layout', async () => {
    const tasks = [taskDoc('t0'), taskDoc('t1'), taskDoc('t2')];
    await refreshEmbeddings(root, [...tasks, knowledgeDoc('k1')], fakeEmbed);
    expect(embeddingCacheCoversType(root, 'task')).toBe(true);
    for (const type of ['knowledge', 'feature', 'memory', 'changelog'] as const) {
      expect(embeddingCacheCoversType(root, type)).toBe(false);
    }
  });

  it('minCoverage 0 cannot switch the cold-build guard off', async () => {
    Array.from({ length: 4 }, (_, i) => taskDoc(`t${i}`));
    await refreshEmbeddings(root, [knowledgeDoc('k1')], fakeEmbed);
    // Zero covered task docs is never warm, whatever ratio the caller asks for.
    expect(embeddingCacheCoversType(root, 'task', 0)).toBe(false);
  });
});

describe('parsed-cache memo (one parse per cache-file version per process)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-parsememo-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  const BODY = 'alpha beta gamma '.repeat(60);
  const cacheFile = () => join(root, '.embeddings', 'cache.json');

  function doc(slug: string, body = BODY): CorpusDoc {
    const path = join(root, `${slug}.md`);
    writeFileSync(path, body);
    return makeDoc({ slug, path, body });
  }

  /** Count only the parses of a real cache file (the cache JSON carries a `vectors` key). */
  function spyCacheParses() {
    const real = JSON.parse;
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((text: string, reviver?: (k: string, v: unknown) => unknown) =>
      real(text, reviver));
    const count = () => spy.mock.calls.filter(([t]) => typeof t === 'string' && t.includes('"vectors"')).length;
    return { count };
  }

  it('the readiness gate and the refresh that follows it share ONE parse', async () => {
    const corpus = [doc('a'), doc('b')];
    await refreshEmbeddings(root, corpus, fakeEmbed);

    const { count } = spyCacheParses();
    expect(embeddingCacheUsable(root)).toBe(true);                 // parse #1
    const res = await refreshEmbeddings(root, corpus, fakeEmbed, { additive: true, waitForLock: false });
    expect(res!.stats.embedded).toBe(0);                           // nothing changed → no lock, no reload
    expect(embeddingCacheChunkCount(root)).toBe(res!.index.chunks.length);
    expect(count()).toBe(1);
  });

  it('a refresh that saves drops the memo: the next read sees the new content', async () => {
    const a = doc('a');
    await refreshEmbeddings(root, [a], fakeEmbed);
    const before = embeddingCacheChunkCount(root);                 // memoised
    expect(before).toBeGreaterThan(0);

    const b = doc('b', 'delta epsilon zeta '.repeat(80));
    const res = await refreshEmbeddings(root, [a, b], fakeEmbed);
    expect(res!.stats.embedded).toBeGreaterThan(0);
    expect(embeddingCacheChunkCount(root)).toBe(res!.index.chunks.length);
    expect(embeddingCacheChunkCount(root)).toBeGreaterThan(before);
  });

  it('an external rewrite is re-parsed even when the mtime is restored (size is the second signal)', async () => {
    await refreshEmbeddings(root, [doc('a'), doc('b')], fakeEmbed);
    const mtime = new Date(Date.now() - 60_000);
    utimesSync(cacheFile(), mtime, mtime);
    expect(embeddingCacheChunkCount(root)).toBeGreaterThan(0);     // memoised at (mtime, size)

    const parsed = JSON.parse(readFileSync(cacheFile(), 'utf-8'));
    parsed.docs = {};
    writeFileSync(cacheFile(), JSON.stringify(parsed));
    utimesSync(cacheFile(), mtime, mtime);                         // same mtime, smaller file
    expect(embeddingCacheChunkCount(root)).toBe(0);
  });

  it('a refresh that throws leaves no dirty memo: counts and later refreshes match a clean run', async () => {
    const corpus = [doc('a')];
    await refreshEmbeddings(root, corpus, fakeEmbed);
    const baseline = embeddingCacheChunkCount(root);               // memoised

    const grown = [...corpus, doc('b', 'delta epsilon zeta '.repeat(80))];
    await expect(refreshEmbeddings(root, grown, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(embeddingCacheChunkCount(root)).toBe(baseline);         // snapshot never mutated

    const res = await refreshEmbeddings(root, grown, fakeEmbed);
    expect(res!.stats.embedded).toBeGreaterThan(0);                // b is embedded exactly now
    expect(embeddingCacheChunkCount(root)).toBe(res!.index.chunks.length);
  });

  it('a lock-busy hook refresh searches its in-memory vectors but memoises none of them', async () => {
    const a = doc('a');
    await refreshEmbeddings(root, [a], fakeEmbed);
    const baseline = embeddingCacheChunkCount(root);

    const lock = embeddingCacheLockPath(root);
    expect(acquireFileLock(lock, Date.now(), 60_000)).toBe(true);
    try {
      const b = doc('b', 'delta epsilon zeta '.repeat(80));
      const res = await refreshEmbeddings(root, [a, b], fakeEmbed, { additive: true, waitForLock: false });
      expect(res!.index.chunks.some((c) => c.docKey === 'knowledge/b')).toBe(true); // searched in memory
      expect(embeddingCacheChunkCount(root)).toBe(baseline);                         // disk + memo untouched
    } finally {
      releaseFileLock(lock);
    }
  });
});

describe('full-refresh checkpoints, partial caches and the inline cap', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-checkpoint-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const cacheFile = () => join(root, '.embeddings', 'cache.json');
  const onDisk = () => JSON.parse(readFileSync(cacheFile(), 'utf-8')) as {
    partial?: boolean; vectors: Record<string, string>; docs: Record<string, unknown>;
  };

  /** `n` one-chunk docs with distinct content (one chunk ≈ 150 words, well under the split size). */
  function docs(n: number, from = 0): CorpusDoc[] {
    return Array.from({ length: n }, (_, k) => {
      const i = from + k;
      const body = `topic${i} detail${i} `.repeat(75);
      const path = join(root, `d${i}.md`);
      writeFileSync(path, body);
      return makeDoc({ slug: `d${i}`, path, body });
    });
  }

  /** Embedder that logs every call; `hook` runs first and may throw or answer null. */
  function embedder(hook?: (call: number, texts: string[]) => Float32Array[] | null | void) {
    const sizes: number[] = [];
    const fn = async (texts: string[]): Promise<Float32Array[] | null> => {
      const call = sizes.length;
      sizes.push(texts.length);
      const r = hook?.(call, texts);
      if (r === null) return null;
      return r ?? texts.map(fakeVec);
    };
    return { fn, sizes, total: () => sizes.reduce((a, b) => a + b, 0) };
  }

  it('a full run checkpoints as it goes: the file holds finished slices, flagged partial and unusable, until the run ends', async () => {
    const seen: Array<{ call: number; vectors: number; partial: boolean | undefined; usable: boolean; chunkCount: number }> = [];
    const e = embedder((call) => {
      if (call > 0) {
        const c = onDisk();
        seen.push({
          call, vectors: Object.keys(c.vectors).length, partial: c.partial,
          usable: embeddingCacheUsable(root), chunkCount: embeddingCacheChunkCount(root),
        });
      }
    });
    const res = await refreshEmbeddings(root, docs(12), e.fn, { checkpointEvery: 4 });

    expect(e.sizes).toEqual([4, 4, 4]);
    expect(seen.map((s) => s.vectors)).toEqual([4, 8]);          // saved after each finished slice
    expect(seen.every((s) => s.partial === true)).toBe(true);
    expect(seen.every((s) => s.usable === false)).toBe(true);    // BM25 keeps answering mid-build
    expect(seen.map((s) => s.chunkCount)).toEqual([4, 8]);        // …but the progress is visible
    expect(res!.stats.embedded).toBe(12);

    const done = onDisk();
    expect(Object.keys(done.vectors)).toHaveLength(12);
    expect(done.partial).toBeUndefined();                         // the finished run clears the flag
    expect(embeddingCacheUsable(root)).toBe(true);
  });

  it('a killed run resumes from its last checkpoint: only the missing chunks are embedded', async () => {
    const corpus = docs(12);
    const snapshot = join(root, 'killed-cache.json');
    const killed = embedder((call) => {
      if (call === 2) copyFileSync(cacheFile(), snapshot); // the disk state a SIGKILL here would leave
    });
    await refreshEmbeddings(root, corpus, killed.fn, { checkpointEvery: 4 });

    copyFileSync(snapshot, cacheFile());                     // rewind to the moment of the kill
    const future = new Date(Date.now() + 5000);
    utimesSync(cacheFile(), future, future);
    const survivors = Object.keys(onDisk().vectors).length;
    expect(survivors).toBe(8);
    expect(embeddingCacheUsable(root)).toBe(false);          // unfinished → ensure will pick it up

    const resumed = embedder();
    const res = await refreshEmbeddings(root, corpus, resumed.fn, { checkpointEvery: 4 });
    expect(resumed.total()).toBe(12 - survivors);            // nothing already embedded is redone
    expect(res!.index.chunks).toHaveLength(12);
    expect(onDisk().partial).toBeUndefined();
    expect(embeddingCacheUsable(root)).toBe(true);
  });

  it('an embedder that throws mid-run still leaves everything it finished on disk', async () => {
    const corpus = docs(40);
    const e = embedder((call) => { if (call === 1) throw new Error('boom'); });
    // 40 > one 32-chunk slice, and the 40-chunk bar is not reached before the throw.
    await expect(refreshEmbeddings(root, corpus, e.fn, { checkpointEvery: 40 })).rejects.toThrow('boom');
    expect(e.sizes).toEqual([32, 8]);
    expect(Object.keys(onDisk().vectors)).toHaveLength(32);  // flushed on the way out
    expect(onDisk().partial).toBe(true);

    const next = embedder();
    await refreshEmbeddings(root, corpus, next.fn, { checkpointEvery: 40 });
    expect(next.total()).toBe(8);
  });

  it('a model that vanishes mid-run (null) flushes progress and returns null', async () => {
    const corpus = docs(40);
    const e = embedder((call) => (call === 1 ? null : undefined));
    expect(await refreshEmbeddings(root, corpus, e.fn, { checkpointEvery: 40 })).toBeNull();
    expect(Object.keys(onDisk().vectors)).toHaveLength(32);
    expect(embeddingCacheUsable(root)).toBe(false);
  });

  it('an already-usable index stays usable through a checkpointed incremental update', async () => {
    await refreshEmbeddings(root, docs(6), embedder().fn);
    expect(embeddingCacheUsable(root)).toBe(true);

    const states: boolean[] = [];
    const e = embedder((call) => { if (call > 0) states.push(embeddingCacheUsable(root)); });
    await refreshEmbeddings(root, docs(12), e.fn, { checkpointEvery: 4 }); // 6 old + 6 new docs
    expect(e.sizes).toEqual([4, 2]);
    expect(states).toEqual([true]);                                         // never flipped to BM25
    expect(onDisk().partial).toBeUndefined();
  });

  it('checkpointEvery: 0 disables checkpointing (one embedder call, one final save)', async () => {
    const e = embedder((call) => {
      if (call === 0) expect(existsSync(cacheFile())).toBe(false);
    });
    await refreshEmbeddings(root, docs(12), e.fn, { checkpointEvery: 0 });
    expect(e.sizes).toEqual([12]);
  });

  it('a busy lock only skips checkpoints; the run itself still ends with the usual busy error', async () => {
    const lock = embeddingCacheLockPath(root);
    expect(acquireFileLock(lock, Date.now(), 60_000)).toBe(true);
    try {
      const e = embedder();
      await expect(refreshEmbeddings(root, docs(12), e.fn, { checkpointEvery: 4, lockWaitMs: 30 }))
        .rejects.toBeInstanceOf(EmbeddingLockBusyError);
      expect(e.total()).toBe(12);
      expect(existsSync(cacheFile())).toBe(false);
    } finally {
      releaseFileLock(lock);
    }
  });

  describe('the recall path never embeds more than a small bounded number of chunks inline', () => {
    it('additive + waitForLock:false embeds at most HOOK_MAX_INLINE_CHUNKS and searches what it has', async () => {
      const warm = docs(3);
      await refreshEmbeddings(root, warm, embedder().fn);

      const all = [...warm, ...docs(20, 3)];
      const e1 = embedder();
      const r1 = await refreshEmbeddings(root, all, e1.fn, { additive: true, waitForLock: false });
      expect(HOOK_MAX_INLINE_CHUNKS).toBeLessThanOrEqual(16);
      expect(e1.total()).toBe(HOOK_MAX_INLINE_CHUNKS);
      expect(r1!.index.chunks).toHaveLength(3 + HOOK_MAX_INLINE_CHUNKS);
      expect(embeddingCacheUsable(root)).toBe(true);                         // quality gate untouched
      expect(Object.keys(onDisk().docs)).toHaveLength(3 + HOOK_MAX_INLINE_CHUNKS);

      // Each later prompt takes another bounded bite until the corpus is caught up.
      const e2 = embedder();
      await refreshEmbeddings(root, all, e2.fn, { additive: true, waitForLock: false });
      expect(e2.total()).toBe(HOOK_MAX_INLINE_CHUNKS);
      const e3 = embedder();
      const r3 = await refreshEmbeddings(root, all, e3.fn, { additive: true, waitForLock: false });
      expect(e3.total()).toBe(20 - 2 * HOOK_MAX_INLINE_CHUNKS);
      expect(r3!.index.chunks).toHaveLength(23);
    });

    it('an explicit maxInline wins; 0 embeds nothing and still serves the existing vectors', async () => {
      const warm = docs(3);
      await refreshEmbeddings(root, warm, embedder().fn);
      const e = embedder();
      const res = await refreshEmbeddings(root, [...warm, ...docs(5, 3)], e.fn, { additive: true, waitForLock: false, maxInline: 0 });
      expect(e.total()).toBe(0);
      expect(res!.index.chunks).toHaveLength(3);
    });

    it('callers that wait for the lock (dedup) and full refreshes keep the uncapped behaviour', async () => {
      const warm = docs(3);
      await refreshEmbeddings(root, warm, embedder().fn);
      const e = embedder();
      await refreshEmbeddings(root, [...warm, ...docs(20, 3)], e.fn, { additive: true, waitForLock: true });
      expect(e.total()).toBe(20);
    });

    it('a lock-busy capped refresh persists nothing and a cold cache stays unusable', async () => {
      const lock = embeddingCacheLockPath(root);
      expect(acquireFileLock(lock, Date.now(), 60_000)).toBe(true);
      try {
        const e = embedder();
        const res = await refreshEmbeddings(root, docs(20), e.fn, { additive: true, waitForLock: false });
        expect(e.total()).toBe(HOOK_MAX_INLINE_CHUNKS);
        expect(res!.index.chunks).toHaveLength(HOOK_MAX_INLINE_CHUNKS);
      } finally {
        releaseFileLock(lock);
      }
      expect(embeddingCacheUsable(root)).toBe(false);
    });
  });
});
