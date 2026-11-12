import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DATA_MAX_ENTRIES, HOST_FILE_MAX_BYTES, SDK_FILE_MAX_BYTES, SHARED_WARN_BYTES, WRITING_SETTLE_MS,
  declMatches, largeDataLine, parseDataDecl, shareRefusal, sharedSet, teamSharedBytes, validateDeclPath,
  type DataDecl,
} from '../../src/lib/apps/data-share.js';
import { parseManifest, dataUndeclared } from '../../src/lib/apps/manifest.js';
import type { AppRecord } from '../../src/lib/apps/registry.js';
import type { Consent } from '../../src/lib/apps/data-consent.js';

/** app-veri-ortak criterion 1: the declaration, the shared-set precedence and K4. */

const entries = (n: number, prefix = 'p') => Array.from({ length: n }, (_, i) => ({ path: `${prefix}${i}/`, why: 'w' }));

describe('the data declaration (K1)', () => {
  it('rejects every bad path', () => {
    for (const p of ['/abs/', 'C:/x', '../up/', 'a/../b', '**/*.json', 'a/**', '.hidden/', 'x/.claude/settings.json', '.env', 'a//b', 'a\\b', 'a/*/b.json', 'a/*.json/', 'a*b.json', '']) {
      expect(validateDeclPath(p), p).not.toBeNull();
    }
    expect(validateDeclPath(42)).toBe('not_string');
  });

  it('accepts a folder, a file and a one-level glob', () => {
    for (const p of ['favorites/', 'notes/team/', 'board.json', 'favorites/*.json', '*.json']) expect(validateDeclPath(p), p).toBeNull();
  });

  it('absent field = undecided (null); shared: [] is a valid decision', () => {
    expect(parseDataDecl(undefined)).toEqual({ ok: true, decl: null });
    expect(parseDataDecl({ shared: [] })).toEqual({ ok: true, decl: { shared: [], local: [] } });
  });

  it('a 21st entry, a missing or long why and a bad path are errors', () => {
    expect(parseDataDecl({ shared: entries(DATA_MAX_ENTRIES) }).ok).toBe(true);
    expect(parseDataDecl({ shared: entries(DATA_MAX_ENTRIES + 1) }).ok).toBe(false);
    expect(parseDataDecl({ shared: [{ path: 'a/' }] }).ok).toBe(false);
    expect(parseDataDecl({ shared: [{ path: 'a/', why: '   ' }] }).ok).toBe(false);
    expect(parseDataDecl({ local: [{ path: 'a/', why: 'x'.repeat(121) }] }).ok).toBe(false);
    expect(parseDataDecl({ shared: [{ path: '../a/', why: 'w' }] }).ok).toBe(false);
    expect(parseDataDecl({ shared: 'favorites/' }).ok).toBe(false);
    expect(parseDataDecl('x').ok).toBe(false);
  });

  it('the manifest carries it: absent = undecided, bad = a validation error', () => {
    const base = { slug: 'rakip', name: 'Rakip' };
    const none = parseManifest(JSON.stringify(base), null);
    expect(none.ok && none.manifest.data).toBeNull();
    expect(none.ok && dataUndeclared(none.manifest)).toBe(true);
    const good = parseManifest(JSON.stringify({ ...base, data: { shared: [{ path: 'favorites/', why: 'team picks' }], local: [{ path: 'cache/', why: 'refetched' }] } }), null);
    expect(good.ok && good.manifest.data?.shared[0].path).toBe('favorites/');
    const bad = parseManifest(JSON.stringify({ ...base, data: { shared: [{ path: '/etc/', why: 'x' }] } }), null);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.some((e) => e.field.startsWith('data.shared[0]'))).toBe(true);
  });

  it('declMatches: folder prefix, exact file, one-level glob', () => {
    expect(declMatches('favorites/', 'favorites/a.json')).toBe(true);
    expect(declMatches('favorites/', 'favorites/x/b.json')).toBe(true);
    expect(declMatches('favorites/', 'favoritesX/a.json')).toBe(false);
    expect(declMatches('board.json', 'board.json')).toBe(true);
    expect(declMatches('board.json', 'board.json.bak')).toBe(false);
    expect(declMatches('notes/*.md', 'notes/a.md')).toBe(true);
    expect(declMatches('notes/*.md', 'notes/sub/a.md')).toBe(false);
    expect(declMatches('*.json', 'a.json')).toBe(true);
    expect(declMatches('*.json', 'x/a.json')).toBe(false);
  });
});

