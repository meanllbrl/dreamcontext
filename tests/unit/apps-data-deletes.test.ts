import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PER_SYNC_DELETE_CAP, TOMBSTONE_TTL_MS, addTombstone, capDeletes, clearTombstones, listTombstones, tombstonesPath } from '../../src/lib/apps/data-deletes.js';

/** app-veri-ortak K6: a delete only from the app, as a tombstone; TTL and the per-sync cap. */

let home: string;
const HASH = 'abcdef0123456789';
beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-deletes-'))); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('tombstones', () => {
  it('lives in ~/.dreamcontext/apps/deletes/<hash>.json', () => {
    expect(tombstonesPath(home, HASH)).toBe(join(home, '.dreamcontext', 'apps', 'deletes', `${HASH}.json`));
  });

  it('added, listed once per path, cleared when delivered', () => {
    addTombstone(home, HASH, 'favorites/a.json');
    addTombstone(home, HASH, 'favorites/a.json');
    addTombstone(home, HASH, 'favorites/b.json');
    expect(listTombstones(home, HASH).map((t) => t.path)).toEqual(['favorites/a.json', 'favorites/b.json']);
    clearTombstones(home, HASH, ['favorites/a.json']);
    expect(listTombstones(home, HASH).map((t) => t.path)).toEqual(['favorites/b.json']);
  });

  it('a stone that never lands is dropped after 30 days', () => {
    const t0 = Date.UTC(2026, 10, 1);
    addTombstone(home, HASH, 'favorites/a.json', t0);
    expect(listTombstones(home, HASH, t0 + TOMBSTONE_TTL_MS - 1)).toHaveLength(1);
    expect(listTombstones(home, HASH, t0 + TOMBSTONE_TTL_MS)).toHaveLength(0);
    clearTombstones(home, HASH, [], t0 + TOMBSTONE_TTL_MS);
    expect(listTombstones(home, HASH, t0)).toHaveLength(0);
  });

  it('refuses a bad path or hash', () => {
    expect(() => addTombstone(home, HASH, '../x.json')).toThrow();
    expect(() => addTombstone(home, HASH, 'a/.env')).toThrow();
    expect(() => addTombstone(home, '../h', 'a.json')).toThrow();
    expect(listTombstones(home, '../h')).toEqual([]);
  });

  it(`more than ${PER_SYNC_DELETE_CAP} deletes in one sync: none sent, the owner is asked`, () => {
    const twenty = Array.from({ length: PER_SYNC_DELETE_CAP }, (_, i) => `f/${i}.json`);
    expect(capDeletes(twenty)).toEqual({ send: twenty, ask: false });
    expect(capDeletes([...twenty, 'f/x.json'])).toEqual({ send: [], ask: true });
  });
});
