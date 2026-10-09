// The embedding loader is the ONE door to the network. Two rules, proven here against a mocked
// @huggingface/transformers (no real model, no real fetch, a temp HOME):
//
//   1. A caller that did not opt in (`allowDownload`) NEVER turns remote models on: an incomplete
//      model gives null (BM25 fallback), touches no state and creates nothing on disk.
//   2. An opted-in fetch runs under the machine-wide download lock, wipes a torn leftover first,
//      and leaves the model "incomplete" until the ONNX session has loaded.
//
// Plus the callers that used to bypass the door: `embed refresh|dedup --if-present` and the
// server's download route (the latter in embeddings-route-incomplete-model.test.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Command } from 'commander';

interface LoadRecord {
  remote: boolean;
  lockHeld: boolean;
  sentinel: boolean;
  /** A file the previous (torn) attempt left behind was still there when the load began. */
  tornLeftover: boolean;
}

const tf = vi.hoisted(() => {
  const state = {
    env: { allowRemoteModels: true as boolean, cacheDir: '' },
    loads: [] as LoadRecord[],
    probe: { lock: '', sentinel: '', leftover: '' },
    onLoad: null as null | (() => Promise<void> | void),
    /** Runs right after the loader's dynamic import resolves — the gap between its completeness probe and its load. */
    onImport: null as null | (() => void),
    fail: false,
    /** An offline load of a model whose files are gone throws, as the real library does. */
    strictOffline: false,
    /** Files this attempt reports as fully fetched (progress `done`), before the session load. */
    fetchedFiles: [] as string[],
    active: 0,
    maxActive: 0,
  };
  // The loader sets `env.cacheDir` the moment its import resolves, before its second probe.
  Object.defineProperty(state.env, 'cacheDir', {
    configurable: true,
    get: () => '',
    set: () => { state.onImport?.(); },
  });
  return state;
});

vi.mock('@huggingface/transformers', () => {
  const record = async (opts?: { progress_callback?: (e: { status: string; file: string }) => void }): Promise<void> => {
    const { existsSync: exists } = await import('node:fs');
    tf.loads.push({
      remote: tf.env.allowRemoteModels,
      lockHeld: exists(tf.probe.lock),
      sentinel: exists(tf.probe.sentinel),
      tornLeftover: exists(tf.probe.leftover),
    });
    tf.active++;
    tf.maxActive = Math.max(tf.maxActive, tf.active);
    try {
      if (tf.strictOffline && !tf.env.allowRemoteModels && !exists(tf.probe.leftover)) {
        throw new Error('offline and the model files are not cached');
      }
      await tf.onLoad?.();
      for (const file of tf.fetchedFiles) opts?.progress_callback?.({ status: 'done', file });
      if (tf.fail) throw new Error('simulated download failure');
    } finally {
      tf.active--;
    }
  };
  return {
    env: tf.env,
    pipeline: vi.fn(async (_task: string, _model: string, opts?: { progress_callback?: (e: { status: string; file: string }) => void }) => {
      await record(opts);
      return async (texts: string[]) => ({ data: new Float32Array(texts.length * 2).fill(1), dims: [texts.length, 2] });
    }),
    AutoTokenizer: { from_pretrained: vi.fn(async () => { await record(); return () => ({}); }) },
    AutoModel: { from_pretrained: vi.fn(async () => { await record(); return async () => ({}); }) },
  };
});

const E5_REPO = 'Xenova/multilingual-e5-small';
const GEMMA_REPO = 'onnx-community/embeddinggemma-300m-ONNX';
const GRAPH_FILES = ['onnx/model_quantized.onnx', 'config.json', 'tokenizer.json'];

let tmp: string;
let home: string;
const realHome = process.env.HOME;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['DREAMCONTEXT_EMBED_MODEL', 'DREAMCONTEXT_EMBED_AUTO', 'DREAMCONTEXT_RECALL_MODE'] as const;

const modelsDir = () => join(home, '.dreamcontext', 'models');
const lockPath = () => join(modelsDir(), '.download.lock');

function placeFiles(repo: string, files: string[]): void {
  for (const f of files) {
    const p = join(modelsDir(), repo, f);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, 'x');
  }
}

