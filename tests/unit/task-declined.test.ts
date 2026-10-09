import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readDeclined, writeDeclined, appendDeclined, findDeclined, removeDeclined,
  matchDeclinedSemantically, declinedMatchThreshold,
  DECLINED_REL_PATH, MAX_DECLINED, MIN_DECLINE_REASON_CHARS, DECLINED_SEMANTIC_LIMIT,
  DECLINED_MATCH_THRESHOLD, type DeclinedIdea,
} from '../../src/lib/task-declined.js';

/**
 * T2. The gap: a tombstone only exists for a slug that WAS a task. Work proposed
 * in one session and cancelled in the next leaves no trace at all, so the next
 * sleep cycle sees "this was discussed" and files it. This ledger is that trace.
 *
 * What matters most here is what the store does when it CANNOT answer: a corrupt
 * file, a missing model, a failed embed. Every one of those degrades to "nothing
 * declined" so the caller falls back to the exact-key match and says so — never
 * a throw inside an unattended `tasks create`.
 */

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-declined-'));
  mkdirSync(join(root, 'state'), { recursive: true });
  delete process.env.DREAMCONTEXT_DECLINED_MATCH;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.DREAMCONTEXT_DECLINED_MATCH;
});

const stamp = '2026-09-11T10:00:00.000Z';
const idea = (key: string, over: Partial<DeclinedIdea> = {}): DeclinedIdea => ({
  key, topic: `topic for ${key}`, declinedAt: stamp, reason: `dropped because of ${key}`, ...over,
});

// ── Deterministic fake embedder (the dedup.test.ts idiom, no model load) ──────
// Each text carries an `@v(x,y,z)` tag; the embedder returns that direction as a
// unit vector, so the cosine between candidate and entry is exactly the dot of
// their tagged directions and every threshold boundary is testable to the decimal.
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
const fakeEmbed = vi.fn(async (texts: string[]): Promise<Float32Array[]> => texts.map(vecFor));
/** A direction at exact cosine `c` to [1,0,0] (in the x-y plane). */
function atCosine(c: number): string {
  const y = Math.sqrt(Math.max(0, 1 - c * c));
  return `@v(${c},${y},0)`;
}
/** The candidate always points at [1,0,0]; entries are placed at a chosen cosine. */
const CANDIDATE = { title: 'A brand new task', why: '@v(1,0,0) the justification prose' };
const at = (key: string, c: number): DeclinedIdea => idea(key, { topic: `${key} ${atCosine(c)}` });

// Block body, NOT a concise arrow: `mockClear()` returns the mock, and a
// beforeEach that RETURNS a function has it called as teardown — which would
// invoke the embedder with no arguments after every test.
beforeEach(() => { fakeEmbed.mockClear(); });

