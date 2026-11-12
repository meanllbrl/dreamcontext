/**
 * The per-machine state of a team pull of app data (app-veri-ortak plan r6, K5, K7): the PULL
 * RECORD, the PARK folder and the CONFLICT STORE. Types and plain file helpers only: no git call
 * lives here (data-exchange.ts, wave 2, owns every git step and `recoverAppPulls`/`finishAppPull`).
 *
 *  - Pull record `~/.dreamcontext/apps/pull/<hash>.json`: written FIRST, work after. While it
 *    exists no door of the app opens ({@link appPullHeld}: gateway handle()+upgrade(),
 *    supervisor, write gate, bash gate). Only the merge finishing removes it, never time.
 *  - Park `~/.dreamcontext/apps/park/<hash>/<stamp>/<path>`: my unsent copy, set aside before a
 *    merge and put back after it, however it ends.
 *  - Conflict store `~/.dreamcontext/apps/conflicts/<hash>/<stamp>/<path>` with its index
 *    `~/.dreamcontext/apps/conflicts/<hash>.json`: the team's copy kept while mine stays in place
 *    (the unit is the file; a human picks), newest {@link CONFLICTS_KEEP} per app.
 *
 * Every park, restore and store target is contained ({@link containedPath}: `safeChildPath` plus
 * the K4 name check on every part) under the app's data folder or the per-hash folder.
 */

