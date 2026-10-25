import { spawn, execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { GIT_SAFE_ARGS } from '../super/worktrees.js';

/**
 * Fill a task worktree made with `--no-checkout` straight from git's object store, byte for byte
 * (AI Team v2 C1-6; owner decision 2026-10-25, "ham checkout": close the class).
 *
 * A checkout passes every file through the repo's conversions: smudge filters, `ident`, eol. Those
 * are configured in a repo config the agent working in the task can write (the worktree shares
 * it), and git can be told about a filter in ways no list of overrides keeps up with (a driver in
 * an `includeIf` that applies only on the task branch, a name `-c` cannot express). So the HOST
 * never asks git to convert content: it reads the commit's tree (`ls-tree`), takes each blob raw
 * (`cat-file --batch`, which runs no filter), writes it, and records the index (`read-tree`, which
 * touches no file). Every call runs with `--no-lazy-fetch` (TASK_GIT_ARGS): in a partial clone a
 * missing object would otherwise be fetched through a transport the same config names
 * (`core.sshCommand`, `remote.*.uploadpack`), and that program would run here. A git older than
 * 2.44 rejects the flag, so the fill fails closed and the task is blocked. Nothing configured in
 * the repo runs here. The agent's own git commands later run in its session, under its level.
 *
 * What it costs: files git would have converted arrive as stored (a git-lfs file is its pointer;
 * the agent can `git lfs pull` itself), objects a partial clone never fetched are refused, and the
 * index carries no stat data until the agent's first `git status` refreshes it. Submodules are
 * left as empty folders.
 */

/** The task path's git: Super's safe set, plus no lazy fetch of missing objects. */
export const TASK_GIT_ARGS: readonly string[] = ['--no-lazy-fetch', ...GIT_SAFE_ARGS];

const MARKER = 'dreamcontext-raw-checkout';
const GIT_TIMEOUT_MS = 2 * 60_000;
/** The blob stream's own bound: a fill that stalls this long is refused, never waited on. */
const FILL_TIMEOUT_MS = 15 * 60_000;
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };

function gitSync(cwd: string, args: string[]): Buffer {
  return execFileSync('git', [...TASK_GIT_ARGS, ...args], {
    cwd, env: GIT_ENV, timeout: GIT_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** The worktree's own git dir (`.git/worktrees/<name>`), where the done-marker lives. */
function worktreeGitDir(wt: string): string {
  const raw = gitSync(wt, ['rev-parse', '--git-dir']).toString('utf8').trim();
  return isAbsolute(raw) ? raw : resolve(wt, raw);
}

/** Whether this worktree was already filled (a crash between the add and the fill refills it). */
export function rawCheckoutDone(wt: string): boolean {
  try {
    return existsSync(join(worktreeGitDir(wt), MARKER));
  } catch {
    return false;
  }
}

interface TreeEntry { mode: string; type: string; sha: string; path: string }

function listTree(wt: string): TreeEntry[] {
  const out = gitSync(wt, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD']).toString('utf8');
  const entries: TreeEntry[] = [];
  for (const rec of out.split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t');
    const [mode, type, sha] = rec.slice(0, tab).split(' ');
    entries.push({ mode, type, sha, path: rec.slice(tab + 1) });
  }
  return entries;
}

/** Where one blob's bytes go as they arrive; `end` once the whole blob is through. */
interface BlobSink { write(chunk: Buffer): void; end(): void }

/**
 * Stream `shas` through ONE `git cat-file --batch` (no --filters, no textconv). Each blob's body is
 * handed to the sink `onBlob` opens for it chunk by chunk, as it arrives: no blob is ever held
 * whole, whatever its size. Rejects on a missing object, a git error, a sink's throw, or the fill
 * timeout.
 */
function streamBlobs(wt: string, shas: string[], onBlob: (sha: string, size: number) => BlobSink): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn('git', [...TASK_GIT_ARGS, 'cat-file', '--batch'], { cwd: wt, env: GIT_ENV, stdio: ['pipe', 'pipe', 'ignore'] });
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) { try { child.kill('SIGKILL'); } catch { /* gone */ } fail(err); } else done();
    };
    const timer = setTimeout(() => finish(new Error('the raw fill timed out')), FILL_TIMEOUT_MS);
    // Only a header's unfinished bytes are ever kept between chunks; a body goes straight out.
    let buf: Buffer = Buffer.alloc(0);
    let want: { size: number; got: number; sink: BlobSink } | null = null;
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      try {
        for (;;) {
          if (!want) {
            const nl = buf.indexOf(0x0a);
            if (nl < 0) return;
            const [sha, type, size] = buf.subarray(0, nl).toString('utf8').split(' ');
            buf = buf.subarray(nl + 1);
            if (type === 'missing' || size === undefined) { finish(new Error(`object ${sha} is not in this clone (a partial clone? fetch it first)`)); return; }
            want = { size: Number(size), got: 0, sink: onBlob(sha, Number(size)) };
          }
          if (want.got < want.size) {
            const take = Math.min(buf.length, want.size - want.got);
            if (take) { want.sink.write(buf.subarray(0, take)); want.got += take; buf = buf.subarray(take); }
            if (want.got < want.size) return;
          }
          if (!buf.length) return; // the newline after the body is still coming
          buf = buf.subarray(1);
          want.sink.end();
          want = null;
        }
      } catch (err) {
        finish(err as Error);
      }
    });
    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      if (code !== 0) finish(new Error(`git cat-file --batch exited ${code}`));
      else if (want || buf.length) finish(new Error('git cat-file --batch ended mid-object'));
      else finish();
    });
    child.stdin.on('error', () => { /* the close handler reports it */ });
    child.stdin.end(shas.join('\n') + (shas.length ? '\n' : ''));
  });
}

