/**
 * Transport 1, sender half: git state travels git-native, never as .git files.
 *
 * - The REPOSITORY owns refs (heads/tags/notes), objects and the stash list; each CHECKOUT
 *   (main or worktree) owns HEAD, indexTree and worktreeTree.
 * - Snapshot trees are wrapped as deterministic commits under
 *   `refs/handsfree/snap/<trip>/<checkoutId>/{index,worktree}` and stash entries under
 *   `refs/handsfree/snap/<trip>/stash/<n>` so a bundle carries them.
 * - Bundles are produced/consumed as FILES or STREAMS (the forwarder caps request bodies
 *   below 32 MB, so wave 2 uploads them in chunks), never as one in-memory buffer.
 *
 * Every git call goes through an INJECTED {@link ProcessRunner}: the cloud passes
 * `spawnAsWorker` (dcuser), the laptop a plain spawner ({@link createSpawnRunner}).
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { linkStaysHome, symlinkTargetInside } from './paths.js';
import { join, relative, resolve, sep } from 'node:path';

// ---------------------------------------------------------------- PINNED runner contract

export interface RunResult { code: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: Buffer }
export interface RunOptions {
  cwd: string;
  env?: Record<string, string>;          // merged onto the runner's own allow-listed base env
  input?: Buffer | NodeJS.ReadableStream; // piped to stdin
  stdoutTo?: NodeJS.WritableStream;       // stream stdout here instead of buffering (bundles, packs)
  timeoutMs?: number;
}
export type ProcessRunner = (cmd: string, args: string[], opts: RunOptions) => Promise<RunResult>;

/**
 * A plain spawner (the laptop side; tests). `baseEnv` defaults to the current process env.
 * `stdoutTo` is written to but NOT ended: the caller owns that stream.
 */
export function createSpawnRunner(opts: { baseEnv?: Record<string, string | undefined> } = {}): ProcessRunner {
  return (cmd, args, o) => new Promise<RunResult>((resolvePromise, reject) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.baseEnv ?? process.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, o.env ?? {});
    const child = spawn(cmd, args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    if (o.timeoutMs) timer = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs);
    if (o.stdoutTo) child.stdout.pipe(o.stdoutTo as NodeJS.WritableStream, { end: false });
    else child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (o.stdoutTo) child.stdout.unpipe(o.stdoutTo as NodeJS.WritableStream);
      resolvePromise({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
    child.stdin.on('error', () => { /* child exited before reading all input */ });
    if (o.input === undefined) child.stdin.end();
    else if (Buffer.isBuffer(o.input)) child.stdin.end(o.input);
    else (o.input as NodeJS.ReadableStream).pipe(child.stdin);
  });
}

// ---------------------------------------------------------------- git plumbing

/** Hooks and fsmonitor never run for our git calls; paths are never quoted. */
export const GIT_SAFE_ARGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false'];
export const GIT_BASE_ENV: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };

export class GitError extends Error {
  constructor(readonly args: string[], readonly code: number | null, readonly stderr: string) {
    super(`git ${args.filter((a) => !a.startsWith('core.')).slice(0, 4).join(' ')} failed (${code}): ${stderr.trim().slice(0, 500)}`);
    this.name = 'GitError';
  }
}

export type RefusalKind =
  | 'submodule'
  | 'unmerged'
  | 'in_progress'
  | 'lock'
  | 'filter'
  | 'lfs'
  | 'shallow'
  | 'partial'
  | 'bad_head'
  | 'bad_ref'
  | 'bad_path'
  | 'bad_snapshot'
  | 'bad_link';

export class HandsfreeRefusal extends Error {
  constructor(readonly kind: RefusalKind, message: string, readonly path?: string) {
    super(message);
    this.name = 'HandsfreeRefusal';
  }
}

export interface GitCallOptions {
  env?: Record<string, string>;
  input?: Buffer | NodeJS.ReadableStream;
  stdoutTo?: NodeJS.WritableStream;
  allowFail?: boolean;
  timeoutMs?: number;
}

export async function git(run: ProcessRunner, cwd: string, args: string[], o: GitCallOptions = {}): Promise<RunResult> {
  const full = [...GIT_SAFE_ARGS, ...args];
  const res = await run('git', full, {
    cwd,
    env: { ...GIT_BASE_ENV, ...(o.env ?? {}) },
    input: o.input,
    stdoutTo: o.stdoutTo,
    timeoutMs: o.timeoutMs,
  });
  if (res.code !== 0 && !o.allowFail) throw new GitError(args, res.code, res.stderr.toString());
  return res;
}

export async function gitOut(run: ProcessRunner, cwd: string, args: string[], o: GitCallOptions = {}): Promise<string> {
  return (await git(run, cwd, args, o)).stdout.toString('utf8');
}

