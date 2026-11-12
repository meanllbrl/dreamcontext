/**
 * Which of an app's data goes to the team (app-veri-ortak plan r6, K1, K3, K4). THE single source
 * of the rule: the exchange layer (data-exchange.ts), the push and pull gates, the Apps page and
 * the SDK all ask this module and nothing else.
 *
 *  - K1: the manifest's `data: {shared: [{path, why}], local: [{path, why}]}`, parsed by
 *    {@link parseDataDecl}. Absent = "undecided": nothing is shared (the old behaviour).
 *  - K3: the shared set = declared `shared` ∩ owner-approved − `local` − owner-excluded, and only
 *    while the brain is `full-repo` with cloud sync on ({@link brainShareMode}).
 *  - K4: {@link shareRefusal}, the one rule a single file passes at stage, push and pull alike.
 *
 * Hand-made data (emekle üretilmiş veri) is shared; re-fetchable cache, personal and secret data
 * stay on this Mac. Nothing here touches git or writes a file.
 */

import { closeSync, lstatSync, openSync, readdirSync, readSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { readSetupConfig } from '../setup-config.js';
import { resolveBrainSyncEnabled, resolveMode } from '../git-sync/brain-repo.js';
import { appDataDir, checkAppDataChain, isInstructionName, foldName } from './data-dir.js';
import type { AppRecord } from './registry.js';
import type { Consent } from './data-consent.js';
import { listConflicts, listKeptOut } from './data-conflicts.js';

// ─── types and limits ──────────────────────────────────────────────────────────────

export interface DataEntry { path: string; why: string }
export interface DataDecl { shared: DataEntry[]; local: DataEntry[] }
/** Why a file stays on this Mac. Our own size is never one (owner, 2026-11-12): shared data of
 *  any size goes, and a large app only gets a warning ({@link SHARED_WARN_BYTES}). `host_limit` is
 *  the git host's, not ours: one file over {@link HOST_FILE_MAX_BYTES} would make every later
 *  brain push fail, so that one file stays here and everything else keeps syncing. */
export type HeldReason = 'db_file' | 'name' | 'not_plain' | 'writing' | 'not_approved_here' | 'conflict' | 'host_limit';
export interface Held { path: string; reason: HeldReason }
export type DataMode = 'shared' | 'local' | 'undecided' | 'pending' | 'sync_off';

export const HELD_REASONS: readonly HeldReason[] = ['db_file', 'name', 'not_plain', 'writing', 'not_approved_here', 'conflict', 'host_limit'];
/** At most this many entries per list (`shared`, `local`) and per consent array. */
export const DATA_MAX_ENTRIES = 20;
export const DATA_WHY_MAX = 120;
/**
 * One request of the app SDK's `/__dc/data` read and write (a JSON body held in memory). Only a
 * bound of that HTTP route: never a rule of what the team sync sends or takes in.
 */
export const SDK_FILE_MAX_BYTES = 5 * 1024 * 1024;
/**
 * Above this, an app's shared data (the team's copy as the next sync leaves it) is LARGE: it still
 * syncs in full, and the Apps page and the CLI say it slows every teammate's sync. A warning, never
 * a refusal (owner, 2026-11-12: no size limit on shared app data).
 */
export const SHARED_WARN_BYTES = 25 * 1024 * 1024;
/**
 * GitHub refuses any push carrying a single file over 100 MB (GH001), and the refused commit would
 * then stop every later brain push of this Mac. Not a limit of ours: the one file over it stays on
 * this Mac (`host_limit`), the rest of the app and the brain keep syncing.
 */
export const HOST_FILE_MAX_BYTES = 100 * 1024 * 1024;
/** A file written less than this long ago is left for the next sync (it may be mid-write). */
export const WRITING_SETTLE_MS = 3000;
const DECL_PATH_MAX = 200;
const WALK_MAX_DEPTH = 12;
const WALK_MAX_ENTRIES = 10_000;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// ─── K1: the declaration ───────────────────────────────────────────────────────────

/** The error code of a declared path, or null when it is fine. */
export type DeclPathError = 'not_string' | 'empty' | 'too_long' | 'absolute' | 'backslash' | 'control' | 'dotdot' | 'globstar' | 'dotted' | 'empty_part' | 'bad_glob';

const GLOB_LAST_RE = /^\*\.[A-Za-z0-9_-]{1,16}$/;

/**
 * A declared path, relative to the app's data folder: a folder `x/` (nested allowed), a file
 * `x.json`, or `*.ext` one level inside a folder (`dir/*.json`, or `*.json` at the top). No
 * absolute path, no `..`, no `**`, no part starting with a dot. Shared by the manifest parser
 * and the owner's consent route.
 */
export function validateDeclPath(p: unknown): DeclPathError | null {
  if (typeof p !== 'string') return 'not_string';
  if (!p.length) return 'empty';
  if (p.length > DECL_PATH_MAX) return 'too_long';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'absolute';
  if (p.includes('\\')) return 'backslash';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return 'control';
  if (p.includes('**')) return 'globstar';
  const parts = (p.endsWith('/') ? p.slice(0, -1) : p).split('/');
  for (const [i, part] of parts.entries()) {
    if (!part) return 'empty_part';
    if (part === '..') return 'dotdot';
    if (part.startsWith('.')) return 'dotted';
    const last = i === parts.length - 1;
    if (/[*?[\]{}]/.test(part)) {
      if (!last || p.endsWith('/') || !GLOB_LAST_RE.test(part)) return 'bad_glob';
    }
  }
  return null;
}

/** Control, zero-width, bidi and line/paragraph separator code points (by number: no invisible
 *  character ever sits in this source). */
function isInvisible(c: number): boolean {
  return c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0x2028 || c === 0x2029;
}

/** One clean line: invisible characters become spaces, runs of space collapse. */
function oneLine(s: string): string {
  return Array.from(s, (ch) => (isInvisible(ch.codePointAt(0) ?? 0) ? ' ' : ch)).join('').replace(/\s+/g, ' ').trim();
}

function parseList(raw: unknown, field: 'shared' | 'local', errors: string[]): DataEntry[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) { errors.push(`data.${field}: not a list`); return []; }
  if (raw.length > DATA_MAX_ENTRIES) errors.push(`data.${field}: more than ${DATA_MAX_ENTRIES} entries`);
  const out: DataEntry[] = [];
  raw.slice(0, DATA_MAX_ENTRIES).forEach((e, i) => {
    const f = `data.${field}[${i}]`;
    if (!isObj(e)) { errors.push(`${f}: not {"path","why"}`); return; }
    const bad = validateDeclPath(e.path);
    if (bad) { errors.push(`${f}.path: ${bad}`); return; }
    if (typeof e.why !== 'string' || !e.why.trim()) { errors.push(`${f}.why: missing`); return; }
    if (Array.from(e.why).length > DATA_WHY_MAX) { errors.push(`${f}.why: longer than ${DATA_WHY_MAX} characters`); return; }
    const why = oneLine(e.why);
    const path = e.path as string;
    if (out.some((x) => x.path === path)) { errors.push(`${f}.path: duplicate "${path}"`); return; }
    out.push({ path, why });
  });
  return out;
}