let home: string; let dir: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-share-')));
  dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const put = (rel: string, body: string | Buffer = '{}') => {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body);
  return p;
};
const later = () => Date.now() + 60_000;

describe('one file through the gate (K4)', () => {
  it('every refusal code', () => {
    const ok = put('favorites/a.json');
    expect(shareRefusal('favorites/a.json', lstatSync(ok), null, { stage: true, nowMs: later() })).toBeNull();
    // dotted part, .env, instruction name (folded)
    expect(shareRefusal('x/.claude/settings.json', null, null)).toBe('name');
    expect(shareRefusal('favorites/.env.local', null, null)).toBe('name');
    expect(shareRefusal('favorites/CLAUDE.md', null, null)).toBe('name');
    // `agent` + U+017F (long s) + `.md` folds to AGENTS.md on APFS
    expect(shareRefusal(`favorites/agent${String.fromCodePoint(0x17f)}.md`, null, null)).toBe('name');
    expect(shareRefusal('favorites/../x.json', null, null)).toBe('name');
    // symlink
    symlinkSync(ok, join(dir, 'favorites/link.json'));
    expect(shareRefusal('favorites/link.json', lstatSync(join(dir, 'favorites/link.json')), null)).toBe('not_plain');
    // hardlink: only at stage
    linkSync(ok, join(dir, 'favorites/hard.json'));
    const hard = lstatSync(join(dir, 'favorites/hard.json'));
    expect(shareRefusal('favorites/hard.json', hard, null, { stage: true, nowMs: later() })).toBe('not_plain');
    expect(shareRefusal('favorites/hard.json', hard, null, { nowMs: later() })).toBeNull();
    // DB by extension and by magic bytes
    for (const n of ['x.db', 'x.sqlite', 'x.sqlite3', 'x.db-wal', 'x.db-shm', 'x.db-journal']) expect(shareRefusal(`favorites/${n}`, null, null), n).toBe('db_file');
    const magic = Buffer.from('SQLite format 3\0', 'latin1');
    const disguised = put('favorites/data.json', Buffer.concat([magic, Buffer.alloc(32)]));
    expect(shareRefusal('favorites/data.json', lstatSync(disguised), magic, { stage: true, nowMs: later() })).toBe('db_file');
    // size is never a refusal (owner, 2026-11-12): a file over the SDK's request bound still goes
    const big = put('favorites/big.json', Buffer.alloc(SDK_FILE_MAX_BYTES + 1));
    expect(shareRefusal('favorites/big.json', lstatSync(big), null, { stage: true, nowMs: later() })).toBeNull();
    // the host's per-file limit, not ours: one file over 100 MB stays here (GitHub refuses it)
    const at = lstatSync(big);
    expect(shareRefusal('favorites/big.json', { ...at, isFile: () => true, isSymbolicLink: () => false, size: HOST_FILE_MAX_BYTES }, null, { stage: true, nowMs: later() })).toBeNull();
    expect(shareRefusal('favorites/big.json', { ...at, isFile: () => true, isSymbolicLink: () => false, size: HOST_FILE_MAX_BYTES + 1 }, null, { stage: true, nowMs: later() })).toBe('host_limit');
    // writing within 3 s, stage only
    const fresh = lstatSync(put('favorites/fresh.json'));
    expect(shareRefusal('favorites/fresh.json', fresh, null, { stage: true, nowMs: fresh.mtimeMs + WRITING_SETTLE_MS - 1000 })).toBe('writing');
    expect(shareRefusal('favorites/fresh.json', fresh, null, { stage: true, nowMs: fresh.mtimeMs + WRITING_SETTLE_MS + 1 })).toBeNull();
    expect(shareRefusal('favorites/fresh.json', fresh, null, { nowMs: fresh.mtimeMs })).toBeNull();
  });

  it('teamSharedBytes: the team\'s files with this Mac\'s copies over the same path, plus its new ones', () => {
    const mb = 1024 * 1024;
    // A and B each under the warning line alone; together over it (the B11 case): counted whole.
    const team = [{ rel: 'favorites/a1.bin', size: 20 * mb }, { rel: 'favorites/shared.json', size: 1 * mb }];
    const mine = [{ rel: 'favorites/b1.bin', size: 20 * mb }, { rel: 'favorites/shared.json', size: 2 * mb }];
    expect(teamSharedBytes(team, mine)).toBe(42 * mb);
    expect(teamSharedBytes(team, mine)).toBeGreaterThan(SHARED_WARN_BYTES);
    expect(teamSharedBytes([], [])).toBe(0);
    expect(largeDataLine('Rakip', 42 * mb)).toMatch(/large \(42\.0 MB for the team\)\. It all syncs/);
  });
});