import { randomBytes } from 'node:crypto';
import { constants, copyFileSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { safeChildPath } from '../../server/safe-path.js';
import { APP_SLUG_RE } from './bundle.js';
import { appsHome } from './registry.js';
import { APP_HASH_RE, appStateFile, assertAppHash, readJsonStrict, writeJsonAtomic } from './data-consent.js';
import { pathNameRefusal } from './data-share.js';

// ─── wave-2 signatures (data-exchange.ts implements, the surface calls) ─────────────

export interface AppPullCtx { gitCwd: string; contextRoot: string; projectRoot: string; home: string; nowMs?: number }
/** Crash recovery + every sync's start; runs only while this process holds the brain lock. */
export type RecoverAppPullsFn = (ctx: AppPullCtx) => { recovered: string[]; skipped: 'locked' | null; notes: string[] };
/** Apply a finished pull's plan (or only put the park back after an abort); only with no MERGE_HEAD. */
export type FinishAppPullFn = (ctx: AppPullCtx, hash: string) => { done: boolean; note?: string };

// ─── the pull record ──────────────────────────────────────────────────────────────

export type PullPhase = 'parked' | 'merged' | 'finished';
/**
 * One path of the settle plan (K5 rule). `land`: the team's copy goes to disk. `store_theirs`:
 * the team's copy is taken off disk into the conflict store (a path this Mac calls local, or a
 * declaration-less app). `mine_back_theirs_stored`: mine (parked, or HEAD^1) back on disk, the
 * team's to the store, the path `conflict`. `delete_ok`: a tombstoned delete from the team.
 * `reason` carries the store kind or the K4 refusal code the plan was made with.
 */
export interface PlanEntry { path: string; action: 'land' | 'store_theirs' | 'mine_back_theirs_stored' | 'delete_ok'; reason?: string }
export interface ParkedPath { path: string; stash: string; tracked: boolean }
export interface PullRecord {
  v: 1;
  hash: string;
  slug: string;
  preHead: string | null;
  mergeHead: string | null;
  phase: PullPhase;
  parked: ParkedPath[];
  /**
   * Incoming paths (data-relative) that were ABSENT from this Mac's disk before the merge. "Mine"
   * is what the disk held, never HEAD's blob: for these, putting mine back means removing the
   * file. Written by `parkBeforeMerge` before any move; absent (undefined) = the park never ran,
   * so what the disk held is unknown and no HEAD blob is ever written back.
   */
  absent?: string[];
  plan: PlanEntry[] | null;
  at: string;
}

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const PLAN_ACTIONS = ['land', 'store_theirs', 'mine_back_theirs_stored', 'delete_ok'] as const;
const STAMP_RE = /^\d{8}T\d{6}Z-[0-9a-f]{4}$/;

export function pullRecordPath(home: string, hash: string): string {
  return appStateFile(home, 'pull', hash);
}
export function pullDir(home: string): string {
  return join(appsHome(home), 'pull');
}
export function parkDir(home: string, hash: string): string {
  assertAppHash(hash);
  return join(appsHome(home), 'park', hash);
}
export function conflictDir(home: string, hash: string): string {
  assertAppHash(hash);
  return join(appsHome(home), 'conflicts', hash);
}
export function conflictIndexPath(home: string, hash: string): string {
  return appStateFile(home, 'conflicts', hash);
}

/** `YYYYMMDDTHHMMSSZ-xxxx`, the stamp of one park or store run. */
export function newStamp(nowMs: number = Date.now()): string {
  return `${new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${randomBytes(2).toString('hex')}`;
}

/**
 * `rel` under `base` as an absolute path, or null: every part passes the K4 name check (no
 * empty, `.`, `..`, dotted or instruction-named part) and `safeChildPath` keeps it inside.
 */
export function containedPath(base: string, rel: string): string | null {
  if (typeof rel !== 'string' || pathNameRefusal(rel)) return null;
  const abs = safeChildPath(base, rel);
  return abs && abs !== base ? abs : null;
}

/** A stash path: `<stamp>/<data path>`, its stamp well-formed, the rest a contained data path. */
function stashOk(stash: unknown): stash is string {
  if (typeof stash !== 'string') return false;
  const i = stash.indexOf('/');
  return i > 0 && STAMP_RE.test(stash.slice(0, i)) && pathNameRefusal(stash.slice(i + 1)) === null;
}

function validRecord(raw: unknown, hash: string): PullRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || r.hash !== hash || typeof r.slug !== 'string' || !APP_SLUG_RE.test(r.slug)) return null;
  if (r.preHead !== null && (typeof r.preHead !== 'string' || !SHA_RE.test(r.preHead))) return null;
  if (r.mergeHead !== null && (typeof r.mergeHead !== 'string' || !SHA_RE.test(r.mergeHead))) return null;
  if (r.phase !== 'parked' && r.phase !== 'merged' && r.phase !== 'finished') return null;
  if (!Array.isArray(r.parked) || typeof r.at !== 'string') return null;
  const parked: ParkedPath[] = [];
  for (const p of r.parked) {
    if (!p || typeof p !== 'object') return null;
    const x = p as Record<string, unknown>;
    if (typeof x.path !== 'string' || pathNameRefusal(x.path) || !stashOk(x.stash) || typeof x.tracked !== 'boolean') return null;
    parked.push({ path: x.path, stash: x.stash, tracked: x.tracked });
  }
  let absent: string[] | undefined;
  if (r.absent !== undefined) {
    if (!Array.isArray(r.absent)) return null;
    absent = [];
    for (const a of r.absent) {
      if (typeof a !== 'string' || pathNameRefusal(a)) return null;
      if (!absent.includes(a)) absent.push(a);
    }
  }
  let plan: PlanEntry[] | null = null;
  if (r.plan !== null) {
    if (!Array.isArray(r.plan)) return null;
    plan = [];
    for (const e of r.plan) {
      if (!e || typeof e !== 'object') return null;
      const x = e as Record<string, unknown>;
      if (typeof x.path !== 'string' || pathNameRefusal(x.path) || !(PLAN_ACTIONS as readonly unknown[]).includes(x.action)) return null;
      plan.push({ path: x.path, action: x.action as PlanEntry['action'], ...(typeof x.reason === 'string' ? { reason: x.reason.slice(0, 80) } : {}) });
    }
  }
  return { v: 1, hash, slug: r.slug as string, preHead: r.preHead as string | null, mergeHead: r.mergeHead as string | null, phase: r.phase as PullPhase, parked, ...(absent ? { absent } : {}), plan, at: r.at as string };
}

/** Write (or advance) the record. Throws when it does not validate or cannot be written. */
export function writePullRecord(home: string, rec: PullRecord): void {
  const ok = validRecord(rec, rec.hash);
  if (!ok) throw new Error('bad pull record (a path, stash, sha or phase is not allowed)');
  writeJsonAtomic(pullRecordPath(home, rec.hash), ok);
}

