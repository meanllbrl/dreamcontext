// The embedding model profile table (profiles.ts) and the embedder that runs the active profile.
// transformers.js is mocked: nothing here loads (or downloads) a real model.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DEFAULT_EMBED_PROFILE_ID,
  EMBED_PROFILES,
  embedCacheModelKey,
  selectEmbedProfile,
} from '../../src/lib/embeddings/profiles.js';

const tf = vi.hoisted(() => ({
  env: { allowRemoteModels: true as boolean, cacheDir: '' },
  /** One entry per model load, with allowRemoteModels as it stood at that call. */
  loads: [] as Array<{ kind: 'pipeline' | 'tokenizer' | 'model'; remote: boolean; model: string; dtype?: string }>,
  /** Every batch the tokenizer was asked to encode (the prompt-prefixed texts). */
  tokenized: [] as string[][],
  /** What the mocked graph does: 'ok' | 'throw' | 'no-output'. */
  graph: 'ok' as 'ok' | 'throw' | 'no-output',
}));

vi.mock('@huggingface/transformers', () => ({
  env: tf.env,
  pipeline: vi.fn(async (_task: string, model: string, opts: { dtype?: string }) => {
    tf.loads.push({ kind: 'pipeline', remote: tf.env.allowRemoteModels, model, dtype: opts.dtype });
    // mean-pooling pipeline: row j of the batch = [length of text j, 1]
    return async (texts: string | string[]) => {
      const list = Array.isArray(texts) ? texts : [texts];
      tf.tokenized.push(list);
      const data = new Float32Array(list.length * 2);
      list.forEach((t, j) => { data[j * 2] = t.length; data[j * 2 + 1] = 1; });
      return { data, dims: [list.length, 2] };
    };
  }),
  AutoTokenizer: {
    from_pretrained: vi.fn(async (model: string) => {
      tf.loads.push({ kind: 'tokenizer', remote: tf.env.allowRemoteModels, model });
      return (texts: string[]) => { tf.tokenized.push(texts); return { texts }; };
    }),
  },
  AutoModel: {
    from_pretrained: vi.fn(async (model: string, opts: { dtype?: string }) => {
      tf.loads.push({ kind: 'model', remote: tf.env.allowRemoteModels, model, dtype: opts.dtype });
      return async (inputs: { texts: string[] }) => {
        if (tf.graph === 'throw') throw new Error('onnxruntime exploded');
        if (tf.graph === 'no-output') return {};
        const n = inputs.texts.length;
        const data = new Float32Array(n * 4);
        // row j = [length of text j, 1, 1, 1] — the length survives L2 normalisation as row[0] / row[1]
        inputs.texts.forEach((t, j) => { data.set([t.length, 1, 1, 1], j * 4); });
        return { sentence_embedding: { data, dims: [n, 4] } };
      };
    }),
  },
}));

let home: string;
const realHome = process.env.HOME;
const realModel = process.env.DREAMCONTEXT_EMBED_MODEL;

async function loadEmbedder(selector?: string) {
  if (selector === undefined) delete process.env.DREAMCONTEXT_EMBED_MODEL; else process.env.DREAMCONTEXT_EMBED_MODEL = selector;
  vi.resetModules();
  return import('../../src/lib/embeddings/embedder.js');
}

function placeFiles(repo: string, files: string[]): void {
  const root = join(home, '.dreamcontext', 'models', repo);
  for (const f of files) {
    mkdirSync(join(root, f, '..'), { recursive: true });
    writeFileSync(join(root, f), 'x');
  }
}

const GEMMA_REPO = 'onnx-community/embeddinggemma-300m-ONNX';
const GEMMA_Q8_GRAPH = ['onnx/model_quantized.onnx', 'config.json', 'tokenizer.json'];
const GEMMA_COMPLETE = [...GEMMA_Q8_GRAPH, 'onnx/model_quantized.onnx_data'];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-embed-profiles-'));
  process.env.HOME = home;
  tf.env.allowRemoteModels = true;
  tf.loads.length = 0;
  tf.tokenized.length = 0;
  tf.graph = 'ok';
});
afterEach(() => {
  process.env.HOME = realHome;
  if (realModel === undefined) delete process.env.DREAMCONTEXT_EMBED_MODEL; else process.env.DREAMCONTEXT_EMBED_MODEL = realModel;
  rmSync(home, { recursive: true, force: true });
});

