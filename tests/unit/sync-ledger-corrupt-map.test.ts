import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SyncLedger, unionTaskMap, type TaskMapEntry } from '../../src/lib/task-backend/sync-state.js';
import { TaskBackendError } from '../../src/lib/task-backend/types.js';

/**
 * Scope B (#204) — the committed `.tasks-map.json` must never silently read as
 * an empty map. A conflict-markered (or otherwise corrupt) map has to THROW,
 * not fall back to `[]` — a fallback there is exactly what let `recordMapping`
 * rewrite the map with only-new entries, permanently orphaning every canonical
 * mapping. `unionTaskMap` is the lossless, dcId-ordered merge primitive that
 * both `mergeTasksMapJson` (git-sync) and `healConflictedMap` (below) share.
 */

const MAP_REL = join('state', '.tasks-map.json');

let contextRoot: string;

function mapPath(): string {
  return join(contextRoot, MAP_REL);
}

function writeRawMap(content: string): void {
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  writeFileSync(mapPath(), content, 'utf-8');
}

function entry(overrides: Partial<TaskMapEntry>): TaskMapEntry {
  return { slug: 'foo', dcId: 'task_D1', backend: 'clickup', remoteId: 'R1', ...overrides };
}

beforeEach(() => {
  const raw = join(tmpdir(), `dc-map-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  contextRoot = realpathSync(raw);
});

afterEach(() => {
  rmSync(contextRoot, { recursive: true, force: true });
});

// ───────────────────────────── B1 / B3 — strict readMap ────────────────────

describe('SyncLedger.readMap — strict (B1, B3)', () => {
  it('B1: throws corrupt_ledger on a file with unresolved conflict markers', () => {
    writeRawMap(['<<<<<<< HEAD', '[{"slug":"foo"}]', '=======', '[{"slug":"bar"}]', '>>>>>>> theirs', ''].join('\n'));
    const ledger = new SyncLedger(contextRoot);
    let thrown: unknown;
    try {
      ledger.readMap();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TaskBackendError);
    expect((thrown as TaskBackendError).code).toBe('corrupt_ledger');
  });

  it('B1: throws corrupt_ledger on plain invalid JSON (no markers)', () => {
    writeRawMap('{not valid json at all');
    const ledger = new SyncLedger(contextRoot);
    expect(() => ledger.readMap()).toThrow(TaskBackendError);
    try {
      ledger.readMap();
    } catch (err) {
      expect((err as TaskBackendError).code).toBe('corrupt_ledger');
    }
  });

  it('B3: a missing map file returns [] without throwing', () => {
    const ledger = new SyncLedger(contextRoot);
    expect(existsSync(mapPath())).toBe(false);
    expect(ledger.readMap()).toEqual([]);
  });

  it('a valid, well-formed map reads through normally', () => {
    writeRawMap(JSON.stringify([entry({ slug: 'foo' })], null, 2) + '\n');
    const ledger = new SyncLedger(contextRoot);
    expect(ledger.readMap()).toEqual([entry({ slug: 'foo' })]);
  });
});

// ───────────────────────────── B2 — recordMapping aborts on corruption ─────

describe('SyncLedger.recordMapping — aborts before writing on a corrupt map (B2)', () => {
  it('throws and leaves the on-disk bytes byte-for-byte unchanged', () => {
    const markered = ['<<<<<<< HEAD', '[{"slug":"foo","dcId":"D1","backend":"clickup","remoteId":"R1"}]', '=======', '[{"slug":"foo","dcId":"D2","backend":"clickup","remoteId":"R2"}]', '>>>>>>> theirs', ''].join('\n');
    writeRawMap(markered);
    const before = readFileSync(mapPath(), 'utf-8');

    const ledger = new SyncLedger(contextRoot);
    expect(() => ledger.recordMapping(entry({ slug: 'brand-new-task', dcId: 'task_NEW', remoteId: 'R99' })))
      .toThrow(TaskBackendError);

    const after = readFileSync(mapPath(), 'utf-8');
    expect(after).toBe(before);
  });
});

// ───────────────────────────── B5 — healConflictedMap ───────────────────────

describe('SyncLedger.healConflictedMap (B5)', () => {
  it('rewrites a markered map as marker-free JSON, the union of both sides', () => {
    const ours = [entry({ slug: 'foo', dcId: 'task_D1', remoteId: 'R1' })];
    const theirs = [entry({ slug: 'bar', dcId: 'task_D2', remoteId: 'R2' })];
    const markered = [
      '<<<<<<< HEAD',
      JSON.stringify(ours),
      '=======',
      JSON.stringify(theirs),
      '>>>>>>> theirs',
      '',
    ].join('\n');
    writeRawMap(markered);

    const ledger = new SyncLedger(contextRoot);
    const healed = ledger.healConflictedMap();
    expect(healed).toBe(true);

    // The file no longer carries markers and is valid JSON — readMap() no longer throws.
    const result = ledger.readMap();
    expect(result).toEqual(unionTaskMap([ours, theirs]));
    expect(readFileSync(mapPath(), 'utf-8')).not.toContain('<<<<<<<');
  });

  it('is a no-op (returns false, leaves bytes untouched) on an already-clean map', () => {
    const clean = JSON.stringify([entry({ slug: 'foo' })], null, 2) + '\n';
    writeRawMap(clean);
    const ledger = new SyncLedger(contextRoot);
    expect(ledger.healConflictedMap()).toBe(false);
    expect(readFileSync(mapPath(), 'utf-8')).toBe(clean);
  });

  it('returns false when the map file does not exist', () => {
    const ledger = new SyncLedger(contextRoot);
    expect(ledger.healConflictedMap()).toBe(false);
  });
});

// ───────────────────────────── rewriteMap ───────────────────────────────────

describe('SyncLedger.rewriteMap', () => {
  it('replaces the whole map in one write, sorted by slug', () => {
    const ledger = new SyncLedger(contextRoot);
    ledger.recordMapping(entry({ slug: 'zeta', dcId: 'task_Z', remoteId: 'RZ' }));
    ledger.rewriteMap([entry({ slug: 'beta', dcId: 'task_B', remoteId: 'RB' }), entry({ slug: 'alpha', dcId: 'task_A', remoteId: 'RA' })]);
    expect(ledger.readMap().map((e) => e.slug)).toEqual(['alpha', 'beta']);
  });
});

// ───────────────────────────── unionTaskMap (A3, A5-unit) ──────────────────

describe('unionTaskMap', () => {
  it('A3: collapses the SAME remoteId under two different slugs to exactly one entry', () => {
    const ours = [entry({ slug: 'old-slug', dcId: 'task_D1', remoteId: 'R1' })];
    const theirs = [entry({ slug: 'renamed-slug', dcId: 'task_D1', remoteId: 'R1' })];
    const result = unionTaskMap([ours, theirs]);
    expect(result).toHaveLength(1);
    expect(result[0].remoteId).toBe('R1');
  });

  it('A5-unit: same-slug, DISTINCT remoteIds — both entries survive, bare slug to the smaller dcId', () => {
    const sideA = [entry({ slug: 'foo', dcId: 'task_D2', remoteId: 'R1' })];
    const sideB = [entry({ slug: 'foo', dcId: 'task_D1', remoteId: 'R2' })];

    const result1 = unionTaskMap([sideA, sideB]);
    const result2 = unionTaskMap([sideB, sideA]); // swapped side order

    expect(result1).toEqual(result2); // byte-stable regardless of side order
    expect(result1).toHaveLength(2);

    const bare = result1.find((e) => e.slug === 'foo')!;
    const suffixed = result1.find((e) => e.slug === 'foo-2')!;
    expect(bare.dcId).toBe('task_D1'); // smaller dcId keeps the bare slug
    expect(bare.remoteId).toBe('R2');
    expect(suffixed.dcId).toBe('task_D2');
    expect(suffixed.remoteId).toBe('R1');
  });

  it('re-slugs a THIRD colliding entry to -3 (next free), still lossless', () => {
    const sides = [[
      entry({ slug: 'foo', dcId: 'task_D1', remoteId: 'R1' }),
      entry({ slug: 'foo', dcId: 'task_D2', remoteId: 'R2' }),
      entry({ slug: 'foo', dcId: 'task_D3', remoteId: 'R3' }),
    ]];
    const result = unionTaskMap(sides);
    expect(result.map((e) => e.slug).sort()).toEqual(['foo', 'foo-2', 'foo-3']);
    expect(new Set(result.map((e) => e.remoteId)).size).toBe(3); // nothing lost
  });

  it('output is sorted by slug', () => {
    const result = unionTaskMap([[
      entry({ slug: 'zeta', dcId: 'task_Z', remoteId: 'RZ' }),
      entry({ slug: 'alpha', dcId: 'task_A', remoteId: 'RA' }),
    ]]);
    expect(result.map((e) => e.slug)).toEqual(['alpha', 'zeta']);
  });

  it('is a pure no-op union when there is no collision at all', () => {
    const sideA = [entry({ slug: 'foo', dcId: 'task_D1', remoteId: 'R1' })];
    const sideB = [entry({ slug: 'bar', dcId: 'task_D2', remoteId: 'R2' })];
    const result = unionTaskMap([sideA, sideB]);
    expect(result).toEqual([sideA[0], sideB[0]].sort((a, b) => a.slug.localeCompare(b.slug)));
  });
});
