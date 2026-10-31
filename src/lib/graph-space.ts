import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { UMAP } from 'umap-js';
import { buildGraph } from './graph.js';
import { buildCorpus, docKey, type CorpusDoc } from './recall.js';
import { embeddingCacheSignature, loadDocCentroids } from './embeddings/store.js';

/**
 * The Brain "meaning space": every document that has an embedding, projected to 2D so that
 * related notes sit together. The set is the RECALL corpus (what the embeddings index), NOT the
 * link graph: the graph has no node for a changelog entry, an archived task, an insight or an
 * objective, and a map built from it silently dropped more than half the brain. Positions are computed ONCE (UMAP over per-doc centroid vectors),
 * cached next to the embedding cache, and served as static coordinates — the client runs no
 * simulation at all, which is what keeps the view fast.
 */

export interface SpacePoint {
  /** Corpus identity, `type/slug` — the same key recall hits and the embedding cache use. */
  id: string;
  /** Corpus type: knowledge, task, changelog, feature, insight… */
  t: string;
  /** Title. */
  l: string;
  /** Path relative to the vault (several changelog entries share one file). */
  p: string;
  /** Tags. */
  g: string[];
  /** Frontmatter status, when the doc has one. */
  s?: string;
  /** One-line gist for the hover card. */
  d: string;
  /** Id of the matching link-graph node, when there is one (opens the full drawer). */
  n?: string;
  /** Normalised to [-1, 1]. */
  x: number;
  y: number;
  /** Cluster index into `clusters`. */
  c: number;
}

export interface SpaceCluster {
  id: number;
  label: string;
  x: number;
  y: number;
  size: number;
}

export type SpaceResult =
  | { state: 'unavailable'; reason: 'no_embeddings' | 'too_few_docs' }
  | {
      state: 'ready';
      model: string;
      signature: string;
      computedAt: string;
      points: SpacePoint[];
      clusters: SpaceCluster[];
    };

const SPACE_FILE = 'space.json';
const SPACE_VERSION = 2;
const MIN_POINTS = 8;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic k-means (k-means++ seeding) on 2D points. Returns the cluster index per point. */
export function kmeans2d(pts: Array<[number, number]>, k: number, seed = 7): number[] {
  const n = pts.length;
  k = Math.max(1, Math.min(k, n));
  const rnd = mulberry32(seed);
  const centers: Array<[number, number]> = [pts[Math.floor(rnd() * n)]];
  const d2 = new Float64Array(n).fill(Infinity);
  while (centers.length < k) {
    const c = centers[centers.length - 1];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const dx = pts[i][0] - c[0];
      const dy = pts[i][1] - c[1];
      d2[i] = Math.min(d2[i], dx * dx + dy * dy);
      total += d2[i];
    }
    let r = rnd() * total;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      r -= d2[i];
      if (r <= 0) { pick = i; break; }
    }
    centers.push(pts[pick]);
  }
  const assign = new Array<number>(n).fill(0);
  for (let iter = 0; iter < 40; iter++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bd = Infinity;
      for (let j = 0; j < k; j++) {
        const dx = pts[i][0] - centers[j][0];
        const dy = pts[i][1] - centers[j][1];
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = j; }
      }
      if (assign[i] !== best) { assign[i] = best; moved = true; }
    }
    const sum = Array.from({ length: k }, () => [0, 0, 0]);
    for (let i = 0; i < n; i++) {
      sum[assign[i]][0] += pts[i][0];
      sum[assign[i]][1] += pts[i][1];
      sum[assign[i]][2]++;
    }
    for (let j = 0; j < k; j++) if (sum[j][2]) centers[j] = [sum[j][0] / sum[j][2], sum[j][1] / sum[j][2]];
    if (!moved) break;
  }
  return assign;
}

const GENERIC_TAGS = new Set(['tag', 'knowledge', 'feature', 'task', 'state']);
const STOP = new Set(['this', 'that', 'with', 'from', 'when', 'into', 'over', 'have', 'için', 'olan', 'gibi', 'daha', 'which', 'their', 'about']);

