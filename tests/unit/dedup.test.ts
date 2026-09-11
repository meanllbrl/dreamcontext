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

/** Write a TASK doc (`state/<slug>.md`) — the corpus the filing bar checks. */
function writeTask(slug: string, name: string, tag: string): void {
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(
    join(root, 'state', `${slug}.md`),
    `---\nname: ${name}\ndescription: ${name} description\n---\n\n${tag} ${slug} body content here\n`,
  );
}

/**
 * Write a real SESSION DIGEST through the layout `loadDigestDocs` reads, so the
 * capture doc enters the `task` corpus the way it does in production (slug
 * `digest#<sessionId>`, `capture: true`) rather than being simulated.
 */
function writeDigest(sessionId: string, tag: string): void {
  mkdirSync(join(root, 'state', '.session-digests'), { recursive: true });
  writeFileSync(
    join(root, 'state', '.session-digests', `${sessionId}.md`),
    `---\nsession_id: ${sessionId}\ncreated_at: '2026-09-11T00:00:00.000Z'\n---\n\n${tag} what happened this session\n`,
  );
}

const call = (candidate: { title: string; description?: string; body: string }, opts = {}) =>
  dedupCandidate(root, candidate, { embed: fakeEmbed, ...opts });

const callTasks = (candidate: { title: string; description?: string; body: string }, opts = {}) =>
  dedupCandidate(root, candidate, { embed: fakeEmbed, types: ['task'], ...opts });

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