/** Fixed identity + date so the same tree always wraps into the same commit on both sides. */
export const SNAP_COMMIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: 'dreamcontext handsfree',
  GIT_AUTHOR_EMAIL: 'handsfree@dreamcontext.invalid',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'dreamcontext handsfree',
  GIT_COMMITTER_EMAIL: 'handsfree@dreamcontext.invalid',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

const TRIP_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESERVED_TRIPS = new Set(['snap', 'backup', 'incoming', 'base']);

export function assertTripId(trip: string): string {
  if (typeof trip !== 'string' || !TRIP_RE.test(trip) || RESERVED_TRIPS.has(trip)) {
    throw new HandsfreeRefusal('bad_snapshot', `invalid trip id ${JSON.stringify(trip)}`);
  }
  return trip;
}

const ALLOWED_REF_RE = /^refs\/(?:heads|tags|notes)\/./;

/** The ref allow-list: refs/heads|tags|notes/* with a well-formed name (stash travels as a list). */
export function isAllowedRef(ref: string): boolean {
  return typeof ref === 'string' && ALLOWED_REF_RE.test(ref) && isWellFormedRef(ref);
}

/** Static subset of `git check-ref-format` (no spawn needed). */
export function isWellFormedRef(ref: string): boolean {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 1024) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(ref)) return false;
  if (ref.includes('..') || ref.includes('@{') || ref.includes('//')) return false;
  if (ref.endsWith('/') || ref.endsWith('.') || ref === '@') return false;
  return ref.split('/').every((c) => c.length > 0 && !c.startsWith('.') && !c.endsWith('.lock'));
}

export function oidRe(format: ObjectFormat): RegExp {
  return format === 'sha256' ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/;
}

export type ObjectFormat = 'sha1' | 'sha256';

// ---------------------------------------------------------------- snapshot types

export type HeadState =
  | { kind: 'symref'; ref: string; oid: string | null }
  | { kind: 'detached'; oid: string };

export interface CheckoutSnapshot {
  checkoutId: string;
  /** Absolute path on the side that took the snapshot. */
  path: string;
  isMain: boolean;
  head: HeadState;
  indexTree: string;
  worktreeTree: string;
  /** Tolerant (recovery) snapshots only: MERGE_HEAD, REBASE_HEAD, … saved as commits. */
  inProgress?: Record<string, string>;
}

export interface StashEntry { oid: string; message: string }

export interface RepoSnapshot {
  version: 1;
  trip: string;
  objectFormat: ObjectFormat;
  repoPath: string;
  refs: Record<string, string>;
  /** Laptop→cloud only (one-way); never applied on the laptop. */
  remoteRefs?: Record<string, string>;
  /** `stash@{0}` first, exactly as `git log -g refs/stash` lists it. */
  stash: StashEntry[];
  checkouts: CheckoutSnapshot[];
  tolerant: boolean;
}

export const snapRefPrefix = (trip: string) => `refs/handsfree/snap/${assertTripId(trip)}`;
export const snapIndexRef = (trip: string, cid: string) => `${snapRefPrefix(trip)}/${cid}/index`;
export const snapWorktreeRef = (trip: string, cid: string) => `${snapRefPrefix(trip)}/${cid}/worktree`;
export const snapStashRef = (trip: string, n: number) => `${snapRefPrefix(trip)}/stash/${n}`;
export const snapInProgressRef = (trip: string, cid: string, name: string) => `${snapRefPrefix(trip)}/${cid}/inprogress/${name}`;

