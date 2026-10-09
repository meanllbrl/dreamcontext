import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EMBED_PROFILE } from '../../src/lib/embeddings/profiles.js';

// A large model's ONNX graph (small) lands before its weights, so a download that was interrupted
// or is still running leaves the three small files in place with the weights missing. Loading that
// model is not offline: the embedder re-opens the remote fetch, UNLOCKED, racing the one process
// (`embed ensure`) that is allowed to download. So the server's index paths treat such a model as
// "not on disk" and never start a build against it. These run the REAL completeness probe against a
// temp HOME (modules are re-imported under it: the models dir is fixed at import time).

const HAS_WEIGHTS = EMBED_PROFILE.dataFiles.length > 0;

// The download route is the one server door that may fetch. transformers.js is mocked so a
// "fetch" is just a recorded load; what matters is WHEN it starts relative to the download lock.
const tf = vi.hoisted(() => ({
  env: { allowRemoteModels: true as boolean, cacheDir: '' },
  /** One entry per model load: allowRemoteModels at that call, and whether the lock file existed. */
  loads: [] as Array<{ remote: boolean; lockHeld: boolean }>,
  lockPath: '',
}));

vi.mock('@huggingface/transformers', () => {
  const record = async (): Promise<void> => {
    const { existsSync: exists } = await import('node:fs');
    tf.loads.push({ remote: tf.env.allowRemoteModels, lockHeld: exists(tf.lockPath) });
  };
  return {
    env: tf.env,
    pipeline: vi.fn(async () => { await record(); return async () => ({ data: new Float32Array([1, 0]), dims: [1, 2] }); }),
    AutoTokenizer: { from_pretrained: vi.fn(async () => { await record(); return () => ({}); }) },
    AutoModel: { from_pretrained: vi.fn(async () => { await record(); return async () => ({}); }) },
  };
});

let tmp: string;
let home: string;
let root: string;
const savedHome = process.env.HOME;

function writeModel(withWeights: boolean): void {
  const dir = join(home, '.dreamcontext', 'models', EMBED_PROFILE.model);
  for (const f of [...EMBED_PROFILE.files, ...(withWeights ? EMBED_PROFILE.dataFiles : [])]) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), 'x');
  }
}

async function routes() {
  vi.resetModules();
  return import('../../src/server/routes/embeddings.js');
}

/** A response double that records the status and parsed JSON body. */
function fakeRes() {
  const out: { status?: number; body?: any } = {};
  const res = {
    writeHead: (status: number) => { out.status = status; },
    end: (body: string) => { out.body = JSON.parse(body); },
  } as unknown as ServerResponse;
  return { res, out };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ac-embed-route-'));
  home = join(tmp, 'home');
  root = join(tmp, 'project', '_dream_context');
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  writeFileSync(join(root, 'knowledge', 'alpha.md'), '---\nname: alpha\n---\nApples.\n');
  process.env.HOME = home;
  tf.loads.length = 0;
  tf.lockPath = join(home, '.dreamcontext', 'models', '.download.lock');
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  vi.resetModules();
  rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!HAS_WEIGHTS)('server index paths with a half-downloaded model (graph present, weights missing)', () => {
  const embed = async (texts: string[]) => texts.map(() => new Float32Array([0.6, 0.8, 0]));

  it('ensureIndexBuilt (run on every Assistant spawn) starts no build, so nothing can re-open the fetch', async () => {
    writeModel(false);
    const { ensureIndexBuilt, _resetIndexRuns } = await routes();
    _resetIndexRuns();
    expect(ensureIndexBuilt(root, { usable: () => false, embed })).toBe(false);
    expect(existsSync(join(root, '.embeddings'))).toBe(false);
  });

  it('handleEmbeddingIndexBuild answers 409 model_missing and starts no build', async () => {
    writeModel(false);
    const { handleEmbeddingIndexBuild, _resetIndexRuns } = await routes();
    _resetIndexRuns();
    const { res, out } = fakeRes();
    await handleEmbeddingIndexBuild({} as IncomingMessage, res, {}, root);
    expect(out.status).toBe(409);
    expect(out.body.error).toBe('model_missing');
    expect(existsSync(join(root, '.embeddings'))).toBe(false);
  });

  it('control: once the weights are on disk, ensureIndexBuilt does start the build', async () => {
    writeModel(true);
    const { ensureIndexBuilt, _resetIndexRuns } = await routes();
    _resetIndexRuns();
    expect(ensureIndexBuilt(root, { usable: () => false, embed })).toBe(true);
    await new Promise((r) => setTimeout(r, 100)); // let the (fake-embedder) build finish before the temp dir goes
  });
});

describe('POST /api/embeddings/download goes through the download lock', () => {
  const lockPath = () => join(home, '.dreamcontext', 'models', '.download.lock');

  it('with a detached `embed ensure` holding the lock, the route fetches nothing until the lock is released', async () => {
    mkdirSync(join(home, '.dreamcontext', 'models'), { recursive: true });
    writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, at: Date.now() }) + '\n');
    const { handleEmbeddingModelDownload } = await routes();
    const { res, out } = fakeRes();
    await handleEmbeddingModelDownload({} as IncomingMessage, res);
    expect(out.status).toBe(200);
    expect(out.body.ok).toBe(true);

    await new Promise((r) => { setTimeout(r, 200); });
    expect(tf.loads).toEqual([]); // parked behind the holder: it never raced it

    rmSync(lockPath(), { force: true }); // `embed ensure` finishes
    await vi.waitFor(() => expect(tf.loads.length).toBeGreaterThan(0), { timeout: 3000 });
    expect(tf.loads.every((l) => l.remote && l.lockHeld)).toBe(true); // and then fetched under the lock
    await vi.waitFor(() => expect(existsSync(lockPath())).toBe(false));
  });

  it('with the lock free, the fetch runs holding it', async () => {
    const { handleEmbeddingModelDownload } = await routes();
    const { res } = fakeRes();
    await handleEmbeddingModelDownload({} as IncomingMessage, res);
    await vi.waitFor(() => expect(tf.loads.length).toBeGreaterThan(0), { timeout: 3000 });
    expect(tf.loads.every((l) => l.remote && l.lockHeld)).toBe(true);
    await vi.waitFor(() => expect(existsSync(lockPath())).toBe(false));
  });
});
