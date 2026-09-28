// Embedding-cache writes are serialized per vault (HYBRID DELTA a/b, task: the notch Assistant
// answers without the plumbing). Several processes refresh ONE cache — a hook per prompt, the
// server's index build, sleep, `embed refresh` — and a plain load → modify → save let the later
// save drop the earlier one's vectors. These pin the fix:
//   • two concurrent refreshes both land their chunks (no lost vectors);
//   • a held lock makes the hook path (waitForLock:false) return at once, writing nothing;
//   • a waiting writer gives up after its bounded spin, throws, and writes nothing;
//   • a prune never evicts a vector another writer added mid-refresh;
//   • a failed index build is not re-fired inside the 30-minute cooldown.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CorpusDoc } from '../../src/lib/recall.js';
import {
  refreshEmbeddings, embeddingCacheLockPath, EmbeddingLockBusyError,
} from '../../src/lib/embeddings/store.js';
import { acquireFileLock, releaseFileLock } from '../../src/lib/file-lock.js';
import {
  startIndexBuild, ensureIndexBuilt, _resetIndexRuns, INDEX_BUILD_ERROR_COOLDOWN_MS,
} from '../../src/server/routes/embeddings.js';

let root: string;

function doc(slug: string, body: string): CorpusDoc {
  const path = join(root, 'knowledge', `${slug}.md`);
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  writeFileSync(path, body);
  return { type: 'knowledge', slug, title: slug, description: '', body, path } as unknown as CorpusDoc;
}

function cacheOnDisk(): { docs: Record<string, unknown>; vectors: Record<string, string> } {
  return JSON.parse(readFileSync(join(root, '.embeddings', 'cache.json'), 'utf-8'));
}

const vec = () => new Float32Array([0.6, 0.8, 0]);

/** An embedder whose answer the test releases — so two refreshes overlap for real. */
function gatedEmbedder() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const embed = async (texts: string[]) => { await gate; return texts.map(vec); };
  return { embed, release };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-embed-lock-'));
  _resetIndexRuns();
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('refreshEmbeddings — per-vault write lock', () => {
  it('two concurrent refreshes both land their chunks', async () => {
    const a = doc('alpha', '# Alpha\n\nThe alpha section talks about apples in some depth.\n');
    const b = doc('beta', '# Beta\n\nThe beta section talks about bananas in some depth.\n');
    const ea = gatedEmbedder();
    const eb = gatedEmbedder();
    // Both load the SAME (empty) snapshot before either writes.
    const pa = refreshEmbeddings(root, [a], ea.embed, { additive: true });
    const pb = refreshEmbeddings(root, [b], eb.embed, { additive: true });
    ea.release();
    await pa;
    eb.release();
    await pb;
    const cache = cacheOnDisk();
    expect(Object.keys(cache.docs).sort()).toEqual(['knowledge/alpha', 'knowledge/beta']);
    // Every doc's chunks have a vector on disk — none was lost to the later save.
    for (const d of Object.values(cache.docs) as Array<{ hashes: string[] }>) {
      for (const h of d.hashes) expect(cache.vectors[h]).toBeDefined();
    }
    expect(existsSync(embeddingCacheLockPath(root))).toBe(false); // released
  });

  it('a held lock makes the hook path return without blocking, writing nothing', async () => {
    const a = doc('alpha', '# Alpha\n\nApples.\n');
    const lock = embeddingCacheLockPath(root);
    expect(acquireFileLock(lock, Date.now(), 60_000)).toBe(true);
    try {
      const t0 = Date.now();
      const res = await refreshEmbeddings(root, [a], async (t) => t.map(vec), { additive: true, waitForLock: false });
      expect(Date.now() - t0).toBeLessThan(500);
      expect(res).not.toBeNull(); // it still searches (what it loaded + what it computed)
      expect(existsSync(join(root, '.embeddings', 'cache.json'))).toBe(false); // nothing persisted
    } finally {
      releaseFileLock(lock);
    }
  });

  it('a waiting writer gives up after its bounded spin: throws, writes nothing', async () => {
    const a = doc('alpha', '# Alpha\n\nApples.\n');
    const lock = embeddingCacheLockPath(root);
    acquireFileLock(lock, Date.now(), 60_000);
    try {
      await expect(refreshEmbeddings(root, [a], async (t) => t.map(vec), { waitForLock: true, lockWaitMs: 80 }))
        .rejects.toBeInstanceOf(EmbeddingLockBusyError);
      expect(existsSync(join(root, '.embeddings', 'cache.json'))).toBe(false);
    } finally {
      releaseFileLock(lock);
    }
  });

  it('a waiting writer lands once the holder releases', async () => {
    const a = doc('alpha', '# Alpha\n\nApples.\n');
    const lock = embeddingCacheLockPath(root);
    acquireFileLock(lock, Date.now(), 60_000);
    setTimeout(() => releaseFileLock(lock), 60);
    await refreshEmbeddings(root, [a], async (t) => t.map(vec), { waitForLock: true, lockWaitMs: 5_000 });
    expect(Object.keys(cacheOnDisk().docs)).toEqual(['knowledge/alpha']);
  });

  it('a prune never evicts a vector another writer added mid-refresh', async () => {
    const a = doc('alpha', '# Alpha\n\nApples.\n');
    const b = doc('beta', '# Beta\n\nBananas.\n');
    // The pruning refresh (whole corpus = [a]) starts from an empty snapshot …
    const ep = gatedEmbedder();
    const prune = refreshEmbeddings(root, [a], ep.embed, {});
    // … while a hook adds beta and lands first.
    await refreshEmbeddings(root, [b], async (t) => t.map(vec), { additive: true });
    ep.release();
    await prune;
    const cache = cacheOnDisk();
    expect(Object.keys(cache.docs).sort()).toEqual(['knowledge/alpha', 'knowledge/beta']);
    const betaHashes = (cache.docs['knowledge/beta'] as { hashes: string[] }).hashes;
    for (const h of betaHashes) expect(cache.vectors[h]).toBeDefined();
  });

  it('a prune still evicts what it saw and no longer wants', async () => {
    const a = doc('alpha', '# Alpha\n\nApples.\n');
    const b = doc('beta', '# Beta\n\nBananas.\n');
    const embed = async (t: string[]) => t.map(vec);
    await refreshEmbeddings(root, [a, b], embed, {});
    const res = await refreshEmbeddings(root, [a], embed, {});
    expect(Object.keys(cacheOnDisk().docs)).toEqual(['knowledge/alpha']);
    expect(res?.stats.evicted).toBeGreaterThan(0);
  });
});