/** Fresh module instances under the temp HOME (the models dir is fixed at import time). */
/** `null` = the default profile (an `undefined` argument would just pick the e5 default here). */
async function loadEmbedder(selector: string | null = 'e5-small') {
  if (selector === null) delete process.env.DREAMCONTEXT_EMBED_MODEL; else process.env.DREAMCONTEXT_EMBED_MODEL = selector;
  vi.resetModules();
  const mod = await import('../../src/lib/embeddings/embedder.js');
  tf.probe.lock = lockPath();
  tf.probe.sentinel = join(modelsDir(), mod.EMBED_PROFILE.model, '.downloading');
  tf.probe.leftover = join(modelsDir(), mod.EMBED_PROFILE.model, 'config.json');
  return mod;
}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), 'dc-embed-lock-'));
  home = join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  tf.env.allowRemoteModels = true;
  tf.loads.length = 0;
  tf.onLoad = null;
  tf.onImport = null;
  tf.fail = false;
  tf.strictOffline = false;
  tf.fetchedFiles = [];
  tf.active = 0;
  tf.maxActive = 0;
});

afterEach(() => {
  process.env.HOME = realHome;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  process.exitCode = undefined;
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe('a caller that did not opt in never fetches', () => {
  it('model absent: embedQuery / embedPassages / embeddingsAvailable give null/false, load nothing, create nothing', async () => {
    const e = await loadEmbedder();
    expect(await e.embedQuery('hello')).toBeNull();
    expect(await e.embedPassages(['a'])).toBeNull();
    expect(await e.embeddingsAvailable()).toBe(false);
    expect(tf.loads).toEqual([]);
    expect(tf.env.allowRemoteModels).toBe(true); // never even touched: the flag is only ever set by a load
    expect(existsSync(modelsDir())).toBe(false); // no lock file, no model dir, no sentinel
    expect(e.getEmbedModelStatus().state).toBe('not_downloaded'); // a refusal is not a failure
  });

  it('graph without its weights (a half download) is incomplete too — still no fetch', async () => {
    placeFiles(GEMMA_REPO, GRAPH_FILES);
    const e = await loadEmbedder(null); // the default profile ships external weights
    expect(e.isEmbedModelDownloaded()).toBe(true);
    expect(e.isEmbedModelComplete()).toBe(false);
    expect(await e.embedQuery('hello')).toBeNull();
    expect(await e.embeddingsAvailable()).toBe(false);
    expect(tf.loads).toEqual([]);
    expect(existsSync(lockPath())).toBe(false);
  });

  it('a refusal does not poison the process: a later opted-in call still downloads', async () => {
    const e = await loadEmbedder();
    expect(await e.embeddingsAvailable()).toBe(false);
    expect(await e.embeddingsAvailable({ allowDownload: true })).toBe(true);
    expect(tf.loads.map((l) => l.remote)).toEqual([true]);
  });

  it('a complete model loads offline with no lock and no sentinel, opted in or not', async () => {
    placeFiles(E5_REPO, GRAPH_FILES);
    const e = await loadEmbedder();
    expect(await e.embedQuery('hello')).not.toBeNull();
    expect(tf.loads).toEqual([{ remote: false, lockHeld: false, sentinel: false, tornLeftover: true }]);
    expect(existsSync(lockPath())).toBe(false);
  });
});

describe('an opted-in download holds the machine-wide lock', () => {
  it('the lock and the interrupted-download sentinel exist for the whole fetch, and both are gone after', async () => {
    const e = await loadEmbedder();
    expect(await e.embeddingsAvailable({ allowDownload: true })).toBe(true);
    expect(tf.loads).toEqual([{ remote: true, lockHeld: true, sentinel: true, tornLeftover: false }]);
    expect(existsSync(lockPath())).toBe(false);
    expect(existsSync(tf.probe.sentinel)).toBe(false);
  });

  it('startEmbedModelDownload (the server route\'s door) takes the same lock', async () => {
    const e = await loadEmbedder();
    e.startEmbedModelDownload();
    await vi.waitFor(() => expect(tf.loads).toHaveLength(1));
    expect(tf.loads[0]).toMatchObject({ remote: true, lockHeld: true });
    await vi.waitFor(() => expect(e.getEmbedModelStatus().state).not.toBe('downloading'));
    expect(existsSync(lockPath())).toBe(false);
  });

  it('a live holder keeps it out: the fetch does not start and the holder\'s lock is untouched', async () => {
    mkdirSync(modelsDir(), { recursive: true });
    writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, at: Date.now() }) + '\n');
    const e = await loadEmbedder();
    expect(await e.embeddingsAvailable({ allowDownload: true, waitMs: 120 })).toBe(false);
    expect(tf.loads).toEqual([]);
    expect(existsSync(lockPath())).toBe(true);
    expect(e.getEmbedModelStatus().error).toMatch(/another process is still downloading/);
  });

  it('two concurrent downloads serialize: the second waits, then finds the model complete and loads offline', async () => {
    const a = await loadEmbedder();
    const b = await loadEmbedder(); // an independent module instance = an independent process, same lock file
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    tf.onLoad = async () => {
      if (tf.loads.length !== 1) return; // only the first (fetching) load is held open
      await gate;
      placeFiles(E5_REPO, GRAPH_FILES); // the "download" lands its files
    };

    const first = a.embeddingsAvailable({ allowDownload: true });
    await vi.waitFor(() => expect(tf.loads).toHaveLength(1));
    const second = b.embeddingsAvailable({ allowDownload: true });
    await new Promise((r) => { setTimeout(r, 200); });
    expect(tf.loads).toHaveLength(1); // b is parked on the lock, not fetching alongside a
    expect(existsSync(lockPath())).toBe(true);

    release();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(tf.loads.map((l) => l.remote)).toEqual([true, false]);
    expect(tf.maxActive).toBe(1);
    expect(existsSync(lockPath())).toBe(false);
  });
});