describe('profile table', () => {
  it('defaults to EmbeddingGemma q8', () => {
    const p = selectEmbedProfile(undefined);
    expect(p.id).toBe(DEFAULT_EMBED_PROFILE_ID);
    expect(p.id).toBe('embeddinggemma-q8');
    expect(p.model).toBe(GEMMA_REPO);
    expect(p.dims).toBe(768);
    expect(p.dtype).toBe('q8');
  });

  it('keeps e5-small, and its cache key is the bare repo id every existing e5 index was written with', () => {
    const e5 = selectEmbedProfile('e5-small');
    expect(e5.model).toBe('Xenova/multilingual-e5-small');
    expect(e5.dims).toBe(384);
    expect(embedCacheModelKey(e5)).toBe('Xenova/multilingual-e5-small');
  });

  it('accepts a profile id, a cache key, or the pre-profile bare repo id', () => {
    expect(selectEmbedProfile('e5-small').id).toBe('e5-small');
    expect(selectEmbedProfile(embedCacheModelKey(selectEmbedProfile('e5-small'))).id).toBe('e5-small');
    expect(selectEmbedProfile('Xenova/multilingual-e5-small').id).toBe('e5-small');
    expect(selectEmbedProfile(GEMMA_REPO).id).toBe('embeddinggemma-q8');
    expect(selectEmbedProfile(embedCacheModelKey(selectEmbedProfile('embeddinggemma-q8'))).id).toBe('embeddinggemma-q8');
  });

  it('falls back to the default for an unknown or blank selector — never guesses a prompt format', () => {
    expect(selectEmbedProfile('some/unknown-model').id).toBe(DEFAULT_EMBED_PROFILE_ID);
    expect(selectEmbedProfile('   ').id).toBe(DEFAULT_EMBED_PROFILE_ID);
  });

  it('every profile has its own cache key, and the dtype is part of Gemma\'s', () => {
    const keys = EMBED_PROFILES.map((p) => embedCacheModelKey(p));
    expect(new Set(keys).size).toBe(EMBED_PROFILES.length);
    expect(embedCacheModelKey(selectEmbedProfile('embeddinggemma-q8'))).toBe(`${GEMMA_REPO}#q8`);
  });

  it('every profile\'s graph file and weights file follow transformers.js\'s dtype naming', () => {
    for (const p of EMBED_PROFILES) {
      const suffix = p.dtype === 'q8' ? 'model_quantized' : `model_${p.dtype}`;
      expect(p.files).toContain(`onnx/${suffix}.onnx`);
      for (const data of p.dataFiles) expect(data).toBe(`onnx/${suffix}.onnx_data`);
    }
  });
});

describe('model files on disk', () => {
  it('Gemma: graph + metadata = downloaded, but the weights file makes it complete', async () => {
    placeFiles(GEMMA_REPO, GEMMA_Q8_GRAPH);
    const e = await loadEmbedder();
    expect(e.isEmbedModelDownloaded()).toBe(true);
    expect(e.isEmbedModelComplete()).toBe(false);
    placeFiles(GEMMA_REPO, ['onnx/model_quantized.onnx_data']);
    expect(e.isEmbedModelComplete()).toBe(true);
  });

  it('a Gemma download does not satisfy the e5 profile (and vice versa) — each profile checks its own directory', async () => {
    placeFiles(GEMMA_REPO, [...GEMMA_Q8_GRAPH, 'onnx/model_quantized.onnx_data']);
    const e = await loadEmbedder('e5-small');
    expect(e.isEmbedModelDownloaded()).toBe(false);
  });

  it('e5: complete is the same three files — nothing else to wait for', async () => {
    placeFiles('Xenova/multilingual-e5-small', GEMMA_Q8_GRAPH);
    const e = await loadEmbedder('e5-small');
    expect(e.isEmbedModelDownloaded()).toBe(true);
    expect(e.isEmbedModelComplete()).toBe(true);
  });
});

