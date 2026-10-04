/**
 * Transport 2 manifest + the ROOT-ID contract both transports and wave 2 build on.
 *
 * Manifest: an lstat walk that never follows symlinks, keyed in a `Map` by posix-relative
 * path; sha256 is computed lazily, reusing the last agreed manifest's hash when size AND
 * mtime are unchanged.
 *
 * Root-id contract (AC10): the laptop's GO manifest lists every in-scope root by a stable
 * id. Every later destination on the laptop — a returned file, a transcript, a new
 * worktree — is derived from that laptop-written manifest by root id, never from anything
 * the cloud sends (a cloud-sent path is only ever a RELATIVE path under such a root, run
 * through the shared guard).
 *
 * Pure fs + stream functions: no server imports, no module state, no uid assumption.
 */
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, join, posix, relative, resolve, sep } from 'node:path';
import { STAYS_HOME_REASON, checkRelPath, foldPath, foldSegment, linkStaysHome } from './paths.js';
import type { ProcessRunner } from './git-snapshot.js';

export type EntryType = 'file' | 'symlink';

export interface ManifestEntry {
  path: string;
  type: EntryType;
  /** Bytes for a file; the UTF-8 byte length of the target for a symlink. */
  size: number;
  /** Only the exec bit is honoured on apply; the rest is informational. */
  mode: number;
  mtimeMs: number;
  /** sha256 of the content (file) or of the link target string (symlink). */
  sha256: string;
  linkTarget?: string;
}

export type Manifest = Map<string, ManifestEntry>;

// ---------------------------------------------------------------- root-id contract

export type RootKind = 'vault' | 'repo' | 'worktree' | 'transcripts';

export interface RootSpec {
  /** Stable id: {@link rootIdFor} of the LAPTOP absolute path. */
  rootId: string;
  kind: RootKind;
  /** Absolute path on the laptop (the cloud mirrors it at the same path in production). */
  absPath: string;
  /** For a worktree: the root id of its repository's main checkout. */
  repoRootId?: string;
  /** For a repo: the parents new worktrees may be created under (realpaths at go). */
  allowedWorktreeParents?: string[];
}

export interface GoManifest {
  version: 1;
  tripId: string;
  laptopId: string;
  createdAt: string;
  home: string;
  roots: RootSpec[];
}

export function rootIdFor(absPath: string): string {
  return 'r-' + createHash('sha256').update(resolve(absPath)).digest('hex').slice(0, 16);
}

/**
 * Harness-injected path mapping. Production always uses {@link identityPathMap} (the cloud
 * mirrors every in-scope file at the SAME absolute path). The round-trip test harness,
 * whose fake cloud lives in a scratch HOME, passes {@link prefixPathMap}. There is no env
 * flag: the mapping is a parameter.
 */
export interface PathMap {
  toLocal(laptopAbs: string): string;
}
export const identityPathMap: PathMap = { toLocal: (p) => p };
export function prefixPathMap(fromPrefix: string, toPrefix: string): PathMap {
  const from = resolve(fromPrefix);
  return {
    toLocal(p: string) {
      const r = resolve(p);
      if (r === from) return resolve(toPrefix);
      if (r.startsWith(from + sep)) return join(resolve(toPrefix), r.slice(from.length + 1));
      return r;
    },
  };
}

export class DestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DestinationError';
  }
}

/** The local absolute root for a root id, taken ONLY from the laptop's go manifest. */
export function rootFor(go: GoManifest, rootId: string, map: PathMap = identityPathMap): RootSpec & { localPath: string } {
  const spec = go.roots.find((r) => r.rootId === rootId);
  if (!spec) throw new DestinationError(`unknown root id ${JSON.stringify(rootId)} (not in this laptop's go manifest)`);
  return { ...spec, localPath: map.toLocal(spec.absPath) };
}

/** Absolute local destination for (rootId, rel): the rel goes through the shared guard. */
export function resolveDestination(go: GoManifest, rootId: string, rel: string, map: PathMap = identityPathMap): string {
  const c = checkRelPath(rel);
  if (!c.ok) throw new DestinationError(`refused path ${JSON.stringify(rel)}: ${c.reason}`);
  return join(rootFor(go, rootId, map).localPath, ...rel.split('/'));
}

