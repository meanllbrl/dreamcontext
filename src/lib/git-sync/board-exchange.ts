import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { realPath } from '../real-path.js';
import { acquireFileLockWithin, releaseFileLock } from '../file-lock.js';
import { BOARD_SUFFIX, WHITEBOARDS_DIR, trashWhiteboard } from '../whiteboards/store.js';
import { mergeGroupOrderJson } from '../whiteboards/group-order.js';
import { CREDENTIAL_HELPER_DISABLE_ARGS, GitSyncError, NETWORK_OP_TIMEOUT_MS, PUSH_TIMEOUT_MS } from './git.js';
import { mergeWhiteboardMd } from './semantic-merge.js';
import { scrubContent, summarizeScrub, type ScrubHit } from './scrub.js';

/**
 * Boards travel even when the rest of the brain cannot (owner, 2026-11-18: "dream sync sends
 * everything it can; conflicts wait for sleep"). A sync whose team merge waits for /dream-sync
 * (a prose conflict) or for the human (a code conflict) moves nothing: git merges are whole. This
 * moves the boards alone, both ways, without touching the waiting merge:
 *
 *  - in: each board path the remote changed comes to disk (a board changed on both sides is
 *    merged element by element with the normal sync's own rule, `mergeWhiteboardMd`, under the
 *    board's lock, so a save from the open editor is never written over);
 *  - out: ONE commit on top of the remote tip holding only the remote's tree with our board
 *    files in it, pushed as a plain fast-forward. HEAD, the index, MERGE_HEAD and every file
 *    outside `whiteboards/` stay as they were. The later normal merge sees the same board bytes
 *    on both sides (or merges them element by element, as always).
 *
 * Never inferred from absence: a board path one side deleted is left to the normal sync (no
 * deletion is sent here). A path changed on both sides that has no element rule (a picture)
 * waits too. Symlinks and anything outside `whiteboards/` are never read or written.
 *
 * The base of each path: what this Mac and the remote last agreed on through the exchange
 * (`dc-board-exchange.json` in the git dir, this Mac only), while the same merge still waits;
 * else the waiting merge's base. The merge base alone never learns what the exchange already
 * moved (review r1): a board that came in and was then deleted by its author would be sent
 * back, and a second rename undone. With the agreed base, a board the team deleted after it
 * came in goes to this Mac's board trash (recoverable), never back to the remote.
 */

export interface BoardExchangeResult {
  /** Board files (boards, pictures, the group order) the remote got from this Mac. */
  sent: number;
  /** Board files that came to this Mac's disk. */
  received: number;
  /** Board paths left to the normal sync (deleted on one side, a corrupt board, a two-sided picture). */
  waiting: number;
  /** Why nothing was sent, when the out half stopped (a secret in a board, the remote moved twice). */
  note?: string;
  /** Why the exchange did not finish: `secret` (a board holds one), `no-session` (no GitHub
   *  sign-in), `no-git` (no git dir). Absent when it ran to the end. */
  stopped?: 'secret' | 'no-session' | 'no-git';
  /** Boards the team deleted after they came here, moved to this Mac's board trash. */
  trashed?: number;
  scrub?: { blocks: ScrubHit[]; warns: ScrubHit[] };
}

export interface BoardExchangeIo {
  /** The repo root git runs in (the sync's `gitCwd`). */
  gitCwd: string;
  /** Absolute `_dream_context/`. */
  contextRoot: string;
  /** The brain's path inside the repo (`_dream_context/` or ''), from `brainPrefix`. */
  prefix: string;
  remote: string;
  branch: string;
  /** Runs a networked step with the credential env (the sync's `GitHubAuthSession.run`). */
  network: <T>(fn: (env: NodeJS.ProcessEnv) => T | Promise<T>) => Promise<T>;
  /** Author + committer of the board commit; git's own identity when absent. */
  author?: { name: string; email: string };
  /**
   * Whether a scrub result stops the send: the sync's own gate (`isBlockingScrub` with its
   * `--strict`), so the boards' push is never weaker than the sync's other pushes. Default:
   * BLOCK hits only (the sync's non-strict gate).
   */
  blocksPush?: (scrub: { blocks: ScrubHit[]; warns: ScrubHit[] }) => boolean;
}

/** Git's own binary test: a NUL in the first 8000 bytes. Every other blob is scrubbed as text. */
export function looksLikeText(bytes: Buffer): boolean {
  return !bytes.subarray(0, 8000).includes(0);
}

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

