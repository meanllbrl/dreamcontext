import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ensureHybridReady,
  spawnEmbedEnsure,
  EMBED_ENSURE_RETRY_MS,
  EMBED_ENSURE_LOCK_STALE_MS,
  type EnsureDeps,
} from '../../src/lib/embeddings/provision.js';
import { EmbeddingLockBusyError, refreshEmbeddings, embeddingCacheLockPath, embeddingCacheUsable } from '../../src/lib/embeddings/store.js';
import { EMBED_PROFILE, embedCacheModelKey } from '../../src/lib/embeddings/profiles.js';
import { hybridReady } from '../../src/lib/embeddings/hybrid.js';
import { buildCorpus } from '../../src/lib/recall.js';
import { checkEmbeddings, type EmbeddingProbes } from '../../src/cli/commands/doctor.js';
import * as embedder from '../../src/lib/embeddings/embedder.js';
import * as provision from '../../src/lib/embeddings/provision.js';

// The suite runs with DREAMCONTEXT_EMBED_AUTO=0 (tests/setup/isolate-spawn-env.ts) so nothing can
// download or embed behind a test's back. This file is the one that exercises provisioning, so it
// clears the opt-out itself, and every probe/IO seam is injected: no model, network or HOME is touched.
const ENV_KEYS = ['DREAMCONTEXT_EMBED_AUTO', 'DREAMCONTEXT_RECALL_MODE'] as const;