/** Canonical id of a snapshot's STATE (paths and trip excluded) — the go equality check. */
export function snapshotId(s: RepoSnapshot): string {
  const sorted = (o: Record<string, string>) => Object.keys(o).sort().map((k) => [k, o[k]]);
  const canon = {
    refs: sorted(s.refs),
    stash: s.stash.map((e) => [e.oid, e.message]),
    checkouts: [...s.checkouts]
      .sort((a, b) => (a.checkoutId < b.checkoutId ? -1 : 1))
      .map((c) => [c.checkoutId, c.head, c.indexTree, c.worktreeTree]),
  };
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

// ---------------------------------------------------------------- reading state

export async function objectFormat(run: ProcessRunner, cwd: string): Promise<ObjectFormat> {
  const f = (await gitOut(run, cwd, ['rev-parse', '--show-object-format'])).trim();
  return f === 'sha256' ? 'sha256' : 'sha1';
}

export async function emptyTree(run: ProcessRunner, cwd: string): Promise<string> {
  return (await gitOut(run, cwd, ['mktree'], { input: Buffer.alloc(0) })).trim();
}

export interface WorktreeInfo { path: string; isMain: boolean; bare: boolean; prunable: boolean }

export async function listWorktrees(run: ProcessRunner, repoPath: string): Promise<WorktreeInfo[]> {
  const out = await gitOut(run, repoPath, ['worktree', 'list', '--porcelain', '-z']);
  const list: WorktreeInfo[] = [];
  let cur: WorktreeInfo | null = null;
  for (const field of out.split('\0')) {
    if (field === '') {
      if (cur) list.push(cur);
      cur = null;
      continue;
    }
    if (field.startsWith('worktree ')) cur = { path: resolve(field.slice(9)), isMain: list.length === 0, bare: false, prunable: false };
    else if (cur && field === 'bare') cur.bare = true;
    else if (cur && field.startsWith('prunable')) cur.prunable = true;
  }
  if (cur) list.push(cur);
  return list;
}

export async function readRefs(run: ProcessRunner, cwd: string, patterns: string[]): Promise<Record<string, string>> {
  const out = await gitOut(run, cwd, ['for-each-ref', '--format=%(objectname) %(refname)', ...patterns]);
  const refs: Record<string, string> = {};
  for (const line of out.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    refs[line.slice(sp + 1)] = line.slice(0, sp);
  }
  return refs;
}

/** The stash list, `stash@{0}` first, with the reflog messages `stash store -m` restores. */
export async function readStash(run: ProcessRunner, cwd: string): Promise<StashEntry[]> {
  const has = await git(run, cwd, ['rev-parse', '-q', '--verify', 'refs/stash'], { allowFail: true });
  if (has.code !== 0) return [];
  const out = await gitOut(run, cwd, ['log', '-g', '--format=%H %gs', 'refs/stash', '--']);
  return out.split('\n').filter(Boolean).map((l) => {
    const sp = l.indexOf(' ');
    return sp < 0 ? { oid: l, message: '' } : { oid: l.slice(0, sp), message: l.slice(sp + 1) };
  });
}

export async function readHead(run: ProcessRunner, checkout: string): Promise<HeadState> {
  const sym = await git(run, checkout, ['symbolic-ref', '-q', 'HEAD'], { allowFail: true });
  const oidRes = await git(run, checkout, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { allowFail: true });
  const oid = oidRes.code === 0 ? oidRes.stdout.toString().trim() : null;
  if (sym.code === 0) {
    const ref = sym.stdout.toString().trim();
    if (!ref.startsWith('refs/heads/') || !isWellFormedRef(ref)) throw new HandsfreeRefusal('bad_head', `HEAD points at ${ref}, not refs/heads/*`);
    return { kind: 'symref', ref, oid };
  }
  if (!oid) throw new HandsfreeRefusal('bad_head', `detached HEAD with no commit in ${checkout}`);
  return { kind: 'detached', oid };
}

async function gitDirOf(run: ProcessRunner, checkout: string): Promise<{ gitDir: string; commonDir: string }> {
  const out = await gitOut(run, checkout, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']);
  const [gitDir, commonDir] = out.trim().split('\n');
  return { gitDir, commonDir };
}

const IN_PROGRESS_FILES = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD'];

/** Which multi-step operations are in progress in this checkout (per-worktree git dir). */
export function inProgressStates(gitDir: string): string[] {
  const found: string[] = [];
  for (const f of IN_PROGRESS_FILES) if (existsSync(join(gitDir, f))) found.push(f);
  if (existsSync(join(gitDir, 'rebase-merge'))) found.push('rebase-merge');
  if (existsSync(join(gitDir, 'rebase-apply'))) found.push('rebase-apply');
  if (existsSync(join(gitDir, 'BISECT_LOG'))) found.push('BISECT_LOG');
  return found;
}

/** Commits worth saving from an in-progress operation (tolerant recovery). */
function inProgressHeads(gitDir: string): Record<string, string> {
  const pick: Array<[string, string]> = [
    ['MERGE_HEAD', 'MERGE_HEAD'],
    ['CHERRY_PICK_HEAD', 'CHERRY_PICK_HEAD'],
    ['REVERT_HEAD', 'REVERT_HEAD'],
    ['REBASE_HEAD', 'REBASE_HEAD'],
    ['rebase-merge/orig-head', 'REBASE_ORIG_HEAD'],
    ['rebase-merge/onto', 'REBASE_ONTO'],
    ['rebase-apply/orig-head', 'REBASE_APPLY_ORIG_HEAD'],
    ['rebase-apply/onto', 'REBASE_APPLY_ONTO'],
  ];
  const out: Record<string, string> = {};
  for (const [file, name] of pick) {
    try {
      const lines = readFileSync(join(gitDir, file), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
      // MERGE_HEAD may list several parents (octopus): keep each.
      lines.forEach((oid, i) => {
        if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(oid)) out[i === 0 ? name : `${name}_${i}`] = oid;
      });
    } catch { /* absent */ }
  }
  return out;
}

export interface TreeEntry { mode: string; type: string; oid: string; path: string }

export async function lsTree(run: ProcessRunner, cwd: string, tree: string): Promise<TreeEntry[]> {
  const out = await gitOut(run, cwd, ['ls-tree', '-r', '-z', '--full-tree', tree]);
  const entries: TreeEntry[] = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, type, oid] = rec.slice(0, tab).split(' ');
    entries.push({ mode, type, oid, path: rec.slice(tab + 1) });
  }
  return entries;
}