/** Claude's transcript dir encoding: absolute path with every non-alphanumeric → '-'. */
export function encodeProjectDir(absPath: string): string {
  return resolve(absPath).replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * The transcript dirs a return may write into: the encoded dirs of the go manifest's
 * code roots under `<claudeProjectsDir>` (the laptop computes them; the `cwd` inside a
 * transcript is only used to confirm, never to choose).
 */
export function transcriptDirsFor(go: GoManifest, claudeProjectsDir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of go.roots) {
    if (r.kind === 'transcripts') continue;
    out.set(encodeProjectDir(r.absPath), join(claudeProjectsDir, encodeProjectDir(r.absPath)));
  }
  return out;
}

export function isTranscriptDirAllowed(go: GoManifest, encodedName: string): boolean {
  return go.roots.some((r) => r.kind !== 'transcripts' && encodeProjectDir(r.absPath) === encodedName);
}

const WORKTREE_LEAF_RE = /^[a-z0-9-]+$/;

/**
 * Where a worktree that appeared in the cloud may be created on the laptop: only under
 * one of its repo's allowed parents (from the go manifest), with a `[a-z0-9-]+` leaf, and
 * realpath-checked (the parent must exist as a real dir; the leaf must not exist yet).
 */
export function allowedNewWorktreePath(
  go: GoManifest,
  repoRootId: string,
  candidateLaptopAbs: string,
  map: PathMap = identityPathMap,
): string {
  const repo = rootFor(go, repoRootId, map);
  if (repo.kind !== 'repo') throw new DestinationError(`root ${repoRootId} is not a repository`);
  const leaf = basename(candidateLaptopAbs);
  if (!WORKTREE_LEAF_RE.test(leaf)) throw new DestinationError(`worktree leaf ${JSON.stringify(leaf)} is not [a-z0-9-]+`);
  const parentLaptop = resolve(candidateLaptopAbs, '..');
  const allowed = (repo.allowedWorktreeParents ?? []).map((p) => resolve(p));
  if (!allowed.includes(parentLaptop)) {
    throw new DestinationError(`worktree parent ${parentLaptop} is not an allowed parent of ${repo.absPath}`);
  }
  const parentLocal = map.toLocal(parentLaptop);
  let real: string;
  try {
    const st = lstatSync(parentLocal);
    if (!st.isDirectory()) throw new DestinationError(`worktree parent ${parentLocal} is not a directory`);
    real = realpathSync.native(parentLocal);
  } catch (err) {
    if (err instanceof DestinationError) throw err;
    throw new DestinationError(`worktree parent ${parentLocal} does not exist`);
  }
  const dest = join(real, leaf);
  try {
    lstatSync(dest);
    throw new DestinationError(`worktree destination ${dest} already exists`);
  } catch (err) {
    if (err instanceof DestinationError) throw err;
  }
  return dest;
}

// ---------------------------------------------------------------- selection rules

/** Directories under `_dream_context/` that never travel. */
export const DREAM_EXCLUDED_DIRS = ['marketing', 'tmp', '.embeddings', '.obsidian'];

/** dreamcontext's own credential files: NEVER travel, refused on Return. */
export const NEVER_TRAVEL = ['_dream_context/state/.secrets.json', '_dream_context/lab/credentials.json'];

export function isNeverTravel(rel: string): boolean {
  const f = foldPath(rel);
  return NEVER_TRAVEL.some((n) => foldPath(n) === f || f.endsWith('/' + foldPath(n)));
}

const SECRET_BASENAME_RE =
  /^(?:\.env(?:\..*)?|\.npmrc|\.dev\.vars|\.netrc|service-account.*\.json|credentials.*\.json|.*\.(?:p12|pem|p8|key|keystore|jks))$/;

/** The secret class: travels, is wiped from the cloud on return, listed in the receipt. */
export function isSecretClass(rel: string): boolean {
  return SECRET_BASENAME_RE.test(foldSegment(posix.basename(rel)));
}