describe('the declined ledger', () => {
  it('starts empty and never throws on a missing file', () => {
    expect(readDeclined(root)).toEqual([]);
    expect(findDeclined(root, 'anything')).toBeNull();
  });

  it('records an idea and reads it back, at the documented path', () => {
    appendDeclined(root, idea('drop-the-offline-mode'));
    expect(findDeclined(root, 'drop-the-offline-mode')).toEqual(idea('drop-the-offline-mode'));
    expect(existsSync(join(root, DECLINED_REL_PATH))).toBe(true);
  });

  it('keeps the optional session stamp', () => {
    appendDeclined(root, idea('k', { session: 'sess-123' }));
    expect(findDeclined(root, 'k')?.session).toBe('sess-123');
  });

  it('is newest-first and REPLACES a re-recorded key rather than duplicating it', () => {
    appendDeclined(root, idea('a', { declinedAt: '2026-01-01T00:00:00.000Z', reason: 'the old reason' }));
    appendDeclined(root, idea('b'));
    appendDeclined(root, idea('a', { declinedAt: '2026-03-01T00:00:00.000Z', reason: 'the newest reason' }));
    const all = readDeclined(root);
    expect(all.map((d) => d.key)).toEqual(['a', 'b']);
    expect(all[0].reason).toBe('the newest reason');
  });

  it('caps at MAX_DECLINED, keeping the newest', () => {
    writeDeclined(root, Array.from({ length: MAX_DECLINED + 5 }, (_, i) => idea(`k${i}`)));
    const all = readDeclined(root);
    expect(all).toHaveLength(MAX_DECLINED);
    expect(all[0].key).toBe('k0');
  });

  it('a corrupt ledger degrades to empty instead of breaking every task create', () => {
    writeFileSync(join(root, DECLINED_REL_PATH), '{not json');
    expect(() => readDeclined(root)).not.toThrow();
    expect(readDeclined(root)).toEqual([]);
    // The unreadable file is left alone — a read never destroys what it cannot parse.
    expect(readFileSync(join(root, DECLINED_REL_PATH), 'utf-8')).toBe('{not json');
  });

  it('a non-array file reads as empty', () => {
    writeFileSync(join(root, DECLINED_REL_PATH), JSON.stringify({ declined: [idea('k')] }));
    expect(readDeclined(root)).toEqual([]);
  });

  it('drops malformed entries but keeps the good ones', () => {
    writeFileSync(join(root, DECLINED_REL_PATH), JSON.stringify([
      idea('good'), { key: 'no-reason', topic: 't', declinedAt: stamp }, { nope: true }, null, 'string', 42,
    ]));
    expect(readDeclined(root).map((d) => d.key)).toEqual(['good']);
  });
});

describe('undecline', () => {
  it('reports FALSE for a key that was never declined, and changes nothing', () => {
    appendDeclined(root, idea('a'));
    expect(removeDeclined(root, 'never-declined')).toBe(false);
    expect(readDeclined(root).map((d) => d.key)).toEqual(['a']);
  });

  it('lifts the entry and persists the removal', () => {
    appendDeclined(root, idea('a'));
    appendDeclined(root, idea('b'));
    expect(removeDeclined(root, 'a')).toBe(true);
    expect(readDeclined(root).map((d) => d.key)).toEqual(['b']);
    expect(findDeclined(root, 'a')).toBeNull();
  });
});

