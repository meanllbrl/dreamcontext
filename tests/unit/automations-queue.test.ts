/**
 * The machine-local run queue (D9): at most one waiting entry per automation,
 * by construction — a second enqueue for the same slug overwrites the first
 * rather than accumulating a list. Never in the brain; see queue.ts's module
 * doc for the threat model this protects against.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  automationsQueuePath,
  clearQueuedFire,
  drainQueue,
  enqueueFire,
  queuedFire,
} from '../../src/lib/automations/queue.js';

let home: string;
const NOW = Date.parse('2026-08-09T10:00:00.000Z');
const PROJECT = '/Users/test/proj';
const OTHER_PROJECT = '/Users/test/other-proj';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-queue-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('enqueueFire — at most one waiting entry per slug', () => {
  it('a second enqueue overwrites the first, and the file has exactly one entry for it', () => {
    enqueueFire(PROJECT, 'x', 'T1', home, NOW);
    enqueueFire(PROJECT, 'x', 'T2', home, NOW + 1000);
    expect(queuedFire(PROJECT, 'x', home)).toEqual({
      slug: 'x',
      firedAt: 'T2',
      enqueuedAt: new Date(NOW + 1000).toISOString(),
    });
    const onDisk = JSON.parse(readFileSync(automationsQueuePath(home), 'utf-8'));
    expect(Object.keys(onDisk[PROJECT])).toEqual(['x']);
  });

  it('is written at mode 0600', () => {
    enqueueFire(PROJECT, 'x', 'T1', home, NOW);
    expect(statSync(automationsQueuePath(home)).mode & 0o777).toBe(0o600);
  });

  it('lives in ~/.dreamcontext — never the brain', () => {
    expect(automationsQueuePath(home)).toBe(join(home, '.dreamcontext', 'automations-queue.json'));
  });

  it('refuses a traversal slug and writes nothing', () => {
    enqueueFire(PROJECT, '../../etc/passwd', 'T1', home, NOW);
    expect(queuedFire(PROJECT, '../../etc/passwd', home)).toBeNull();
    expect(existsSyncSafe(automationsQueuePath(home))).toBe(false);
  });

  it('refuses an unsafe slug generally (reserved name) without throwing', () => {
    expect(() => enqueueFire(PROJECT, 'cache', 'T1', home, NOW)).not.toThrow();
    expect(queuedFire(PROJECT, 'cache', home)).toBeNull();
  });
});

describe('draining', () => {
  it('returns every entry for the project and clears it, leaving other projects untouched', () => {
    enqueueFire(PROJECT, 'a', 'TA', home, NOW);
    enqueueFire(PROJECT, 'b', 'TB', home, NOW);
    enqueueFire(OTHER_PROJECT, 'c', 'TC', home, NOW);

    const drained = drainQueue(PROJECT, home, NOW + 5000);
    expect(drained.sort((x, y) => x.slug.localeCompare(y.slug))).toEqual([
      { slug: 'a', firedAt: 'TA', enqueuedAt: new Date(NOW).toISOString() },
      { slug: 'b', firedAt: 'TB', enqueuedAt: new Date(NOW).toISOString() },
    ]);
    expect(queuedFire(PROJECT, 'a', home)).toBeNull();
    expect(queuedFire(PROJECT, 'b', home)).toBeNull();
    expect(queuedFire(OTHER_PROJECT, 'c', home)).toEqual({
      slug: 'c',
      firedAt: 'TC',
      enqueuedAt: new Date(NOW).toISOString(),
    });
  });

  it('draining an empty project returns an empty array and does not throw', () => {
    expect(drainQueue(PROJECT, home, NOW)).toEqual([]);
  });
});

describe('clearQueuedFire', () => {
  it('removes only the named slug', () => {
    enqueueFire(PROJECT, 'a', 'TA', home, NOW);
    enqueueFire(PROJECT, 'b', 'TB', home, NOW);
    clearQueuedFire(PROJECT, 'a', home, NOW);
    expect(queuedFire(PROJECT, 'a', home)).toBeNull();
    expect(queuedFire(PROJECT, 'b', home)).not.toBeNull();
  });

  it('clearing an unqueued slug is a no-op, never a throw', () => {
    expect(() => clearQueuedFire(PROJECT, 'nope', home, NOW)).not.toThrow();
  });
});

describe('the file cannot grow forever, and cannot take the subsystem down', () => {
  it('prunes an entry older than the TTL on the next write', () => {
    const ancient = NOW - 8 * 24 * 60 * 60 * 1000; // 8 days ago, past the 7-day TTL
    enqueueFire(PROJECT, 'old', 'T-old', home, ancient);
    expect(queuedFire(PROJECT, 'old', home)).not.toBeNull();
    // A second write (any write) triggers the prune.
    enqueueFire(PROJECT, 'new', 'T-new', home, NOW);
    expect(queuedFire(PROJECT, 'old', home)).toBeNull();
    expect(queuedFire(PROJECT, 'new', home)).not.toBeNull();
  });

  it('a corrupt file reads as empty and does not throw', () => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(automationsQueuePath(home), 'not json at all', 'utf-8');
    expect(queuedFire(PROJECT, 'x', home)).toBeNull();
    expect(drainQueue(PROJECT, home, NOW)).toEqual([]);
    expect(() => enqueueFire(PROJECT, 'x', 'T1', home, NOW)).not.toThrow();
  });

  it('drops individual malformed entries rather than failing the whole file', () => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(
      automationsQueuePath(home),
      JSON.stringify({
        [PROJECT]: {
          good: { slug: 'good', firedAt: 'T1', enqueuedAt: new Date(NOW).toISOString() },
          bad: { slug: 'bad' }, // missing firedAt/enqueuedAt
          alsoBad: 'not an object',
        },
      }),
      'utf-8',
    );
    expect(queuedFire(PROJECT, 'good', home)).toEqual({
      slug: 'good',
      firedAt: 'T1',
      enqueuedAt: new Date(NOW).toISOString(),
    });
    expect(queuedFire(PROJECT, 'bad', home)).toBeNull();
    expect(queuedFire(PROJECT, 'alsoBad', home)).toBeNull();
  });
});

function existsSyncSafe(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