/** Refuse a mode-160000 (gitlink) entry: submodules and nested clones never travel. */
export async function assertNoGitlinks(run: ProcessRunner, cwd: string, tree: string): Promise<void> {
  for (const e of await lsTree(run, cwd, tree)) {
    if (e.mode === '160000') {
      throw new HandsfreeRefusal(
        'submodule',
        `"${e.path}" is a nested git repository (mode 160000). Hands-free mode does not carry submodules or nested clones: add "${e.path}/" to .gitignore (or .git/info/exclude) and try again.`,
        e.path,
      );
    }
  }
}

/** D19 refusal text for a symlink that can never travel (mirrors the submodule refusal). */
function badLinkMessage(path: string, target: string): string {
  return `"${path}" is a symlink to ${JSON.stringify(target)}, which cannot travel (absolute, outside the repository, or not a plain relative path). Hands-free mode does not carry it: rewrite it as a relative link or ignore it, then try again.`;
}

/**
 * Which machine runs the check (D19 amended): the `laptop` checks lexically AND physically
 * (on-disk links); the `cloud` checks lexically only, because a tracked link can resolve
 * outside there purely through cloud-only content (an install's absolute link) and must not
 * refuse the whole Return; the laptop's apply and preflight keep the physical check.
 */
export type CheckSide = 'laptop' | 'cloud';

/** Does the link at `rel` (with `target`) fail D18/D19? Lexical always; physical on the laptop when it is on disk with that target. */
function linkCannotTravel(checkout: string, rel: string, target: string, side: CheckSide): boolean {
  if (!symlinkTargetInside(rel, target)) return true;
  if (side === 'cloud') return false;
  try {
    const abs = join(checkout, ...rel.split('/'));
    if (lstatSync(abs).isSymbolicLink() && readlinkSync(abs) === target) return linkStaysHome(checkout, rel, target);
  } catch { /* not on disk: lexical verdict stands */ }
  return false;
}

/**
 * D19: refuse a tree holding a 120000 entry whose target cannot travel (fails the
 * canonical rule or resolves outside the repo), naming the file, exactly like
 * {@link assertNoGitlinks}.
 */
export async function assertTravelableLinks(run: ProcessRunner, checkout: string, tree: string, side: CheckSide = 'laptop'): Promise<void> {
  for (const e of await lsTree(run, checkout, tree)) {
    if (e.mode !== '120000') continue;
    const target = await gitOut(run, checkout, ['cat-file', 'blob', e.oid]);
    if (linkCannotTravel(checkout, e.path, target, side)) throw new HandsfreeRefusal('bad_link', badLinkMessage(e.path, target), e.path);
  }
}

// ---------------------------------------------------------------- preflight

export interface PreflightProblem { kind: RefusalKind; detail: string; path?: string }

/**
 * The git preflight (laptop at go, cloud at return while still active; re-run after any
 * cut). Returns every problem; an empty list means the checkout may travel.
 */