export interface WalkOptions {
  /** Return false to skip a directory (posix-relative to the root). */
  descend?: (relDir: string) => boolean;
  /** Return false to drop a file/symlink. */
  include?: (rel: string) => boolean;
  /**
   * REQUIRED. Which machine walks (D19 amended). `laptop` (go, and the laptop's own
   * Return manifest) leaves out links that could never be written on the other side
   * ('stays on the laptop'). `cloud` includes EVERY link: a link the cloud leaves out
   * would read as "deleted in the cloud" at Return and delete the laptop's copy; the
   * laptop's apply refuses a bad incoming link instead and keeps its own.
   */
  side: Side;
}

/** Reason listed for a path that exists but cannot be read (D20: refused, never dropped). */
export const UNREADABLE_REASON = 'unreadable';

export type Side = 'laptop' | 'cloud';

export interface WalkResult {
  entries: Array<{ path: string; type: EntryType }>;
  /**
   * Paths never included, with the reason: guard refusals, and (D19) symlinks whose target
   * the other side could never write, reported as 'stays on the laptop'.
   */
  refused: Array<{ path: string; reason: string }>;
}

/**
 * lstat walk from `root/startRel` that never follows symlinks. Sockets, fifos and devices
 * are skipped; a path the shared guard refuses (a nested `.git`, …) is reported, not
 * included.
 */
export function walk(root: string, startRels: string[], opts: WalkOptions): WalkResult {
  if (opts?.side !== 'laptop' && opts?.side !== 'cloud') throw new Error('walk: `side` is required (laptop | cloud)');
  const out: WalkResult = { entries: [], refused: [] };
  // D20: anything that exists but cannot be read is REFUSED and listed, never dropped
  // silently (a silently missing cloud dir would otherwise look like a deletion).
  const unreadable = (rel: string, err: unknown): boolean => {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return false;
    out.refused.push({ path: rel === '' ? '.' : rel, reason: `${UNREADABLE_REASON} (${code ?? 'error'})` });
    return true;
  };
  const seen = new Set<string>();
  const visit = (rel: string) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const c = checkRelPath(rel);
    if (!c.ok) {
      out.refused.push({ path: rel, reason: c.reason });
      return;
    }
    let st;
    try {
      st = lstatSync(join(root, ...rel.split('/')));
    } catch (err) {
      unreadable(rel, err);
      return;
    }
    if (st.isSymbolicLink() || st.isFile()) {
      if (opts.include && !opts.include(rel)) return;
      if (st.isSymbolicLink() && opts.side === 'laptop') {
        // D19: a link the other side could never write stays home (never sent, never deleted).
        let target = '';
        try { target = readlinkSync(join(root, ...rel.split('/'))); } catch { /* vanished */ }
        if (linkStaysHome(root, rel, target)) {
          out.refused.push({ path: rel, reason: STAYS_HOME_REASON });
          return;
        }
      }
      out.entries.push({ path: rel, type: st.isSymbolicLink() ? 'symlink' : 'file' });
      return;
    }
    if (!st.isDirectory()) return;
    if (opts.descend && !opts.descend(rel)) return;
    let names: string[];
    try {
      names = readdirSync(join(root, ...rel.split('/')));
    } catch (err) {
      unreadable(rel, err);
      return;
    }
    for (const n of names.sort()) visit(`${rel}/${n}`);
  };
  for (const s of startRels) {
    if (s === '' || s === '.') {
      let names: string[] = [];
      try { names = readdirSync(root); } catch (err) { unreadable('', err); }
      for (const n of names.sort()) visit(n);
    } else {
      visit(s.replace(/\/+$/, ''));
    }
  }
  return out;
}