/**
 * The manifest's `data` field. `decl: null` = the field is absent ("undecided"); `shared: []` is
 * a valid decision. Errors are one line each, `<field>: <problem>`.
 */
export function parseDataDecl(raw: unknown): { ok: true; decl: DataDecl | null } | { ok: false; errors: string[] } {
  if (raw === undefined || raw === null) return { ok: true, decl: null };
  if (!isObj(raw)) return { ok: false, errors: ['data: not {"shared": [...], "local": [...]}'] };
  const errors: string[] = [];
  for (const k of Object.keys(raw)) if (k !== 'shared' && k !== 'local') errors.push(`data.${k}: unknown field`);
  const shared = parseList(raw.shared, 'shared', errors);
  const local = parseList(raw.local, 'local', errors);
  if (errors.length) return { ok: false, errors };
  return { ok: true, decl: { shared, local } };
}

/** Does the declared path cover `relPath` (a file path, `/`-separated)? */
export function declMatches(declPath: string, relPath: string): boolean {
  if (declPath.endsWith('/')) return relPath.startsWith(declPath) && relPath.length > declPath.length;
  const star = declPath.lastIndexOf('*');
  if (star >= 0) {
    const dir = declPath.slice(0, star); // '' or 'dir/'
    const ext = declPath.slice(star + 1); // '.json'
    if (!relPath.startsWith(dir)) return false;
    const rest = relPath.slice(dir.length);
    return !rest.includes('/') && rest.length > ext.length && rest.endsWith(ext);
  }
  return relPath === declPath;
}