/** null = no record; `corrupt` = there is one but it cannot be trusted (kept, never applied). */
export function readPullRecord(home: string, hash: string): { ok: true; rec: PullRecord } | { ok: false; corrupt: true } | null {
  let p: string;
  try { p = pullRecordPath(home, hash); } catch { return { ok: false, corrupt: true }; }
  let raw: unknown;
  try {
    raw = readJsonStrict(p);
  } catch { return { ok: false, corrupt: true }; }
  if (raw === null) return null;
  const rec = validRecord(raw, hash);
  return rec ? { ok: true, rec } : { ok: false, corrupt: true };
}

export function removePullRecord(home: string, hash: string): void {
  try { unlinkSync(pullRecordPath(home, hash)); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/** Every record on this Mac (corrupt ones included, as such). */
export function listPullRecords(home: string): { hash: string; read: { ok: true; rec: PullRecord } | { ok: false; corrupt: true } }[] {
  let names: string[];
  try { names = readdirSync(pullDir(home)); } catch { return []; }
  const out: { hash: string; read: { ok: true; rec: PullRecord } | { ok: false; corrupt: true } }[] = [];
  for (const n of names.sort()) {
    if (!n.endsWith('.json')) continue;
    const hash = n.slice(0, -5);
    if (!APP_HASH_RE.test(hash)) continue;
    const read = readPullRecord(home, hash);
    if (read) out.push({ hash, read });
  }
  return out;
}

/**
 * Is this app held for a team pull? The record FILE EXISTS (a symlink or a corrupt one too).
 * Read from disk on every call, never cached, never parsed. Anything but a clean "no such file"
 * answers held (fail closed).
 */
export function appPullHeld(home: string, hash: string): boolean {
  let p: string;
  try { p = pullRecordPath(home, hash); } catch { return true; }
  try { lstatSync(p); return true; } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

// ─── the conflict store ───────────────────────────────────────────────────────────

/**
 * How many LOOSE copies an app keeps: copies nobody has to pick any more (a `local_path` or
 * `not_installed` copy whose path has no open kept-out mark). Never a limit on what still waits:
 * a `conflict` (the team's copy waiting for the owner's pick) and a copy whose path is still
 * marked kept out are never dropped by a count; they leave only when the owner picks or the disk
 * holds the team's copy again. Otherwise a dropped copy would let this Mac's file go out over the
 * team's.
 */
export const CONFLICTS_KEEP = 20;
export type ConflictKind = 'conflict' | 'local_path' | 'not_installed';
export interface ConflictEntry { path: string; storedAt: string; stash: string; kind: ConflictKind }

function readIndex(home: string, hash: string): ConflictEntry[] {
  let raw: unknown;
  try { raw = readJsonStrict(conflictIndexPath(home, hash)); } catch { return []; }
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { entries?: unknown }).entries)) return [];
  const out: ConflictEntry[] = [];
  for (const e of (raw as { entries: unknown[] }).entries) {
    if (!e || typeof e !== 'object') continue;
    const x = e as Record<string, unknown>;
    if (typeof x.path !== 'string' || pathNameRefusal(x.path) || !stashOk(x.stash) || typeof x.storedAt !== 'string') continue;
    if (x.kind !== 'conflict' && x.kind !== 'local_path' && x.kind !== 'not_installed') continue;
    out.push({ path: x.path, storedAt: x.storedAt, stash: x.stash, kind: x.kind });
  }
  return out;
}

function dropStash(home: string, hash: string, stash: string): void {
  const abs = containedPath(conflictDir(home, hash), stash);
  if (abs) try { rmSync(abs, { force: true }); } catch { /* next time */ }
}

/** The stored team copies of this app, newest last. Never throws. */
export function listConflicts(home: string, hash: string): ConflictEntry[] {
  try { return readIndex(home, hash); } catch { return []; }
}

