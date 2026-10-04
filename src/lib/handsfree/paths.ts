/**
 * The SHARED path guard for both hands-free transports (git working-tree writes and the
 * non-git pack apply). Every path that crosses the laptop<->cloud boundary goes through
 * here before anything touches the disk, on BOTH sides.
 *
 * Pure fs + string functions: no server imports, no module state, no assumption about
 * which uid runs them. Every root is passed in by the caller.
 *
 * Rules (task "Shared path guard"):
 *  - posix-relative only; refuse `..`, `.`, empty segments, absolute, NUL, backslash;
 *  - refuse any `.git` segment at any depth after NFC + case-fold, including the variants
 *    HFS+ (Unicode ignorables) and NTFS (trailing dots/spaces, `::$DATA` streams, `git~1`)
 *    would resolve to `.git`;
 *  - collisions across the whole incoming set, and against differently-spelled existing
 *    paths, after NFC + case-fold → conflicts (never a write);
 *  - case-only renames: deletions are ordered before additions;
 *  - symlink targets must resolve inside the root and symlinks are written last;
 *  - at write time every parent dir is lstat-checked to be a real directory whose realpath
 *    is inside the root.
 */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { posix, sep, join, dirname, basename } from 'node:path';

export type PathRefusal =
  | 'empty'
  | 'not_string'
  | 'too_long'
  | 'nul'
  | 'backslash'
  | 'absolute'
  | 'dot_segment'
  | 'dotdot'
  | 'empty_segment'
  | 'dot_git'
  | 'control_char';

export type PathCheck = { ok: true; path: string } | { ok: false; reason: PathRefusal; path: string };

export class PathGuardError extends Error {
  constructor(readonly reason: string, readonly path: string, message?: string) {
    super(message ?? `handsfree path refused (${reason}): ${JSON.stringify(path)}`);
    this.name = 'PathGuardError';
  }
}

const MAX_PATH_CHARS = 4096;

/**
 * Code points HFS+ ignores when comparing names (git's `is_hfs_dotgit` list): a name
 * spelled `.g‌it` IS `.git` on such a volume.
 */
const HFS_IGNORABLE_RE = /[​-‏‪-‮⁠-⁯﻿]/g;

/** NFC + drop HFS ignorables + lower-case: the comparison key for one name. */
export function foldSegment(seg: string): string {
  return seg.normalize('NFC').replace(HFS_IGNORABLE_RE, '').toLowerCase();
}

/** NFC + case-fold for a whole relative path (the collision key). */
export function foldPath(rel: string): string {
  return rel.split('/').map(foldSegment).join('/');
}

/**
 * True when a single segment names `.git` on ANY of the filesystems involved: exact,
 * any case, NFD/NFC, HFS-ignorable code points, NTFS trailing dots/spaces, NTFS
 * alternate data streams (`.git::$INDEX_ALLOCATION`) and the 8.3 short name `git~1`.
 */
export function isDotGitSegment(seg: string): boolean {
  let f = foldSegment(seg);
  const colon = f.indexOf(':');
  if (colon >= 0) f = f.slice(0, colon);
  f = f.replace(/[. ]+$/, '');
  return f === '.git' || f === 'git~1';
}

/** Validate one posix-relative path. Never touches the disk. */
export function checkRelPath(p: unknown): PathCheck {
  if (typeof p !== 'string') return { ok: false, reason: 'not_string', path: String(p) };
  if (p.length === 0) return { ok: false, reason: 'empty', path: p };
  if (p.length > MAX_PATH_CHARS) return { ok: false, reason: 'too_long', path: p };
  if (p.includes('\0')) return { ok: false, reason: 'nul', path: p };
  if (p.includes('\\')) return { ok: false, reason: 'backslash', path: p };
  // eslint-disable-next-line no-control-regex
  if (/[\x01-\x1f\x7f]/.test(p)) return { ok: false, reason: 'control_char', path: p };
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return { ok: false, reason: 'absolute', path: p };
  for (const seg of p.split('/')) {
    if (seg === '') return { ok: false, reason: 'empty_segment', path: p };
    if (seg === '.') return { ok: false, reason: 'dot_segment', path: p };
    if (seg === '..') return { ok: false, reason: 'dotdot', path: p };
    if (isDotGitSegment(seg)) return { ok: false, reason: 'dot_git', path: p };
  }
  return { ok: true, path: p };
}