// ─── K4: one file through the gate ─────────────────────────────────────────────────

/** What {@link shareRefusal} reads of a file: an `fs.Stats` fits, so does a blob's description. */
export type ShareStat = Pick<Stats, 'size'> & Partial<Pick<Stats, 'nlink' | 'mtimeMs'>> & { isFile(): boolean; isSymbolicLink(): boolean };

const DB_SUFFIXES = ['.db', '.sqlite', '.sqlite3', '-wal', '-shm', '-journal'];
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

/**
 * The name half of K4, for any path a write would build: every part non-empty, not `.`/`..`, not
 * dotted (so not `.env*`), not an instruction name (CLAUDE.md, AGENTS.md, …, NFKC folded).
 */
export function pathNameRefusal(relPath: string): 'name' | null {
  if (typeof relPath !== 'string' || !relPath || relPath.length > 1024 || relPath.startsWith('/') || relPath.includes('\\') || relPath.includes('\0')) return 'name';
  const parts = relPath.split('/');
  for (const [i, part] of parts.entries()) {
    if (!part || part === '.' || part === '..') return 'name';
    const folded = foldName(part);
    if (part.startsWith('.') || folded.startsWith('.')) return 'name';
    if (isInstructionName(part, i < parts.length - 1)) return 'name';
  }
  return null;
}

export function isDbName(relPath: string): boolean {
  const n = foldName(relPath.split('/').pop() ?? '');
  return DB_SUFFIXES.some((s) => n.endsWith(s));
}

export function isSqliteHead(head16: Buffer | null | undefined): boolean {
  return !!head16 && head16.length >= SQLITE_MAGIC.length && head16.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC);
}

/**
 * K4 for one file: null = it may go; else why not. `st: null` = no stat at hand (a blob checked
 * by name and head only; the caller checks mode and size itself). `opts.stage` adds the
 * stage-only checks: hard links (`nlink > 1`) and a write younger than {@link WRITING_SETTLE_MS}.
 */
export function shareRefusal(relPath: string, st: ShareStat | null, head16: Buffer | null, opts: { stage?: boolean; nowMs?: number } = {}): HeldReason | null {
  if (pathNameRefusal(relPath)) return 'name';
  if (st) {
    if (st.isSymbolicLink() || !st.isFile()) return 'not_plain';
    if (opts.stage && (st.nlink ?? 1) > 1) return 'not_plain';
  }
  if (isDbName(relPath) || isSqliteHead(head16)) return 'db_file';
  if (st && st.size > HOST_FILE_MAX_BYTES) return 'host_limit';
  if (st && opts.stage && typeof st.mtimeMs === 'number' && (opts.nowMs ?? Date.now()) - st.mtimeMs < WRITING_SETTLE_MS) return 'writing';
  return null;
}