describe('a torn download cannot pass for a finished one', () => {
  it('a leftover sentinel makes complete files count as incomplete: callers get null, no fetch', async () => {
    placeFiles(E5_REPO, GRAPH_FILES);
    const e = await loadEmbedder();
    writeFileSync(tf.probe.sentinel, '{}');
    expect(e.isEmbedModelDownloaded()).toBe(true);
    expect(e.isEmbedModelComplete()).toBe(false);
    expect(await e.embedQuery('hello')).toBeNull();
    expect(tf.loads).toEqual([]);
  });

  it('the next opted-in attempt wipes the torn files and fetches afresh', async () => {
    placeFiles(E5_REPO, GRAPH_FILES);
    const e = await loadEmbedder();
    writeFileSync(tf.probe.sentinel, '{}');
    expect(await e.embeddingsAvailable({ allowDownload: true })).toBe(true);
    expect(tf.loads).toEqual([{ remote: true, lockHeld: true, sentinel: true, tornLeftover: false }]);
    expect(existsSync(tf.probe.sentinel)).toBe(false);
  });

  it('a fetch that dies after writing files leaves the model incomplete, and the retry refetches', async () => {
    const e = await loadEmbedder();
    tf.fail = true;
    tf.onLoad = () => placeFiles(E5_REPO, GRAPH_FILES); // files land, then the load throws
    expect(await e.embeddingsAvailable({ allowDownload: true })).toBe(false);
    expect(existsSync(lockPath())).toBe(false); // the lock is released even on failure
    expect(e.isEmbedModelDownloaded()).toBe(true);
    expect(e.isEmbedModelComplete()).toBe(false); // sentinel still there
    expect(await e.embedQuery('x')).toBeNull(); // and nobody else may use or re-fetch it

    tf.fail = false;
    tf.onLoad = null;
    expect(await e.embeddingsAvailable({ allowDownload: true })).toBe(true);
    expect(tf.loads[1]).toEqual({ remote: true, lockHeld: true, sentinel: true, tornLeftover: false });
    expect(existsSync(tf.probe.sentinel)).toBe(false);
  });
});