describe('matchDeclinedSemantically', () => {
  it('returns null on an empty store WITHOUT calling the embedder', async () => {
    expect(await matchDeclinedSemantically(root, CANDIDATE, { embed: fakeEmbed })).toBeNull();
    expect(fakeEmbed).not.toHaveBeenCalled();
  });

  it('matches a reworded idea at 0.86 — above the 0.82 floor', async () => {
    appendDeclined(root, at('reworded', 0.86));
    const hit = await matchDeclinedSemantically(root, CANDIDATE, { embed: fakeEmbed });
    expect(hit?.idea.key).toBe('reworded');
    expect(hit?.sim).toBeCloseTo(0.86, 5);
  });

  it('does NOT match an adjacent idea at 0.80 — below the floor', async () => {
    appendDeclined(root, at('adjacent', 0.80));
    expect(await matchDeclinedSemantically(root, CANDIDATE, { embed: fakeEmbed })).toBeNull();
  });

  it('returns the BEST match when several clear the floor', async () => {
    appendDeclined(root, at('close', 0.86));
    appendDeclined(root, at('closest', 0.95));
    appendDeclined(root, at('far', 0.10));
    const hit = await matchDeclinedSemantically(root, CANDIDATE, { embed: fakeEmbed });
    expect(hit?.idea.key).toBe('closest');
  });

  it('embeds the candidate plus one text per entry, in ONE call', async () => {
    appendDeclined(root, at('a', 0.86));
    appendDeclined(root, at('b', 0.10));
    await matchDeclinedSemantically(root, CANDIDATE, { embed: fakeEmbed });
    expect(fakeEmbed).toHaveBeenCalledTimes(1);
    expect(fakeEmbed.mock.calls[0][0]).toHaveLength(3);
  });

  it('only compares the newest DECLINED_SEMANTIC_LIMIT entries', async () => {
    // Newest-first on disk: the perfect match sits one past the limit, so it is
    // never embedded — the cap is a real bound, not a comment.
    const newest = Array.from({ length: DECLINED_SEMANTIC_LIMIT }, (_, i) => at(`recent-${i}`, 0.10));
    writeDeclined(root, [...newest, at('ancient-perfect-match', 1)]);
    expect(await matchDeclinedSemantically(root, CANDIDATE, { embed: fakeEmbed })).toBeNull();
    expect(fakeEmbed.mock.calls[0][0]).toHaveLength(DECLINED_SEMANTIC_LIMIT + 1);
  });

  it('honours an explicit threshold over the default', async () => {
    appendDeclined(root, at('adjacent', 0.80));
    const hit = await matchDeclinedSemantically(root, CANDIDATE, { embed: fakeEmbed, threshold: 0.75 });
    expect(hit?.idea.key).toBe('adjacent');
  });

  it('reads DREAMCONTEXT_DECLINED_MATCH at CALL time, not at import', async () => {
    appendDeclined(root, at('reworded', 0.86));
    process.env.DREAMCONTEXT_DECLINED_MATCH = '0.9';
    expect(await matchDeclinedSemantically(root, CANDIDATE, { embed: fakeEmbed })).toBeNull();
    delete process.env.DREAMCONTEXT_DECLINED_MATCH;
    expect((await matchDeclinedSemantically(root, CANDIDATE, { embed: fakeEmbed }))?.idea.key).toBe('reworded');
  });

  it('falls back to the default on a garbage or out-of-range override', async () => {
    appendDeclined(root, at('reworded', 0.86));
    for (const bad of ['not-a-number', '0.1', '3', '']) {
      process.env.DREAMCONTEXT_DECLINED_MATCH = bad;
      expect(declinedMatchThreshold()).toBe(DECLINED_MATCH_THRESHOLD);
      expect((await matchDeclinedSemantically(root, CANDIDATE, { embed: fakeEmbed }))?.idea.key).toBe('reworded');
    }
  });

  it('returns null when the model is unavailable — the caller keeps only the exact-key match', async () => {
    appendDeclined(root, at('reworded', 0.86));
    expect(await matchDeclinedSemantically(root, CANDIDATE, { embed: async () => null })).toBeNull();
  });

  it('returns null when the embedder returns FEWER vectors than texts', async () => {
    appendDeclined(root, at('reworded', 0.86));
    const short = async () => [unit(1, 0, 0)];
    expect(await matchDeclinedSemantically(root, CANDIDATE, { embed: short })).toBeNull();
  });

  it('returns null on MIXED dimensionality rather than scoring a prefix of two spaces', async () => {
    appendDeclined(root, at('reworded', 0.86));
    const mixed = async () => [unit(1, 0, 0), new Float32Array([1, 0, 0, 0])];
    expect(await matchDeclinedSemantically(root, CANDIDATE, { embed: mixed })).toBeNull();
  });

  it('degrades to null when an embed call THROWS — a sleep cycle must not abort', async () => {
    appendDeclined(root, at('reworded', 0.86));
    const boom = async () => { throw new Error('WASM fault'); };
    await expect(matchDeclinedSemantically(root, CANDIDATE, { embed: boom })).resolves.toBeNull();
  });

  it('returns null for a blank candidate instead of a confident-looking verdict', async () => {
    appendDeclined(root, at('reworded', 0.86));
    expect(await matchDeclinedSemantically(root, { title: '', why: '  ' }, { embed: fakeEmbed })).toBeNull();
    expect(fakeEmbed).not.toHaveBeenCalled();
  });
});

describe('the pinned contract constants', () => {
  it('are the values the filing bar and the CLI were built against', () => {
    expect(DECLINED_REL_PATH).toBe('state/.task-declined.json');
    expect(MAX_DECLINED).toBe(500);
    expect(MIN_DECLINE_REASON_CHARS).toBe(20);
    expect(DECLINED_SEMANTIC_LIMIT).toBe(100);
    expect(DECLINED_MATCH_THRESHOLD).toBe(0.82);
    expect(declinedMatchThreshold()).toBe(0.82);
  });
});
