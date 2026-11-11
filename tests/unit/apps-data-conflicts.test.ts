import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFLICTS_KEEP, addConflict, appPullHeld, conflictDir, containedPath, listConflicts, listPullRecords, newStamp,
  parkTarget, pullRecordPath, readPullRecord, rekeyAppState, removePullRecord, resolveConflict, writePullRecord,
  type PullRecord,
} from '../../src/lib/apps/data-conflicts.js';
import { finishAppPull, recoverAppPulls } from '../../src/lib/apps/data-exchange.js';
import { addTombstone, listTombstones } from '../../src/lib/apps/data-deletes.js';

/** app-veri-ortak K5/K7 state: the pull record, the park and the conflict store. */

let home: string; let dataDir: string;
const HASH = 'abcdef0123456789';
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-conflicts-')));
  dataDir = join(home, 'proj', '_dream_context', 'apps', 'rakip');
  mkdirSync(dataDir, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const sha = (c: string) => c.repeat(40);
const record = (over: Partial<PullRecord> = {}): PullRecord => ({
  v: 1, hash: HASH, slug: 'rakip', preHead: sha('a'), mergeHead: sha('b'), phase: 'parked',
  parked: [{ path: 'favorites/a.json', stash: `${newStamp()}/favorites/a.json`, tracked: true }], plan: null, at: new Date().toISOString(), ...over,
});

describe('the pull record', () => {
  it('written, read back, listed, removed; held while it exists', () => {
    expect(appPullHeld(home, HASH)).toBe(false);
    expect(readPullRecord(home, HASH)).toBeNull();
    writePullRecord(home, record());
    expect(appPullHeld(home, HASH)).toBe(true);
    const r = readPullRecord(home, HASH);
    expect(r && r.ok && r.rec.phase).toBe('parked');
    writePullRecord(home, record({ phase: 'merged', plan: [{ path: 'favorites/b.json', action: 'land' }] }));
    const again = readPullRecord(home, HASH);
    expect(again && again.ok && again.rec.plan).toEqual([{ path: 'favorites/b.json', action: 'land' }]);
    expect(listPullRecords(home).map((x) => x.hash)).toEqual([HASH]);
    removePullRecord(home, HASH);
    expect(appPullHeld(home, HASH)).toBe(false);
    removePullRecord(home, HASH); // idempotent
  });

  it('a corrupt record keeps the app held and reads as corrupt', () => {
    mkdirSync(join(home, '.dreamcontext', 'apps', 'pull'), { recursive: true });
    writeFileSync(pullRecordPath(home, HASH), '{not json');
    expect(appPullHeld(home, HASH)).toBe(true);
    expect(readPullRecord(home, HASH)).toEqual({ ok: false, corrupt: true });
    expect(listPullRecords(home)[0].read).toEqual({ ok: false, corrupt: true });
  });

  it('reads from disk every call (no cache)', () => {
    writePullRecord(home, record());
    expect(appPullHeld(home, HASH)).toBe(true);
    rmSync(pullRecordPath(home, HASH));
    expect(appPullHeld(home, HASH)).toBe(false);
  });

  it('path traversal in a record is refused on write and on read', () => {
    expect(() => writePullRecord(home, record({ parked: [{ path: '../../x', stash: `${newStamp()}/x`, tracked: false }] }))).toThrow();
    expect(() => writePullRecord(home, record({ parked: [{ path: 'x.json', stash: '../../etc/passwd', tracked: false }] }))).toThrow();
    expect(() => writePullRecord(home, record({ plan: [{ path: 'a/.claude/settings.json', action: 'land' }] }))).toThrow();
    expect(() => writePullRecord(home, record({ mergeHead: 'HEAD; rm -rf' }))).toThrow();
    mkdirSync(join(home, '.dreamcontext', 'apps', 'pull'), { recursive: true });
    const bad = { ...record(), parked: [{ path: '../../../etc/passwd', stash: `${newStamp()}/x`, tracked: true }] };
    writeFileSync(pullRecordPath(home, HASH), JSON.stringify(bad));
    expect(readPullRecord(home, HASH)).toEqual({ ok: false, corrupt: true });
    expect(appPullHeld(home, HASH)).toBe(true);
  });

  it('a bad hash never names a file and answers held (fail closed)', () => {
    expect(() => pullRecordPath(home, '../x')).toThrow();
    expect(appPullHeld(home, '../x')).toBe(true);
  });

  it('contained targets: park and data paths stay inside', () => {
    expect(containedPath(dataDir, 'favorites/a.json')).toBe(join(dataDir, 'favorites/a.json'));
    for (const bad of ['../x', '/etc/passwd', 'a/../../x', 'a/.env', 'CLAUDE.md', '']) expect(containedPath(dataDir, bad), bad).toBeNull();
    expect(parkTarget(home, HASH, `${newStamp()}/favorites/a.json`)).toContain(join('.dreamcontext', 'apps', 'park', HASH));
    expect(parkTarget(home, HASH, '../escape/a.json')).toBeNull();
  });

  it('outside a git repo recovery finds nothing to do and a missing record is finished', () => {
    const ctx = { gitCwd: home, contextRoot: join(home, 'proj', '_dream_context'), projectRoot: join(home, 'proj'), home };
    expect(recoverAppPulls(ctx)).toEqual({ recovered: [], skipped: null, notes: [] });
    expect(finishAppPull(ctx, HASH)).toEqual({ done: true });
    writePullRecord(home, record());
    expect(finishAppPull(ctx, HASH).done).toBe(false); // the brain is not in a git repo: kept
  });

  it('`absent` (paths with no file on disk before the merge) is kept, deduped, and validated like `parked`', () => {
    writePullRecord(home, record({ absent: ['favorites/t.json', 'favorites/t.json', 'cache/x.json'] }));
    const r = readPullRecord(home, HASH);
    expect(r && r.ok && r.rec.absent).toEqual(['favorites/t.json', 'cache/x.json']);
    writePullRecord(home, record());
    const none = readPullRecord(home, HASH);
    expect(none && none.ok && none.rec.absent).toBeUndefined(); // the park never ran: unknown
    expect(() => writePullRecord(home, record({ absent: ['../../etc/passwd'] }))).toThrow();
    expect(() => writePullRecord(home, record({ absent: ['a/.env'] }))).toThrow();
    mkdirSync(join(home, '.dreamcontext', 'apps', 'pull'), { recursive: true });
    writeFileSync(pullRecordPath(home, HASH), JSON.stringify({ ...record(), absent: 'favorites/t.json' }));
    expect(readPullRecord(home, HASH)).toEqual({ ok: false, corrupt: true });
  });
});

describe('the conflict store and resolve', () => {
  it('theirs: the stored copy lands in the data folder and the entry goes', () => {
    writeFileSync(join(dataDir, 'mine.json'), 'mine');
    mkdirSync(join(dataDir, 'favorites'));
    writeFileSync(join(dataDir, 'favorites', 'a.json'), 'mine');
    const add = addConflict(home, HASH, 'favorites/a.json', 'conflict', { data: Buffer.from('theirs') });
    expect(add.ok).toBe(true);
    expect(listConflicts(home, HASH).map((c) => c.path)).toEqual(['favorites/a.json']);
    expect(resolveConflict(home, HASH, dataDir, 'favorites/a.json', 'theirs')).toEqual({ ok: true });
    expect(readFileSync(join(dataDir, 'favorites', 'a.json'), 'utf-8')).toBe('theirs');
    expect(listConflicts(home, HASH)).toEqual([]);
    expect(resolveConflict(home, HASH, dataDir, 'favorites/a.json', 'theirs')).toEqual({ ok: false, error: 'no_conflict' });
  });

  it('mine: the stored copy is dropped, my file untouched', () => {
    writeFileSync(join(dataDir, 'board.json'), 'mine');
    const src = join(home, 'theirs.json');
    writeFileSync(src, 'theirs');
    const add = addConflict(home, HASH, 'board.json', 'conflict', { file: src });
    expect(add.ok).toBe(true);
    const stored = add.ok ? join(conflictDir(home, HASH), add.entry.stash) : '';
    expect(existsSync(stored)).toBe(true);
    expect(resolveConflict(home, HASH, dataDir, 'board.json', 'mine')).toEqual({ ok: true });
    expect(existsSync(stored)).toBe(false);
    expect(readFileSync(join(dataDir, 'board.json'), 'utf-8')).toBe('mine');
  });

  it('refuses a bad path, a symlinked source and a symlinked folder on the way', () => {
    expect(addConflict(home, HASH, '../x.json', 'conflict', { data: Buffer.from('x') }).ok).toBe(false);
    expect(addConflict(home, HASH, 'x/.claude/settings.json', 'conflict', { data: Buffer.from('x') }).ok).toBe(false);
    const link = join(home, 'link.json');
    symlinkSync('/etc/hosts', link);
    expect(addConflict(home, HASH, 'a.json', 'conflict', { file: link })).toEqual({ ok: false, error: 'not_plain' });
    // a planted symlink inside the data folder is never written through
    const outside = join(home, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(dataDir, 'favorites'));
    expect(addConflict(home, HASH, 'favorites/a.json', 'conflict', { data: Buffer.from('theirs') }).ok).toBe(true);
    const r = resolveConflict(home, HASH, dataDir, 'favorites/a.json', 'theirs');
    expect(r.ok).toBe(false);
    expect(existsSync(join(outside, 'a.json'))).toBe(false);
  });

  it(`keeps the newest ${CONFLICTS_KEEP}, one entry per path`, () => {
    for (let i = 0; i < CONFLICTS_KEEP + 3; i++) addConflict(home, HASH, `f/${i}.json`, 'local_path', { data: Buffer.from(String(i)) }, Date.now() + i * 1000);
    addConflict(home, HASH, `f/${CONFLICTS_KEEP + 2}.json`, 'conflict', { data: Buffer.from('again') }, Date.now() + 99_000);
    const all = listConflicts(home, HASH);
    expect(all.length).toBe(CONFLICTS_KEEP);
    expect(all.map((c) => c.path)).not.toContain('f/0.json');
    expect(all.filter((c) => c.path === `f/${CONFLICTS_KEEP + 2}.json`)).toHaveLength(1);
  });
});

describe('rekeyAppState (a team folder installed under the same slug)', () => {
  const TEAM = 't-0123456789abcdef0123456789abcdef01234567';
  it('moves the conflict index and store and the tombstones to the installed app\'s hash', () => {
    expect(addConflict(home, TEAM, 'notes/n.json', 'not_installed', { data: Buffer.from('{"n":1}') }).ok).toBe(true);
    addTombstone(home, TEAM, 'favorites/a.json');
    const r = rekeyAppState(home, TEAM, HASH);
    expect(r).toEqual({ ok: true, moved: ['conflict index', 'conflict store', 'tombstones'] });
    expect(listConflicts(home, TEAM)).toEqual([]);
    expect(listConflicts(home, HASH).map((c) => c.path)).toEqual(['notes/n.json']);
    expect(listTombstones(home, HASH).map((t) => t.path)).toEqual(['favorites/a.json']);
    expect(existsSync(conflictDir(home, TEAM))).toBe(false);
    expect(resolveConflict(home, HASH, dataDir, 'notes/n.json', 'theirs')).toEqual({ ok: true });
    expect(readFileSync(join(dataDir, 'notes/n.json'), 'utf-8')).toBe('{"n":1}');
  });

  it('refuses while a pull is open (either key), over state the target already has, and a bad hash; nothing to move is fine', () => {
    expect(rekeyAppState(home, TEAM, HASH)).toEqual({ ok: true, moved: [] });
    writePullRecord(home, { ...record(), hash: TEAM });
    expect(rekeyAppState(home, TEAM, HASH)).toEqual({ ok: false, reason: 'pull_open' });
    removePullRecord(home, TEAM);
    addTombstone(home, TEAM, 'favorites/a.json');
    addTombstone(home, HASH, 'favorites/b.json');
    expect(rekeyAppState(home, TEAM, HASH)).toEqual({ ok: false, reason: 'target_busy' });
    expect(listTombstones(home, TEAM).map((t) => t.path)).toEqual(['favorites/a.json']);
    expect(rekeyAppState(home, '../x', HASH)).toEqual({ ok: false, reason: 'bad_app' });
  });
});