function git(cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: Buffer; timeoutMs?: number } = {}): Buffer {
  try {
    return execFileSync('git', args, {
      cwd,
      env: opts.env,
      input: opts.input,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: 'SIGKILL' as const } : {}),
    });
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = e.stderr !== undefined ? String(e.stderr) : '';
    throw new GitSyncError(`git ${args[0] === '-c' ? args[2] : args[0]} failed: ${stderr.trim() || e.message || 'unknown error'}`, stderr || undefined);
  }
}

function text(cwd: string, args: string[]): string | null {
  try { return git(cwd, args).toString('utf-8').trim() || null; } catch { return null; }
}

interface TreeEntry { mode: string; sha: string }

/** Regular files (blobs, not links or submodules) under `dir` in `rev`, by repo path. */
function treeFiles(cwd: string, rev: string, dir: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  let raw: string;
  // An error is never read as an empty tree: with an agreed base, absence trashes (review r2).
  raw = git(cwd, ['ls-tree', '-r', '-z', rev, '--', dir]).toString('utf-8');
  for (const rec of raw.split('\0')) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(rec);
    if (!m || m[2] !== 'blob' || (m[1] !== '100644' && m[1] !== '100755')) continue;
    out.set(m[4], { mode: m[1], sha: m[3] });
  }
  return out;
}

function blob(cwd: string, sha: string): Buffer {
  return git(cwd, ['cat-file', 'blob', sha]);
}

const same = (a: Buffer | null, b: Buffer | null) => (a === null ? b === null : b !== null && a.equals(b));

/** What happens to one path: nothing, our copy goes out, theirs comes in, or a merged copy does both. */
type Pick =
  | { kind: 'none' }
  | { kind: 'wait' }
  | { kind: 'send'; bytes: Buffer }
  | { kind: 'take'; bytes: Buffer }
  | { kind: 'both'; bytes: Buffer }
  /** The team deleted it after both sides agreed on it here (`agreed` base only). */
  | { kind: 'drop' };

/**
 * The 3-way decision for one board path. Pure. `agreed`: the base is what both sides last
 * agreed on through the exchange, which the normal merge does not know, so a deletion by the
 * team is this exchange's to apply (`drop`); a merge-base base leaves it to the normal merge.
 */
export function decideBoardPath(relPath: string, base: Buffer | null, ours: Buffer | null, theirs: Buffer | null, agreed = false): Pick {
  if (same(ours, theirs)) return { kind: 'none' };
  // One side has no copy: never read as a deletion to send (the normal sync's job).
  if (theirs === null) {
    if (base !== null && same(base, ours)) return agreed ? { kind: 'drop' } : { kind: 'none' };
    return { kind: 'send', bytes: ours! };
  }
  if (ours === null) return base !== null && same(base, theirs) ? { kind: 'none' } : { kind: 'take', bytes: theirs };
  if (same(ours, base)) return { kind: 'take', bytes: theirs };
  if (same(theirs, base)) return { kind: 'send', bytes: ours };
  // Changed on both sides: the element rule for a board, the group-order rule for `.groups.json`.
  if (relPath.endsWith(BOARD_SUFFIX)) {
    const m = mergeWhiteboardMd(base?.toString('utf-8') ?? '', ours.toString('utf-8'), theirs.toString('utf-8'));
    if (m.needsAgent || m.merged === null) return { kind: 'wait' };
    const bytes = Buffer.from(m.merged, 'utf-8');
    return bytes.equals(ours) ? { kind: 'send', bytes } : { kind: 'both', bytes };
  }
  if (relPath.endsWith(`${WHITEBOARDS_DIR}/.groups.json`)) {
    const bytes = Buffer.from(mergeGroupOrderJson(base?.toString('utf-8') ?? '', ours.toString('utf-8'), theirs.toString('utf-8')), 'utf-8');
    return bytes.equals(ours) ? { kind: 'send', bytes } : { kind: 'both', bytes };
  }
  return { kind: 'wait' };
}

/**
 * The absolute disk path of a board repo path, every hop `lstat`ed: an existing hop must be a
 * real directory (never a link) and the file, when there, a regular file. Null = refuse.
 * `create` makes the missing directories (for a file that comes in).
 */
