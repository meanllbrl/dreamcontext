// Session state merge at Return: per entry by id, cloud wins per entry, tombstones for tabs
// closed on the phone, chatPermissionMode + bypass ALWAYS the laptop's, cloud-only entries
// land bypass:false; titles per id; the tab map never deletes; the op backs up and rolls back.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SavedMeta } from '../../src/server/routes/agent-sessions.js';
import { readRosterSurface, writeMergedRosterSurface, writeMergedRosterSurfaceAsync } from '../../src/server/routes/agent-sessions.js';
import { acquireFileLock, releaseFileLock } from '../../src/lib/file-lock.js';
import { createJournal, journalPath, loadJournal, runJournal } from '../../src/lib/handsfree/journal.js';
import {
  isSessionStatePath, mergeRoster, mergeTitles, ROSTER_REL, SESSION_MAP_REL, sessionMergeHandlers, TITLES_REL, type RosterSurface,
} from '../../src/lib/handsfree/session-merge.js';
import type { JournalOp } from '../../src/lib/handsfree/journal.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const tab = (sessionId: string, title: string, bypass: boolean, extra: Partial<SavedMeta> = {}): SavedMeta => ({ title, bypass, minimized: false, size: 1, sessionId, kind: 'chat', ...extra });
const surf = (sessions: SavedMeta[], mode: 'auto' | 'bypass', activePane?: number): RosterSurface => ({ sessions, chatPermissionMode: mode, ...(activePane !== undefined ? { activePane } : {}) });

describe('mergeRoster', () => {
  it('keeps the laptop permission mode and bypass, lets the cloud win per entry, tombstones phone-closed tabs, lands cloud-only tabs bypass:false', () => {
    const start = surf([tab(A, 'a', true), tab(B, 'b', false)], 'auto');
    const laptop = surf([tab(A, 'a', true), tab(B, 'b', false), tab(D, 'laptop new', false)], 'auto', 0);
    const cloud = surf([tab(A, 'a renamed on phone', false, { pane: 1 }), tab(C, 'phone tab', true)], 'bypass', 1);
    const m = mergeRoster(start, laptop, cloud);
    expect(m.surface.chatPermissionMode).toBe('auto');
    expect(m.surface.sessions.map((s) => [s.sessionId, s.title, s.bypass])).toEqual([
      [A, 'a renamed on phone', true], // cloud wins per entry; bypass stays the laptop's
      [D, 'laptop new', false], // laptop-only entry kept
      [C, 'phone tab', false], // cloud-only: bypass forced false
    ]);
    expect(m.surface.sessions[0].pane).toBe(1);
    expect(m.surface.activePane).toBe(1);
    expect(m.report.closedOnPhone).toEqual(['b']);
    expect(m.report.openedOnPhone).toEqual(['phone tab']);
  });

  it('a tab closed on the laptop meanwhile is not resurrected by the cloud', () => {
    const start = surf([tab(A, 'a', false)], 'auto');
    const m = mergeRoster(start, surf([], 'auto'), surf([tab(A, 'a', false)], 'auto'));
    expect(m.surface.sessions).toEqual([]);
  });
});

describe('mergeTitles', () => {
  it('per id: the cloud entry wins only when it changed since trip start', () => {
    const start = { titles: { [A]: { title: 'a', updated: '1' }, [B]: { title: 'b', updated: '1' } } };
    const laptop = { titles: { [A]: { title: 'a', updated: '1' }, [B]: { title: 'b laptop', updated: '2' } } };
    const cloud = { titles: { [A]: { title: 'a phone', updated: '3' }, [B]: { title: 'b', updated: '1' }, [C]: { title: 'c', updated: '3' } } };
    const m = mergeTitles(start, laptop, cloud);
    expect(m.store.titles).toEqual({ [A]: { title: 'a phone', updated: '3' }, [B]: { title: 'b laptop', updated: '2' }, [C]: { title: 'c', updated: '3' } });
    expect(m.changed).toBe(2);
  });
});