export async function sha256File(abs: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(abs)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export function sha256Of(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Build a manifest for the given walked entries. A file whose size and mtime match the
 * `previous` (last agreed) manifest reuses its sha256; otherwise it is hashed now.
 */
export async function buildManifest(
  root: string,
  entries: Array<{ path: string; type: EntryType }>,
  previous?: Manifest,
  /**
   * D20: where to list an entry that exists but cannot be read (lstat, readlink, read).
   * Without it such an error THROWS: an unreadable path is never silently dropped.
   */
  refused?: Array<{ path: string; reason: string }>,
): Promise<Manifest> {
  const m: Manifest = new Map();
  const fail = (path: string, err: unknown): void => {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (!refused) throw err;
    refused.push({ path, reason: `${UNREADABLE_REASON} (${code ?? 'error'})` });
  };
  for (const e of entries) {
    const abs = join(root, ...e.path.split('/'));
    let st;
    try {
      st = lstatSync(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') fail(e.path, err);
      continue; // ENOENT: vanished since the walk
    }
    if (st.isSymbolicLink()) {
      let target: string;
      try {
        target = readlinkSync(abs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') fail(e.path, err);
        continue;
      }
      m.set(e.path, {
        path: e.path,
        type: 'symlink',
        size: Buffer.byteLength(target),
        mode: 0o120777,
        mtimeMs: Math.trunc(st.mtimeMs),
        sha256: sha256Of(target),
        linkTarget: target,
      });
      continue;
    }
    if (!st.isFile()) continue;
    const mtimeMs = Math.trunc(st.mtimeMs);
    const prev = previous?.get(e.path);
    let sha256: string;
    if (prev && prev.type === 'file' && prev.size === st.size && prev.mtimeMs === mtimeMs) sha256 = prev.sha256;
    else {
      try {
        sha256 = await sha256File(abs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') fail(e.path, err);
        continue;
      }
    }
    m.set(e.path, { path: e.path, type: 'file', size: st.size, mode: st.mode & 0o777, mtimeMs, sha256 });
  }
  return m;
}

const isExec = (mode: number) => (mode & 0o111) !== 0;

/** Same content as far as a transfer cares: type, hash, link target, exec bit. */
export function sameContent(a: ManifestEntry | undefined, b: ManifestEntry | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.type !== b.type || a.sha256 !== b.sha256) return false;
  if (a.type === 'symlink') return a.linkTarget === b.linkTarget;
  return isExec(a.mode) === isExec(b.mode);
}

export interface ManifestDiff {
  added: string[];
  changed: string[];
  deleted: string[];
}

export function diffManifests(from: Manifest, to: Manifest): ManifestDiff {
  const d: ManifestDiff = { added: [], changed: [], deleted: [] };
  for (const [p, e] of to) {
    const f = from.get(p);
    if (!f) d.added.push(p);
    else if (!sameContent(f, e)) d.changed.push(p);
  }
  for (const p of from.keys()) if (!to.has(p)) d.deleted.push(p);
  for (const k of ['added', 'changed', 'deleted'] as const) d[k].sort();
  return d;
}

export function manifestToJSON(m: Manifest): ManifestEntry[] {
  return [...m.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Parse an UNTRUSTED manifest (e.g. the cloud's): every entry validated, guard applied. */
export function manifestFromJSON(raw: unknown): Manifest {
  if (!Array.isArray(raw)) throw new Error('manifest: not an array');
  const m: Manifest = new Map();
  for (const r of raw) {
    const e = validateEntry(r);
    if (m.has(e.path)) throw new Error(`manifest: duplicate path ${JSON.stringify(e.path)}`);
    m.set(e.path, e);
  }
  return m;
}

export function validateEntry(r: unknown, maxSize = Number.MAX_SAFE_INTEGER): ManifestEntry {
  const o = r as Record<string, unknown>;
  if (!o || typeof o !== 'object') throw new Error('manifest entry: not an object');
  const c = checkRelPath(o.path);
  if (!c.ok) throw new Error(`manifest entry: refused path ${JSON.stringify(o.path)} (${c.reason})`);
  if (o.type !== 'file' && o.type !== 'symlink') throw new Error(`manifest entry: bad type for ${c.path}`);
  if (!Number.isSafeInteger(o.size) || (o.size as number) < 0 || (o.size as number) > maxSize) throw new Error(`manifest entry: bad size for ${c.path}`);
  if (!Number.isSafeInteger(o.mode) || (o.mode as number) < 0) throw new Error(`manifest entry: bad mode for ${c.path}`);
  if (typeof o.mtimeMs !== 'number' || !Number.isFinite(o.mtimeMs)) throw new Error(`manifest entry: bad mtime for ${c.path}`);
  if (typeof o.sha256 !== 'string' || !HEX64.test(o.sha256)) throw new Error(`manifest entry: bad sha256 for ${c.path}`);
  const e: ManifestEntry = { path: c.path, type: o.type, size: o.size as number, mode: o.mode as number, mtimeMs: Math.trunc(o.mtimeMs), sha256: o.sha256 };
  if (o.type === 'symlink') {
    if (typeof o.linkTarget !== 'string' || o.linkTarget.length === 0 || o.linkTarget.includes('\0')) throw new Error(`manifest entry: bad link target for ${c.path}`);
    if (sha256Of(o.linkTarget) !== o.sha256) throw new Error(`manifest entry: link hash mismatch for ${c.path}`);
    e.linkTarget = o.linkTarget;
  } else if (o.linkTarget !== undefined) {
    throw new Error(`manifest entry: link target on a file ${c.path}`);
  }
  return e;
}

/**
 * The non-git candidate set for one root (Transport 2, "Set per root"): ignored files
 * under `_dream_context/` minus its excluded dirs, ignored `.claude/` content, the secret
 * class, and `handsfree.include` opt-ins. Tracked and untracked-NON-ignored files belong
 * to Transport 1 and are never listed here. `isGitRepo=false` (a vault without git) walks
 * `_dream_context/` and `.claude/` directly. dreamcontext's own credential files never
 * appear.
 */
export async function selectNonGitEntries(
  run: ProcessRunner,
  root: string,
  opts: { isGitRepo: boolean; include?: string[]; /** Required: see {@link WalkOptions.side}. */ side: Side },
): Promise<WalkResult> {
  const includes = (opts.include ?? []).map((p) => p.replace(/^\.\/+/, '').replace(/\/+$/, '')).filter((p) => checkRelPath(p).ok);
  const underInclude = (rel: string) => includes.some((i) => rel === i || rel.startsWith(i + '/'));
  const dreamExcluded = (rel: string) => DREAM_EXCLUDED_DIRS.some((d) => rel === `_dream_context/${d}` || rel.startsWith(`_dream_context/${d}/`));
  const keepFile = (rel: string): boolean => {
    if (isNeverTravel(rel)) return false;
    if (dreamExcluded(rel)) return false;
    if (rel.startsWith('_dream_context/') || rel.startsWith('.claude/')) return true;
    if (isSecretClass(rel)) return true;
    return underInclude(rel);
  };
  const descend = (relDir: string): boolean => {
    if (dreamExcluded(relDir)) return false;
    const base = posix.basename(relDir);
    if (base === 'node_modules') return relDir.startsWith('_dream_context/') || underInclude(relDir);
    return true;
  };

  if (!opts.isGitRepo) {
    return walk(root, ['_dream_context', '.claude', ...includes], { descend, include: keepFile, side: opts.side });
  }

  const res = await run('git', ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory'], {
    cwd: root,
    env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  if (res.code !== 0) throw new Error(`git ls-files failed in ${root}: ${res.stderr.toString().trim()}`);
  const listed = res.stdout.toString('utf8').split('\0').filter(Boolean);
  const starts: string[] = [];
  for (const raw of listed) {
    const rel = raw.replace(/\/$/, '');
    const isDir = raw.endsWith('/');
    if (!isDir) {
      if (keepFile(rel)) starts.push(rel);
      continue;
    }
    // A collapsed ignored directory: walk it only when its content can belong to the set.
    if (rel === '_dream_context' || rel.startsWith('_dream_context/') || rel === '.claude' || rel.startsWith('.claude/') || underInclude(rel)) {
      starts.push(rel);
    } else if (includes.some((i) => i.startsWith(rel + '/'))) {
      for (const i of includes) if (i.startsWith(rel + '/')) starts.push(i);
    }
  }
  return walk(root, starts, { descend, include: keepFile, side: opts.side });
}

/** Helper for callers that hold absolute paths: posix-relative path of `abs` under `root`, or null. */
export function relUnder(root: string, abs: string): string | null {
  const r = relative(resolve(root), resolve(abs));
  if (r === '' || r.startsWith('..') || r.startsWith(sep) || /^[A-Za-z]:/.test(r)) return null;
  return r.split(sep).join('/');
}