/**
 * The size of an app's shared data as the team holds it once this Mac's next sync went: every
 * team file (`teamFiles`, HEAD's sizes) with this Mac's shared copies (`mine`) over the same path,
 * plus this Mac's new ones. Feeds the LARGE warning only, never a refusal.
 */
export function teamSharedBytes(teamFiles: readonly { rel: string; size: number }[], mine: readonly { rel: string; size: number }[]): number {
  const by = new Map<string, number>();
  for (const f of teamFiles) by.set(f.rel, f.size);
  for (const f of mine) by.set(f.rel, f.size);
  let n = 0;
  for (const v of by.values()) n += v;
  return n;
}

/** The one sentence a LARGE app gets in the CLI (sync, `apps data`). */
export function largeDataLine(name: string, bytes: number): string {
  return `${name}: its shared data is large (${(bytes / 1024 / 1024).toFixed(1)} MB for the team). It all syncs, but every teammate downloads it, so team sync gets slower. Keep images, exports and re-fetchable data in a local folder.`;
}

// ─── the mode condition (K5) ───────────────────────────────────────────────────────

/** Team data moves only in a `full-repo` brain with cloud sync on. Never throws (off on error). */
export function brainShareMode(projectRoot: string): { fullRepo: boolean; cloudSyncOn: boolean } {
  try {
    const config = readSetupConfig(projectRoot);
    return { fullRepo: resolveMode(config) === 'full-repo', cloudSyncOn: resolveBrainSyncEnabled(projectRoot, config).enabled };
  } catch {
    return { fullRepo: false, cloudSyncOn: false };
  }
}

// ─── K3: the shared set ────────────────────────────────────────────────────────────

/** Declared shared paths the owner has neither approved nor excluded (nothing after a decline). */
export function pendingApprovalOf(decl: DataDecl | null, consent: Consent | null): string[] {
  if (!decl) return [];
  if (consent?.declined) return [];
  const approved = new Set(consent?.approved ?? []);
  const excluded = new Set(consent?.excluded ?? []);
  return decl.shared.map((e) => e.path).filter((p) => !approved.has(p) && !excluded.has(p));
}

export interface SharedSetDeps {
  /** Instead of reading the brain's config. */
  mode?: { fullRepo: boolean; cloudSyncOn: boolean };
  /** Instead of `appDataDir(projectRoot, slug)` (and its chain check). */
  dataDir?: string;
  nowMs?: number;
  /** Paths held as `conflict`; default: the conflict store's `conflict` entries. */
  conflicts?: string[];
}

export interface SharedSetResult {
  mode: DataMode;
  paths: string[];
  /** Each of `paths` with its size on disk now. */
  sizes: { rel: string; size: number }[];
  held: Held[];
  bytes: number;
  /** Declared shared paths neither approved nor excluded (empty after a decline or when undecided). */
  pending: string[];
}

function readHead16(abs: string): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(abs, 'r');
    const b = Buffer.alloc(16);
    const n = readSync(fd, b, 0, 16, 0);
    return b.subarray(0, n);
  } catch { return null; } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* closed */ }
  }
}

/** Every non-folder entry under `dir`, relative and `/`-separated; links are listed, never followed. */
function walkFiles(dir: string): { rel: string; abs: string; st: Stats }[] {
  const out: { rel: string; abs: string; st: Stats }[] = [];
  let seen = 0;
  const walk = (d: string, prefix: string, depth: number): void => {
    let names: string[];
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const name of names) {
      if (++seen > WALK_MAX_ENTRIES) return;
      const abs = join(d, name);
      let st: Stats;
      try { st = lstatSync(abs); } catch { continue; }
      const rel = prefix + name;
      if (st.isDirectory()) { if (depth < WALK_MAX_DEPTH) walk(abs, `${rel}/`, depth + 1); continue; }
      out.push({ rel, abs, st });
    }
  };
  walk(dir, '', 1);
  return out;
}