describe('Gemma load path', () => {
  it('with every file on disk: tokenizer and graph load with remote models OFF, the q8 dtype', async () => {
    placeFiles(GEMMA_REPO, [...GEMMA_Q8_GRAPH, 'onnx/model_quantized.onnx_data']);
    const e = await loadEmbedder();
    expect(await e.embedQuery('hello')).not.toBeNull();
    expect(tf.loads.map((l) => l.kind)).toEqual(['tokenizer', 'model']);
    expect(tf.loads.every((l) => l.remote === false)).toBe(true);
    expect(tf.loads.every((l) => l.model === GEMMA_REPO)).toBe(true);
    expect(tf.loads[1].dtype).toBe('q8');
  });

  it('a download cut short (graph without its weights) is NOT re-fetched by a plain load — only the opted-in door heals it', async () => {
    placeFiles(GEMMA_REPO, GEMMA_Q8_GRAPH);
    const e = await loadEmbedder();
    expect(e.isEmbedModelDownloaded()).toBe(true); // the three-file gate is satisfied...
    expect(await e.embedQuery('hello')).toBeNull(); // ...but a recall-path load must not fetch the rest (BM25 fallback)
    expect(tf.loads).toEqual([]);
    expect(await e.embeddingsAvailable({ allowDownload: true })).toBe(true); // `embed ensure` / the download route do
    expect(tf.loads.every((l) => l.remote === true)).toBe(true);
  });

  it('uses the model card\'s prompt markers for queries and passages', async () => {
    placeFiles(GEMMA_REPO, GEMMA_COMPLETE);
    const e = await loadEmbedder();
    await e.embedQuery('how do I publish');
    await e.embedPassages(['a passage']);
    expect(tf.tokenized[0]).toEqual(['task: search result | query: how do I publish']);
    expect(tf.tokenized[1]).toEqual(['title: none | text: a passage']);
  });

  it('returns L2-normalised vectors read from the graph\'s sentence_embedding output', async () => {
    placeFiles(GEMMA_REPO, GEMMA_COMPLETE);
    const e = await loadEmbedder();
    const v = await e.embedQuery('x');
    expect(v).not.toBeNull();
    const norm = Math.sqrt(Array.from(v as Float32Array).reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('batches by length (longest first) and returns the vectors in INPUT order', async () => {
    placeFiles(GEMMA_REPO, GEMMA_COMPLETE);
    const e = await loadEmbedder();
    const texts = ['aa', 'a much longer passage of text here', 'bbbb', 'cccccccc'];
    const out = await e.embedPassages(texts);
    expect(out).not.toBeNull();
    const batch = tf.tokenized[0];
    // sorted longest-first inside the batch
    expect(batch.map((t) => t.length)).toEqual([...batch.map((t) => t.length)].sort((a, b) => b - a));
    // row j carries the length of the prefixed text j: row[0] / row[1]
    out!.forEach((row, j) => {
      expect(Math.round(row[0] / row[1])).toBe(`title: none | text: ${texts[j]}`.length);
    });
  });

  it('reports monotonic progress ending at the total, across several batches', async () => {
    placeFiles(GEMMA_REPO, GEMMA_COMPLETE);
    const e = await loadEmbedder();
    const seen: number[] = [];
    const out = await e.embedPassages(Array.from({ length: 40 }, (_, i) => `passage ${i}`), (done, total) => {
      expect(total).toBe(40);
      seen.push(done);
    });
    expect(out).toHaveLength(40);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen[seen.length - 1]).toBe(40);
  });

  it('an inference failure yields null (BM25 fallback), never a throw', async () => {
    placeFiles(GEMMA_REPO, GEMMA_COMPLETE);
    const e = await loadEmbedder();
    tf.graph = 'throw';
    await expect(e.embedQuery('x')).resolves.toBeNull();
    await expect(e.embedPassages(['x'])).resolves.toBeNull();
  });

  it('a graph without a sentence_embedding output yields null too', async () => {
    placeFiles(GEMMA_REPO, GEMMA_COMPLETE);
    const e = await loadEmbedder();
    tf.graph = 'no-output';
    await expect(e.embedQuery('x')).resolves.toBeNull();
  });
});

describe('e5 load path (unchanged)', () => {
  it('runs the feature-extraction pipeline with the q8 dtype and the e5 prompt markers, in input order', async () => {
    placeFiles('Xenova/multilingual-e5-small', GEMMA_Q8_GRAPH);
    const e = await loadEmbedder('e5-small');
    await e.embedQuery('hello');
    expect(tf.loads).toEqual([{ kind: 'pipeline', remote: false, model: 'Xenova/multilingual-e5-small', dtype: 'q8' }]);
    expect(tf.tokenized[0]).toEqual(['query: hello']);

    const out = await e.embedPassages(['b', 'aaaa']);
    expect(tf.tokenized[1]).toEqual(['passage: b', 'passage: aaaa']); // NOT length-sorted
    expect(out!.map((row) => row[0])).toEqual(['passage: b'.length, 'passage: aaaa'.length]);
  });
});

describe('per-profile dedup defaults', () => {
  const ENVS = ['DREAMCONTEXT_DEDUP_MERGE', 'DREAMCONTEXT_DEDUP_MERGE_MARGIN', 'DREAMCONTEXT_DEDUP_REVIEW', 'DREAMCONTEXT_DECLINED_MATCH'];
  afterEach(() => { for (const k of ENVS) delete process.env[k]; });

  async function loadGates(selector: string) {
    process.env.DREAMCONTEXT_EMBED_MODEL = selector;
    vi.resetModules();
    const dedup = await import('../../src/lib/embeddings/dedup.js');
    const declined = await import('../../src/lib/task-declined.js');
    return { dedup, declined };
  }

  it('e5-small keeps exactly the gates it was calibrated with (behaviour byte-identical)', () => {
    const e5 = selectEmbedProfile('e5-small');
    expect([e5.dedupMerge, e5.dedupMergeMargin, e5.dedupReview, e5.declinedMatch]).toEqual([0.97, 0.02, 0.91, 0.82]);
  });

  it('every profile\'s gates are coherent: floor ≤ review ≤ merge ≤ 1, margin ≥ 0, declined floor in range', async () => {
    const { dedup } = await loadGates('e5-small');
    for (const p of EMBED_PROFILES) {
      expect(p.dedupReview).toBeGreaterThanOrEqual(dedup.DEDUP_MIN_THRESHOLD);
      expect(p.dedupReview).toBeLessThanOrEqual(p.dedupMerge);
      expect(p.dedupMerge).toBeLessThanOrEqual(1);
      expect(p.dedupMergeMargin).toBeGreaterThanOrEqual(0);
      expect(p.declinedMatch).toBeGreaterThanOrEqual(dedup.DEDUP_MIN_THRESHOLD);
      expect(p.declinedMatch).toBeLessThanOrEqual(1);
    }
  });

  it('Gemma\'s gates sit on its own, wider cosine scale — all below e5\'s, which never fire on it', () => {
    const gemma = selectEmbedProfile('embeddinggemma-q8');
    const e5 = selectEmbedProfile('e5-small');
    expect(gemma.dedupMerge).toBeLessThan(e5.dedupMerge);
    expect(gemma.dedupReview).toBeLessThan(e5.dedupReview);
    expect(gemma.declinedMatch).toBeLessThan(e5.declinedMatch);
    expect(gemma.dedupMergeMargin).toBeGreaterThan(e5.dedupMergeMargin); // a wider spread needs a wider lead
  });

  it('the dedup and declined-idea gates follow the ACTIVE profile', async () => {
    for (const p of EMBED_PROFILES) {
      const { dedup, declined } = await loadGates(p.id);
      expect(dedup.DEDUP_MERGE_THRESHOLD).toBe(p.dedupMerge);
      expect(dedup.DEDUP_MERGE_MARGIN).toBe(p.dedupMergeMargin);
      expect(dedup.DEDUP_REVIEW_THRESHOLD).toBe(p.dedupReview);
      expect(declined.DECLINED_MATCH_THRESHOLD).toBe(p.declinedMatch);
      expect(declined.declinedMatchThreshold()).toBe(p.declinedMatch);
    }
  });

  it('env overrides still win over the profile, and a bad value falls back to the profile\'s own', async () => {
    const gemma = selectEmbedProfile('embeddinggemma-q8');
    process.env.DREAMCONTEXT_DEDUP_MERGE = '0.85';
    process.env.DREAMCONTEXT_DEDUP_REVIEW = '0.6';
    process.env.DREAMCONTEXT_DEDUP_MERGE_MARGIN = '0';
    process.env.DREAMCONTEXT_DECLINED_MATCH = '0.9';
    let g = await loadGates('embeddinggemma-q8');
    expect([g.dedup.DEDUP_MERGE_THRESHOLD, g.dedup.DEDUP_REVIEW_THRESHOLD, g.dedup.DEDUP_MERGE_MARGIN]).toEqual([0.85, 0.6, 0]);
    expect(g.declined.declinedMatchThreshold()).toBe(0.9);

    process.env.DREAMCONTEXT_DEDUP_MERGE = '0.1'; // below the safety floor → ignored
    process.env.DREAMCONTEXT_DECLINED_MATCH = 'nope';
    g = await loadGates('embeddinggemma-q8');
    expect(g.dedup.DEDUP_MERGE_THRESHOLD).toBe(gemma.dedupMerge);
    expect(g.declined.declinedMatchThreshold()).toBe(gemma.declinedMatch);
  });
});

describe('per-profile fusion', () => {
  it('e5-small keeps its pre-2026-10 fusion; Gemma has its own, with a dense gate', () => {
    const e5 = selectEmbedProfile('e5-small');
    const gemma = selectEmbedProfile('embeddinggemma-q8');
    expect([e5.adaptiveCutoff, e5.adaptiveLambda, e5.denseGate]).toEqual([18, 0.1, null]);
    expect([gemma.adaptiveCutoff, gemma.adaptiveLambda, gemma.denseGate]).toEqual([12, 0.7, { raw: 24, margin: 1.25 }]);
  });

  it('every profile\'s fusion is coherent: λ in (0,1), gate raw at/above the cutoff, margin ≥ 1', () => {
    for (const p of EMBED_PROFILES) {
      expect(p.adaptiveLambda).toBeGreaterThan(0);
      expect(p.adaptiveLambda).toBeLessThan(1);
      if (p.denseGate) {
        expect(p.denseGate.raw).toBeGreaterThanOrEqual(p.adaptiveCutoff);
        expect(p.denseGate.margin).toBeGreaterThanOrEqual(1);
      }
    }
  });
});
