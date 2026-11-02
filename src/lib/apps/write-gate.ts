/**
 * The file gate of an app chat (plan-veri r3, K1): a PreToolUse hook on the file tools, for the
 * app's own assistant AND a bound AI Team member. A write lands only inside the app's own data
 * folder (`_dream_context/apps/<slug>/`); a read or search never reaches another app's data.
 *
 * The gate judges the RESOURCE, not the input's spelling. Three security rounds each found a new
 * spelling (a search above `apps/`, an absolute glob, a trailing space, `~/`, a wildcard-first
 * pattern) because the old gate re-derived how Claude Code would read the input and let through
 * whatever it did not recognise. Now:
 *
 * 1. An input is used only in its canonical form: absolute, no `.`/`..` segment, no `//`, no
 *    `~`, no control, format or non-ASCII space character, no segment that starts or ends with a
 *    space, no backslash (on POSIX). Anything else is refused, never normalised: there is then
 *    no second reading of it for a tool to take.
 * 2. Every path is judged by what it IS on disk: `realpath` of it (or of its nearest existing
 *    ancestor), plus its lexical form, against the identity of protected data: any folder at
 *    `_dream_context/apps/<x>` that is not this chat's own, the `apps` folder itself, and
 *    `~/.dreamcontext/apps` (old data, backups, findings).
 * 3. A search (Grep, Glob, a Read of a folder) is judged by the tree it would walk: the gate walks
 *    that tree itself (lstat, links resolved and followed as if the tool followed them) and
 *    refuses when anything protected is reachable, or when the tree is too big to prove clean.
 *    A search always walks its whole `path` (Claude Code rewrites a relative pattern before
 *    `rg` runs); an absolute pattern adds its literal prefix, and with `..` and rooted
 *    alternatives refused no expansion can leave that prefix.
 * 5. Protected folders are also known by file identity (dev:ino), so a second name of the disk
 *    (macOS `/System/Volumes/Data/...`, `/.vol`) is refused even where `realpath` keeps it.
 * 4. Inside the own data folder no symlink is accepted, on any path.
 *
 * It answers `{}` or `deny`, never `allow`: a pass leaves the verdict to the permission rules.
 */

import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, win32 } from 'node:path';
import type { BashGateContext, BashGateDecision } from './bash-gate.js';
import { APPS_DATA_FOLDER, checkAppDataChain, foldName, isInstructionName, WRITE_REFUSED_NAMES } from './data-dir.js';

export const WRITE_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
export const READ_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob'];
export const FILE_GATE_MATCHER = [...WRITE_TOOLS, ...READ_TOOLS].join('|');

/** A search walks at most this many entries or this long before it counts as unprovable (tests lower it). */
export const WALK_LIMITS = { entries: 50_000, ms: 4_000 };

const WIN = process.platform === 'win32';
const P = WIN ? win32 : posix;
const CONTEXT_FOLDER = '_dream_context';

const deny = (reason: string): BashGateDecision => ({ decision: 'deny', reason });
const PASS: BashGateDecision = { decision: 'pass' };

// ─── 1. canonical input ─────────────────────────────────────────────────────────────

// Control, format (zero-width, bidi), and every space character but the plain one.
// eslint-disable-next-line no-control-regex
const ODD_CHAR = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]|(?! )\p{Zs}/u;

/**
 * macOS gives the data volume a second name (`/System/Volumes/Data/Users/...` is `/Users/...`, a
 * firmlink `realpath` does not undo) and `/.vol/<dev>/<ino>` names any file by number. Neither
 * spelling is ever needed: refused as input and as a resolved path.
 */
function aliasSpelling(p: string): boolean {
  if (process.platform !== 'darwin') return false;
  const f = foldName(p);
  return f.startsWith('/system/volumes/') || f === '/system/volumes' || f.startsWith('/.vol/') || f === '/.vol';
}

function segmentsOf(p: string): string[] {
  return WIN ? p.split(/[\\/]/) : p.split('/');
}