function diskPath(contextRoot: string, prefix: string, relPath: string, create: boolean): string | null {
  const head = `${prefix}${WHITEBOARDS_DIR}/`;
  if (!relPath.startsWith(head)) return null;
  const parts = relPath.slice(head.length).split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\\') || p.includes('\0'))) return null;
  const base = join(contextRoot, WHITEBOARDS_DIR);
  let cur = base;
  for (const [i, part] of [WHITEBOARDS_DIR, ...parts].entries()) {
    if (i > 0) cur = join(cur, part);
    const last = i === parts.length;
    let st;
    try { st = lstatSync(i === 0 ? base : cur); } catch { st = null; }
    if (st === null) {
      if (last) break;
      if (!create) return null;
      mkdirSync(i === 0 ? base : cur);
      continue;
    }
    if (st.isSymbolicLink()) return null;
    if (last ? !st.isFile() : !st.isDirectory()) return null;
  }
  try {
    const realBase = realPath(base);
    const realParent = realPath(join(cur, '..'));
    if (realParent !== realBase && !realParent.startsWith(realBase + sep)) return null;
  } catch { return null; }
  return cur;
}

function readDisk(contextRoot: string, prefix: string, relPath: string): Buffer | null {
  const p = diskPath(contextRoot, prefix, relPath, false);
  if (!p) return null;
  try { return lstatSync(p).isFile() ? readFileSync(p) : null; } catch { return null; }
}

