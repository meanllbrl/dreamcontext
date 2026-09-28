// The embedding model loads OFFLINE once it is on disk (HYBRID DELTA c). transformers.js
// revalidates against the Hub by default — a network round trip in front of every hook
// process's first embed. getExtractor sets tf.env.allowRemoteModels = !isEmbedModelDownloaded()
// right before tf.pipeline, so with the files present nothing may fetch; with them absent
// (the explicit download door) it still can.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tf = vi.hoisted(() => ({
  env: { allowRemoteModels: true as boolean, cacheDir: '' },
  /** allowRemoteModels as it stood at each pipeline() call. */
  remoteAtLoad: [] as boolean[],
}));

vi.mock('@huggingface/transformers', () => ({
  env: tf.env,
  pipeline: vi.fn(async () => {
    tf.remoteAtLoad.push(tf.env.allowRemoteModels);
    // What a remote-allowed load would do on a cache miss / revalidation.
    if (tf.env.allowRemoteModels) await fetch('https://huggingface.co/Xenova/multilingual-e5-small/resolve/main/config.json');
    return async () => ({ data: new Float32Array([1, 0]), dims: [1, 2] });
  }),
}));

let home: string;
const realHome = process.env.HOME;
let fetchSpy: ReturnType<typeof vi.fn>;

async function loadEmbedder() {
  vi.resetModules();
  return import('../../src/lib/embeddings/embedder.js');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-embed-offline-'));
  process.env.HOME = home;
  tf.env.allowRemoteModels = true; // the library default
  tf.remoteAtLoad.length = 0;
  fetchSpy = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

function placeModelFiles(): void {
  const root = join(home, '.dreamcontext', 'models', 'Xenova', 'multilingual-e5-small');
  mkdirSync(join(root, 'onnx'), { recursive: true });
  writeFileSync(join(root, 'onnx', 'model_quantized.onnx'), 'x');
  writeFileSync(join(root, 'config.json'), '{}');
  writeFileSync(join(root, 'tokenizer.json'), '{}');
}

describe('getExtractor offline flag', () => {
  it('with the model files on disk, loads with remote models off and never fetches', async () => {
    placeModelFiles();
    const e = await loadEmbedder();
    expect(e.isEmbedModelDownloaded()).toBe(true);
    expect(await e.embedQuery('hello')).not.toBeNull();
    expect(tf.remoteAtLoad).toEqual([false]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('with the model absent (the explicit download door), remote models stay allowed', async () => {
    const e = await loadEmbedder();
    expect(e.isEmbedModelDownloaded()).toBe(false);
    e.startEmbedModelDownload();
    await vi.waitFor(() => expect(tf.remoteAtLoad).toEqual([true]));
  });
});