/** Why `raw` is not a canonical absolute path, or null when it is. */
export function canonicalProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return 'no path given';
  if (raw.length > 4096) return 'the path is too long';
  if (ODD_CHAR.test(raw)) return 'the path holds a control, invisible or unusual space character';
  if (!WIN && raw.includes('\\')) return 'the path holds a backslash';
  if (!P.isAbsolute(raw)) return 'the path is not absolute (no `~`, no relative path)';
  if (aliasSpelling(raw)) return 'the path goes through a second name of the disk (`/System/Volumes`, `/.vol`)';
  // segs[0] is '' (the POSIX root) or the drive; one trailing separator leaves a last ''.
  const body = segmentsOf(raw).slice(1);
  if (body.length && body[body.length - 1] === '') body.pop();
  for (const s of body) {
    if (s === '') return 'the path holds an empty segment (`//`)';
    if (s === '.' || s === '..') return 'the path holds a `.` or `..` segment';
    if (s !== s.trim()) return 'a part of the path starts or ends with a space';
  }
  return null;
}

/** The canonical path without a trailing separator. Call only after {@link canonicalProblem}. */
function clean(raw: string): string {
  return raw.length > 1 && /[\\/]$/.test(raw) && !/^[A-Za-z]:[\\/]$/.test(raw) ? raw.slice(0, -1) : raw;
}

// ─── 2. what a path is ──────────────────────────────────────────────────────────────

/** realpath of the nearest existing ancestor, the rest appended: a path that does not exist yet. */
function realNear(p: string): string {
  try { return realpathSync.native(p); } catch { /* not there yet */ }
  const parent = dirname(p);
  return parent === p ? p : join(realNear(parent), basename(p));
}

function foldedInside(root: string, p: string): boolean {
  const r = relative(foldName(root), foldName(p));
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
}
const foldedAtOrInside = (root: string, p: string): boolean => foldName(root) === foldName(p) || foldedInside(root, p);

/** What the gate knows about this chat's place, made once per call. */
interface Scope {
  slug: string;
  /** This project's root, lexical (as recorded) and real. */
  projectRoots: string[];
  /** This chat's own data folder, as recorded (the canonical spelling the chat was given). */
  ownDir: string | null;
  ownReal: string | null;
  /** `~/.dreamcontext/apps` for every home this process can name, lexical and real. */
  homeApps: string[];
  /** This project's `_dream_context/apps`, lexical and real: the fast refusal of an ancestor. */
  appsRoots: string[];
  /** File identities (dev:ino) of the protected folders and of the own folder: a second spelling still has them. */
  protectedIds: Set<string>;
  ownId: string | null;
}

function idOf(p: string): string | null {
  try { const st = statSync(p, { bigint: true }); return `${st.dev}:${st.ino}`; } catch { return null; }
}

function makeScope(ctx: BashGateContext): Scope {
  const homes = [...new Set([ctx.home, homedir()].filter((h): h is string => typeof h === 'string' && isAbsolute(h)))];
  const homeApps = homes.flatMap((h) => { const a = join(h, '.dreamcontext', 'apps'); return [a, realNear(a)]; });
  const projectRoots = ctx.projectRoot ? [...new Set([ctx.projectRoot, realNear(ctx.projectRoot)])] : [];
  let ownDir: string | null = null; let ownReal: string | null = null;
  if (ctx.projectRoot && checkAppDataChain(ctx.projectRoot, ctx.slug).ok) {
    ownDir = ctx.dataDir;
    try { ownReal = realpathSync.native(ctx.dataDir); } catch { ownReal = null; }
  }
  const appsRoots = projectRoots.flatMap((r) => { const a = join(r, CONTEXT_FOLDER, APPS_DATA_FOLDER); return [a, realNear(a)]; });
  const protectedIds = new Set([...homeApps, ...appsRoots].map(idOf).filter((id): id is string => id !== null));
  const ownId = ownReal ? idOf(ownReal) : null;
  return { slug: ctx.slug, projectRoots, ownDir, ownReal, homeApps: [...new Set(homeApps)], appsRoots: [...new Set(appsRoots)], protectedIds, ownId };
}

type Area = 'own' | 'other' | 'free';