describe('a fetch that finished but whose ONNX session will not start is not a torn download', () => {
  const RAW_ERROR = 'simulated download failure'; // what the mock's session load throws
  // The surfaced text adds the way out, so a user who hits it knows what to run.
  const SESSION_ERROR = expect.stringMatching(/^simulated download failure — .*dreamcontext embed ensure --repair/);

  it('keeps the files, records the load error, and a later attempt retries the load OFFLINE instead of re-downloading', async () => {
    const e = await loadEmbedder();
    tf.fetchedFiles = GRAPH_FILES; // every expected file reported whole...
    tf.onLoad = () => placeFiles(E5_REPO, GRAPH_FILES);
    tf.fail = true; // ...then the session refuses to start (native binary / CPU)
    expect(await e.embeddingsAvailable({ allowDownload: true })).toBe(false);
    expect(tf.loads).toEqual([{ remote: true, lockHeld: true, sentinel: true, tornLeftover: false }]);
    expect(existsSync(lockPath())).toBe(false);
    expect(JSON.parse(readFileSync(tf.probe.sentinel, 'utf-8'))).toMatchObject({ phase: 'fetched', loadError: SESSION_ERROR });
    expect(e.isEmbedModelDownloaded()).toBe(true); // the files are all there...
    expect(e.isEmbedModelComplete()).toBe(false); // ...but the model is not usable: hybrid stays off, nobody loads it per prompt
    expect(e.getEmbedLoadError()).toEqual(SESSION_ERROR);
    expect(e.getEmbedLoadError()).toContain(RAW_ERROR);

    // The next process (a fresh module instance): same verdict from disk alone, then a retry that wipes nothing.
    tf.onLoad = null;
    const next = await loadEmbedder();
    expect(next.getEmbedModelStatus()).toMatchObject({ state: 'error', downloaded: false, error: SESSION_ERROR });
    expect(await next.embedQuery('x')).toBeNull(); // a recall-path caller never retries the load or the fetch
    expect(await next.embeddingsAvailable({ allowDownload: true })).toBe(false);
    expect(tf.loads).toHaveLength(2);
    expect(tf.loads[1]).toEqual({ remote: false, lockHeld: true, sentinel: true, tornLeftover: true }); // offline, files untouched

    // Once the environment is fixed the same files load, and the sentinel goes away.
    tf.fail = false;
    const fixed = await loadEmbedder();
    expect(await fixed.embeddingsAvailable({ allowDownload: true })).toBe(true);
    expect(tf.loads[2].remote).toBe(false);
    expect(existsSync(tf.probe.sentinel)).toBe(false);
    expect(fixed.isEmbedModelComplete()).toBe(true);
    expect(fixed.getEmbedModelStatus()).toMatchObject({ state: 'ready', downloaded: true, error: null });
  });

  it('a fetch that died before every file was whole is still torn: the next attempt wipes and refetches', async () => {
    const e = await loadEmbedder();
    tf.fetchedFiles = ['config.json']; // the graph and tokenizer never reported whole
    tf.onLoad = () => placeFiles(E5_REPO, GRAPH_FILES);
    tf.fail = true;
    expect(await e.embeddingsAvailable({ allowDownload: true })).toBe(false);
    expect(JSON.parse(readFileSync(tf.probe.sentinel, 'utf-8')).phase).toBe('fetching');

    tf.onLoad = null;
    tf.fail = false;
    const next = await loadEmbedder();
    expect(await next.embeddingsAvailable({ allowDownload: true })).toBe(true);
    expect(tf.loads[1]).toEqual({ remote: true, lockHeld: true, sentinel: true, tornLeftover: false });
  });

  it('ensureHybridReady: the second ensure does not re-download, fails with the reason, and the status agrees', async () => {
    process.env.DREAMCONTEXT_RECALL_MODE = 'hybrid';
    delete process.env.DREAMCONTEXT_EMBED_AUTO;
    const root = join(tmp, 'project', '_dream_context');
    mkdirSync(join(root, 'state'), { recursive: true });
    const e = await loadEmbedder();
    const { ensureHybridReady } = await import('../../src/lib/embeddings/provision.js');
    const deps = { isPackageInstalled: () => true, cacheUsable: () => true };
    tf.fetchedFiles = GRAPH_FILES;
    tf.onLoad = () => { if (tf.loads.length === 1) placeFiles(E5_REPO, GRAPH_FILES); };
    tf.fail = true;

    expect(await ensureHybridReady(root, {}, deps)).toBe('failed');
    const marker = JSON.parse(readFileSync(join(root, '.embeddings', 'ensure.json'), 'utf-8')) as { reason: string };
    expect(marker.reason).toEqual(SESSION_ERROR); // the throttle marker says WHY (and what to run), not just "failed"

    expect(await ensureHybridReady(root, {}, deps)).toBe('failed');
    expect(tf.loads.map((l) => l.remote)).toEqual([true, false]); // 300 MB are fetched once, not once per ensure
    expect(e.getEmbedModelStatus()).toMatchObject({ state: 'error', downloaded: false, error: SESSION_ERROR });
  });
});