export async function gitPreflight(run: ProcessRunner, checkout: string, o: { side?: CheckSide } = {}): Promise<PreflightProblem[]> {
  const side = o.side ?? 'laptop';
  const problems: PreflightProblem[] = [];
  const { gitDir, commonDir } = await gitDirOf(run, checkout);
  const unmerged = await gitOut(run, checkout, ['ls-files', '-u', '-z']);
  if (unmerged.length > 0) problems.push({ kind: 'unmerged', detail: 'the index has unmerged entries' });
  for (const s of inProgressStates(gitDir)) problems.push({ kind: 'in_progress', detail: `${s} is in progress` });
  for (const dir of new Set([gitDir, commonDir])) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { /* */ }
    for (const n of names) if (n.endsWith('.lock')) problems.push({ kind: 'lock', detail: `${n} is held`, path: join(dir, n) });
  }
  if ((await gitOut(run, checkout, ['rev-parse', '--is-shallow-repository'])).trim() === 'true') {
    problems.push({ kind: 'shallow', detail: 'shallow clone' });
  }
  const promisor = await git(run, checkout, ['config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$'], { allowFail: true });
  if (promisor.code === 0 && promisor.stdout.toString().trim()) problems.push({ kind: 'partial', detail: 'partial clone' });
  if (existsSync(join(checkout, '.gitmodules'))) problems.push({ kind: 'submodule', detail: '.gitmodules present' });
  const staged = await gitOut(run, checkout, ['ls-files', '-s', '-z']);
  for (const rec of staged.split('\0')) {
    if (rec.startsWith('160000 ')) problems.push({ kind: 'submodule', detail: 'gitlink in the index', path: rec.slice(rec.indexOf('\t') + 1) });
  }
  // D19: symlinks that can never travel, staged (index blobs) or on disk (the worktree).
  const badLinks = new Map<string, string>();
  for (const rec of staged.split('\0')) {
    if (!rec.startsWith('120000 ')) continue;
    const path = rec.slice(rec.indexOf('\t') + 1);
    const oid = rec.split(' ')[1];
    const target = await gitOut(run, checkout, ['cat-file', 'blob', oid]);
    if (linkCannotTravel(checkout, path, target, side)) badLinks.set(path, target);
  }
  const listed = (await gitOut(run, checkout, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean);
  for (const path of new Set(listed)) {
    if (badLinks.has(path) || path.endsWith('/')) continue;
    try {
      const abs = join(checkout, ...path.split('/'));
      if (!lstatSync(abs).isSymbolicLink()) continue;
      const target = readlinkSync(abs);
      if (linkCannotTravel(checkout, path, target, side)) badLinks.set(path, target);
    } catch { /* deleted in the worktree */ }
  }
  for (const [path, target] of badLinks) problems.push({ kind: 'bad_link', detail: badLinkMessage(path, target), path });
  if (existsSync(join(checkout, '.lfsconfig'))) problems.push({ kind: 'lfs', detail: '.lfsconfig present' });
  const attrFiles = (await gitOut(run, checkout, ['ls-files', '-z', '--', ':(glob)**/.gitattributes'])).split('\0').filter(Boolean);
  const attrPaths = attrFiles.map((f) => join(checkout, f));
  attrPaths.push(join(commonDir, 'info', 'attributes'));
  if (existsSync(join(checkout, '.gitattributes')) && !attrFiles.includes('.gitattributes')) attrPaths.push(join(checkout, '.gitattributes'));
  for (const p of attrPaths) {
    let text = '';
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    const m = /(^|\s)filter=([^\s]+)/m.exec(text);
    if (m) problems.push({ kind: m[2] === 'lfs' ? 'lfs' : 'filter', detail: `filter=${m[2]} in ${relative(checkout, p) || p}`, path: p });
  }
  return problems;
}

// ---------------------------------------------------------------- snapshot

export interface SnapshotOptions {
  trip: string;
  /** Tolerant recovery: a merge/rebase in progress is captured (conflict markers as content). */
  tolerant?: boolean;
  /** Extra in-scope roots (other repos) nested inside this repo's checkouts. */
  extraNestedRoots?: string[];
  /** Which `git worktree list` entries are checkouts (e.g. "under HOME"). Default: all. */
  checkoutFilter?: (absPath: string) => boolean;
  /** Stable checkout id; production uses the root id of the LAPTOP path. */
  checkoutIdFor: (absPath: string) => string;
  /** Which machine snapshots (default laptop): the cloud's link check is lexical only. */
  side?: CheckSide;
  /** Carry refs/remotes/* (laptop→cloud only). */
  includeRemotes?: boolean;
  /**
   * Write the snap refs (default true). False for a comparison-only snapshot (the laptop's
   * S_now at Return) so the trip-start snap refs stay intact.
   */
  writeRefs?: boolean;
}