/** Distinctive-word score: frequent in the cluster, rare elsewhere. */
function topTerms(per: Array<Map<string, number>>, global: Map<string, number>, c: number, n: number): string[] {
  return [...per[c].entries()]
    .map(([t, here]) => ({ t, score: here * (here / (global.get(t) ?? here)) }))
    .sort((a, b) => b.score - a.score || a.t.localeCompare(b.t))
    .slice(0, n)
    .map((x) => x.t);
}

/**
 * A cluster label: its most distinctive tags; when the cluster has too few tags (changelog entries
 * carry none), its most distinctive title words; else its dominant type.
 */
function labelClusters(docs: Array<{ type: string; title: string; tags: string[] }>, assign: number[], k: number): string[] {
  const tagG = new Map<string, number>();
  const wordG = new Map<string, number>();
  const tagC: Array<Map<string, number>> = Array.from({ length: k }, () => new Map());
  const wordC: Array<Map<string, number>> = Array.from({ length: k }, () => new Map());
  const types: Array<Map<string, number>> = Array.from({ length: k }, () => new Map());
  docs.forEach((d, i) => {
    const c = assign[i];
    types[c].set(d.type, (types[c].get(d.type) ?? 0) + 1);
    for (const t of new Set(d.tags.map((x) => x.toLowerCase()))) {
      if (GENERIC_TAGS.has(t)) continue;
      tagG.set(t, (tagG.get(t) ?? 0) + 1);
      tagC[c].set(t, (tagC[c].get(t) ?? 0) + 1);
    }
    for (const w of new Set(d.title.toLowerCase().match(/\p{L}{4,}/gu) ?? [])) {
      if (STOP.has(w)) continue;
      wordG.set(w, (wordG.get(w) ?? 0) + 1);
      wordC[c].set(w, (wordC[c].get(w) ?? 0) + 1);
    }
  });
  return Array.from({ length: k }, (_, c) => {
    // Tags are often namespaced (`topic:recall`); the namespace is noise on a map label.
    const tags = topTerms(tagC, tagG, c, 3)
      .map((t) => t.replace(/^[a-z]+:/, ''))
      .filter((t) => !t.includes('/') && !t.endsWith('.md'));
    const parts = [...new Set(tags.slice(0, 2))];
    // Title words only fill the gap, and never repeat a tag ("recall · recall").
    for (const w of topTerms(wordC, wordG, c, 4)) {
      if (parts.length >= 2) break;
      if (!parts.includes(w)) parts.push(w);
    }
    const label = parts.join(' · ');
    if (label) return label;
    const top = [...types[c].entries()].sort((a, b) => b[1] - a[1])[0];
    return top ? top[0] : `cluster ${c + 1}`;
  });
}

function spacePath(contextRoot: string): string {
  return join(contextRoot, '.embeddings', SPACE_FILE);
}

function readSpaceCache(contextRoot: string, signature: string): SpaceResult | null {
  try {
    const p = spacePath(contextRoot);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, 'utf-8')) as SpaceResult & { v?: number };
    if (j.v !== SPACE_VERSION || j.state !== 'ready' || j.signature !== signature) return null;
    // Strip the bookkeeping field so a cached answer is byte-identical to a fresh one.
    const { v: _v, ...result } = j;
    return result as SpaceResult;
  } catch {
    return null;
  }
}

function writeSpaceCache(contextRoot: string, r: SpaceResult): void {
  try {
    mkdirSync(join(contextRoot, '.embeddings'), { recursive: true });
    const tmp = spacePath(contextRoot) + '.tmp';
    writeFileSync(tmp, JSON.stringify({ ...r, v: SPACE_VERSION }));
    renameSync(tmp, spacePath(contextRoot));
  } catch {
    // The cache is an optimisation; a read-only vault just recomputes.
  }
}

const inflight = new Map<string, Promise<SpaceResult>>();