describe('a caller that did not opt in stays offline even if the model changes under it', () => {
  it('the model going incomplete between the completeness probe and the load never turns the fetch on', async () => {
    placeFiles(E5_REPO, GRAPH_FILES);
    const e = await loadEmbedder();
    tf.strictOffline = true;
    // The loader probed "complete", then yields on its dynamic import; here another process wipes the model.
    tf.onImport = () => rmSync(join(modelsDir(), E5_REPO), { recursive: true, force: true });
    expect(e.isEmbedModelComplete()).toBe(true);
    expect(await e.embedQuery('hello')).toBeNull(); // offline load of a missing model fails → BM25
    expect(tf.loads).toEqual([{ remote: false, lockHeld: false, sentinel: false, tornLeftover: false }]);
    expect(tf.env.allowRemoteModels).toBe(false);
    expect(existsSync(lockPath())).toBe(false);
    expect(existsSync(tf.probe.sentinel)).toBe(false); // and it wrote nothing into the model dir
  });

  it('an opted-in caller whose model was whole at the probe is offline too: no fetch, no lock — and the NEXT call repairs under the lock', async () => {
    placeFiles(E5_REPO, GRAPH_FILES);
    const e = await loadEmbedder();
    tf.strictOffline = true;
    tf.onImport = () => rmSync(join(modelsDir(), E5_REPO), { recursive: true, force: true });
    expect(await e.embeddingsAvailable({ allowDownload: true })).toBe(false);
    expect(tf.loads).toEqual([{ remote: false, lockHeld: false, sentinel: false, tornLeftover: false }]);

    tf.onImport = null;
    expect(await e.embeddingsAvailable({ allowDownload: true })).toBe(true);
    expect(tf.loads[1]).toEqual({ remote: true, lockHeld: true, sentinel: true, tornLeftover: false });
  });
});

describe('a whole model never waits on, or takes, the download lock', () => {
  const writeLock = (ageMs: number, pid = process.pid) => {
    mkdirSync(modelsDir(), { recursive: true });
    writeFileSync(lockPath(), JSON.stringify({ pid, at: Date.now() - ageMs }) + '\n');
  };

  it('a stale lock whose PID was recycled by a live process does not hold a good model: it loads offline at once', async () => {
    placeFiles(E5_REPO, GRAPH_FILES);
    writeLock(3 * 60 * 60 * 1000); // 3 h old, recorded PID alive (recycled)
    const e = await loadEmbedder();
    const t0 = Date.now();
    expect(await e.embeddingsAvailable({ allowDownload: true, waitMs: 5_000 })).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(tf.loads).toEqual([{ remote: false, lockHeld: true, sentinel: false, tornLeftover: true }]); // lockHeld = the stale file, untouched
    expect(e.getEmbedModelStatus()).toMatchObject({ state: 'ready', downloaded: true, error: null });
  });
});

describe('a whole model ignores even a LIVE download lock', () => {
  it('another process mid-download elsewhere (fresh lock, live PID) does not delay loading a model that is already whole', async () => {
    placeFiles(E5_REPO, GRAPH_FILES);
    mkdirSync(modelsDir(), { recursive: true });
    writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, at: Date.now() }) + '\n');
    const e = await loadEmbedder();
    expect(await e.embeddingsAvailable({ allowDownload: true, waitMs: 150 })).toBe(true);
    expect(tf.loads.every((l) => !l.remote)).toBe(true);
    expect(existsSync(lockPath())).toBe(true); // never touched
  });
});