let tmp: string;
let root: string;
let modelLock: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  delete process.env.DREAMCONTEXT_EMBED_AUTO;
  process.env.DREAMCONTEXT_RECALL_MODE = 'hybrid';
  tmp = mkdtempSync(join(tmpdir(), 'ac-embed-provision-'));
  root = join(tmp, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  modelLock = join(tmp, 'models', '.download.lock');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

const embeddingsPath = (...p: string[]) => join(root, '.embeddings', ...p);

type SpawnFn = NonNullable<Parameters<typeof spawnEmbedEnsure>[1]>['spawn'];
type TestDeps = EnsureDeps & { spawn?: SpawnFn };

/** Deps where the machine has the package and (optionally) the model; everything else injected. */
function deps(over: TestDeps = {}): TestDeps {
  return {
    isPackageInstalled: () => true,
    isModelComplete: () => true,
    cacheUsable: () => false,
    refresh: async () => ({ index: { chunks: [1, 2, 3] } }),
    loadModel: async () => true,
    modelLockPath: modelLock,
    now: () => 1_000_000_000_000,
    ...over,
  };
}

describe('ensureHybridReady — when it does nothing', () => {
  it('is a no-op under DREAMCONTEXT_EMBED_AUTO=0: no marker, no lock, no index', async () => {
    process.env.DREAMCONTEXT_EMBED_AUTO = '0';
    const refresh = vi.fn();
    expect(await ensureHybridReady(root, {}, deps({ refresh }))).toBe('skipped:optout');
    expect(refresh).not.toHaveBeenCalled();
    expect(existsSync(embeddingsPath())).toBe(false);
  });

  it('skips a vault whose recall mode is not hybrid', async () => {
    process.env.DREAMCONTEXT_RECALL_MODE = 'raw';
    const refresh = vi.fn();
    expect(await ensureHybridReady(root, {}, deps({ refresh }))).toBe('skipped:mode');
    expect(refresh).not.toHaveBeenCalled();
    expect(existsSync(embeddingsPath())).toBe(false);
  });

  it('skips when the runtime package is not installed (recall stays on BM25)', async () => {
    const loadModel = vi.fn();
    const refresh = vi.fn();
    expect(await ensureHybridReady(root, {}, deps({ isPackageInstalled: () => false, loadModel, refresh }))).toBe('skipped:package');
    expect(loadModel).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(existsSync(embeddingsPath())).toBe(false);
  });

  it('reports ready without touching the index when model and index are already usable', async () => {
    const refresh = vi.fn();
    expect(await ensureHybridReady(root, {}, deps({ cacheUsable: () => true, refresh }))).toBe('ready');
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('ensureHybridReady — the model', () => {
  it('never downloads with allowDownload:false and records no failure marker (the caller chose that)', async () => {
    const loadModel = vi.fn();
    expect(await ensureHybridReady(root, { allowDownload: false }, deps({ isModelComplete: () => false, loadModel }))).toBe('failed');
    expect(loadModel).not.toHaveBeenCalled();
    expect(existsSync(embeddingsPath('ensure.json'))).toBe(false);
    expect(existsSync(modelLock)).toBe(false);
  });

  it('downloads under the machine-wide lock, then releases it', async () => {
    let onDisk = false;
    let lockHeldDuringLoad = false;
    const loadModel = vi.fn(async () => {
      lockHeldDuringLoad = existsSync(modelLock);
      onDisk = true;
      return true;
    });
    const out = await ensureHybridReady(root, {}, deps({ isModelComplete: () => onDisk, cacheUsable: () => true, loadModel }));
    expect(out).toBe('downloaded');
    expect(loadModel).toHaveBeenCalledTimes(1);
    expect(lockHeldDuringLoad).toBe(true);
    expect(existsSync(modelLock)).toBe(false);
  });

  it('writes the retry marker when the download fails', async () => {
    const out = await ensureHybridReady(root, {}, deps({ isModelComplete: () => false, loadModel: async () => false }));
    expect(out).toBe('failed');
    const marker = JSON.parse(readFileSync(embeddingsPath('ensure.json'), 'utf-8')) as { at: number; reason: string };
    expect(marker.at).toBe(1_000_000_000_000);
    expect(marker.reason).toMatch(/download/);
    expect(existsSync(modelLock)).toBe(false);
  });

  it('does not re-download when another process finished the download while this one waited', async () => {
    let onDisk = false;
    const loadModel = vi.fn(async () => true);
    // The first probe (before the lock) says "absent"; by the time the lock is held it is on disk.
    const probe = vi.fn(() => { const was = onDisk; onDisk = true; return was; });
    const out = await ensureHybridReady(root, {}, deps({ isModelComplete: probe, cacheUsable: () => true, loadModel }));
    expect(out).toBe('ready');
    expect(loadModel).not.toHaveBeenCalled();
  });
});

describe('ensureHybridReady — the index', () => {
  it('builds the index once, reports indexed and clears an old failure marker', async () => {
    mkdirSync(embeddingsPath(), { recursive: true });
    writeFileSync(embeddingsPath('ensure.json'), JSON.stringify({ at: 1, reason: 'old' }));
    const refresh = vi.fn(async () => ({ index: { chunks: [1] } }));
    expect(await ensureHybridReady(root, {}, deps({ refresh }))).toBe('indexed');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(existsSync(embeddingsPath('ensure.json'))).toBe(false);
    expect(existsSync(embeddingsPath('ensure.lock'))).toBe(false); // the run lock is released
  });

  it('gitignores the .embeddings dir it creates, even when no cache was ever saved', async () => {
    await ensureHybridReady(root, {}, deps({ refresh: async () => null }));
    expect(readFileSync(embeddingsPath('.gitignore'), 'utf-8')).toBe('*\n');
  });

  it('fails with a marker when the model is unavailable at index time', async () => {
    expect(await ensureHybridReady(root, {}, deps({ refresh: async () => null }))).toBe('failed');
    expect(existsSync(embeddingsPath('ensure.json'))).toBe(true);
  });

  it('treats a busy cache lock as contention, not a fault: failed, but no marker', async () => {
    const refresh = async () => { throw new EmbeddingLockBusyError(); };
    expect(await ensureHybridReady(root, {}, deps({ refresh }))).toBe('failed');
    expect(existsSync(embeddingsPath('ensure.json'))).toBe(false);
  });

  it('records any other index failure as a marker', async () => {
    const refresh = async () => { throw new Error('disk full'); };
    expect(await ensureHybridReady(root, {}, deps({ refresh }))).toBe('failed');
    expect(JSON.parse(readFileSync(embeddingsPath('ensure.json'), 'utf-8')).reason).toBe('disk full');
  });

  it('lets only one ensure run work a vault: a live run lock means this run backs off untouched', async () => {
    mkdirSync(embeddingsPath(), { recursive: true });
    writeFileSync(embeddingsPath('ensure.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }) + '\n');
    const refresh = vi.fn();
    expect(await ensureHybridReady(root, {}, deps({ refresh, now: Date.now }))).toBe('failed');
    expect(refresh).not.toHaveBeenCalled();
    expect(existsSync(embeddingsPath('ensure.json'))).toBe(false);
    expect(existsSync(embeddingsPath('ensure.lock'))).toBe(true); // not ours — left alone
  });
});

describe('spawnEmbedEnsure', () => {
  const NOW = 1_000_000_000_000;

  function fakeSpawn() {
    const child = { on: vi.fn(), unref: vi.fn() };
    const spawn = vi.fn(() => child);
    return { spawn: spawn as unknown as SpawnFn, child, calls: spawn };
  }

  it('starts a DETACHED, stdio-ignored, unref()d `embed ensure --quiet` in the project dir', () => {
    const f = fakeSpawn();
    const started = spawnEmbedEnsure(root, deps({ isModelComplete: () => false, spawn: f.spawn }));
    expect(started).toBe(true);
    expect(f.calls).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = f.calls.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(cmd).toBe(process.execPath);
    expect(args.slice(1)).toEqual(['embed', 'ensure', '--quiet']);
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore', cwd: dirname(root) });
    expect(f.child.unref).toHaveBeenCalledTimes(1);
    expect(f.child.on).toHaveBeenCalledWith('error', expect.any(Function)); // a spawn failure cannot crash the hook
  });

  it('does not spawn under DREAMCONTEXT_EMBED_AUTO=0', () => {
    process.env.DREAMCONTEXT_EMBED_AUTO = '0';
    const f = fakeSpawn();
    expect(spawnEmbedEnsure(root, deps({ isModelComplete: () => false, spawn: f.spawn }))).toBe(false);
    expect(f.calls).not.toHaveBeenCalled();
    expect(existsSync(embeddingsPath())).toBe(false);
  });

  it('does not spawn when hybrid already engages, the mode is not hybrid, or the package is missing', () => {
    const f = fakeSpawn();
    expect(spawnEmbedEnsure(root, deps({ cacheUsable: () => true, spawn: f.spawn }))).toBe(false);
    expect(spawnEmbedEnsure(root, deps({ isPackageInstalled: () => false, isModelComplete: () => false, spawn: f.spawn }))).toBe(false);
    process.env.DREAMCONTEXT_RECALL_MODE = 'off';
    expect(spawnEmbedEnsure(root, deps({ isModelComplete: () => false, spawn: f.spawn }))).toBe(false);
    expect(f.calls).not.toHaveBeenCalled();
  });

  it('waits out a recent failure for 24h, then retries', () => {
    mkdirSync(embeddingsPath(), { recursive: true });
    writeFileSync(embeddingsPath('ensure.json'), JSON.stringify({ at: NOW - 1000, reason: 'download failed' }));
    const f = fakeSpawn();
    const d = deps({ isModelComplete: () => false, spawn: f.spawn, now: () => NOW });
    expect(spawnEmbedEnsure(root, d)).toBe(false);
    expect(spawnEmbedEnsure(root, { ...d, now: () => NOW + EMBED_ENSURE_RETRY_MS + 1 })).toBe(true);
  });

  it('does not stack a second process behind a live run, but reclaims a stale run lock', () => {
    mkdirSync(embeddingsPath(), { recursive: true });
    writeFileSync(embeddingsPath('ensure.lock'), JSON.stringify({ pid: 1, at: NOW - 1000 }));
    const f = fakeSpawn();
    const d = deps({ isModelComplete: () => false, spawn: f.spawn, now: () => NOW });
    expect(spawnEmbedEnsure(root, d)).toBe(false);
    expect(spawnEmbedEnsure(root, { ...d, now: () => NOW + EMBED_ENSURE_LOCK_STALE_MS + 1 })).toBe(true);
  });

  it('swallows a spawn that throws: provisioning must never break a hook', () => {
    const spawn = (() => { throw new Error('EAGAIN'); }) as unknown as SpawnFn;
    expect(spawnEmbedEnsure(root, deps({ isModelComplete: () => false, spawn }))).toBe(false);
  });
});

// Criterion 6, the parts that need no process: a hybrid prompt never provisions inline.
describe('the prompt path never provisions (criterion 6)', () => {
  /** A cache written by "another model": exists on disk, but is not usable for this build. */
  function writeStaleKeyCache(): void {
    mkdirSync(embeddingsPath(), { recursive: true });
    writeFileSync(embeddingsPath('cache.json'), JSON.stringify({
      version: 1,
      model: 'someone-else/another-embedding-model',
      docs: {},
      vectors: { deadbeef: 'AAAA' },
    }));
  }

  it('a stale cache key keeps hybrid off (so the hook falls back to BM25)', () => {
    writeStaleKeyCache();
    expect(existsSync(embeddingsPath('cache.json'))).toBe(true);
    expect(embeddingCacheUsable(root)).toBe(false);
    expect(hybridReady(root, 'hybrid')).toBe(false);
  });

  it('with no cache at all hybrid is not ready either', () => {
    expect(hybridReady(root, 'hybrid')).toBe(false);
  });

  it('a busy cache lock never blocks the prompt-path refresh and persists nothing', async () => {
    writeFileSync(join(root, 'state', 'a.md'), '---\nname: a\n---\nsome task body about widgets\n');
    const corpus = buildCorpus(root);
    expect(corpus.length).toBeGreaterThan(0);
    mkdirSync(embeddingsPath(), { recursive: true });
    writeFileSync(embeddingCacheLockPath(root), JSON.stringify({ pid: process.pid, at: Date.now() }) + '\n');

    const embed = async (texts: string[]) => texts.map(() => new Float32Array([1, 0, 0]));
    const t0 = Date.now();
    const res = await refreshEmbeddings(root, corpus, embed, { additive: true, waitForLock: false });
    expect(Date.now() - t0).toBeLessThan(2000); // a waiting writer would spin for 30 s
    expect(res).not.toBeNull();
    expect(existsSync(embeddingsPath('cache.json'))).toBe(false);
  });
});

/**
 * A model is only usable when its weights are on disk too. A large model's ONNX graph (tiny) lands
 * first, so a download killed mid-way leaves the three small files in place with the weights
 * missing. These tests run the REAL completeness probe against a temp HOME, so they fail if any
 * caller goes back to the three-file `isEmbedModelDownloaded` question.
 */
describe('an interrupted download (graph present, weights missing)', () => {
  const HAS_DATA_FILES = EMBED_PROFILE.dataFiles.length > 0;

  function writeModel(home: string, withWeights: boolean): void {
    const dir = join(home, '.dreamcontext', 'models', EMBED_PROFILE.model);
    const files = [...EMBED_PROFILE.files, ...(withWeights ? EMBED_PROFILE.dataFiles : [])];
    for (const f of files) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), 'x');
    }
  }

  function writeUsableCache(): void {
    mkdirSync(embeddingsPath(), { recursive: true });
    writeFileSync(embeddingsPath('cache.json'), JSON.stringify({
      version: 1, model: embedCacheModelKey(), docs: {}, vectors: { aa: 'AAAA' },
    }));
  }

  /** Run `fn` with modules re-imported under `home` (the models dir is fixed at import time). */
  async function underHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
    const previous = process.env.HOME;
    process.env.HOME = home;
    vi.resetModules();
    try {
      return await fn();
    } finally {
      if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
      vi.resetModules();
    }
  }

  it.skipIf(!HAS_DATA_FILES)('hybridReady is false for an incomplete model even with a usable index, and true once the weights land', async () => {
    const home = join(tmp, 'home');
    writeUsableCache();
    writeModel(home, false);
    const readyBefore = await underHome(home, async () => {
      const { hybridReady } = await import('../../src/lib/embeddings/hybrid.js');
      const { isEmbedModelDownloaded } = await import('../../src/lib/embeddings/embedder.js');
      expect(isEmbedModelDownloaded()).toBe(true); // the old three-file question is satisfied...
      return hybridReady(root, 'hybrid');
    });
    expect(readyBefore).toBe(false); // ...and the prompt path must still refuse (it would re-open the fetch)

    writeModel(home, true);
    const readyAfter = await underHome(home, async () => {
      const { hybridReady } = await import('../../src/lib/embeddings/hybrid.js');
      return hybridReady(root, 'hybrid');
    });
    expect(readyAfter).toBe(true);
  });

  it.skipIf(!HAS_DATA_FILES)('ensure repairs it under the machine-wide download lock', async () => {
    const home = join(tmp, 'home');
    writeModel(home, false);
    let lockHeldDuringRepair = false;
    const outcome = await underHome(home, async () => {
      const { ensureHybridReady: ensure } = await import('../../src/lib/embeddings/provision.js');
      return ensure(root, {}, {
        isPackageInstalled: () => true,
        cacheUsable: () => true,
        modelLockPath: modelLock,
        now: Date.now,
        loadModel: async () => {
          lockHeldDuringRepair = existsSync(modelLock);
          writeModel(home, true); // the fetch heals it
          return true;
        },
      });
    });
    expect(outcome).toBe('downloaded');
    expect(lockHeldDuringRepair).toBe(true);
    expect(existsSync(modelLock)).toBe(false);
  });

  it('spawnEmbedEnsure starts a repair even though the index is usable', () => {
    const child = { on: vi.fn(), unref: vi.fn() };
    const spawn = vi.fn(() => child) as unknown as SpawnFn;
    expect(spawnEmbedEnsure(root, deps({ isModelComplete: () => false, cacheUsable: () => true, spawn }))).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('two vaults repairing at once download ONCE: the second waits for the lock and finds the model complete', async () => {
    const rootB = join(tmp, 'other', '_dream_context');
    mkdirSync(join(rootB, 'state'), { recursive: true });
    let complete = false;
    let downloads = 0;
    const shared: TestDeps = {
      isPackageInstalled: () => true,
      isModelComplete: () => complete,
      cacheUsable: () => true,
      modelLockPath: modelLock,
      now: Date.now,
      loadModel: async () => {
        downloads++;
        await new Promise((r) => setTimeout(r, 150)); // a download takes time; the other ensure arrives meanwhile
        complete = true;
        return true;
      },
    };
    const [a, b] = await Promise.all([ensureHybridReady(root, {}, shared), ensureHybridReady(rootB, {}, shared)]);
    expect(downloads).toBe(1);
    expect([a, b].sort()).toEqual(['downloaded', 'ready']);
    expect(existsSync(modelLock)).toBe(false);
  });
});

describe('doctor: the hybrid-recall check', () => {
  const READY: EmbeddingProbes = { mode: 'hybrid', packageInstalled: true, modelDownloaded: true, indexUsable: true, automationOff: false };
  const check = (over: Partial<EmbeddingProbes>) => checkEmbeddings(root, { ...READY, ...over });

  it('is ok when hybrid is fully provisioned', () => {
    const [r] = check({});
    expect(r.status).toBe('ok');
    expect(r.code).toBe('doctor/hybrid-recall');
  });

  it('is ok, and says so, when the user chose a non-hybrid mode', () => {
    const [r] = check({ mode: 'raw', modelDownloaded: false, indexUsable: false });
    expect(r.status).toBe('ok');
    expect(r.message).toMatch(/raw/);
  });

  it('warns that BM25 is all there is when the runtime package is missing', () => {
    const [r] = check({ packageInstalled: false });
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/BM25 only/);
  });

  it('names exactly what is missing and offers both fixes', () => {
    const [model] = check({ modelDownloaded: false });
    expect(model.status).toBe('warn');
    expect(model.message).toMatch(/embedding model is not ready/);
    expect(model.supportedFixes).toEqual(['dreamcontext embed ensure', 'dreamcontext doctor --fix']);

    const [index] = check({ indexUsable: false });
    expect(index.message).toMatch(/embedding index is not ready/);

    const [both] = check({ modelDownloaded: false, indexUsable: false });
    expect(both.message).toMatch(/model and this vault's embedding index are not ready/);
  });

  it('says background provisioning is off when DREAMCONTEXT_EMBED_AUTO=0', () => {
    expect(check({ indexUsable: false, automationOff: true })[0].message).toMatch(/DREAMCONTEXT_EMBED_AUTO=0/);
    expect(check({ indexUsable: false })[0].message).toMatch(/provision it in the background/);
  });
});

describe('the model-download lock has one owner', () => {
  it('provision re-exports the embedder\'s lock constants, so there is a single stale/wait contract', () => {
    expect(provision.MODEL_DOWNLOAD_LOCK_STALE_MS).toBe(embedder.MODEL_DOWNLOAD_LOCK_STALE_MS);
    expect(provision.MODEL_DOWNLOAD_LOCK_WAIT_MS).toBe(embedder.MODEL_DOWNLOAD_LOCK_WAIT_MS);
    expect(embedder.MODEL_DOWNLOAD_LOCK_PATH.endsWith(join('models', '.download.lock'))).toBe(true);
  });
});