/**
 * The identity of one spelling of a path. `other` = inside protected data: any
 * `_dream_context/apps` folder itself or a slug folder in it that is not this chat's own, or
 * `~/.dreamcontext/apps`. `own` = inside this project's own slug folder. Folded (NFC, lower case):
 * an over-match only refuses more.
 */
function areaOf(p: string, s: Scope): Area {
  if (s.homeApps.some((h) => foldedAtOrInside(h, p))) return 'other';
  const segs = segmentsOf(p).map(foldName);
  const ctxF = foldName(CONTEXT_FOLDER); const appsF = foldName(APPS_DATA_FOLDER); const slugF = foldName(s.slug);
  let own = false;
  for (let i = 0; i + 1 < segs.length; i++) {
    if (segs[i] !== ctxF || segs[i + 1] !== appsF) continue;
    const slug = segs[i + 2];
    const prefix = segs.slice(0, i).join('/');
    const isThisProject = s.projectRoots.some((r) => segmentsOf(r).map(foldName).join('/') === prefix);
    if (slug === undefined || slug === '' || !isThisProject || slug !== slugF) return 'other';
    own = true;
  }
  return own ? 'own' : 'free';
}

/**
 * The same question asked of the disk, not the spelling: walk up from `real` and compare each
 * existing folder's identity. The own folder met first = own; a protected folder met first = other.
 */
function identityArea(real: string, s: Scope): Area {
  if (aliasSpelling(real)) return 'other';
  let cur = real;
  for (;;) {
    const id = idOf(cur);
    if (id !== null) {
      if (id === s.ownId) return 'own';
      if (s.protectedIds.has(id)) return 'other';
    }
    const up = dirname(cur);
    if (up === cur) return 'free';
    cur = up;
  }
}

/**
 * A path inside the own folder may be used only through the folder as the chat was given it,
 * with no link anywhere on the way: its real path must be exactly `realOwn + the same tail`.
 */
function ownPathProblem(lex: string, real: string, s: Scope, exactPrefix: boolean): string | null {
  if (!s.ownDir || !s.ownReal) return 'this app\'s data folder is missing, or a step of it is a symlink';
  if (exactPrefix ? lex !== s.ownDir && !lex.startsWith(s.ownDir + P.sep) : !foldedAtOrInside(s.ownDir, lex)) {
    return `use this app's data folder as given, ${s.ownDir}`;
  }
  const tail = relative(foldName(s.ownDir), foldName(lex));
  if (foldName(real) !== foldName(tail ? join(s.ownReal, tail) : s.ownReal)) return 'a step of the path is a symlink';
  try { if (lstatSync(lex).isSymbolicLink()) return 'the target is a symlink'; } catch { /* not there yet */ }
  return null;
}

// ─── 3. what a search walks ─────────────────────────────────────────────────────────

/**
 * Walk the tree a search rooted at `root` (canonical, absolute) could read, as if the tool
 * followed every link. Refuse when protected data is reachable, a link sits inside the own
 * folder, or the tree is too big to prove clean.
 */