/** Compute (or serve from cache) the meaning-space layout. Concurrent calls share one run. */
export function buildSpace(contextRoot: string): Promise<SpaceResult> {
  const key = resolve(contextRoot);
  const running = inflight.get(key);
  if (running) return running;
  const p = computeSpace(contextRoot).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function computeSpace(contextRoot: string): Promise<SpaceResult> {
  const signature = embeddingCacheSignature(contextRoot);
  if (!signature) return { state: 'unavailable', reason: 'no_embeddings' };

  // Same signature as the last run → same embeddings → same layout. Checked BEFORE the (slow)
  // corpus build so a warm request is a single file read.
  const cached = readSpaceCache(contextRoot, signature);
  if (cached) return cached;

  const centroids = new Map(loadDocCentroids(contextRoot).map((c) => [c.docKey, c]));
  // Everything the embeddings index — the recall corpus — not just what the link graph has a node for.
  const docs: CorpusDoc[] = [];
  const vectors: Float32Array[] = [];
  const seen = new Set<string>();
  for (const d of buildCorpus(contextRoot)) {
    const key = docKey(d);
    const c = centroids.get(key);
    if (!c || seen.has(key)) continue;
    seen.add(key);
    docs.push(d);
    vectors.push(c.vector);
  }
  if (docs.length < MIN_POINTS) return { state: 'unavailable', reason: 'too_few_docs' };

  // Link the docs that DO have a graph node, so the full drawer (relations, content) still opens.
  const graphIdByPath = new Map<string, string>();
  const graphIds = new Set<string>();
  for (const n of buildGraph(contextRoot).nodes) {
    graphIdByPath.set(n.path, n.id);
    graphIds.add(n.id);
  }

  const umap = new UMAP({
    nComponents: 2,
    nNeighbors: Math.min(15, docs.length - 1),
    minDist: 0.15,
    random: mulberry32(42),
  });
  const xy = await umap.fitAsync(vectors.map((v) => Array.from(v)));

  // Normalise to [-1, 1] keeping the aspect ratio.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of xy) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const norm: Array<[number, number]> = xy.map(([x, y]) => [((x - cx) / span) * 2, ((y - cy) / span) * 2]);

  const k = Math.max(4, Math.min(32, Math.round(Math.sqrt(docs.length / 2))));
  const assign = kmeans2d(norm, k);
  const labels = labelClusters(
    docs.map((d) => ({ type: d.type, title: d.title, tags: d.tags })),
    assign,
    k,
  );
  const clusters: SpaceCluster[] = [];
  const remap = new Map<number, number>();
  for (let c = 0; c < k; c++) {
    let sx = 0, sy = 0, sz = 0;
    norm.forEach((p, i) => {
      if (assign[i] === c) { sx += p[0]; sy += p[1]; sz++; }
    });
    if (!sz) continue;
    remap.set(c, clusters.length);
    clusters.push({ id: clusters.length, label: labels[c], x: sx / sz, y: sy / sz, size: sz });
  }

  const result: SpaceResult = {
    state: 'ready',
    model: 'multilingual-e5-small',
    signature,
    computedAt: new Date().toISOString(),
    points: docs.map((d, i) => {
      const id = docKey(d);
      const gist = (d.description || d.body).replace(/\s+/g, ' ').trim().slice(0, 180);
      // Changelog entries all live in ONE json file; linking them to a node would open that whole file.
      const n = d.type === 'changelog' ? undefined : graphIdByPath.get(d.relPath) ?? (graphIds.has(id) ? id : undefined);
      return {
        id,
        t: d.type,
        l: d.title || d.slug,
        p: d.relPath,
        g: d.tags,
        ...(d.status ? { s: d.status } : {}),
        d: gist,
        ...(n ? { n } : {}),
        x: Math.round(norm[i][0] * 1e4) / 1e4,
        y: Math.round(norm[i][1] * 1e4) / 1e4,
        c: remap.get(assign[i]) ?? 0,
      };
    }),
    clusters,
  };
  writeSpaceCache(contextRoot, result);
  return result;
}