// ── Review-hardening regressions ─────────────────────────────────────────────
// Each test below pins a defect found in the multi-reviewer pass on 61dbc3d.
describe('dedupCandidate — hardening regressions', () => {
  it('topK ≤ 0 never suppresses the verdict (was: silent CREATE on a certain duplicate)', async () => {
    writeKnowledge('alpha', 'Alpha', '@v(1,0,0)');
    writeKnowledge('beta', 'Beta', '@v(0,1,0)');
    const cand = { title: 'Alpha restated', body: '@v(1,0,0) identical to alpha' };
    for (const topK of [0, -3, 0.4]) {
      const res = await call(cand, { topK });
      expect(res!.top, `topK=${topK} must not drop top`).not.toBeNull();
      expect(res!.top!.sim).toBeCloseTo(1, 5);
      expect(res!.verdict, `topK=${topK} must still MERGE`).toBe('merge');
      expect(res!.neighbors.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('an inverted review>merge pair is clamped so the bands can never invert', async () => {
    writeKnowledge('alpha', 'Alpha', '@v(1,0,0)');
    writeKnowledge('beta', 'Beta', '@v(0,1,0)');
    const inverted = { mergeThreshold: 0.99, reviewThreshold: 0.999 };

    const res = await call({ title: 'near alpha', body: `${atCosine(0.98)} near alpha` }, inverted);
    // The invariant: the reported review bar NEVER sits above the merge bar, so
    // the printed/JSON bands are always coherent (no "below 0.99 merge, above
    // 0.999 review" nonsense).
    expect(res!.reviewThreshold).toBe(0.99);
    expect(res!.reviewThreshold).toBeLessThanOrEqual(res!.mergeThreshold);
    // 0.98 sits below both bars → CREATE. Well-defined, not an inverted-band artifact.
    expect(res!.verdict).toBe('create');

    // …and a near-verbatim twin still merges under the same clamped config.
    const dup = await call({ title: 'Alpha', body: '@v(1,0,0) identical' }, inverted);
    expect(dup!.verdict).toBe('merge');
  });

  it('a blank candidate throws instead of scoring a degenerate vector', async () => {
    writeKnowledge('alpha', 'Alpha', '@v(1,0,0)');
    await expect(call({ title: '   ', body: '' })).rejects.toThrow(/blank/i);
    await expect(call({ title: '', body: '', description: '' })).rejects.toThrow(TypeError);
  });

  it('an embedder that THROWS degrades to null (keyword-recall fallback), not a crash', async () => {
    writeKnowledge('alpha', 'Alpha', '@v(1,0,0)');
    const res = await dedupCandidate(
      root,
      { title: 'x', body: '@v(1,0,0) y' },
      { embed: async () => { throw new Error('WASM exploded'); } },
    );
    expect(res).toBeNull();
  });

  it('an embedder returning fewer vectors than texts degrades to null', async () => {
    writeKnowledge('alpha', 'Alpha', '@v(1,0,0)');
    const res = await dedupCandidate(
      root,
      { title: 'x', body: '@v(1,0,0) y' },
      { embed: async (ts) => (ts.length > 1 ? ts.map(vecFor) : []) },
    );
    expect(res).toBeNull();
  });

  it('a dimension mismatch fails LOUD rather than scoring a truncated prefix', async () => {
    writeKnowledge('alpha', 'Alpha', '@v(1,0,0)');
    // Corpus indexed at 3d (fakeEmbed) but the candidate comes back 2d.
    await call({ title: 'seed', body: '@v(1,0,0) seed' }); // build the 3d index first
    const mixed = async (ts: string[]): Promise<Float32Array[]> =>
      ts.map((t) => (t.includes('CANDIDATE') ? new Float32Array([1, 0]) : vecFor(t)));
    await expect(
      dedupCandidate(root, { title: 'CANDIDATE', body: 'CANDIDATE body' }, { embed: mixed }),
    ).rejects.toThrow(/dimension mismatch/i);
  });

  it('an unnormalized candidate vector fails LOUD (cosine thresholds would be meaningless)', async () => {
    writeKnowledge('alpha', 'Alpha', '@v(1,0,0)');
    await call({ title: 'seed', body: '@v(1,0,0) seed' });
    const unnorm = async (ts: string[]): Promise<Float32Array[]> =>
      ts.map((t) => (t.includes('CANDIDATE') ? new Float32Array([5, 0, 0]) : vecFor(t)));
    await expect(
      dedupCandidate(root, { title: 'CANDIDATE', body: 'CANDIDATE body' }, { embed: unnorm }),
    ).rejects.toThrow(/normalized/i);
  });

  it('a lone neighbor still requires the absolute floor (margin bypass is not a free merge)', async () => {
    writeKnowledge('alpha', 'Alpha', '@v(1,0,0)');
    // Single-doc corpus → margin null → gate bypassed, but 0.94 < 0.97 floor.
    const res = await call({ title: 'kinda alpha', body: `${atCosine(0.94)} kinda` });
    expect(res!.margin).toBeNull();
    expect(res!.verdict).toBe('review');
    // …and a near-verbatim twin on that same lone corpus DOES merge.
    const dup = await call({ title: 'Alpha', body: '@v(1,0,0) identical' });
    expect(dup!.margin).toBeNull();
    expect(dup!.verdict).toBe('merge');
  });
});


// ── excludeCapture: the `task` corpus carries session digests ────────────────
// A task candidate is distilled FROM a session, so it scores ~1.0 against that
// session's own digest — which is not a doc anything can be folded into. The
// filter therefore has to run BEFORE the verdict, not on the reported list.
describe('dedupCandidate — excludeCapture (session digests in the task corpus)', () => {
  it('by DEFAULT a session digest wins the neighbor race and drives the verdict', async () => {
    writeTask('alpha', 'Alpha', atCosine(0.8));
    writeDigest('sess-1', '@v(1,0,0)');
    const res = await callTasks({ title: 'Distilled from the session', body: '@v(1,0,0) same words' });
    expect(res!.verdict).toBe('merge');
    expect(res!.top!.docKey).toBe('task/digest#sess-1');
  });

  it('excludeCapture drops it BEFORE the verdict: create, and no digest in the list', async () => {
    writeTask('alpha', 'Alpha', atCosine(0.8));
    writeDigest('sess-1', '@v(1,0,0)');
    const res = await callTasks(
      { title: 'Distilled from the session', body: '@v(1,0,0) same words' },
      { excludeCapture: true },
    );
    expect(res!.verdict).toBe('create');              // 0.80 < review threshold
    expect(res!.top!.docKey).toBe('task/alpha');
    expect(res!.neighbors.some((n) => n.docKey.startsWith('task/digest#'))).toBe(false);
    // The corpus SEARCHED is still the whole corpus — the flag filters neighbors,
    // it does not pretend the digest was never indexed.
    expect(res!.corpusDocs).toBe(2);
  });

  it('the MARGIN is computed over foldable docs only (the filter is not cosmetic)', async () => {
    writeDigest('sess-1', '@v(1,0,0)');
    writeTask('alpha', 'Alpha', atCosine(0.995));
    writeTask('beta', 'Beta', atCosine(0.9));
    const cand = { title: 'Near alpha', body: '@v(1,0,0) near alpha' };

    // With the digest in: top1 (digest 1.0) − top2 (alpha 0.995) = 0.005 < margin
    // → the margin gate holds the merge, and the "duplicate" named is a digest.
    const withCapture = await callTasks(cand);
    expect(withCapture!.margin!).toBeLessThan(withCapture!.mergeMargin);
    expect(withCapture!.verdict).toBe('review');

    // With it out: alpha is top at 0.995 with a real 0.095 margin over beta.
    const without = await callTasks(cand, { excludeCapture: true });
    expect(without!.top!.docKey).toBe('task/alpha');
    expect(without!.margin!).toBeGreaterThan(without!.mergeMargin);
    expect(without!.verdict).toBe('merge');
  });

  it('is inert on a capture-free corpus — identical result with the flag on', async () => {
    writeKnowledge('alpha', 'Alpha', '@v(1,0,0)');
    writeKnowledge('beta', 'Beta', '@v(0,1,0)');
    const cand = { title: 'Alpha-ish', body: `${atCosine(0.94)} near alpha` };
    const off = await call(cand);
    const on = await call(cand, { excludeCapture: true });
    expect(on).toEqual(off);
  });
});
