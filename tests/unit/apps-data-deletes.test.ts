import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireFileLock, releaseFileLock } from '../../src/lib/file-lock.js';
import {
  PER_SYNC_DELETE_CAP, TOMBSTONE_TTL_MS, addTombstone, approveDeletes, capDeletes, capStones, clearTombstones, listTombstones, markSent,
  setBlocked, tombstonesPath, waitingDeletes,
} from '../../src/lib/apps/data-deletes.js';

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

  it('a stone waiting to be sent never expires; once sent, it is dropped 30 days after the first send', () => {
    const t0 = Date.UTC(2026, 10, 1);
    addTombstone(home, HASH, 'favorites/a.json', t0);
    expect(listTombstones(home, HASH, t0 + 3 * TOMBSTONE_TTL_MS)).toHaveLength(1); // never sent: waits
    const t1 = t0 + 2 * TOMBSTONE_TTL_MS;
    markSent(home, HASH, ['favorites/a.json'], t1);
    markSent(home, HASH, ['favorites/a.json'], t1 + 1000); // a resend keeps the first time
    expect(listTombstones(home, HASH, t1)[0].sentAt).toBe(new Date(t1).toISOString());
    expect(listTombstones(home, HASH, t1 + TOMBSTONE_TTL_MS - 1)).toHaveLength(1);
    expect(listTombstones(home, HASH, t1 + TOMBSTONE_TTL_MS)).toHaveLength(0);
    clearTombstones(home, HASH, [], t1 + TOMBSTONE_TTL_MS);
    expect(listTombstones(home, HASH, t1)).toHaveLength(0);
  });

  it('the owner approves every stone present now: they go past the cap; a later stone follows the cap again', () => {
    for (let i = 0; i < 21; i++) addTombstone(home, HASH, `f/${i}.json`);
    expect(capStones(listTombstones(home, HASH))).toEqual({ send: [], ask: true, waiting: 21 });
    expect(approveDeletes(home, HASH, 21)).toEqual({ ok: true, approved: 21 });
    expect(approveDeletes(home, HASH, 0)).toEqual({ ok: true, approved: 0 });
    expect(capStones(listTombstones(home, HASH)).send).toHaveLength(21);
    for (let i = 21; i < 42; i++) addTombstone(home, HASH, `f/${i}.json`);
    const after = capStones(listTombstones(home, HASH));
    expect(after.send.sort()).toEqual(Array.from({ length: 21 }, (_, i) => `f/${i}.json`).sort());
    expect(after).toMatchObject({ ask: true, waiting: 21 });
  });

  it('an approval names the count the owner saw: a stale count refuses and approves nothing; a stone added after the count is not approved', () => {
    for (let i = 0; i < 25; i++) addTombstone(home, HASH, `f/${i}.json`);
    const shown = waitingDeletes(home, HASH).length; // what the CLI lists
    expect(shown).toBe(25);
    addTombstone(home, HASH, 'f/late.json'); // the app keeps deleting after the owner looked
    expect(approveDeletes(home, HASH, shown)).toEqual({ ok: false, reason: 'changed', waiting: 26 });
    expect(listTombstones(home, HASH).filter((t) => t.approved)).toEqual([]);
    expect(approveDeletes(home, HASH, 26)).toEqual({ ok: true, approved: 26 }); // shown again, then approved
    addTombstone(home, HASH, 'f/later.json');
    expect(waitingDeletes(home, HASH).map((t) => t.path)).toEqual(['f/later.json']);
    expect(listTombstones(home, HASH).find((t) => t.path === 'f/later.json')?.approved).toBeUndefined();
  });

  it('the three counts agree: the listed set, the approvable set and the sync\'s waiting count; a blocked stone is in none of them', () => {
    for (let i = 0; i < 23; i++) addTombstone(home, HASH, `f/${i}.json`);
    setBlocked(home, HASH, ['f/0.json', 'f/1.json']); // the sync cannot send these from here
    const listed = waitingDeletes(home, HASH);
    expect(listed).toHaveLength(21);
    expect(capStones(listTombstones(home, HASH)).waiting).toBe(listed.length);
    expect(approveDeletes(home, HASH, 23)).toEqual({ ok: false, reason: 'changed', waiting: 21 });
    expect(approveDeletes(home, HASH, 21)).toEqual({ ok: true, approved: 21 });
    expect(listTombstones(home, HASH).filter((t) => t.approved).map((t) => t.path)).not.toContain('f/0.json');
    expect(capStones(listTombstones(home, HASH)).send).not.toContain('f/0.json'); // blocked: never sent, approved or not
    setBlocked(home, HASH, []); // sendable again: back to waiting
    expect(waitingDeletes(home, HASH).map((t) => t.path).sort()).toEqual(['f/0.json', 'f/1.json']);
  });

  it('deleting a path again keeps the owner\'s approval of it', () => {
    for (let i = 0; i < 21; i++) addTombstone(home, HASH, `f/${i}.json`);
    expect(approveDeletes(home, HASH, 21)).toMatchObject({ ok: true });
    markSent(home, HASH, ['f/3.json']);
    addTombstone(home, HASH, 'f/3.json');
    const again = listTombstones(home, HASH).find((t) => t.path === 'f/3.json')!;
    expect(again.approved).toBe(true);
    expect(again.sentAt).toBeUndefined();
  });

  // Each refused writer waits STONES_LOCK_WAIT_MS (2 s) before it gives up.
  it('every writer waits for the store\'s lock instead of writing over another process\'s change', { timeout: 20_000 }, () => {
    addTombstone(home, HASH, 'f/a.json');
    const lock = `${tombstonesPath(home, HASH)}.lock`;
    expect(acquireFileLock(lock, Date.now(), 30_000, { verifyPidLiveness: true })).toBe(true); // another writer holds it
    try {
      expect(() => addTombstone(home, HASH, 'f/b.json')).toThrow(/another process/);
      expect(() => approveDeletes(home, HASH, 1)).toThrow(/another process/);
      expect(() => markSent(home, HASH, ['f/a.json'])).toThrow(/another process/);
      expect(() => clearTombstones(home, HASH, ['f/a.json'])).toThrow(/another process/);
    } finally { releaseFileLock(lock); }
    addTombstone(home, HASH, 'f/b.json');
    expect(listTombstones(home, HASH).map((t) => t.path)).toEqual(['f/a.json', 'f/b.json']);
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