/** {@link checkRelPath} that throws. */
export function assertRelPath(p: unknown): string {
  const c = checkRelPath(p);
  if (!c.ok) throw new PathGuardError(c.reason, c.path);
  return c.path;
}

/** All proper ancestors of a relative path, shortest first (`a/b/c` → `a`, `a/b`). */
function ancestors(rel: string): string[] {
  const parts = rel.split('/');
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

export interface CollisionResult {
  /** Paths safe to write as spelled. */
  ok: string[];
  /** Paths that must go to the conflicts folder instead, with the reason. */
  conflicts: Map<string, string>;
}

/**
 * Collision check across the WHOLE incoming set and against the receiver's existing
 * paths, after NFC + case-fold. Two incoming paths (or path prefixes) that fold to the
 * same key but are spelled differently both become conflicts; an incoming path that folds
 * onto an existing, differently-spelled path (or directory) that is NOT being deleted in
 * the same set becomes a conflict. A case-only rename (`README.md` deleted, `Readme.md`
 * added) passes because the old spelling is in `deleting`; the caller orders deletions
 * before additions ({@link orderForApply}).
 */
export function detectCollisions(
  incoming: Iterable<string>,
  existing: Iterable<string>,
  deleting: Iterable<string> = [],
): CollisionResult {
  const inc = [...incoming];
  const del = new Set(deleting);
  const conflicts = new Map<string, string>();

  // key → the set of spellings for every incoming path and every incoming ancestor dir.
  const incSpell = new Map<string, Set<string>>();
  const note = (m: Map<string, Set<string>>, spelled: string) => {
    const k = foldPath(spelled);
    let s = m.get(k);
    if (!s) { s = new Set(); m.set(k, s); }
    s.add(spelled);
  };
  for (const p of inc) {
    note(incSpell, p);
    for (const a of ancestors(p)) note(incSpell, a);
  }

  // Existing paths that survive this apply (deleted ones free their spelling).
  const exSpell = new Map<string, Set<string>>();
  for (const p of existing) {
    if (del.has(p)) continue;
    note(exSpell, p);
    for (const a of ancestors(p)) note(exSpell, a);
  }

  for (const p of inc) {
    for (const piece of [...ancestors(p), p]) {
      const k = foldPath(piece);
      const mine = incSpell.get(k)!;
      if (mine.size > 1) {
        conflicts.set(p, `case/normalization collision in incoming set: ${[...mine].join(' | ')}`);
        break;
      }
      const theirs = exSpell.get(k);
      if (theirs && !theirs.has(piece)) {
        conflicts.set(p, `collides with existing ${[...theirs].join(' | ')}`);
        break;
      }
    }
  }
  return { ok: inc.filter((p) => !conflicts.has(p)), conflicts };
}

export type ApplyKind = 'delete' | 'file' | 'symlink';

/** Deletions first (case-only renames), then regular files, then symlinks LAST. */
export function orderForApply<T extends { kind: ApplyKind; path: string }>(ops: T[]): T[] {
  const rank: Record<ApplyKind, number> = { delete: 0, file: 1, symlink: 2 };
  return [...ops].sort((a, b) => rank[a.kind] - rank[b.kind] || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Longest symlink target accepted, in UTF-8 bytes (far below every OS limit). */
export const MAX_LINK_TARGET_BYTES = 1023;

/**
 * D18: an incoming symlink target is accepted ONLY in canonical relative form
 * `(../)*name(/name)*`: zero or more leading `..`, then plain name segments; D19: `.`
 * segments are ignored anywhere (`./x`, `a/./b`, `./../x` = `../x`). Refused: a `..` after
 * a name, empty segments, a target with no name, absolute targets, NUL, backslash, control
 * characters, a `.git` segment, more than {@link MAX_LINK_TARGET_BYTES} bytes. Without a
 * `..` after a name, no target can climb through a link that a LATER apply creates.
 */
export function isCanonicalLinkTarget(target: unknown): target is string {
  if (typeof target !== 'string' || target.length === 0) return false;
  if (Buffer.byteLength(target, 'utf8') > MAX_LINK_TARGET_BYTES) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\\]/.test(target)) return false;
  if (target.startsWith('/') || /^[A-Za-z]:/.test(target)) return false;
  if (target.split('/').some((x) => x === '')) return false; // empty segment (incl. trailing /)
  const segs = target.split('/').filter((x) => x !== '.'); // D19: `.` is a no-op
  let i = 0;
  while (i < segs.length && segs[i] === '..') i++;
  if (i === segs.length) return false; // `..` alone (or only ..s): no name
  for (; i < segs.length; i++) {
    const s = segs[i];
    if (s === '..' || isDotGitSegment(s)) return false;
  }
  return true;
}

/**
 * Write-time check for an incoming symlink at `rel`: canonical form ({@link
 * isCanonicalLinkTarget}) AND lexically inside the root. The physical check
 * ({@link sweepEscapingSymlinks}, {@link resweepRoot}) runs after the writes.
 */
export function symlinkTargetInside(rel: string, target: string): boolean {
  if (!isCanonicalLinkTarget(target)) return false;
  const resolved = posix.normalize(posix.join(posix.dirname(rel), target));
  if (resolved === '..' || resolved.startsWith('../')) return false;
  if (resolved === '.') return true;
  return resolved.split('/').every((s) => !isDotGitSegment(s));
}

/**
 * Resolve an absolute path PHYSICALLY: every existing component is lstat'ed and a symlink
 * is replaced by its target before the next `..` is applied (unlike `path.resolve`, which
 * collapses `link/..` lexically). A missing component ends the physical walk; the rest is
 * appended lexically (a missing name cannot be a symlink). `via` lists every symlink the
 * walk went through (absolute paths); `resolved` is null on a loop.
 */
export function physicalTrace(abs: string): { resolved: string | null; via: string[] } {
  let parts = abs.split('/').filter(Boolean);
  let cur = '/';
  let hops = 0;
  let missing = false;
  const via: string[] = [];
  while (parts.length) {
    const seg = parts.shift()!;
    if (seg === '.') continue;
    if (seg === '..') { cur = dirname(cur); continue; }
    const next = join(cur, seg);
    if (missing) { cur = next; continue; }
    let st;
    try {
      st = lstatSync(next);
    } catch {
      missing = true;
      cur = next;
      continue;
    }
    if (st.isSymbolicLink()) {
      if (++hops > 40) return { resolved: null, via };
      via.push(next);
      const t = readlinkSync(next);
      if (t.startsWith('/')) cur = '/';
      parts = [...t.split('/').filter(Boolean), ...parts];
      continue;
    }
    cur = next;
  }
  try {
    return { resolved: realpathNative(cur), via }; // canonical spelling when it exists
  } catch {
    return { resolved: cur, via };
  }
}

export function physicalResolve(abs: string): string {
  const t = physicalTrace(abs);
  if (t.resolved === null) throw new PathGuardError('symlink_loop', abs, `symlink loop at ${abs}`);
  return t.resolved;
}

/** True when the symlink at `root/rel` resolves (physically, through any chain) outside the root. */
export function symlinkEscapes(root: string, rel: string): boolean {
  const rootReal = realpathNative(root);
  const t = physicalTrace(join(rootReal, ...rel.split('/')));
  return t.resolved === null || !isInside(rootReal, t.resolved); // a loop is never acceptable
}

/**
 * D19: a symlink ON THE SENDER that can never be applied on the other side (target not
 * canonical, lexically outside, or physically resolving outside `root`) does not travel:
 * it stays on the laptop, absent from every manifest/tree, so a Return can never read it as
 * "deleted in the cloud". Both transports ask this before a link leaves.
 */
export const STAYS_HOME_REASON = 'stays on the laptop';

export function linkStaysHome(root: string, rel: string, target: string): boolean {
  if (!symlinkTargetInside(rel, target)) return true;
  try {
    return symlinkEscapes(root, rel);
  } catch {
    return true;
  }
}

function isSymlinkAt(root: string, rel: string): boolean {
  try {
    return lstatSync(join(root, ...rel.split('/'))).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The per-apply physical check for BOTH transports (AC9). After the symlinks of one apply
 * are written, each one is resolved physically; one that lands outside the root is undone
 * via `undo` (restore from backup, or remove a created link) and returned. Repeats until
 * stable, because undoing one link can change where another resolves. Callers run it in a
 * `finally`, so a failed write never skips it. Never throws: a failing undo is reported.
 */
export function sweepEscapingSymlinks(root: string, rels: string[], undo: (rel: string) => void): string[] {
  const escaped: string[] = [];
  let pending = [...rels];
  for (let round = 0; round < rels.length + 1; round++) {
    const bad = pending.filter((rel) => isSymlinkAt(root, rel) && symlinkEscapes(root, rel));
    if (bad.length === 0) break;
    for (const rel of bad) {
      try { undo(rel); } catch { try { rmSync(join(root, ...rel.split('/')), { force: true }); } catch { /* reported */ } }
      escaped.push(rel);
    }
    pending = pending.filter((r) => !bad.includes(r));
  }
  return escaped;
}

/** A link THIS Return wrote (from a backup ledger): it may be undone by {@link resweepRoot}. */
export interface OwnedLink {
  rel: string;
  /** Write order across both transports; the highest is undone first. */
  order: number;
  undo: () => void;
}

export interface ResweepResult {
  /** Links this Return wrote that were undone because a chain through them escaped. */
  undone: string[];
  /** Links that still escape without any link of this Return: reported, never touched. */
  escaping: string[];
}

/**
 * D18 whole-root re-sweep, called once BOTH transports have finished a root at Return.
 * Every symlink of the root (`linkRels`: the 120000 entries of the new worktree tree, the
 * non-git manifest's symlinks, links that predate this trip, plus every `owned` link) is
 * re-checked on disk. For an escaping link, the links of THIS Return on its chain are
 * undone newest first until nothing escapes; an escape whose chain holds none of them is
 * only reported, and the laptop is left untouched.
 */
export function resweepRoot(root: string, linkRels: string[], owned: OwnedLink[]): ResweepResult {
  const rootReal = realpathNative(root);
  const absOf = (rel: string) => join(rootReal, ...rel.split('/'));
  const live = new Map<string, OwnedLink>();
  for (const o of owned) {
    const prev = live.get(absOf(o.rel));
    if (!prev || prev.order < o.order) live.set(absOf(o.rel), o);
  }
  const all = [...new Set([...linkRels, ...owned.map((o) => o.rel)])];
  const undone: string[] = [];
  let escaping: string[] = [];
  for (let round = 0; round <= owned.length + 1; round++) {
    const bad: Array<{ rel: string; via: string[] }> = [];
    for (const rel of all) {
      if (!isSymlinkAt(rootReal, rel)) continue;
      const t = physicalTrace(absOf(rel));
      if (t.resolved !== null && isInside(rootReal, t.resolved)) continue;
      bad.push({ rel, via: t.via });
    }
    escaping = bad.map((b) => b.rel);
    let pick: OwnedLink | null = null;
    for (const b of bad) {
      for (const v of b.via) {
        const o = live.get(v);
        if (o && (!pick || o.order > pick.order)) pick = o;
      }
    }
    if (!pick) break;
    try { pick.undo(); } catch { try { rmSync(absOf(pick.rel), { force: true }); } catch { /* reported below */ } }
    live.delete(absOf(pick.rel));
    undone.push(pick.rel);
  }
  return { undone, escaping };
}

function realpathNative(p: string): string {
  return realpathSync.native(p);
}

function isInside(parentReal: string, childReal: string): boolean {
  return childReal === parentReal || childReal.startsWith(parentReal.endsWith(sep) ? parentReal : parentReal + sep);
}

/**
 * Write-time parent check: every ancestor of `rel` under `root` must be a REAL directory
 * (lstat, never a symlink), spelled exactly as on disk, whose realpath stays inside the
 * root. Missing ancestors are created one by one (each re-checked) when `create` is set.
 * Throws {@link PathGuardError} on any violation. Returns the absolute target path.
 */
export function ensureSafeParents(root: string, rel: string, opts: { create: boolean }): string {
  assertRelPath(rel);
  const rootReal = realpathNative(root);
  const parts = rel.split('/');
  let cur = rootReal;
  for (let i = 0; i < parts.length - 1; i++) {
    const name = parts[i];
    const next = join(cur, name);
    let st;
    try {
      st = lstatSync(next);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      if (!opts.create) return join(rootReal, ...parts);
      mkdirSync(next);
      st = lstatSync(next);
    }
    if (st.isSymbolicLink()) throw new PathGuardError('parent_symlink', rel, `parent ${parts.slice(0, i + 1).join('/')} is a symlink`);
    if (!st.isDirectory()) throw new PathGuardError('parent_not_dir', rel, `parent ${parts.slice(0, i + 1).join('/')} is not a directory`);
    // Exact on-disk spelling (a case-insensitive or normalization-insensitive volume would
    // otherwise route `Foo/x` into an existing `foo/`).
    if (!readdirSync(cur).includes(name)) {
      throw new PathGuardError('parent_spelling', rel, `parent ${parts.slice(0, i + 1).join('/')} exists with a different spelling`);
    }
    const real = realpathNative(next);
    if (!isInside(rootReal, real)) throw new PathGuardError('parent_escapes', rel);
    cur = real;
  }
  return join(cur, parts[parts.length - 1]);
}

/**
 * The final component's on-disk state. `differentSpelling` means something answers lstat
 * under this name but the directory lists it under another spelling (a case-insensitive
 * hit): the caller must treat that as a conflict, never overwrite it.
 */
export function leafState(abs: string): 'absent' | 'file' | 'symlink' | 'dir' | 'other' | 'differentSpelling' {
  let st;
  try {
    st = lstatSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return 'absent';
    throw err;
  }
  if (!readdirSync(dirname(abs)).includes(basename(abs))) return 'differentSpelling';
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isFile()) return 'file';
  if (st.isDirectory()) return 'dir';
  return 'other';
}

/**
 * A free destination for a conflict copy of `rel` under `dir`: `rel` itself when nothing
 * answers there, else `rel~cloud-N`. Two incoming spellings that fold together (A.txt /
 * a.txt) must both survive in conflicts/ on a case-insensitive volume.
 */
export function freeConflictTarget(dir: string, rel: string): string {
  // A parent of `rel` may already be a FILE in conflicts/ (the cloud sent `x` and `x/y`):
  // fall back to one flat name so the copy is still kept.
  const flat = rel.split('/').join('%2F');
  for (const base of rel === flat ? [rel] : [rel, flat]) {
    for (let n = 0; n < 1000; n++) {
      const candidate = n === 0 ? base : `${base}~cloud-${n}`;
      let abs: string;
      try {
        abs = ensureSafeParents(dir, candidate, { create: true });
      } catch (err) {
        if (err instanceof PathGuardError && base !== flat) break;
        throw err;
      }
      if (leafState(abs) === 'absent') return abs;
    }
  }
  throw new PathGuardError('conflict_target', rel, `no free conflict name for ${rel}`);
}

/** Temp sibling name for temp+rename writes (never collides with a real name we accept). */
export function tempSibling(abs: string): string {
  return join(dirname(abs), `.${basename(abs).slice(0, 64)}.hf-${randomBytes(6).toString('hex')}.tmp`);
}

/** Durable small-file write: temp + fsync + rename (+ best-effort dir fsync). */
export function atomicWriteFile(abs: string, data: string | Buffer, mode = 0o600): void {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = tempSibling(abs);
  const fd = openSync(tmp, 'wx', mode);
  try {
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, abs);
  fsyncDir(dirname(abs));
}

export function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* not supported everywhere */ }
}