describe('session.merge op', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hf-smerge-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (base: string, rel: string, data: string) => {
    mkdirSync(join(base, rel, '..'), { recursive: true });
    writeFileSync(join(base, rel), data);
  };

  it('merges through the roster surface (generation bump), never deletes map files, and Roll back restores', async () => {
    const root = join(dir, 'vault');
    const startDir = join(dir, 'start');
    const cloudDir = join(dir, 'cloud');
    const roster = (s: SavedMeta[], mode: string) => JSON.stringify({ sessions: s, chatPermissionMode: mode });
    for (const base of [root, startDir]) {
      write(base, ROSTER_REL, roster([tab(A, 'a', true), tab(B, 'b', false)], 'bypass'));
      write(base, TITLES_REL, JSON.stringify({ titles: { [A]: { title: 'a', updated: '1' } } }));
      write(base, `${SESSION_MAP_REL}/${A}.json`, JSON.stringify({ current: A, updated: '1' }));
    }
    write(root, `${SESSION_MAP_REL}/${D}.json`, JSON.stringify({ current: D, updated: '1' }));
    write(cloudDir, ROSTER_REL, roster([tab(A, 'a phone', false), tab(C, 'c phone', true)], 'auto'));
    write(cloudDir, TITLES_REL, JSON.stringify({ titles: { [A]: { title: 'a phone', updated: '2' } } }));
    write(cloudDir, `${SESSION_MAP_REL}/${A}.json`, JSON.stringify({ current: C, updated: '2' }));
    const before = readFileSync(join(root, ROSTER_REL), 'utf8');

    const tripDir = join(dir, 'trip');
    const h = sessionMergeHandlers({ tripDir, roster: { read: readRosterSurface, write: writeMergedRosterSurface } })['session.merge'];
    const op = { id: 's', kind: 'session.merge', writes: true, state: 'started', params: { root, scope: 'session-r', startDir, cloudDir } } as JournalOp;
    const res = await h.apply(op) as { titlesChanged: number; mapFilesWritten: number };
    const got = readRosterSurface(join(root, '_dream_context'));
    expect(got.chatPermissionMode).toBe('bypass');
    expect(got.sessions.map((s) => [s.sessionId, s.bypass])).toEqual([[A, true], [C, false]]);
    expect(got.generation).toBe(1);
    expect(res.titlesChanged).toBe(1);
    expect(JSON.parse(readFileSync(join(root, `${SESSION_MAP_REL}/${A}.json`), 'utf8')).current).toBe(C);
    expect(existsSync(join(root, `${SESSION_MAP_REL}/${D}.json`))).toBe(true);

    const undo = await h.undo!(op) as { restored: string[] };
    expect(undo.restored).toContain(ROSTER_REL);
    expect(readFileSync(join(root, ROSTER_REL), 'utf8')).toBe(before);
    expect(JSON.parse(readFileSync(join(root, `${SESSION_MAP_REL}/${A}.json`), 'utf8')).current).toBe(A);
  });

  it('isSessionStatePath picks exactly the three session files', () => {
    expect(isSessionStatePath(ROSTER_REL)).toBe(true);
    expect(isSessionStatePath(TITLES_REL)).toBe(true);
    expect(isSessionStatePath(`${SESSION_MAP_REL}/${A}.json`)).toBe(true);
    expect(isSessionStatePath(`${SESSION_MAP_REL}/notes.json`)).toBe(false);
    expect(isSessionStatePath('_dream_context/state/notes.md')).toBe(false);
  });
});

describe('session.merge under a held roster lock (lane F writeMergedRosterSurfaceAsync)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hf-sbusy-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function setupOp(waitMs: number) {
    const root = join(dir, 'vault');
    const startDir = join(dir, 'start');
    const cloudDir = join(dir, 'cloud');
    const roster = (s: SavedMeta[]) => JSON.stringify({ sessions: s, chatPermissionMode: 'auto' });
    const write = (base: string, rel: string, data: string) => { mkdirSync(join(base, rel, '..'), { recursive: true }); writeFileSync(join(base, rel), data); };
    for (const base of [root, startDir]) {
      write(base, ROSTER_REL, roster([tab(A, 'a', false)]));
      write(base, TITLES_REL, JSON.stringify({ titles: { [A]: { title: 'a', updated: '1' } } }));
    }
    write(cloudDir, ROSTER_REL, roster([tab(A, 'a phone', false)]));
    write(cloudDir, TITLES_REL, JSON.stringify({ titles: { [A]: { title: 'a phone', updated: '2' } } }));
    const tripDir = join(dir, 'trip');
    mkdirSync(tripDir, { recursive: true });
    const handlers = sessionMergeHandlers({ tripDir, roster: { read: readRosterSurface, write: (c, sur) => writeMergedRosterSurfaceAsync(c, sur, { waitMs }) } });
    const jp = journalPath(tripDir, 'return');
    createJournal(jp, { trip: 't-1', direction: 'return', ops: [{ id: 's', kind: 'session.merge', writes: true, params: { root, scope: 'session-r', startDir, cloudDir } }] });
    const lock = join(root, '_dream_context', 'state', '.agent-sessions.json.lock');
    return { root, jp, handlers, lock, before: { roster: readFileSync(join(root, ROSTER_REL), 'utf8'), titles: readFileSync(join(root, TITLES_REL), 'utf8') } };
  }

  it('a lock that stays held fails the op with NOTHING written; the journal stays resumable and Resume lands it', async () => {
    const t = setupOp(200);
    expect(acquireFileLock(t.lock, Date.now(), 60_000, { verifyPidLiveness: true })).toBe(true);
    try {
      await expect(runJournal(t.jp, t.handlers)).rejects.toMatchObject({ code: 'roster_busy' });
    } finally {
      releaseFileLock(t.lock);
    }
    // Not half-applied: neither the roster nor the titles changed; the op is `started` with its error.
    expect(readFileSync(join(t.root, ROSTER_REL), 'utf8')).toBe(t.before.roster);
    expect(readFileSync(join(t.root, TITLES_REL), 'utf8')).toBe(t.before.titles);
    const op = loadJournal(t.jp)!.ops[0];
    expect(op.state).toBe('started');
    expect(op.error).toMatch(/locked/);
    // Resume retries the op.
    await runJournal(t.jp, t.handlers);
    expect(loadJournal(t.jp)!.ops[0].state).toBe('done');
    expect(readRosterSurface(join(t.root, '_dream_context')).sessions[0].title).toBe('a phone');
    expect(JSON.parse(readFileSync(join(t.root, TITLES_REL), 'utf8')).titles[A].title).toBe('a phone');
  });

  it('a lock released during the wait just succeeds (the Return waits instead of failing)', async () => {
    const t = setupOp(5_000);
    expect(acquireFileLock(t.lock, Date.now(), 60_000, { verifyPidLiveness: true })).toBe(true);
    setTimeout(() => releaseFileLock(t.lock), 300);
    await runJournal(t.jp, t.handlers);
    expect(loadJournal(t.jp)!.ops[0].state).toBe('done');
    expect(readRosterSurface(join(t.root, '_dream_context')).sessions[0].title).toBe('a phone');
  });
});