/** A tree path that stays inside the worktree: relative, no `..`, no `.git` component. */
function safeRel(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes('\0')) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

/** No component on the way to `abs` (inside `root`) is a symlink: a write never leaves the worktree. */
function parentsAreDirs(root: string, rel: string): boolean {
  const parts = rel.split('/').slice(0, -1);
  let cur = root;
  for (const p of parts) {
    cur = join(cur, p);
    try {
      if (lstatSync(cur).isSymbolicLink()) return false;
    } catch {
      // not there yet: it is created as a real folder
    }
  }
  return true;
}

function target(root: string, e: TreeEntry): string {
  if (!safeRel(e.path)) throw new Error(`refusing a tree path outside the worktree: ${JSON.stringify(e.path)}`);
  const abs = join(root, ...e.path.split('/'));
  if (!abs.startsWith(root + sep)) throw new Error(`refusing a tree path outside the worktree: ${JSON.stringify(e.path)}`);
  if (!parentsAreDirs(root, e.path)) throw new Error(`refusing to write through a symlink: ${JSON.stringify(e.path)}`);
  mkdirSync(join(abs, '..'), { recursive: true });
  return abs;
}

/** A symlink's target is a path: anything longer is not one, and is never buffered. */
const LINK_MAX = 4096;
const COPY_CHUNK = 1024 * 1024;

/** Remove whatever sits at `abs` and create the file anew (`wx`): a link or a hard link there is
 *  replaced, never written through. */
function createFresh(abs: string, e: TreeEntry): number {
  rmSync(abs, { force: true });
  return openSync(abs, 'wx', e.mode === '100755' ? 0o755 : 0o644);
}

function writeAll(fd: number, chunk: Buffer): void {
  for (let off = 0; off < chunk.length;) off += writeSync(fd, chunk, off, chunk.length - off);
}

/** A second path with the same blob: copied from the first one written, in bounded reads. */
function copyFresh(src: string, abs: string, e: TreeEntry): void {
  const from = openSync(src, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const to = createFresh(abs, e);
    try {
      const chunk = Buffer.allocUnsafe(COPY_CHUNK);
      for (let n; (n = readSync(from, chunk, 0, COPY_CHUNK, null)) > 0;) writeAll(to, chunk.subarray(0, n));
    } finally {
      closeSync(to);
    }
  } finally {
    closeSync(from);
  }
}

/**
 * Fill `wt` (made with `--no-checkout`, HEAD on the task branch) from HEAD's tree, raw. Idempotent:
 * re-run on a worktree a crash left half filled, it rewrites every tracked file. Every file is
 * removed and created anew (`wx`), so a link or a hard link sitting at a tracked path is replaced,
 * never written through. Throws on a git error, a missing object, a path that would leave the
 * worktree, or a write through a symlink.
 */
export async function rawCheckout(wt: string): Promise<void> {
  const root = resolve(wt);
  const entries = listTree(wt);
  for (const e of entries.filter((x) => x.type === 'commit')) mkdirSync(target(root, e), { recursive: true });
  const files = new Map<string, TreeEntry[]>();
  const links: TreeEntry[] = [];
  for (const e of entries) {
    if (e.type !== 'blob') continue;
    if (e.mode === '120000') { links.push(e); continue; }
    files.set(e.sha, [...(files.get(e.sha) ?? []), e]);
  }
  const linkTargets = new Map<string, string>();
  const linkShas = new Set(links.map((l) => l.sha));
  let open: number | null = null;
  // Files as their blobs arrive, written straight through; link targets are kept (they are short)
  // and made last, so a link made by this pass is never on the way to a file it writes.
  try {
    await streamBlobs(wt, [...new Set([...files.keys(), ...linkShas])], (sha, size) => {
      const paths = files.get(sha) ?? [];
      const keepLink = linkShas.has(sha);
      if (keepLink && size > LINK_MAX) throw new Error(`refusing a symlink target of ${size} bytes`);
      const linkChunks: Buffer[] = [];
      const first = paths.length ? target(root, paths[0]) : null;
      open = first ? createFresh(first, paths[0]) : null;
      return {
        write(chunk) {
          if (open !== null) writeAll(open, chunk);
          if (keepLink) linkChunks.push(Buffer.from(chunk));
        },
        end() {
          if (open !== null) { closeSync(open); open = null; }
          if (first) for (const e of paths.slice(1)) copyFresh(first, target(root, e), e);
          if (keepLink) linkTargets.set(sha, Buffer.concat(linkChunks).toString('utf8'));
        },
      };
    });
  } finally {
    if (open !== null) closeSync(open);
  }
  for (const e of links) {
    const abs = target(root, e);
    rmSync(abs, { force: true });
    symlinkSync(linkTargets.get(e.sha) ?? '', abs);
  }
  // The index, from the commit, without touching a file (no stat data: the agent's first status fills it).
  gitSync(wt, ['read-tree', 'HEAD']);
  writeFileSync(join(worktreeGitDir(wt), MARKER), `${new Date().toISOString()}\n`);
}