function judgeSearchRoot(root: string, s: Scope, given: string): BashGateDecision {
  const real = realNear(root);
  const areas = [areaOf(root, s), areaOf(real, s), identityArea(real, s)];
  if (areas.includes('other')) return deny(`Not searched: ${given} is another app's data (or every app's).`);
  if (areas.includes('own')) {
    const problem = ownPathProblem(root, real, s, false);
    if (problem) return deny(`Not searched: ${problem}.`);
  }
  const holdsProtected = (p: string) => [...s.appsRoots, ...s.homeApps].some((a) => foldedAtOrInside(p, a));
  if (holdsProtected(root) || holdsProtected(real)) {
    return deny(`Not searched: ${given} holds every app's data. Search inside this app's data folder (${s.ownDir ?? 'its data folder'}) or a folder that holds no app data.`);
  }
  let st;
  try { st = lstatSync(real); } catch { return PASS; } // nothing there: nothing to read
  if (!st.isDirectory()) return PASS;

  const started = Date.now();
  let seen = 0;
  const visited = new Set<string>([real]);
  const stack = [real];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; } // unreadable for the tool too
    for (const e of entries) {
      if (++seen > WALK_LIMITS.entries || Date.now() - started > WALK_LIMITS.ms) {
        return deny(`Not searched: ${given} is too big to check for app data. Search a narrower folder.`);
      }
      const p = join(dir, e.name);
      const area = areaOf(p, s);
      if (area === 'other') return deny(`Not searched: ${given} holds another app's data (${p}).`);
      if (e.isSymbolicLink()) {
        if (area === 'own') return deny(`Not searched: this app's data folder holds a symlink (${p}).`);
        let target: string;
        try { target = realpathSync.native(p); } catch { continue; } // dangling: reaches nothing
        const tArea = areaOf(target, s);
        if (tArea === 'other' || holdsProtected(target) || identityArea(target, s) === 'other') return deny(`Not searched: ${p} links to app data.`);
        let tst;
        try { tst = lstatSync(target); } catch { continue; }
        if (tst.isDirectory() && !visited.has(target)) { visited.add(target); stack.push(target); }
        continue;
      }
      if (e.isDirectory() && !visited.has(p)) {
        const id = idOf(p);
        if (id !== null && s.protectedIds.has(id)) return deny(`Not searched: ${given} holds app data (${p}).`);
        visited.add(p); stack.push(p);
      }
    }
  }
  return PASS;
}

// ─── globs ──────────────────────────────────────────────────────────────────────────

const GLOB_META = /[*?[\]{}()!+@\\]/;