/**
 * What would go to the team from this app NOW, and what is held back with why. Precedence:
 * owner-excluded > `local` > `shared`; an unlisted path is local; an approval counts only for a
 * declared `shared` path. A declared-shared file the owner has not approved is held
 * `not_approved_here`.
 *
 * `mode` is the truth about what is shared NOW, first match wins: `sync_off` (not full-repo or
 * cloud sync off, nothing goes) > `undecided` (no declaration) > `shared` (at least one approved,
 * not excluded shared path and no decline: the set is live even when every file is held) >
 * `pending` (nothing approved yet, a declared shared path awaits the owner) > `local`. The paths
 * still awaiting approval are `pending`, apart from the mode, so the Apps page can ask about a
 * newly declared path while the mode stays `shared`.
 */
export function sharedSet(ctx: { projectRoot: string; home: string }, rec: AppRecord | null, decl: DataDecl | null, consent: Consent | null, deps: SharedSetDeps = {}): SharedSetResult {
  const pending = pendingApprovalOf(decl, consent);
  const m = deps.mode ?? brainShareMode(ctx.projectRoot);
  if (!m.fullRepo || !m.cloudSyncOn) return { mode: 'sync_off', paths: [], sizes: [], held: [], bytes: 0, pending };
  if (!decl) return { mode: 'undecided', paths: [], sizes: [], held: [], bytes: 0, pending: [] };
  const sharedPaths = new Set(decl.shared.map((e) => e.path));
  const excluded = consent?.excluded ?? [];
  const approved = (consent?.approved ?? []).filter((p) => sharedPaths.has(p));
  const declined = consent?.declined === true;
  const live = !declined && approved.some((p) => !excluded.includes(p));
  const mode: DataMode = live ? 'shared' : pending.length ? 'pending' : 'local';
  const none = (): SharedSetResult => ({ mode, paths: [], sizes: [], held: [], bytes: 0, pending });
  if (!rec) return none();

  let dir = deps.dataDir;
  if (!dir) {
    if (!checkAppDataChain(ctx.projectRoot, rec.slug).ok) return none();
    try { dir = appDataDir(ctx.projectRoot, rec.slug); } catch { return none(); }
  }
  let conflicts: Set<string>;
  if (deps.conflicts) conflicts = new Set(deps.conflicts);
  else {
    // Held as two versions: a stored `conflict`, and a path whose team copy came in while it was
    // not shared here (kept out) that the late-approval restore has not settled yet. A missing
    // stored copy must never turn into a send over the team's.
    try { conflicts = new Set(listConflicts(ctx.home, rec.hash).filter((c) => c.kind === 'conflict').map((c) => c.path)); } catch { conflicts = new Set(); }
    for (const p of listKeptOut(ctx.home, rec.hash)) conflicts.add(p);
  }
  const nowMs = deps.nowMs ?? Date.now();
  const held: Held[] = [];
  const sizes: { rel: string; size: number }[] = [];
  for (const f of walkFiles(dir)) {
    if (excluded.some((x) => declMatches(x, f.rel))) continue;
    if (decl.local.some((x) => declMatches(x.path, f.rel))) continue;
    const covering = decl.shared.filter((x) => declMatches(x.path, f.rel));
    if (!covering.length) continue;
    if (declined || !covering.some((x) => approved.includes(x.path))) { held.push({ path: f.rel, reason: 'not_approved_here' }); continue; }
    if (conflicts.has(f.rel)) { held.push({ path: f.rel, reason: 'conflict' }); continue; }
    const head = f.st.isFile() ? readHead16(f.abs) : null;
    const why = shareRefusal(f.rel, f.st, head, { stage: true, nowMs });
    if (why) { held.push({ path: f.rel, reason: why }); continue; }
    sizes.push({ rel: f.rel, size: f.st.size });
  }
  return { mode, paths: sizes.map((x) => x.rel), sizes, held, bytes: sizes.reduce((n, x) => n + x.size, 0), pending };
}
