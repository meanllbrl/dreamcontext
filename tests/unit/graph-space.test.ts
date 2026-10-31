/**
 * The Brain "meaning space" layout: related notes must land together, EVERY embedded document
 * must be on the map — including the kinds the link graph has no node for (archived tasks) —
 * and an unembedded vault must say so rather than fail. The embedding cache is synthesised (tiny hand-made vectors in two topics), so this
 * exercises the real loader → UMAP → k-means path without the 113 MB model.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSpace, kmeans2d } from '../../src/lib/graph-space.js';

let root: string;

function vec(v: number[]): string {
  return Buffer.from(new Float32Array(v).buffer).toString('base64');
}

/** Topic A points along axis 0, topic B along axis 1, each with a little deterministic jitter. */
function topicVec(topic: 'a' | 'b', i: number): number[] {
  const v = new Array(16).fill(0);
  v[topic === 'a' ? 0 : 1] = 1;
  v[2 + (i % 6)] = 0.05 * ((i % 3) + 1);
  return v;
}

function seedVault(): void {
  mkdirSync(join(root, 'knowledge', 'sub'), { recursive: true });
  const docs: Record<string, unknown> = {};
  const vectors: Record<string, string> = {};
  for (let i = 0; i < 12; i++) {
    const topic = i < 6 ? 'a' : 'b';
    const slug = `${topic}-note-${i}`;
    // Half of each topic is filed in a subfolder, which the graph's synthesised `path` misses.
    const rel = i % 2 ? join('knowledge', 'sub', `${slug}.md`) : join('knowledge', `${slug}.md`);
    writeFileSync(join(root, rel), `---\nname: ${slug}\ndescription: ${topic}\ntags: [${topic}]\n---\nbody\n`);
    const hash = `h${i}`;
    docs[`knowledge/${slug}`] = { path: join(root, rel), mtimeMs: 1, hashes: [hash] };
    vectors[hash] = vec(topicVec(topic, i));
  }
  // Archived tasks are in the recall corpus (and so in the embedding cache) but the link graph
  // has no node for them: the first version of the map silently dropped every one.
  mkdirSync(join(root, 'state', 'archive'), { recursive: true });
  for (let j = 0; j < 3; j++) {
    const slug = `old-task-${j}`;
    const rel = join('state', 'archive', `${slug}.md`);
    writeFileSync(join(root, rel), `---\nname: ${slug}\nstatus: completed\ntags: [a]\n---\nbody\n`);
    docs[`task/${slug}`] = { path: join(root, rel), mtimeMs: 1, hashes: [`t${j}`] };
    vectors[`t${j}`] = vec(topicVec('a', j));
  }
  mkdirSync(join(root, '.embeddings'), { recursive: true });
  writeFileSync(
    join(root, '.embeddings', 'cache.json'),
    JSON.stringify({ version: 1, model: process.env.DREAMCONTEXT_EMBED_MODEL ?? 'Xenova/multilingual-e5-small', docs, vectors }),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-space-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('kmeans2d', () => {
  it('is deterministic and separates two far-apart blobs', () => {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 10; i++) pts.push([i * 0.01, i * 0.01], [5 + i * 0.01, 5 + i * 0.01]);
    const a = kmeans2d(pts, 2);
    expect(kmeans2d(pts, 2)).toEqual(a);
    for (let i = 0; i < pts.length; i += 2) expect(a[i]).toBe(a[0]);
    for (let i = 1; i < pts.length; i += 2) expect(a[i]).toBe(a[1]);
    expect(a[0]).not.toBe(a[1]);
  });
});

describe('buildSpace', () => {
  it('reports no_embeddings for a vault without an index', async () => {
    const r = await buildSpace(root);
    expect(r).toEqual({ state: 'unavailable', reason: 'no_embeddings' });
  });

  it('places every embedded note — including ones in a knowledge subfolder — and groups topics', async () => {
    seedVault();
    const r = await buildSpace(root);
    expect(r.state).toBe('ready');
    if (r.state !== 'ready') return;
    expect(r.points).toHaveLength(15);
    // The three archived tasks (no graph node) are on the map.
    expect(r.points.filter((p) => p.t === 'task').map((p) => p.id).sort()).toEqual([
      'task/old-task-0',
      'task/old-task-1',
      'task/old-task-2',
    ]);

    // Points are keyed by corpus identity `type/slug`, wherever the file sits.
    const pos = new Map(r.points.map((p) => [p.id, p]));
    const id = (slug: string, _i: number) => `knowledge/${slug}`;
    const dist = (x: string, y: string) => {
      const p = pos.get(x)!, q = pos.get(y)!;
      return Math.hypot(p.x - q.x, p.y - q.y);
    };
    // Same-topic notes sit closer than cross-topic ones (subfolder note a-note-1 included).
    expect(dist(id('a-note-0', 0), id('a-note-1', 1))).toBeLessThan(dist(id('a-note-0', 0), id('b-note-6', 6)));
    expect(dist(id('b-note-6', 6), id('b-note-7', 7))).toBeLessThan(dist(id('b-note-6', 6), id('a-note-1', 1)));
    for (const p of r.points) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(1.0001);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(1.0001);
    }
    expect(r.clusters.reduce((n, c) => n + c.size, 0)).toBe(15);
  });

  it('serves the second call from the on-disk cache (same layout)', async () => {
    seedVault();
    const a = await buildSpace(root);
    const b = await buildSpace(root);
    expect(b).toEqual(a);
  });
});