/** Why a glob pattern cannot be bounded to a definite tree, or null. */
export function patternProblem(pattern: string): string | null {
  if (pattern.length === 0 || pattern.length > 4096) return 'an empty or too long pattern';
  if (ODD_CHAR.test(pattern)) return 'the pattern holds a control, invisible or unusual space character';
  if (pattern.includes('..')) return 'the pattern holds `..`';
  if (pattern.startsWith('~')) return 'the pattern starts with `~`';
  if (!WIN && pattern.includes('\\')) return 'the pattern holds a backslash';
  if (/\/\//.test(pattern)) return 'the pattern holds `//`';
  // A brace or extglob alternative may start at the root (`{/abs,x}`): its tree is not the prefix's.
  if (/[{,(|][\\/]/.test(pattern)) return 'an alternative in the pattern starts at the root';
  for (const seg of segmentsOf(pattern)) if (seg !== seg.trim()) return 'a part of the pattern starts or ends with a space';
  return null;
}

/** The literal folder a pattern starts in: everything before the separator that precedes the first wildcard. */
function literalPrefix(pattern: string): string {
  const w = pattern.search(GLOB_META);
  const literal = w === -1 ? pattern : pattern.slice(0, w);
  const cut = Math.max(literal.lastIndexOf('/'), WIN ? literal.lastIndexOf('\\') : -1);
  return cut <= 0 ? (cut === 0 ? literal.slice(0, 1) : '') : literal.slice(0, cut);
}

/**
 * The folders an ABSOLUTE pattern may start in besides `path`: its literal prefix, and that prefix
 * joined under `base` when it is really there (a tool may resolve or join it).
 */
function patternRoots(pattern: string, base: string): string[] {
  const prefix = literalPrefix(pattern) || P.sep;
  const joined = P.join(base, prefix);
  let there = false;
  try { lstatSync(joined); there = true; } catch { /* nothing there: nothing to read */ }
  return [...new Set([prefix, ...(there ? [joined] : [])])];
}

// ─── decisions ──────────────────────────────────────────────────────────────────────

function decideWrite(raw: unknown, ctx: BashGateContext, s: Scope): BashGateDecision {
  const problem = canonicalProblem(raw);
  if (problem) return deny(`Not written: ${problem}. Give an absolute path inside this app's data folder, ${ctx.dataDir}.`);
  const lex = clean(raw as string);
  if (!ctx.projectRoot) return deny('Not written: this chat has no data folder on record.');
  if (!s.ownDir || !s.ownReal) return deny('Not written: this app\'s data folder is missing, or a step of it is a symlink.');
  if (!lex.startsWith(s.ownDir + P.sep)) return deny(`Not written: this assistant writes only inside its app's data folder, ${s.ownDir}.`);
  const real = realNear(lex);
  const own = ownPathProblem(lex, real, s, true);
  if (own) return deny(`Not written: ${own}.`);
  try {
    const st = lstatSync(lex);
    if (st.isFile() && st.nlink > 1) return deny('Not written: the target has a second name (a hard link).');
  } catch { /* a new file */ }
  const segs = lex.slice(s.ownDir.length + 1).split(WIN ? /[\\/]/ : '/').filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    const last = i === segs.length - 1;
    if (isInstructionName(segs[i], !last, WRITE_REFUSED_NAMES) || (last && isInstructionName(segs[i], true, WRITE_REFUSED_NAMES.filter((n) => n.endsWith('/'))))) {
      return deny(`Not written: ${segs[i]} is an instruction or ignore file; app data is data, never instructions.`);
    }
  }
  return PASS;
}

function decideRead(raw: unknown, s: Scope): BashGateDecision {
  const problem = canonicalProblem(raw);
  if (problem) return deny(`Not read: ${problem}.`);
  const lex = clean(raw as string);
  const real = realNear(lex);
  const areas = [areaOf(lex, s), areaOf(real, s), identityArea(real, s)];
  if (areas.includes('other')) return deny('Not read: another app\'s data folder is not this assistant\'s to read.');
  if (areas.includes('own')) {
    const own = ownPathProblem(lex, real, s, false);
    if (own) return deny(`Not read: ${own}.`);
  }
  let st;
  try { st = lstatSync(real); } catch { return PASS; }
  return st.isDirectory() ? judgeSearchRoot(lex, s, lex) : PASS;
}

function decideSearch(tool: 'Grep' | 'Glob', input: Record<string, unknown>, s: Scope, cwd: string | undefined): BashGateDecision {
  const given = typeof input.path === 'string' && input.path !== '' ? input.path : cwd;
  if (given === undefined) return deny('Not searched: name an absolute folder to search in.');
  const problem = canonicalProblem(given);
  if (problem) return deny(`Not searched: ${problem}. Name an absolute folder to search in.`);
  const base = clean(given);
  const pattern = tool === 'Glob' ? input.pattern : input.glob;
  const roots = [base];
  if (pattern !== undefined && pattern !== null && pattern !== '') {
    if (typeof pattern !== 'string') return deny('Not searched: the pattern is not text.');
    const pp = patternProblem(pattern);
    if (pp) return deny(`Not searched: ${pp}. Give the folder as an absolute path and a pattern inside it.`);
    // The tool walks all of `path` whatever the pattern (Claude Code rewrites a relative pattern
    // before `rg` runs: security review of the resource gate, C1), so `path` is always judged; an
    // absolute pattern adds the folders it may start in.
    if (P.isAbsolute(pattern)) roots.push(...patternRoots(pattern, base));
  }
  for (const root of new Set(roots)) {
    const d = judgeSearchRoot(root, s, root === base ? given : root);
    if (d.decision !== 'pass') return d;
  }
  return PASS;
}

/** Decide one file-tool call. A tool outside the matcher passes (the matcher names the gated ones). */
export function classifyFileTool(tool: string, input: Record<string, unknown>, ctx: BashGateContext, cwd?: string): BashGateDecision {
  const gated = WRITE_TOOLS.includes(tool) || READ_TOOLS.includes(tool);
  if (!gated) return PASS;
  const s = makeScope(ctx);
  if (WRITE_TOOLS.includes(tool)) {
    // Every path field the call carries is judged; a call with none is refused.
    const paths = [input.file_path, input.notebook_path].filter((p) => p !== undefined);
    if (!paths.length) return deny('Not written: no path given.');
    for (const p of paths) {
      const d = decideWrite(p, ctx, s);
      if (d.decision !== 'pass') return d;
    }
    return PASS;
  }
  if (tool === 'Read') return decideRead(input.file_path, s);
  return decideSearch(tool as 'Grep' | 'Glob', input, s, cwd);
}
