import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readTaskHead, readTaskHeads, resetTaskHeadsForTests } from '../../src/lib/task-heads.js';
import { SyncLedger, MEMBERS_LIVE_MS, membersStale } from '../../src/lib/task-backend/sync-state.js';
import { getTaskSyncStatus } from '../../src/lib/task-backend/index.js';

// Task: opening the app is slow (2026-11-23). The scans that run on every app open read each
// task file's head and the sync state once per file stamp; a write anywhere is seen at once.

let root: string;
let ctx: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-load-memos-'));
  ctx = join(root, '_dream_context');
  mkdirSync(join(ctx, 'state'), { recursive: true });
  resetTaskHeadsForTests();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Rewrite a file and move its mtime, so the stamp changes even within one clock tick. */
function rewrite(path: string, text: string, at: number): void {
  writeFileSync(path, text);
  utimesSync(path, at, at);
}

describe('task heads memo', () => {
  it('reads every task head, and a rewritten file is read again', () => {
    const a = join(ctx, 'state', 'alpha.md');
    rewrite(a, '---\nname: Alpha\nagent: scout\n---\nbody\n', 1_000);
    writeFileSync(join(ctx, 'state', 'beta.md'), '---\nname: Beta\n---\n');
    writeFileSync(join(ctx, 'state', 'NOT-a-task.md'), '---\nname: X\n---\n');
    expect(readTaskHeads(ctx).map((h) => [h.slug, h.data.agent])).toEqual([['alpha', 'scout'], ['beta', undefined]]);
    // Same stamp: the same object comes back (no re-read).
    expect(readTaskHead(ctx, 'alpha.md')).toBe(readTaskHead(ctx, 'alpha.md'));
    rewrite(a, '---\nname: Alpha\nagent: other\n---\nbody\n', 2_000);
    expect(readTaskHead(ctx, 'alpha.md')?.data.agent).toBe('other');
  });

  it('a task file that will not parse is marked broken, and a symlink is never read', () => {
    writeFileSync(join(ctx, 'state', 'bad.md'), '---\nname: [unclosed\n---\n');
    const outside = join(root, 'secret.md');
    writeFileSync(outside, '---\nagent: scout\n---\n');
    symlinkSync(outside, join(ctx, 'state', 'link.md'));
    const heads = readTaskHeads(ctx);
    expect(heads.map((h) => [h.slug, h.broken])).toEqual([['bad', true]]);
    expect(readTaskHead(ctx, 'link.md')).toBeNull();
  });

  it('a file swapped for a symlink after it was cached is refused, not served from the memo', () => {
    const p = join(ctx, 'state', 'swap.md');
    writeFileSync(p, '---\nagent: scout\n---\n');
    expect(readTaskHead(ctx, 'swap.md')?.data.agent).toBe('scout');
    rmSync(p);
    const outside = join(root, 'other.md');
    writeFileSync(outside, '---\nagent: thief\n---\n');
    symlinkSync(outside, p);
    expect(readTaskHead(ctx, 'swap.md')).toBeNull();
  });
});

describe('sync state peek', () => {
  it('parses once per stamp, and a write through the ledger is seen by the next peek', () => {
    const ledger = new SyncLedger(ctx);
    ledger.writeSyncState({ watermark: null, tasks: { a: { last_synced_at: 1, pendingPush: true } } });
    expect(getTaskSyncStatus(ctx, null).pendingPush).toBe(1);
    expect(ledger.peekSyncState()).toBe(ledger.peekSyncState());
    ledger.writeSyncState({ watermark: 5, tasks: { a: { last_synced_at: 1 }, b: { last_synced_at: 1, pendingPush: true }, c: { last_synced_at: 1, pendingPush: true } } });
    const status = getTaskSyncStatus(ctx, null);
    expect(status.pendingPush).toBe(2);
    expect(status.watermark).toBe(5);
  });

  it('readMembers hands out a copy: a caller changing it never reaches the memo', () => {
    const ledger = new SyncLedger(ctx);
    ledger.writeMembers({ alice: { id: 'alice', name: 'alice' } });
    const m = ledger.readMembers();
    delete m.alice;
    expect(Object.keys(ledger.readMembers())).toEqual(['alice']);
  });

  it('a member roster is refreshed behind its answer only once it is older than the live window', () => {
    expect(membersStale(null, 10)).toBe(true);
    expect(membersStale(1_000, 1_000 + MEMBERS_LIVE_MS - 1)).toBe(false);
    expect(membersStale(1_000, 1_000 + MEMBERS_LIVE_MS)).toBe(true);
  });
});