describe('the download lock — and only it — is reclaimable past a hard age ceiling', () => {
  const writeLock = (ageMs: number) => {
    mkdirSync(modelsDir(), { recursive: true });
    writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, at: Date.now() - ageMs }) + '\n');
  };

  it('a lock older than the ceiling is taken over although its PID is alive: the download proceeds, then releases it', async () => {
    writeLock(3 * 60 * 60 * 1000);
    const e = await loadEmbedder();
    expect(await e.embeddingsAvailable({ allowDownload: true, waitMs: 500 })).toBe(true);
    expect(tf.loads).toEqual([{ remote: true, lockHeld: true, sentinel: true, tornLeftover: false }]);
    expect(existsSync(lockPath())).toBe(false);
  });

  it('a lock past the stale age but under the ceiling, with a live PID, is still respected', async () => {
    writeLock(60 * 60 * 1000); // 1 h: past staleMs (30 min), under the 2 h ceiling
    const e = await loadEmbedder();
    expect(await e.embeddingsAvailable({ allowDownload: true, waitMs: 150 })).toBe(false);
    expect(tf.loads).toEqual([]);
    expect(existsSync(lockPath())).toBe(true);
  });
});

describe('a `fetched` model whose files were damaged afterwards, and --repair', () => {
  /** Gemma ships an external-data file, so this is the profile where "missing weights" exists. */
  const fetchedSentinel = JSON.stringify({ phase: 'fetched', loadError: 'session would not start' });
  const bigFile = (repo: string, rel: string, bytes: number) => {
    const p = join(modelsDir(), repo, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, Buffer.alloc(bytes, 1));
  };

  it('weights gone: no offline retry — the wipe-and-refetch path runs, under the lock', async () => {
    placeFiles(GEMMA_REPO, GRAPH_FILES); // graph + metadata only; the weights file was cleaned away
    writeFileSync(join(modelsDir(), GEMMA_REPO, '.downloading'), fetchedSentinel);
    const e = await loadEmbedder(null);
    expect(await e.embeddingsAvailable({ allowDownload: true })).toBe(true);
    expect(tf.loads.length).toBeGreaterThan(0);
    expect(tf.loads[0]).toEqual({ remote: true, lockHeld: true, sentinel: true, tornLeftover: false }); // wiped first
    expect(tf.loads.every((l) => l.remote && l.lockHeld)).toBe(true);
    expect(existsSync(tf.probe.sentinel)).toBe(false);
  });

  it('weights present at a plausible size: the offline retry still applies (no wipe, no fetch)', async () => {
    placeFiles(GEMMA_REPO, GRAPH_FILES);
    bigFile(GEMMA_REPO, 'onnx/model_quantized.onnx_data', 1024 * 1024 + 1);
    writeFileSync(join(modelsDir(), GEMMA_REPO, '.downloading'), fetchedSentinel);
    const e = await loadEmbedder(null);
    expect(await e.embeddingsAvailable({ allowDownload: true })).toBe(true);
    expect(tf.loads.every((l) => !l.remote && l.tornLeftover)).toBe(true);
    expect(existsSync(tf.probe.sentinel)).toBe(false);
    expect(e.isEmbedModelComplete()).toBe(true);
  });

  it('weights truncated to a stub: damaged, not a load problem — refetched', async () => {
    placeFiles(GEMMA_REPO, [...GRAPH_FILES, 'onnx/model_quantized.onnx_data']); // 1-byte "weights"
    writeFileSync(join(modelsDir(), GEMMA_REPO, '.downloading'), fetchedSentinel);
    const e = await loadEmbedder(null);
    expect(await e.embeddingsAvailable({ allowDownload: true })).toBe(true);
    expect(tf.loads[0]).toMatchObject({ remote: true, lockHeld: true, tornLeftover: false });
  });

  it('the load error surfaced for a fetched model names `embed ensure --repair`', async () => {
    const e = await loadEmbedder();
    tf.fetchedFiles = GRAPH_FILES;
    tf.onLoad = () => placeFiles(E5_REPO, GRAPH_FILES);
    tf.fail = true;
    await e.embeddingsAvailable({ allowDownload: true });
    expect(e.getEmbedModelStatus().error).toMatch(/dreamcontext embed ensure --repair/);
  });

  it('a whole, sentinel-free model whose weights are damaged fails offline — and the error still names `embed ensure --repair`', async () => {
    placeFiles(E5_REPO, GRAPH_FILES);
    const e = await loadEmbedder();
    tf.fail = true; // the offline session load throws on the damaged weights
    expect(e.isEmbedModelComplete()).toBe(true);
    expect(await e.embeddingsAvailable({ allowDownload: true })).toBe(false);
    expect(tf.loads.every((l) => !l.remote)).toBe(true); // offline, no fetch, no lock
    expect(e.getEmbedLoadError()).toMatch(/^simulated download failure — .*dreamcontext embed ensure --repair/);
    expect(e.getEmbedModelStatus().error).toMatch(/dreamcontext embed ensure --repair/);
    expect(existsSync(tf.probe.sentinel)).toBe(false); // nothing was recorded on disk: the model was never "fetched" here
  });

  it('repair wipes a whole-looking model and refetches it under the lock', async () => {
    placeFiles(E5_REPO, GRAPH_FILES);
    const e = await loadEmbedder();
    expect(e.isEmbedModelComplete()).toBe(true);
    expect(await e.embeddingsAvailable({ allowDownload: true, repair: true })).toBe(true);
    expect(tf.loads).toEqual([{ remote: true, lockHeld: true, sentinel: true, tornLeftover: false }]);
    expect(existsSync(lockPath())).toBe(false);
    expect(existsSync(tf.probe.sentinel)).toBe(false);
  });

  it('startEmbedModelDownload({ repair }) (the server route) does the same', async () => {
    placeFiles(E5_REPO, GRAPH_FILES);
    const e = await loadEmbedder();
    e.startEmbedModelDownload({ repair: true });
    await vi.waitFor(() => expect(tf.loads).toHaveLength(1));
    expect(tf.loads[0]).toEqual({ remote: true, lockHeld: true, sentinel: true, tornLeftover: false });
  });

  it('ensureHybridReady({ repair: true }) refetches although every file looks present — and plain ensure does not', async () => {
    process.env.DREAMCONTEXT_RECALL_MODE = 'hybrid';
    delete process.env.DREAMCONTEXT_EMBED_AUTO;
    const root = join(tmp, 'project', '_dream_context');
    mkdirSync(join(root, 'state'), { recursive: true });
    placeFiles(E5_REPO, GRAPH_FILES);
    await loadEmbedder();
    const { ensureHybridReady } = await import('../../src/lib/embeddings/provision.js');
    const deps = { isPackageInstalled: () => true, cacheUsable: () => true };
    expect(await ensureHybridReady(root, {}, deps)).toBe('ready');
    expect(tf.loads).toEqual([]);
    tf.onLoad = () => placeFiles(E5_REPO, GRAPH_FILES); // the repair's download lands its files again
    expect(await ensureHybridReady(root, { repair: true }, deps)).toBe('downloaded');
    expect(tf.loads).toEqual([{ remote: true, lockHeld: true, sentinel: true, tornLeftover: false }]);
    expect(await ensureHybridReady(root, { repair: true, allowDownload: false }, deps)).toBe('failed');
  });
});

