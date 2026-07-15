import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dedupCandidate } from '../../src/lib/embeddings/dedup.js';

/**
 * Deterministic fake embedder — NO model load. Each text carries an `@v(x,y,z)`
 * tag; the embedder returns that direction as a unit vector, so the cosine
 * between any candidate and any doc is exactly the dot of their tagged directions
 * and every verdict boundary is testable to the decimal. Injected into
 * dedupCandidate (which threads it to BOTH the index refresh and the candidate
 * embed), so the real ONNX model is never touched.
 */
function unit(x: number, y: number, z: number): Float32Array {
  const n = Math.hypot(x, y, z) || 1;
  return new Float32Array([x / n, y / n, z / n]);
}
function vecFor(text: string): Float32Array {
  const m = text.match(/@v\(([^)]+)\)/);
  if (!m) return unit(1, 0, 0);
  const [x, y, z] = m[1].split(',').map(Number);
  return unit(x, y, z);
}
const fakeEmbed = async (texts: string[]): Promise<Float32Array[]> => texts.map(vecFor);
/** A direction at exact cosine c to [1,0,0] (in the x-y plane). */
function atCosine(c: number): string {
  const y = Math.sqrt(Math.max(0, 1 - c * c));
  return `@v(${c},${y},0)`;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-dedup-'));
  mkdirSync(join(root, 'knowledge'), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a knowledge doc whose embedded direction is set by `tag` (`@v(x,y,z)`). */
function writeKnowledge(slug: string, name: string, tag: string): void {
  writeFileSync(
    join(root, 'knowledge', `${slug}.md`),
    `---\nname: ${name}\ndescription: ${name} description\n---\n\n${tag} ${slug} body content here\n`,
  );
}

const call = (candidate: { title: string; description?: string; body: string }, opts = {}) =>
  dedupCandidate(root, candidate, { embed: fakeEmbed, ...opts });

describe('dedupCandidate — verdicts', () => {
  it('MERGE: candidate near-identical to one doc, far from the rest', async () => {
    writeKnowledge('alpha', 'Alpha', '@v(1,0,0)');
    writeKnowledge('beta', 'Beta', '@v(0,1,0)');
    const res = await call({ title: 'Alpha restated', body: '@v(1,0,0) same as alpha' });
    expect(res).not.toBeNull();
    expect(res!.verdict).toBe('merge');
    expect(res!.top!.docKey).toBe('knowledge/alpha');
    expect(res!.top!.sim).toBeCloseTo(1, 5);
    expect(res!.margin).toBeGreaterThan(res!.mergeMargin);
  });

  it('REVIEW: candidate in the 0.91–0.97 same-topic band', async () => {
    writeKnowledge('alpha', 'Alpha', '@v(1,0,0)');
    writeKnowledge('beta', 'Beta', '@v(0,1,0)');
    const res = await call({ title: 'Kind of like Alpha', body: `${atCosine(0.94)} adjacent to alpha` });
    expect(res!.verdict).toBe('review');
    expect(res!.top!.docKey).toBe('knowledge/alpha');
    expect(res!.top!.sim).toBeCloseTo(0.94, 4);
  });

  it('CREATE: candidate below the review threshold for every doc', async () => {
    writeKnowledge('alpha', 'Alpha', '@v(1,0,0)');
    writeKnowledge('beta', 'Beta', '@v(0,1,0)');
    const res = await call({ title: 'Novel topic', body: `${atCosine(0.5)} unrelated` });
    expect(res!.verdict).toBe('create');
    expect(res!.top!.sim).toBeLessThan(res!.reviewThreshold);
  });

  it('margin gate: high absolute sim to TWO docs at once → REVIEW, not MERGE', async () => {
    // Two docs almost coincident with each other AND with the candidate: top1 and
    // top2 are both ~0.9998, so the margin is ~0 and auto-merge is (correctly) held.
    writeKnowledge('twinA', 'Twin A', '@v(1,0.02,0)');
    writeKnowledge('twinB', 'Twin B', '@v(1,-0.02,0)');
    const res = await call({ title: 'Between the twins', body: '@v(1,0,0) grazes both twins' });
    expect(res!.top!.sim).toBeGreaterThan(res!.mergeThreshold); // absolute floor cleared
    expect(res!.margin!).toBeLessThan(res!.mergeMargin);        // but margin gate blocks it
    expect(res!.verdict).toBe('review');
  });
});

describe('dedupCandidate — options & edges', () => {
  it('excludeDocKey drops a doc from neighbors (re-checking an existing doc you are updating)', async () => {
    writeKnowledge('alpha', 'Alpha', '@v(1,0,0)');
    writeKnowledge('beta', 'Beta', '@v(0,1,0)');
    const res = await call(
      { title: 'Alpha update', body: '@v(1,0,0) updating alpha in place' },
      { excludeDocKey: 'knowledge/alpha' },
    );
    expect(res!.neighbors.find((n) => n.docKey === 'knowledge/alpha')).toBeUndefined();
    expect(res!.top!.docKey).toBe('knowledge/beta');
  });

  it('custom thresholds via opts override the defaults', async () => {
    writeKnowledge('alpha', 'Alpha', '@v(1,0,0)');
    writeKnowledge('beta', 'Beta', '@v(0,1,0)');
    // cosine 0.94 is REVIEW by default, but a lower merge bar promotes it to MERGE.
    const res = await call(
      { title: 'Alpha-ish', body: `${atCosine(0.94)} near alpha` },
      { mergeThreshold: 0.9, reviewThreshold: 0.5 },
    );
    expect(res!.verdict).toBe('merge');
    expect(res!.mergeThreshold).toBe(0.9);
  });

  it('returns null when the embedding model is unavailable', async () => {
    writeKnowledge('alpha', 'Alpha', '@v(1,0,0)');
    const res = await dedupCandidate(
      root,
      { title: 'x', body: '@v(1,0,0) y' },
      { embed: async () => null },
    );
    expect(res).toBeNull();
  });

  it('empty corpus → CREATE with no neighbors and a null margin', async () => {
    const res = await call({ title: 'First doc ever', body: '@v(1,0,0) nothing to compare' });
    expect(res!.verdict).toBe('create');
    expect(res!.neighbors).toHaveLength(0);
    expect(res!.top).toBeNull();
    expect(res!.margin).toBeNull();
  });

  it('respects topK for the neighbor list', async () => {
    for (let i = 0; i < 6; i++) writeKnowledge(`doc${i}`, `Doc ${i}`, `@v(1,${i * 0.1},0)`);
    const res = await call({ title: 'probe', body: '@v(1,0,0) probe' }, { topK: 3 });
    expect(res!.neighbors).toHaveLength(3);
    // similarity-descending
    expect(res!.neighbors[0].sim).toBeGreaterThanOrEqual(res!.neighbors[1].sim);
    expect(res!.neighbors[1].sim).toBeGreaterThanOrEqual(res!.neighbors[2].sim);
  });
});