function writeDisk(abs: string, bytes: Buffer): void {
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, abs);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** `whiteboards/<slug>/<slug>.excalidraw.md` → its slug (the board's lock), else null. */
function boardSlugOf(prefix: string, relPath: string): string | null {
  const m = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${WHITEBOARDS_DIR}/([^/]+)/\\1\\.excalidraw\\.md$`).exec(relPath);
  return m ? m[1]! : null;
}

/**
 * Bring one path in: decided again under the board's lock against what is on disk NOW (the open
 * editor may have saved since the first read), then written atomically. Returns the bytes now on
 * disk that the remote should hold too (null = nothing to send).
 */
async function bringIn(io: BoardExchangeIo, relPath: string, base: Buffer | null, theirs: Buffer, firstOurs: Buffer | null, agreed: boolean): Promise<{ wrote: boolean; send: Buffer | null; wait: boolean }> {
  const slug = boardSlugOf(io.prefix, relPath);
  const lockPath = slug ? join(io.contextRoot, WHITEBOARDS_DIR, '.locks', `${slug}.lock`) : null;
  if (lockPath) {
    mkdirSync(join(io.contextRoot, WHITEBOARDS_DIR, '.locks'), { recursive: true });
    const held = await acquireFileLockWithin(lockPath, { waitMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS });
    if (!held) return { wrote: false, send: null, wait: true };
  }
  try {
    const now = readDisk(io.contextRoot, io.prefix, relPath);
    const pick = decideBoardPath(relPath, base, same(now, firstOurs) ? firstOurs : now, theirs, agreed);
    if (pick.kind === 'none' || pick.kind === 'drop') return { wrote: false, send: null, wait: false };
    if (pick.kind === 'wait') return { wrote: false, send: null, wait: true };
    if (pick.kind === 'send') return { wrote: false, send: pick.bytes, wait: false };
    const abs = diskPath(io.contextRoot, io.prefix, relPath, true);
    if (!abs) return { wrote: false, send: null, wait: true };
    writeDisk(abs, pick.bytes);
    return { wrote: true, send: pick.kind === 'both' ? pick.bytes : null, wait: false };
  } finally {
    if (lockPath) releaseFileLock(lockPath);
  }
}

/** One exchange against the remote tip just fetched. `retry` = the remote moved under the push once already. */
async function exchangeOnce(io: BoardExchangeIo, retry: boolean): Promise<BoardExchangeResult & { moved?: boolean }> {
  const { gitCwd, remote, branch, prefix } = io;
  const dir = `${prefix}${WHITEBOARDS_DIR}`;
  await io.network((env) => {
    git(gitCwd, [...CREDENTIAL_HELPER_DISABLE_ARGS, 'fetch', remote, branch], { env, timeoutMs: NETWORK_OP_TIMEOUT_MS });
  });
  const tip = text(gitCwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}^{commit}`]);
  const head = text(gitCwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (!tip || !head) return { sent: 0, received: 0, waiting: 0 };
  const mergeBase = text(gitCwd, ['merge-base', head, tip]);
  const gitDir = text(gitCwd, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir) return { sent: 0, received: 0, waiting: 0, stopped: 'no-git' };
  const agreed = readAgreed(gitDir, head, mergeBase);

  const theirsTree = treeFiles(gitCwd, tip, dir);
  const baseTree = mergeBase ? treeFiles(gitCwd, mergeBase, dir) : new Map<string, TreeEntry>();
  // Ours: what git would carry from this Mac, tracked or new (ignored files stay home).
  const listed = git(gitCwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', dir]).toString('utf-8');
  const paths = new Set<string>([...theirsTree.keys(), ...listed.split('\0').filter(Boolean)]);

  let received = 0;
  let waiting = 0;
  const out = new Map<string, Buffer>();
  const drops: { slug: string; bytes: Buffer }[] = [];
  for (const relPath of [...paths].sort()) {
    if (!relPath.startsWith(`${dir}/`)) continue;
    const ours = readDisk(io.contextRoot, prefix, relPath);
    const t = theirsTree.get(relPath);
    const theirs = t ? blob(gitCwd, t.sha) : null;
    const known = agreed.has(relPath);
    const agreedSha = agreed.get(relPath);
    const b = baseTree.get(relPath);
    const base = known ? (agreedSha ? blobOrNull(gitCwd, agreedSha) : null) : (b ? blob(gitCwd, b.sha) : null);
    const pick = decideBoardPath(relPath, base, ours, theirs, known);
    if (pick.kind === 'none') continue;
    if (pick.kind === 'drop') { const slug = boardSlugOf(prefix, relPath); if (slug) drops.push({ slug, bytes: ours! }); continue; }
    if (pick.kind === 'wait') { waiting++; continue; }
    if (pick.kind === 'send') { out.set(relPath, pick.bytes); continue; }
    const r = await bringIn(io, relPath, base, theirs!, ours, known);
    if (r.wrote) received++;
    if (r.wait) waiting++;
    if (r.send) out.set(relPath, r.send);
  }
  // The team deleted these boards after both sides agreed on them here: this Mac's board trash.
  let trashed = 0;
  for (const d of drops) {
    if (!same(readDisk(io.contextRoot, prefix, `${dir}/${d.slug}/${d.slug}${BOARD_SUFFIX}`), d.bytes)) continue;
    try { await trashWhiteboard(io.contextRoot, d.slug); trashed++; } catch { waiting++; }
  }
  // The ONE place the agreement is recorded (review r2): the in half is done, so every path whose
  // disk bytes now equal the tip's IS agreed, whatever the out half does next (a secret, a failed
  // push, a moved remote). After a push it is recorded again against the pushed commit.
  const readOurs = (rel: string) => readDisk(io.contextRoot, prefix, rel);
  const agreedNow = writeAgreed(gitDir, head, mergeBase, agreed, gitCwd, tip, dir, readOurs, paths);
  const done = (r: BoardExchangeResult, remoteTip: string): BoardExchangeResult => {
    if (remoteTip !== tip) writeAgreed(gitDir, head, mergeBase, agreedNow, gitCwd, remoteTip, dir, readOurs, paths);
    return trashed ? { ...r, trashed } : r;
  };
  if (out.size === 0) return done({ sent: 0, received, waiting }, tip);

  // Every text going out is scrubbed first, through the sync's own gate (strict included).
  const hits: ScrubHit[] = [];
  for (const [relPath, bytes] of out) {
    if (looksLikeText(bytes)) hits.push(...scrubContent(relPath, bytes.toString('utf-8')));
  }
  const scrub = summarizeScrub(hits);
  const blocksPush = io.blocksPush ?? ((s: { blocks: ScrubHit[] }) => s.blocks.length > 0);
  if (blocksPush(scrub)) {
    return { sent: 0, received, waiting, scrub, stopped: 'secret', note: 'A board looks like it holds a secret, so no board was sent. Remove it and sync again.', ...(trashed ? { trashed } : {}) };
  }

  const idx = join(gitDir, `dc-board-exchange-${process.pid}-${Date.now()}.idx`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  let commit: string;
  try {
    git(gitCwd, ['read-tree', tip], { env });
    for (const [relPath, bytes] of out) {
      const sha = git(gitCwd, ['hash-object', '-w', '--stdin'], { input: bytes }).toString('utf-8').trim();
      const mode = theirsTree.get(relPath)?.mode ?? '100644';
      git(gitCwd, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${relPath}`], { env });
    }
    const tree = git(gitCwd, ['write-tree'], { env }).toString('utf-8').trim();
    if (tree === text(gitCwd, ['rev-parse', `${tip}^{tree}`])) return done({ sent: 0, received, waiting }, tip);
    const who = io.author
      ? { GIT_AUTHOR_NAME: io.author.name, GIT_AUTHOR_EMAIL: io.author.email, GIT_COMMITTER_NAME: io.author.name, GIT_COMMITTER_EMAIL: io.author.email }
      : {};
    commit = git(gitCwd, ['commit-tree', tree, '-p', tip, '-m', 'chore(brain): boards sync'], { env: { ...process.env, ...who } }).toString('utf-8').trim();
  } finally {
    rmSync(idx, { force: true });
  }

  try {
    await io.network((netEnv) => {
      git(gitCwd, [...CREDENTIAL_HELPER_DISABLE_ARGS, 'push', remote, `${commit}:refs/heads/${branch}`], { env: netEnv, timeoutMs: PUSH_TIMEOUT_MS });
    });
  } catch (err) {
    const stderr = (err as GitSyncError).stderr ?? '';
    // The remote moved between the fetch and the push: once more on the new tip.
    if (!retry && /non-fast-forward|fetch first|rejected/i.test(stderr)) return { sent: 0, received, waiting, moved: true, ...(trashed ? { trashed } : {}) };
    throw err;
  }
  // The remote-tracking ref follows (git does this on a named remote; kept explicit).
  try { git(gitCwd, ['update-ref', `refs/remotes/${remote}/${branch}`, commit, tip]); } catch { /* already moved by the push */ }
  return done({ sent: out.size, received, waiting, ...(scrub.warns.length ? { scrub } : {}) }, commit);
}

/** The per-path state this Mac and the remote last agreed on, in the git dir (never synced). */
const AGREED_FILE = 'dc-board-exchange.json';

interface AgreedRecord { head: string; mergeBase: string | null; paths: Record<string, string | null> }

/**
 * What the exchange last left equal on both sides, by path (blob sha, null = absent on both).
 * Only while the same merge waits: a new HEAD or merge base means the normal merge has moved on
 * and its own base is right again, so the record is dropped.
 */
function readAgreed(gitDir: string, head: string, mergeBase: string | null): Map<string, string | null> {
  const file = join(gitDir, AGREED_FILE);
  try {
    if (!existsSync(file) || !lstatSync(file).isFile()) return new Map();
    const rec = JSON.parse(readFileSync(file, 'utf-8')) as AgreedRecord;
    if (rec.head !== head || (rec.mergeBase ?? null) !== (mergeBase ?? null) || typeof rec.paths !== 'object' || rec.paths === null) return new Map();
    return new Map(Object.entries(rec.paths).filter(([, v]) => v === null || (typeof v === 'string' && /^[0-9a-f]{40,64}$/.test(v))));
  } catch { return new Map(); }
}

/** After a finished exchange: every path whose disk bytes equal the remote's is agreed now. */
function writeAgreed(
  gitDir: string, head: string, mergeBase: string | null, prev: Map<string, string | null>,
  cwd: string, remoteTip: string, dir: string, readOurs: (rel: string) => Buffer | null, paths: Set<string>,
): Map<string, string | null> {
  const remote = treeFiles(cwd, remoteTip, dir);
  const next = new Map(prev);
  for (const rel of paths) {
    const t = remote.get(rel);
    const theirs = t ? blob(cwd, t.sha) : null;
    if (!same(readOurs(rel), theirs)) continue;
    next.set(rel, t ? t.sha : null);
  }
  const rec: AgreedRecord = { head, mergeBase, paths: Object.fromEntries(next) };
  try { writeDisk(join(gitDir, AGREED_FILE), Buffer.from(JSON.stringify(rec), 'utf-8')); } catch { /* the next press falls back to the merge base */ }
  return next;
}

function blobOrNull(cwd: string, sha: string): Buffer | null {
  try { return blob(cwd, sha); } catch { return null; }
}

export async function exchangeBoards(io: BoardExchangeIo): Promise<BoardExchangeResult> {
  const first = await exchangeOnce(io, false);
  if (!first.moved) return first;
  const second = await exchangeOnce(io, true);
  const trashed = (first.trashed ?? 0) + (second.trashed ?? 0);
  return { ...second, received: second.received + first.received, ...(trashed ? { trashed } : {}) };
}