describe('ensureHybridReady is an opted-in door and re-enters its own lock', () => {
  it('downloads once through the default loader without waiting on the lock it already holds', { timeout: 10_000 }, async () => {
    process.env.DREAMCONTEXT_RECALL_MODE = 'hybrid';
    delete process.env.DREAMCONTEXT_EMBED_AUTO;
    const root = join(tmp, 'project', '_dream_context');
    mkdirSync(join(root, 'state'), { recursive: true });
    const e = await loadEmbedder();
    const { ensureHybridReady } = await import('../../src/lib/embeddings/provision.js');
    tf.onLoad = () => placeFiles(E5_REPO, GRAPH_FILES);
    const out = await ensureHybridReady(root, {}, { isPackageInstalled: () => true, cacheUsable: () => true });
    expect(out).toBe('downloaded');
    expect(tf.loads).toEqual([{ remote: true, lockHeld: true, sentinel: true, tornLeftover: false }]);
    expect(e.isEmbedModelComplete()).toBe(true);
    expect(existsSync(lockPath())).toBe(false);
  });

  it('allowDownload:false stays off the network entirely', async () => {
    process.env.DREAMCONTEXT_RECALL_MODE = 'hybrid';
    delete process.env.DREAMCONTEXT_EMBED_AUTO;
    const root = join(tmp, 'project', '_dream_context');
    mkdirSync(join(root, 'state'), { recursive: true });
    await loadEmbedder();
    const { ensureHybridReady } = await import('../../src/lib/embeddings/provision.js');
    expect(await ensureHybridReady(root, { allowDownload: false }, { isPackageInstalled: () => true })).toBe('failed');
    expect(tf.loads).toEqual([]);
  });
});

