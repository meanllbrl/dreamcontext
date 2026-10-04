// Hands-free journal (AC11): persisted before any write, crash-replay without re-diffing,
// "target already holds it" counts as done, Resume-or-Roll-back after the first write,
// reverse-order roll back, and the per-trip run lock.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWriteStream, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JournalError, acquireTripRunLock, backupDir, createJournal, journalPath, journalStatus, loadJournal, rollbackJournal,
  rolledBackJournals, runJournal, tripDir, type JournalOp, type OpHandlers,
} from '../../src/lib/handsfree/journal.js';
import { buildManifest, walk } from '../../src/lib/handsfree/manifest.js';
import { writePack } from '../../src/lib/handsfree/pack.js';
import { fileOpHandlers, filesApplyParams, planMirror } from '../../src/lib/handsfree/apply.js';

let home: string;
let dir: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hf-journal-'));
  dir = tripDir(join(home, '.dreamcontext', 'handsfree'), 't1');
  mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function counterHandlers(log: string[], state: Record<string, number>, failOnce: Set<string> = new Set()): OpHandlers {
  return {
    set: {
      isDone: async (op: JournalOp) => state[(op.params as { k: string }).k] === (op.params as { v: number }).v,
      apply: async (op: JournalOp) => {
        const { k, v } = op.params as { k: string; v: number };
        log.push(`apply:${op.id}`);
        if (failOnce.delete(op.id)) throw new Error(`crash in ${op.id}`);
        state[k] = v;
        return { wrote: k };
      },
      undo: async (op: JournalOp) => {
        const { k, prev } = op.params as { k: string; prev: number };
        log.push(`undo:${op.id}`);
        state[k] = prev;
      },
    },
  };
}

const ops = [
  { id: 'a', kind: 'set', writes: true, params: { k: 'a', v: 1, prev: 0 } },
  { id: 'b', kind: 'set', writes: true, params: { k: 'b', v: 2, prev: 0 } },
  { id: 'c', kind: 'set', writes: true, params: { k: 'c', v: 3, prev: 0 } },
];