const CHECKOUT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isInsideDir(parent: string, child: string): boolean {
  return child !== parent && child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

async function wrapTree(run: ProcessRunner, cwd: string, tree: string, msg: string): Promise<string> {
  return (await gitOut(run, cwd, ['commit-tree', tree, '-m', msg], { env: SNAP_COMMIT_ENV })).trim();
}

/** Tree of the worktree: temp index seeded from `seedTree` + `add -A` minus nested checkouts. */
async function worktreeTreeOf(
  run: ProcessRunner,
  checkout: string,
  gitDir: string,
  seedTree: string,
  nestedRels: string[],
): Promise<string> {
  const tmpIndex = join(gitDir, `handsfree-index-${process.pid}-${randomBytes(6).toString('hex')}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    await git(run, checkout, ['read-tree', seedTree], { env });
    // A nested checkout git already ignores (e.g. `**/.claude/worktrees/` in info/exclude) is
    // skipped by `add -A` anyway, and naming an ignored path in a pathspec makes `git add` fail.
    let nested = nestedRels;
    if (nested.length) {
      const ci = await git(run, checkout, ['check-ignore', '-z', '--stdin'], { env, input: Buffer.from(nested.join('\0') + '\0'), allowFail: true });
      const ignored = new Set(ci.stdout.toString('utf8').split('\0').filter(Boolean));
      nested = nested.filter((r) => !ignored.has(r));
    }
    const pathspec = ['.', ...nested.map((r) => `:(exclude,literal)${r}`)];
    await git(run, checkout, ['-c', 'core.safecrlf=false', '-c', 'advice.addEmbeddedRepo=false', 'add', '-A', '--', ...pathspec], { env });
    return (await gitOut(run, checkout, ['write-tree'], { env })).trim();
  } finally {
    rmSync(tmpIndex, { force: true });
    rmSync(tmpIndex + '.lock', { force: true });
  }
}

/**
 * Snapshot S of one repository and every one of its checkouts. Writes ONLY refs under
 * `refs/handsfree/snap/<trip>/` (replacing a previous snapshot of the same trip).
 */
export async function snapshotRepo(run: ProcessRunner, repoPath: string, o: SnapshotOptions): Promise<RepoSnapshot> {
  const trip = assertTripId(o.trip);
  const fmt = await objectFormat(run, repoPath);
  const worktrees = (await listWorktrees(run, repoPath)).filter((w) => !w.bare && !w.prunable && existsSync(w.path));
  const checkouts = worktrees.filter((w) => w.isMain || !o.checkoutFilter || o.checkoutFilter(w.path));
  if (checkouts.length === 0) throw new HandsfreeRefusal('bad_snapshot', `${repoPath} has no checkout`);
  // Every worktree (even one the filter drops) is a git checkout, never content of another.
  const allRoots = [...worktrees.map((c) => c.path), ...(o.extraNestedRoots ?? []).map((p) => resolve(p))];

  const refs = await readRefs(run, repoPath, ['refs/heads', 'refs/tags', 'refs/notes']);
  for (const r of Object.keys(refs)) if (!isAllowedRef(r)) delete refs[r];
  const remoteRefs = o.includeRemotes ? await readRefs(run, repoPath, ['refs/remotes']) : undefined;
  if (remoteRefs) for (const r of Object.keys(remoteRefs)) if (!isWellFormedRef(r) || r.endsWith('/HEAD')) delete remoteRefs[r];
  const stash = await readStash(run, repoPath);
  const empty = await emptyTree(run, repoPath);

  const snaps: CheckoutSnapshot[] = [];
  const snapRefs: Record<string, string> = {};
  for (const w of checkouts) {
    const checkoutId = o.checkoutIdFor(w.path);
    if (!CHECKOUT_ID_RE.test(checkoutId) || checkoutId === 'stash') throw new HandsfreeRefusal('bad_snapshot', `bad checkout id ${checkoutId}`);
    const { gitDir } = await gitDirOf(run, w.path);
    const head = await readHead(run, w.path);
    const busy = inProgressStates(gitDir);
    const unmerged = (await gitOut(run, w.path, ['ls-files', '-u', '-z'])).length > 0;
    const headTree = head.oid ? (await gitOut(run, w.path, ['rev-parse', `${head.oid}^{tree}`])).trim() : empty;

    let indexTree: string;
    let inProgress: Record<string, string> | undefined;
    if (busy.length > 0 || unmerged) {
      if (!o.tolerant) {
        throw new HandsfreeRefusal(unmerged ? 'unmerged' : 'in_progress', `${w.path}: ${unmerged ? 'unmerged index' : busy.join(', ') + ' in progress'}; resolve it first`);
      }
      // Recovery: the index cannot be written as a tree; take HEAD's tree as the index and
      // let the worktree tree carry conflict markers as plain content.
      indexTree = headTree;
      inProgress = inProgressHeads(gitDir);
    } else {
      indexTree = (await gitOut(run, w.path, ['write-tree'])).trim();
    }
    const nestedRels = allRoots.filter((r) => isInsideDir(w.path, r)).map((r) => relative(w.path, r).split(sep).join('/'));
    const worktreeTree = await worktreeTreeOf(run, w.path, gitDir, inProgress ? headTree : indexTree, nestedRels);
    await assertNoGitlinks(run, w.path, indexTree);
    await assertNoGitlinks(run, w.path, worktreeTree);
    if (!o.tolerant) {
      await assertTravelableLinks(run, w.path, indexTree, o.side ?? 'laptop');
      await assertTravelableLinks(run, w.path, worktreeTree, o.side ?? 'laptop');
    }

    snapRefs[snapIndexRef(trip, checkoutId)] = await wrapTree(run, w.path, indexTree, `handsfree index ${checkoutId}`);
    snapRefs[snapWorktreeRef(trip, checkoutId)] = await wrapTree(run, w.path, worktreeTree, `handsfree worktree ${checkoutId}`);
    if (inProgress) {
      for (const [name, oid] of Object.entries(inProgress)) snapRefs[snapInProgressRef(trip, checkoutId, name)] = oid;
    }
    snaps.push({ checkoutId, path: w.path, isMain: w.isMain, head, indexTree, worktreeTree, ...(inProgress ? { inProgress } : {}) });
  }
  stash.forEach((e, i) => { snapRefs[snapStashRef(trip, i)] = e.oid; });

  // Replace this trip's previous snap refs atomically.
  const old = o.writeRefs === false ? null : await readRefs(run, repoPath, [snapRefPrefix(trip) + '/']);
  const lines: string[] = [];
  if (old) {
    for (const r of Object.keys(old)) if (!(r in snapRefs)) lines.push(`delete ${r}`);
    for (const [r, oid] of Object.entries(snapRefs)) lines.push(`update ${r} ${oid}`);
  }
  if (lines.length) await git(run, repoPath, ['update-ref', '--stdin'], { input: Buffer.from(lines.join('\n') + '\n') });

  return {
    version: 1,
    trip,
    objectFormat: fmt,
    repoPath: resolve(repoPath),
    refs,
    ...(remoteRefs ? { remoteRefs } : {}),
    stash,
    checkouts: snaps,
    tolerant: !!o.tolerant,
  };
}

/** Every ref a bundle of this snapshot must carry. */
export function snapshotBundleRefs(s: RepoSnapshot): string[] {
  const trip = s.trip;
  const refs = [...Object.keys(s.refs), ...Object.keys(s.remoteRefs ?? {})];
  for (const c of s.checkouts) {
    refs.push(snapIndexRef(trip, c.checkoutId), snapWorktreeRef(trip, c.checkoutId));
    for (const n of Object.keys(c.inProgress ?? {})) refs.push(snapInProgressRef(trip, c.checkoutId, n));
  }
  s.stash.forEach((_, i) => refs.push(snapStashRef(trip, i)));
  return refs.sort();
}

/** Validate an UNTRUSTED snapshot (the other side's JSON): shapes, oids, ref allow-list, HEAD. */
export function parseRepoSnapshot(raw: unknown, trip: string): RepoSnapshot {
  const bad = (m: string) => new HandsfreeRefusal('bad_snapshot', `snapshot: ${m}`);
  const s = raw as RepoSnapshot;
  if (!s || typeof s !== 'object' || s.version !== 1) throw bad('version');
  if (s.trip !== trip) throw bad('trip mismatch');
  if (typeof s.tolerant !== 'boolean') throw bad('tolerant must be a boolean');
  if (s.objectFormat !== 'sha1' && s.objectFormat !== 'sha256') throw bad('object format');
  const re = oidRe(s.objectFormat);
  const oid = (v: unknown) => typeof v === 'string' && re.test(v);
  if (!s.refs || typeof s.refs !== 'object') throw bad('refs');
  for (const [r, v] of Object.entries(s.refs)) {
    if (!isAllowedRef(r)) throw new HandsfreeRefusal('bad_ref', `snapshot: ref ${JSON.stringify(r)} is not allowed`);
    if (!oid(v)) throw bad(`oid of ${r}`);
  }
  if (s.remoteRefs !== undefined) {
    for (const [r, v] of Object.entries(s.remoteRefs)) if (!r.startsWith('refs/remotes/') || !isWellFormedRef(r) || !oid(v)) throw bad(`remote ref ${r}`);
  }
  if (!Array.isArray(s.stash)) throw bad('stash');
  for (const e of s.stash) {
    // eslint-disable-next-line no-control-regex
    if (!e || !oid(e.oid) || typeof e.message !== 'string' || /[\x00\n\r]/.test(e.message) || e.message.length > 4096) throw bad('stash entry');
  }
  if (!Array.isArray(s.checkouts) || s.checkouts.length === 0) throw bad('checkouts');
  const ids = new Set<string>();
  for (const c of s.checkouts) {
    if (!c || !CHECKOUT_ID_RE.test(c.checkoutId) || c.checkoutId === 'stash' || ids.has(c.checkoutId)) throw bad('checkout id');
    ids.add(c.checkoutId);
    if (!oid(c.indexTree) || !oid(c.worktreeTree)) throw bad('trees');
    const h = c.head;
    if (h?.kind === 'symref') {
      if (!h.ref.startsWith('refs/heads/') || !isWellFormedRef(h.ref)) throw new HandsfreeRefusal('bad_head', `snapshot: HEAD ${JSON.stringify(h.ref)} is not refs/heads/*`);
      if (h.oid !== null && !oid(h.oid)) throw bad('head oid');
    } else if (h?.kind === 'detached') {
      if (!oid(h.oid)) throw new HandsfreeRefusal('bad_head', 'snapshot: detached HEAD is not a commit id');
    } else {
      throw new HandsfreeRefusal('bad_head', 'snapshot: HEAD is neither a symref nor a commit id');
    }
    if (c.inProgress) for (const [n, v] of Object.entries(c.inProgress)) if (!/^[A-Z_0-9]{1,40}$/.test(n) || !oid(v)) throw bad('in-progress ref');
  }
  return s;
}

// ---------------------------------------------------------------- bundles

export interface BundleResult {
  created: boolean;
  /** Known tips the sender does not have (dropped from the prerequisites). */
  droppedTips: string[];
}

async function waitFinished(stream: NodeJS.WritableStream): Promise<void> {
  const w = stream as NodeJS.WritableStream & { writableFinished?: boolean; writableEnded?: boolean };
  if (w.writableFinished) return;
  await new Promise<void>((res, rej) => {
    w.once('finish', () => res());
    w.once('error', rej);
    if (!w.writableEnded) w.end();
  });
}

/**
 * `git bundle create` of `refs` minus the receiver's `knownTips`. Each tip is checked on
 * the sender first (missing → dropped → the bundle is fuller, never broken). Nothing new
 * → `created: false` and nothing is written. `out` is a file path or a stream (the
 * worker's pipe); a stream is ended when the bundle is complete.
 */
export async function createBundle(
  run: ProcessRunner,
  repoPath: string,
  o: { refs: string[]; knownTips: string[]; out: string | NodeJS.WritableStream },
): Promise<BundleResult> {
  if (o.refs.length === 0) {
    if (typeof o.out !== 'string') await waitFinished(o.out);
    return { created: false, droppedTips: [] };
  }
  const tips = [...new Set(o.knownTips)];
  const present: string[] = [];
  const dropped: string[] = [];
  if (tips.length) {
    const check = await gitOut(run, repoPath, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: Buffer.from(tips.join('\n') + '\n') });
    const lines = check.split('\n').filter(Boolean);
    tips.forEach((t, i) => {
      const l = lines[i] ?? '';
      if (l.endsWith(' commit') || l.endsWith(' tag')) present.push(t);
      else dropped.push(t);
    });
  }
  const input = Buffer.from([...o.refs, ...present.map((t) => `^${t}`)].join('\n') + '\n');
  const target = typeof o.out === 'string' ? o.out : '-';
  const res = await git(run, repoPath, ['bundle', 'create', '-q', target, '--stdin'], {
    input,
    stdoutTo: typeof o.out === 'string' ? undefined : o.out,
    allowFail: true,
  });
  if (typeof o.out !== 'string') await waitFinished(o.out);
  if (res.code !== 0) {
    if (/empty bundle/i.test(res.stderr.toString())) {
      if (typeof o.out === 'string') rmSync(o.out, { force: true });
      return { created: false, droppedTips: dropped };
    }
    throw new GitError(['bundle', 'create'], res.code, res.stderr.toString());
  }
  return { created: true, droppedTips: dropped };
}

export class BundlePrerequisiteError extends Error {
  constructor(stderr: string) {
    super(`bundle prerequisites missing: ${stderr.trim().slice(0, 300)}`);
    this.name = 'BundlePrerequisiteError';
  }
}

export const incomingPrefix = (trip: string) => `refs/handsfree/incoming/${assertTripId(trip)}`;

/** Map a sender ref to its quarantine name under `refs/handsfree/incoming/<trip>/`. */
export function incomingRefFor(trip: string, ref: string): string {
  return `${incomingPrefix(trip)}/${ref.slice('refs/'.length)}`;
}

/**
 * Fetch a bundle FILE into `refs/handsfree/incoming/<trip>/*` with `transfer.fsckObjects`.
 * Only allow-listed refs are fetched: refs/heads|tags|notes/*, this trip's snap refs
 * (index/worktree/stash/in-progress), and refs/remotes/* only when `acceptRemotes` (the
 * cloud receiving from the laptop). Everything else in the bundle is ignored. Returns the
 * fetched refs by their ORIGINAL names.
 */
export async function fetchBundle(
  run: ProcessRunner,
  repoPath: string,
  bundlePath: string,
  o: { trip: string; acceptRemotes?: boolean },
): Promise<Record<string, string>> {
  const trip = assertTripId(o.trip);
  const abs = resolve(bundlePath);
  const verify = await git(run, repoPath, ['bundle', 'verify', '-q', abs], { allowFail: true });
  if (verify.code !== 0) throw new BundlePrerequisiteError(verify.stderr.toString());
  const heads = await gitOut(run, repoPath, ['bundle', 'list-heads', abs]);
  const snapPrefix = snapRefPrefix(trip) + '/';
  const accepted: Record<string, string> = {};
  for (const line of heads.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const oid = line.slice(0, sp);
    const ref = line.slice(sp + 1);
    const ok = isAllowedRef(ref)
      || (ref.startsWith(snapPrefix) && isWellFormedRef(ref))
      || (!!o.acceptRemotes && ref.startsWith('refs/remotes/') && isWellFormedRef(ref));
    if (ok) accepted[ref] = oid;
  }
  // Fresh quarantine for this trip.
  const stale = await readRefs(run, repoPath, [incomingPrefix(trip) + '/']);
  if (Object.keys(stale).length) {
    await git(run, repoPath, ['update-ref', '--stdin'], { input: Buffer.from(Object.keys(stale).map((r) => `delete ${r}`).join('\n') + '\n') });
  }
  const specs = Object.keys(accepted).map((r) => `+${r}:${incomingRefFor(trip, r)}`);
  if (specs.length) {
    await git(run, repoPath, [
      '-c', 'transfer.fsckObjects=true', '-c', 'fetch.fsckObjects=true', '-c', 'gc.auto=0',
      'fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--stdin', abs,
    ], { input: Buffer.from(specs.join('\n') + '\n') });
  }
  return accepted;
}