describe('`embed refresh|dedup` gates (the sleep sub-agent paths)', () => {
  let project: string;
  let root: string;
  const cwd = process.cwd();
  let out: string[];

  async function run(...argv: string[]): Promise<void> {
    vi.resetModules();
    const { registerEmbedCommand } = await import('../../src/cli/commands/embed.js');
    const program = new Command().exitOverride();
    registerEmbedCommand(program);
    await program.parseAsync(['node', 'dreamcontext', 'embed', ...argv]);
  }

  /** A cache left by a PREVIOUS model: it exists on disk, but is not usable for the current one. */
  function writeOldModelCache(): void {
    mkdirSync(join(root, '.embeddings'), { recursive: true });
    writeFileSync(
      join(root, '.embeddings', 'cache.json'),
      JSON.stringify({ version: 1, model: 'some/old-model', docs: { 'knowledge/a': { path: 'a', mtimeMs: 1, hashes: ['h1'] } }, vectors: { h1: 'AAAA' } }),
    );
  }

  beforeEach(async () => {
    project = join(tmp, 'project');
    root = join(project, '_dream_context');
    mkdirSync(join(root, 'knowledge'), { recursive: true });
    writeFileSync(join(root, 'knowledge', 'alpha.md'), '---\nname: alpha\n---\nApples.\n');
    process.chdir(project);
    delete process.env.DREAMCONTEXT_EMBED_MODEL; // the default (Gemma) profile
    await loadEmbedder(null);
    out = [];
    const grab = (...a: unknown[]): void => { out.push(a.join(' ')); };
    vi.spyOn(console, 'log').mockImplementation(grab);
    vi.spyOn(console, 'warn').mockImplementation(grab);
    vi.spyOn(console, 'error').mockImplementation(grab);
  });

  afterEach(() => {
    process.chdir(cwd);
  });

  const nothingFetched = (): void => {
    expect(tf.loads).toEqual([]);
    expect(existsSync(lockPath())).toBe(false);
  };

  it('refresh --if-present with an OLD-model cache and no model: quiet exit 0, nothing fetched, nothing embedded', async () => {
    writeOldModelCache();
    await run('refresh', '--if-present');
    expect(process.exitCode).toBeUndefined();
    expect(out.join('\n')).toMatch(/nothing to refresh/i);
    nothingFetched();
  });

  it('refresh --if-present with a complete model but an unusable cache: still a quiet no-op (no inline re-index)', async () => {
    writeOldModelCache();
    placeFiles(GEMMA_REPO, [...GRAPH_FILES, 'onnx/model_quantized.onnx_data']);
    await run('refresh', '--if-present');
    expect(process.exitCode).toBeUndefined();
    nothingFetched();
  });

  it('refresh without --if-present and an incomplete model: names `embed ensure`, exits 1, downloads nothing', async () => {
    await run('refresh');
    expect(process.exitCode).toBe(1);
    expect(out.join('\n')).toMatch(/embed ensure/);
    nothingFetched();
  });

  it('dedup --if-present with an OLD-model cache and no model: verdict unknown, exit 0, nothing fetched', async () => {
    writeOldModelCache();
    await run('dedup', '--title', 'Apples', '--json', '--if-present');
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(out.join('\n'))).toEqual({ verdict: 'unknown', reason: 'no-embedding-cache' });
    nothingFetched();
  });

  it('dedup without --if-present and an incomplete model: unknown / model-incomplete, exit 1, nothing fetched', async () => {
    writeOldModelCache();
    await run('dedup', '--title', 'Apples', '--json');
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(out.join('\n'))).toEqual({ verdict: 'unknown', reason: 'model-incomplete' });
    nothingFetched();
  });

  it('dedup with a complete model but no usable index: unknown / embedding-cache-unusable — it never embeds the corpus inline', async () => {
    writeOldModelCache();
    placeFiles(GEMMA_REPO, [...GRAPH_FILES, 'onnx/model_quantized.onnx_data']);
    await run('dedup', '--title', 'Apples', '--json');
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(out.join('\n'))).toEqual({ verdict: 'unknown', reason: 'embedding-cache-unusable' });
    nothingFetched();
  });
});