describe('journal', () => {
  it('is persisted before any op runs and refuses to be planned twice', () => {
    const p = journalPath(dir, 'return');
    createJournal(p, { trip: 't1', direction: 'return', ops });
    const j = loadJournal(p)!;
    expect(j.ops.map((o) => o.state)).toEqual(['pending', 'pending', 'pending']);
    expect(journalStatus(j)).toMatchObject({ complete: false, writeStarted: false });
    expect(() => createJournal(p, { trip: 't1', direction: 'return', ops })).toThrow(JournalError);
  });

  it('a crash mid-run resumes from the failed op; finished ops never run again', async () => {
    const p = journalPath(dir, 'return');
    createJournal(p, { trip: 't1', direction: 'return', ops });
    const log: string[] = [];
    const state: Record<string, number> = { a: 0, b: 0, c: 0 };
    const h = counterHandlers(log, state, new Set(['b']));
    await expect(runJournal(p, h)).rejects.toThrow(/crash in b/);
    const mid = loadJournal(p)!;
    expect(mid.ops.map((o) => o.state)).toEqual(['done', 'started', 'pending']);
    expect(mid.ops[1].error).toMatch(/crash/);
    expect(journalStatus(mid).writeStarted).toBe(true); // only Resume or Roll back now
    await runJournal(p, h);
    expect(log).toEqual(['apply:a', 'apply:b', 'apply:b', 'apply:c']);
    expect(state).toEqual({ a: 1, b: 2, c: 3 });
    expect(journalStatus(loadJournal(p)!).complete).toBe(true);
  });

  it('an op whose target already holds the expected value counts as done without running', async () => {
    const p = journalPath(dir, 'go');
    createJournal(p, { trip: 't1', direction: 'go', ops });
    const log: string[] = [];
    const state: Record<string, number> = { a: 1, b: 0, c: 3 };
    await runJournal(p, counterHandlers(log, state));
    expect(log).toEqual(['apply:b']);
  });

  it('roll back undoes only started/done ops, newest first, and blocks a further run', async () => {
    const p = journalPath(dir, 'return');
    createJournal(p, { trip: 't1', direction: 'return', ops });
    const log: string[] = [];
    const state: Record<string, number> = { a: 0, b: 0, c: 0 };
    const h = counterHandlers(log, state, new Set(['c']));
    await expect(runJournal(p, h)).rejects.toThrow();
    log.length = 0;
    await rollbackJournal(p, h);
    expect(log).toEqual(['undo:c', 'undo:b', 'undo:a']);
    expect(state).toEqual({ a: 0, b: 0, c: 0 });
    // The rolled-back journal is archived; nothing is left to run or roll back at the path.
    expect(loadJournal(p)).toBeNull();
    const archived = rolledBackJournals(p);
    expect(archived).toHaveLength(1);
    expect(journalStatus(loadJournal(archived[0])!).rolledBack).toBe(true);
    await expect(runJournal(p, h)).rejects.toThrow(/no journal/);
    expect(log).toEqual(['undo:c', 'undo:b', 'undo:a']);
  });

  it('a retried Return can plan a fresh journal after Roll back; every rolled-back one is kept', async () => {
    const p = journalPath(dir, 'return');
    const log: string[] = [];
    const state: Record<string, number> = { a: 0, b: 0, c: 0 };
    const h = counterHandlers(log, state);
    createJournal(p, { trip: 't1', direction: 'return', ops });
    await runJournal(p, h);
    await rollbackJournal(p, h);
    createJournal(p, { trip: 't1', direction: 'return', ops }); // the retry starts fresh
    await runJournal(p, h);
    expect(state).toEqual({ a: 1, b: 2, c: 3 });
    expect(journalStatus(loadJournal(p)!).complete).toBe(true);
    await rollbackJournal(p, h);
    expect(rolledBackJournals(p)).toHaveLength(2);
    expect(existsSync(p)).toBe(false);
  });

  it('re-running Roll back after a crash that followed the archive rename does not throw', async () => {
    const p = journalPath(dir, 'return');
    const log: string[] = [];
    const h = counterHandlers(log, { a: 0, b: 0, c: 0 });
    createJournal(p, { trip: 't1', direction: 'return', ops });
    await runJournal(p, h);
    await rollbackJournal(p, h); // archived
    log.length = 0;
    const again = await rollbackJournal(p, h); // the re-run after a crash
    expect(journalStatus(again).rolledBack).toBe(true);
    expect(log).toEqual([]); // nothing undone twice
    expect(rolledBackJournals(p)).toHaveLength(1);
    await expect(rollbackJournal(journalPath(dir, 'go'), h)).rejects.toThrow(/no journal/);
  });

  it('replays a files.apply op that crashed after writing (idempotent) and rolls it back', async () => {
    const cloud = join(home, 'cloud');
    const root = join(home, 'laptop');
    mkdirSync(join(cloud, 'notes'), { recursive: true });
    mkdirSync(root);
    writeFileSync(join(cloud, 'notes', 'a.md'), 'A');
    writeFileSync(join(cloud, 'b.md'), 'B');
    writeFileSync(join(root, 'b.md'), 'old B');
    const incoming = await buildManifest(cloud, walk(cloud, [''], { side: 'laptop' }).entries);
    const expected = await buildManifest(root, walk(root, [''], { side: 'laptop' }).entries);
    const plan = planMirror(expected, incoming);
    const packPath = join(dir, 'r1.pack');
    await writePack(createWriteStream(packPath), { root: cloud, entries: incoming.values() });
    const p = journalPath(dir, 'return');
    createJournal(p, {
      trip: 't1', direction: 'return',
      ops: [{ id: 'files:r1', kind: 'files.apply', writes: true, params: filesApplyParams({ root, scope: 'r1', packPath, plan, expected, incoming, policy: 'overwrite', maxBytes: 1 << 30 }) }],
    });
    const h = fileOpHandlers({ tripDir: dir });
    // Simulate a kill after the op wrote everything but before `done` was persisted.
    await h['files.apply'].apply(loadJournal(p)!.ops[0]);
    const j = loadJournal(p)!;
    j.ops[0].state = 'started';
    writeFileSync(p, JSON.stringify(j));
    const after = await runJournal(p, h);
    expect(after.ops[0].state).toBe('done');
    expect((after.ops[0].result as { alreadyDone: string[] }).alreadyDone.sort()).toEqual(['b.md', 'notes/a.md']);
    expect(readFileSync(join(root, 'b.md'), 'utf8')).toBe('B');
    expect(existsSync(join(backupDir(dir, 'r1'), 'files', 'b.md'))).toBe(true);
    await rollbackJournal(p, h);
    expect(readFileSync(join(root, 'b.md'), 'utf8')).toBe('old B');
    expect(existsSync(join(root, 'notes'))).toBe(false);
  });
});

describe('per-trip run lock', () => {
  it('is single-flight while the holder lives and reclaimed when it died', () => {
    const lock = acquireTripRunLock(dir)!;
    expect(lock).not.toBeNull();
    expect(acquireTripRunLock(dir)).toBeNull();
    expect(acquireTripRunLock(dir, Date.now() + 60_000)).toBeNull(); // old but alive: never stolen
    lock.release();
    // A lock left by a dead process (no such pid) is reclaimed.
    writeFileSync(join(dir, 'run.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() - 5000 }));
    const again = acquireTripRunLock(dir);
    expect(again).not.toBeNull();
    again!.release();
    expect(existsSync(join(dir, 'run.lock'))).toBe(false);
  });
});