/** Make the folders of `abs` under `base`, every existing step a real folder (no link followed). */
function mkdirsInside(base: string, abs: string): void {
  const root = resolve(base);
  const rel = relative(root, abs).split(sep).slice(0, -1);
  let cur = root;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const part of rel) {
    cur = join(cur, part);
    try { mkdirSync(cur, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const st = lstatSync(cur);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${cur} is not a real folder`);
  }
}

const RESOLVE_TMP_PREFIX = '.dc-resolve-';

/** Remove plain `.dc-resolve-*` files a crashed resolve left in `dir` (links and folders untouched). */
function sweepResolveTemps(dir: string): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!n.startsWith(RESOLVE_TMP_PREFIX)) continue;
    const p = join(dir, n);
    try { if (lstatSync(p).isFile()) unlinkSync(p); } catch { /* gone or not ours */ }
  }
}

/**
 * Keep the team's copy of `relPath` in the store: from a file (`{file}`, a plain file, copied)
 * or bytes (`{data}`). One entry per path (a newer copy replaces the older); of the loose copies
 * the newest {@link CONFLICTS_KEEP} per app are kept, every waiting one is kept.
 */
export function addConflict(home: string, hash: string, relPath: string, kind: ConflictKind, source: { file: string } | { data: Buffer }, nowMs: number = Date.now()): { ok: true; entry: ConflictEntry } | { ok: false; error: string } {
  try { assertAppHash(hash); } catch { return { ok: false, error: 'bad_app' }; }
  if (pathNameRefusal(relPath)) return { ok: false, error: 'bad_path' };
  const stash = `${newStamp(nowMs)}/${relPath}`;
  const base = conflictDir(home, hash);
  const dst = containedPath(base, stash);
  if (!dst) return { ok: false, error: 'bad_path' };
  try {
    mkdirsInside(base, dst);
    if ('file' in source) {
      const st = lstatSync(source.file);
      if (st.isSymbolicLink() || !st.isFile()) return { ok: false, error: 'not_plain' };
      copyFileSync(source.file, dst, constants.COPYFILE_EXCL);
    } else writeFileSync(dst, source.data, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    return { ok: false, error: `store_failed: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` };
  }
  const entry: ConflictEntry = { path: relPath, storedAt: new Date(nowMs).toISOString(), stash, kind };
  const all = readIndex(home, hash);
  const next = [...all.filter((x) => x.path !== relPath), entry];
  // Only loose copies are dropped, oldest first ({@link CONFLICTS_KEEP}); a waiting one never.
  const marked = listKeptOut(home, hash);
  const loose = next.filter((x) => x.kind !== 'conflict' && !marked.has(x.path));
  const drop = new Set(loose.slice(0, Math.max(0, loose.length - CONFLICTS_KEEP)));
  const kept = next.filter((x) => !drop.has(x));
  // The index is written FIRST; a stash leaves disk only once no written index names it.
  try { writeJsonAtomic(conflictIndexPath(home, hash), { entries: kept }); } catch (e) {
    dropStash(home, hash, stash);
    return { ok: false, error: `store_failed: ${(e as Error).message}` };
  }
  for (const old of all.filter((x) => !kept.includes(x))) dropStash(home, hash, old.stash);
  return { ok: true, entry };
}

// ─── team copies kept out of this disk ─────────────────────────────────────────────

/**
 * The paths whose team copy came in while this Mac did not share them (`local_path`,
 * `not_installed`: the pull or install rule took the team's copy off the disk, or left mine in its
 * place). Only the paths, never the bytes, and never capped: the conflict store keeps the newest
 * {@link CONFLICTS_KEEP} copies, but THIS fact must outlive any of them, because it is what tells a
 * later approval that a file here is not the team's (held as two versions, never sent over the
 * team's copy). Written BEFORE the copy is stored, so a store that failed still leaves it.
 */
export function keptOutPath(home: string, hash: string): string {
  return appStateFile(home, 'kept-out', hash);
}

/** The kept-out paths of this app. Never throws (unreadable = none). */
export function listKeptOut(home: string, hash: string): Set<string> {
  let raw: unknown;
  try { raw = readJsonStrict(keptOutPath(home, hash)); } catch { return new Set(); }
  const paths = raw && typeof raw === 'object' ? (raw as { paths?: unknown }).paths : null;
  if (!Array.isArray(paths)) return new Set();
  return new Set(paths.filter((p): p is string => typeof p === 'string' && !pathNameRefusal(p)));
}

function writeKeptOut(home: string, hash: string, next: Set<string>): boolean {
  const p = keptOutPath(home, hash);
  try {
    if (!next.size) { rmSync(p, { force: true }); return true; }
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeJsonAtomic(p, { paths: [...next].sort() });
    return true;
  } catch { return false; }
}

/** Record `paths` as kept out. False when the record could not be written. Never throws. */
export function markKeptOut(home: string, hash: string, paths: readonly string[]): boolean {
  try { assertAppHash(hash); } catch { return false; }
  const all = listKeptOut(home, hash);
  const add = paths.filter((p) => !pathNameRefusal(p) && !all.has(p));
  if (!add.length) return true;
  for (const p of add) all.add(p);
  return writeKeptOut(home, hash, all);
}

/** Forget `paths`: the disk holds the team's copy now, a two-version entry holds them, or the owner picked. Never throws. */
export function clearKeptOut(home: string, hash: string, paths: readonly string[]): void {
  try { assertAppHash(hash); } catch { return; }
  const all = listKeptOut(home, hash);
  let changed = false;
  for (const p of paths) changed = all.delete(p) || changed;
  if (changed) writeKeptOut(home, hash, all);
}

/**
 * Drop the stored entries of `paths` whose kind is one of `kinds` (and their stored copies): a
 * stored team copy that no longer says anything (the disk now holds that same team copy). Index
 * first, then the copies. Returns the paths dropped. Never throws.
 */
export function dropConflictEntries(home: string, hash: string, paths: readonly string[], kinds: readonly ConflictKind[]): string[] {
  try { assertAppHash(hash); } catch { return []; }
  const want = new Set(paths);
  const all = readIndex(home, hash);
  const gone = all.filter((x) => want.has(x.path) && kinds.includes(x.kind));
  if (!gone.length) return [];
  try { writeJsonAtomic(conflictIndexPath(home, hash), { entries: all.filter((x) => !gone.includes(x)) }); } catch { return []; }
  for (const x of gone) dropStash(home, hash, x.stash);
  return gone.map((x) => x.path);
}

/**
 * The owner picked (`apps data resolve <slug> <path> --theirs|--mine --confirm`). `theirs`: the
 * stored copy goes into the data folder (temp + rename); `mine`: the stored copy is dropped.
 * Both remove the entry, so the next outbound stage picks the path up again.
 */
export function resolveConflict(home: string, hash: string, dataDir: string, relPath: string, side: 'theirs' | 'mine'): { ok: true } | { ok: false; error: string } {
  try { assertAppHash(hash); } catch { return { ok: false, error: 'bad_app' }; }
  if (side !== 'theirs' && side !== 'mine') return { ok: false, error: 'bad_side' };
  if (pathNameRefusal(relPath)) return { ok: false, error: 'bad_path' };
  const all = readIndex(home, hash);
  const hit = all.find((x) => x.path === relPath);
  if (!hit) {
    // A path held only by its kept-out mark (no stored copy: the team's file could not be kept):
    // keeping mine is still a pick, and it ends the hold.
    if (side === 'mine' && listKeptOut(home, hash).has(relPath)) { clearKeptOut(home, hash, [relPath]); return { ok: true }; }
    return { ok: false, error: 'no_conflict' };
  }
  const src = containedPath(conflictDir(home, hash), hit.stash);
  if (!src) return { ok: false, error: 'bad_path' };
  if (side === 'theirs') {
    const dst = containedPath(dataDir, relPath);
    if (!dst) return { ok: false, error: 'bad_path' };
    try {
      const st = lstatSync(src);
      if (st.isSymbolicLink() || !st.isFile()) return { ok: false, error: 'stored_copy_missing' };
    } catch { return { ok: false, error: 'stored_copy_missing' }; }
    try {
      const dst0 = lstatSync(dataDir);
      if (dst0.isSymbolicLink() || !dst0.isDirectory()) return { ok: false, error: 'data_folder_not_real' };
    } catch { return { ok: false, error: 'data_folder_not_real' }; }
    // The temp sits beside the target (same volume, so the rename is atomic); one left by a
    // crash would be held `name` forever, so stale `.dc-resolve-*` siblings are swept first.
    const tmp = join(dirname(dst), `${RESOLVE_TMP_PREFIX}${randomBytes(4).toString('hex')}`);
    try {
      mkdirsInside(dataDir, dst);
      sweepResolveTemps(dirname(dst));
      try { if (lstatSync(dst).isSymbolicLink()) rmSync(dst, { force: true }); } catch { /* absent */ }
      copyFileSync(src, tmp, constants.COPYFILE_EXCL);
      renameSync(tmp, dst);
    } catch (e) {
      try { rmSync(tmp, { force: true }); } catch { /* never made */ }
      return { ok: false, error: `write_failed: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` };
    }
  }
  // Index first, then the stored copy: a failed index write leaves the entry AND its copy.
  try { writeJsonAtomic(conflictIndexPath(home, hash), { entries: all.filter((x) => x !== hit) }); } catch (e) {
    return { ok: false, error: `write_failed: ${(e as Error).message}` };
  }
  try { rmSync(src, { force: true }); } catch { /* an unindexed leftover, harmless */ }
  clearKeptOut(home, hash, [relPath]); // the owner picked: from now on an edit here is an edit
  return { ok: true };
}

/** A parked copy's absolute path, contained under the app's park folder; null when not allowed. */
export function parkTarget(home: string, hash: string, stash: string): string | null {
  if (!stashOk(stash)) return null;
  return containedPath(parkDir(home, hash), stash);
}

// ─── moving a team folder's state onto the installed app ───────────────────────────

/**
 * An app installed onto a team folder (Kur, same slug): the per-machine state kept under the team
 * folder's key (`teamHash`, data-stage.ts) moves to the installed app's hash: the conflict index
 * and store, the tombstones and the kept-out paths. Refused while a pull record of either key exists (a pull is
 * open: finish it first) and when the target already has state of its own (never merged over).
 * Lane B calls it from install.ts BEFORE `applyPullRuleForInstall`.
 */
export function rekeyAppState(home: string, fromHash: string, toHash: string): { ok: true; moved: string[] } | { ok: false; reason: 'bad_app' | 'pull_open' | 'target_busy' | 'move_failed' } {
  try { assertAppHash(fromHash); assertAppHash(toHash); } catch { return { ok: false, reason: 'bad_app' }; }
  if (fromHash === toHash) return { ok: true, moved: [] };
  if (appPullHeld(home, fromHash) || appPullHeld(home, toHash)) return { ok: false, reason: 'pull_open' };
  const pairs: { what: string; from: string; to: string }[] = [
    { what: 'conflict index', from: conflictIndexPath(home, fromHash), to: conflictIndexPath(home, toHash) },
    { what: 'conflict store', from: conflictDir(home, fromHash), to: conflictDir(home, toHash) },
    { what: 'tombstones', from: appStateFile(home, 'deletes', fromHash), to: appStateFile(home, 'deletes', toHash) },
    { what: 'kept-out paths', from: keptOutPath(home, fromHash), to: keptOutPath(home, toHash) },
  ];
  const present = pairs.filter((x) => { try { lstatSync(x.from); return true; } catch { return false; } });
  for (const x of present) {
    try { lstatSync(x.to); return { ok: false, reason: 'target_busy' }; } catch { /* free */ }
    if (lstatSync(x.from).isSymbolicLink()) return { ok: false, reason: 'move_failed' };
  }
  const moved: string[] = [];
  for (const x of present) {
    try {
      mkdirSync(dirname(x.to), { recursive: true, mode: 0o700 });
      renameSync(x.from, x.to);
      moved.push(x.what);
    } catch {
      return { ok: false, reason: 'move_failed' };
    }
  }
  return { ok: true, moved };
}