describe('the shared set (K3 precedence)', () => {
  const rec = { slug: 'rakip', hash: 'abcdef0123456789' } as AppRecord;
  const ctx = () => ({ projectRoot: home, home });
  const on = { fullRepo: true, cloudSyncOn: true };
  const decl: DataDecl = {
    shared: [{ path: 'favorites/', why: 'team picks' }, { path: 'notes/', why: 'notes' }, { path: 'board.json', why: 'board' }],
    local: [{ path: 'favorites/draft/', why: 'personal' }, { path: 'cache/', why: 'refetched' }],
  };
  const consent = (c: Partial<Consent>): Consent => ({ approved: [], excluded: [], declined: false, at: '', ...c });
  const deps = (extra: object = {}) => ({ mode: on, dataDir: dir, conflicts: [] as string[], nowMs: later(), ...extra });

  beforeEach(() => {
    put('favorites/a.json'); put('favorites/b.json'); put('favorites/draft/mine.json');
    put('notes/n1.md'); put('board.json'); put('cache/ads.json'); put('other.json');
  });

  it('excluded > local > shared; unlisted is local; unapproved held', () => {
    const r = sharedSet(ctx(), rec, decl, consent({ approved: ['favorites/', 'board.json'], excluded: ['board.json'] }), deps());
    expect(r.paths).toEqual(['favorites/a.json', 'favorites/b.json']);
    expect(r.held).toEqual([{ path: 'notes/n1.md', reason: 'not_approved_here' }]);
    // favorites/ is live, so the mode says shared; notes/ still awaits the owner
    expect(r.mode).toBe('shared');
    expect(r.pending).toEqual(['notes/']);
  });

  it('favorites approved, notes newly declared: mode shared, pending [notes/]', () => {
    const before: DataDecl = { shared: [{ path: 'favorites/', why: 'team picks' }], local: decl.local };
    const c = consent({ approved: ['favorites/'] });
    expect(sharedSet(ctx(), rec, before, c, deps())).toMatchObject({ mode: 'shared', pending: [] });
    const grown: DataDecl = { ...before, shared: [...before.shared, { path: 'notes/', why: 'notes' }] };
    const r = sharedSet(ctx(), rec, grown, c, deps());
    expect(r.mode).toBe('shared');
    expect(r.pending).toEqual(['notes/']);
    expect(r.paths).toEqual(['favorites/a.json', 'favorites/b.json']);
  });

  it('nothing approved yet: pending; approved but every file held: still shared', () => {
    const none = sharedSet(ctx(), rec, decl, null, deps());
    expect(none.mode).toBe('pending');
    expect(none.pending).toEqual(['favorites/', 'notes/', 'board.json']);
    expect(none.paths).toEqual([]);
    const allHeld = sharedSet(ctx(), rec, decl, consent({ approved: ['board.json'], excluded: ['favorites/', 'notes/'] }), deps({ conflicts: ['board.json'] }));
    expect(allHeld.mode).toBe('shared');
    expect(allHeld.paths).toEqual([]);
    expect(allHeld.held).toEqual([{ path: 'board.json', reason: 'conflict' }]);
  });

  it('every shared path decided: mode shared', () => {
    const r = sharedSet(ctx(), rec, decl, consent({ approved: ['favorites/', 'board.json'], excluded: ['notes/'] }), deps());
    expect(r.mode).toBe('shared');
    expect(r.pending).toEqual([]);
    expect(r.paths).toEqual(['board.json', 'favorites/a.json', 'favorites/b.json']);
  });

  it('an approval of an undeclared path does not count', () => {
    const r = sharedSet(ctx(), rec, decl, consent({ approved: ['cache/', 'other.json'], excluded: ['favorites/', 'notes/', 'board.json'] }), deps());
    expect(r.paths).toEqual([]);
    expect(r.mode).toBe('local');
  });

  it('sync off (in-tree or cloud sync off): nothing, mode sync_off', () => {
    const c = consent({ approved: ['favorites/', 'notes/', 'board.json'] });
    expect(sharedSet(ctx(), rec, decl, c, deps({ mode: { fullRepo: false, cloudSyncOn: true } }))).toMatchObject({ mode: 'sync_off', paths: [] });
    expect(sharedSet(ctx(), rec, decl, c, deps({ mode: { fullRepo: true, cloudSyncOn: false } }))).toMatchObject({ mode: 'sync_off', paths: [] });
  });

  it('undecided, declined, conflict and K4 holds', () => {
    expect(sharedSet(ctx(), rec, null, null, deps())).toMatchObject({ mode: 'undecided', paths: [] });
    const declined = sharedSet(ctx(), rec, decl, consent({ approved: ['favorites/'], declined: true }), deps());
    expect(declined.mode).toBe('local');
    expect(declined.paths).toEqual([]);
    put('favorites/x.sqlite');
    const all = consent({ approved: ['favorites/', 'notes/', 'board.json'] });
    const r = sharedSet(ctx(), rec, decl, all, deps({ conflicts: ['favorites/b.json'] }));
    expect(r.held).toContainEqual({ path: 'favorites/b.json', reason: 'conflict' });
    expect(r.held).toContainEqual({ path: 'favorites/x.sqlite', reason: 'db_file' });
    expect(r.paths).not.toContain('favorites/b.json');
  });

  it('an app total over 25 MB holds nothing back: every file goes, sizes counted', () => {
    put('favorites/big1.json', Buffer.alloc(4 * 1024 * 1024));
    for (let i = 0; i < 6; i++) put(`favorites/big-${i}.json`, Buffer.alloc(4 * 1024 * 1024));
    const r = sharedSet(ctx(), rec, decl, consent({ approved: ['favorites/', 'notes/', 'board.json'] }), deps());
    expect(r.held.filter((h) => h.path.startsWith('favorites/big'))).toEqual([]);
    for (const p of ['favorites/big1.json', ...Array.from({ length: 6 }, (_, i) => `favorites/big-${i}.json`)]) expect(r.paths).toContain(p);
    expect(r.bytes).toBeGreaterThanOrEqual(28 * 1024 * 1024);
    expect(r.bytes).toBeGreaterThan(SHARED_WARN_BYTES);
    expect(r.sizes.find((x) => x.rel === 'favorites/big1.json')?.size).toBe(4 * 1024 * 1024);
  });
});
