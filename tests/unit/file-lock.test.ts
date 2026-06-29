import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireFileLock, releaseFileLock } from '../../src/lib/file-lock.js';

/**
 * The cross-process stamp mutex behind `sleep start`. Pure-ish: `nowMs` is
 * injected so staleness is deterministic without sleeping in the test.
 */
describe('acquireFileLock / releaseFileLock', () => {
  let dir: string;
  let lock: string;
  const STALE = 60_000;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dc-filelock-'));
    lock = join(dir, 'nested', '.thing.lock'); // nested → exercises mkdirSync
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('acquires when no lock exists, creating parent dirs', () => {
    expect(acquireFileLock(lock, 1000, STALE)).toBe(true);
    expect(existsSync(lock)).toBe(true);
    expect(JSON.parse(readFileSync(lock, 'utf-8')).at).toBe(1000);
  });

  it('refuses a second acquire while a FRESH lock is held', () => {
    expect(acquireFileLock(lock, 1000, STALE)).toBe(true);
    expect(acquireFileLock(lock, 1000 + STALE, STALE)).toBe(false); // age == TTL → still held (<=)
    expect(acquireFileLock(lock, 1500, STALE)).toBe(false);
  });

  it('breaks and reclaims a STALE lock (age strictly beyond the TTL)', () => {
    expect(acquireFileLock(lock, 1000, STALE)).toBe(true);
    // age = STALE + 1 > TTL → stale → reclaimed; the new stamp records the new time
    expect(acquireFileLock(lock, 1000 + STALE + 1, STALE)).toBe(true);
    expect(JSON.parse(readFileSync(lock, 'utf-8')).at).toBe(1000 + STALE + 1);
    // freshly reclaimed → next contender is refused again
    expect(acquireFileLock(lock, 1000 + STALE + 2, STALE)).toBe(false);
  });

  it('falls back to file mtime when the lock content is garbage (no JSON `at`)', () => {
    acquireFileLock(lock, 1, STALE); // creates parent dir + a valid lock
    writeFileSync(lock, 'not json at all'); // corrupt it → forces the mtime branch
    const mtimeNow = Date.now();
    // nowMs close to mtime → within TTL → treated as genuinely held
    expect(acquireFileLock(lock, mtimeNow, STALE)).toBe(false);
    // nowMs far past mtime → stale via mtime fallback → reclaimed
    expect(acquireFileLock(lock, mtimeNow + 10 * 60_000, 1_000)).toBe(true);
    expect(JSON.parse(readFileSync(lock, 'utf-8')).at).toBe(mtimeNow + 10 * 60_000);
  });

  it('release removes the lock and is idempotent', () => {
    expect(acquireFileLock(lock, 1000, STALE)).toBe(true);
    releaseFileLock(lock);
    expect(existsSync(lock)).toBe(false);
    releaseFileLock(lock); // already gone — must not throw
    // released → a new holder can acquire
    expect(acquireFileLock(lock, 2000, STALE)).toBe(true);
  });
});