describe('startIndexBuild — single flight + error cooldown', () => {
  it('a failed build is not re-fired inside the cooldown (injected failing embedder)', async () => {
    doc('alpha', '# Alpha\n\nApples.\n');
    let calls = 0;
    const failing = async (): Promise<Float32Array[] | null> => { calls += 1; throw new Error('model exploded'); };
    let t = 1_000_000;
    const now = () => t;

    const first = startIndexBuild(root, { embed: failing, now });
    expect(first.started).toBe(true);
    await first.done;
    expect(first.run.state).toBe('error');

    t += 60_000; // a second spawn, a minute later
    const second = startIndexBuild(root, { embed: failing, now });
    expect(second.started).toBe(false);
    expect(calls).toBe(1);

    // The explicit Build button is never held back by it.
    const explicit = startIndexBuild(root, { embed: failing, now, ignoreCooldown: true });
    expect(explicit.started).toBe(true);
    await explicit.done;

    t += INDEX_BUILD_ERROR_COOLDOWN_MS + 1; // past the cooldown → retried
    const later = startIndexBuild(root, { embed: failing, now });
    expect(later.started).toBe(true);
    await later.done;
    expect(calls).toBe(3);
  });

  it('two starts during one build start one build', async () => {
    doc('alpha', '# Alpha\n\nApples.\n');
    const g = gatedEmbedder();
    const a = startIndexBuild(root, { embed: g.embed });
    const b = startIndexBuild(root, { embed: g.embed });
    expect(a.started).toBe(true);
    expect(b.started).toBe(false);
    g.release();
    await a.done;
    expect(a.run.state).toBe('ready');
  });

  it('ensureIndexBuilt: only with the model on disk and an unusable cache', async () => {
    doc('alpha', '# Alpha\n\nApples.\n');
    const embed = async (t: string[]) => t.map(vec);
    expect(ensureIndexBuilt(root, { modelOnDisk: () => false, usable: () => false, embed })).toBe(false);
    expect(ensureIndexBuilt(root, { modelOnDisk: () => true, usable: () => true, embed })).toBe(false);
    expect(ensureIndexBuilt(root, { modelOnDisk: () => true, usable: () => false, embed })).toBe(true);
  });
});
