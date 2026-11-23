import { closeSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { safeVaultPath } from './vault-read.js';

/**
 * Every task file's FRONTMATTER, for the scans that read only it (who a task is assigned to, its
 * status, its id): the agents' usage list and the outside-assignment scan. Each of them parsed
 * every task file's YAML on every call, and both run when the app opens (the Team page, the
 * owner inbox) and on every tick: on a 900-task brain that was over a second of the server's only
 * thread (task: opening the app is slow, 2026-11-23).
 *
 * One memo for both, keyed by the file, valid while its stamp (inode, size, mtime, ctime) holds:
 * a write from anywhere (this process, the CLI, a pull) moves the stamp and the file is read
 * again. A miss reads through `safeVaultPath` (no symlink, never outside the brain), and only the
 * file's head: a task file can carry a long log (the brain's task folder is 100 MB), and reading
 * every file whole was most of the first scan's time. A hit is a stamp taken with `lstat`, so a
 * file replaced by a symlink is a miss and is refused there.
 *
 * The returned objects are SHARED with the memo: read them, never change them.
 */
export interface TaskHead {
  /** The file name without `.md`. */
  slug: string;
  /** The frontmatter; `{}` when the YAML does not parse. */
  data: Readonly<Record<string, unknown>>;
  /** The YAML did not parse (the file assigns nobody). */
  broken: boolean;
}

const MEMO_MAX = 8192;
const memo = new Map<string, { stamp: string; head: TaskHead }>();
const TASK_FILE = /^[a-z0-9][a-z0-9-]*\.md$/;
const HEAD_CHUNK = 16 * 1024;
/** Past this the frontmatter is read no further: a head that long is not a task's. */
const HEAD_MAX = 1024 * 1024;

/**
 * The frontmatter block of a file (`---` line to the closing `---` line, both kept), read a
 * chunk at a time; the whole text read so far when the file has no frontmatter or no closing line.
 */
export function readFrontmatterText(abs: string): string {
  const fd = openSync(abs, 'r');
  try {
    const parts: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.alloc(HEAD_CHUNK);
      const n = readSync(fd, buf, 0, HEAD_CHUNK, total);
      if (n <= 0) break;
      parts.push(n < HEAD_CHUNK ? buf.subarray(0, n) : buf);
      total += n;
      const text = Buffer.concat(parts).toString('utf-8');
      if (!/^---[ \t]*\r?\n/.test(text)) return text;
      const close = /\r?\n---[ \t]*(\r?\n|$)/.exec(text.slice(3));
      // The closing line, whole (a chunk boundary inside it reads one more chunk).
      if (close && (close[1] !== '' || n < HEAD_CHUNK)) return text.slice(0, 3 + close.index + close[0].length);
      if (total >= HEAD_MAX) return text;
    }
    return Buffer.concat(parts).toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

function stampOf(abs: string): string | null {
  try {
    const st = lstatSync(abs);
    if (!st.isFile()) return null;
    return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  } catch {
    return null;
  }
}

/** One task file's head, by its stamp. Null: missing, a symlink, not a file, outside the brain. */
export function readTaskHead(contextRoot: string, fileName: string): TaskHead | null {
  const abs = join(contextRoot, 'state', fileName);
  const stamp = stampOf(abs);
  if (stamp === null) {
    memo.delete(abs);
    return null;
  }
  const hit = memo.get(abs);
  if (hit && hit.stamp === stamp) return hit.head;
  const safe = safeVaultPath(contextRoot, join('state', fileName));
  let raw: string | null = null;
  try {
    raw = safe ? readFrontmatterText(safe) : null;
  } catch {
    raw = null;
  }
  if (raw === null) {
    memo.delete(abs);
    return null;
  }
  let head: TaskHead;
  try {
    const data = matter(raw, {}).data;
    head = { slug: fileName.slice(0, -3), data: data && typeof data === 'object' ? (data as Record<string, unknown>) : {}, broken: false };
  } catch {
    head = { slug: fileName.slice(0, -3), data: {}, broken: true };
  }
  // Cached only when the file did not move during the read (a write landing mid-read).
  if (stampOf(abs) === stamp) {
    memo.delete(abs);
    memo.set(abs, { stamp, head });
    while (memo.size > MEMO_MAX) {
      const oldest = memo.keys().next();
      if (oldest.done) break;
      memo.delete(oldest.value);
    }
  }
  return head;
}

/** Every task file's head under `state/`, in file-name order. */
export function readTaskHeads(contextRoot: string): TaskHead[] {
  let names: string[];
  try {
    names = readdirSync(join(contextRoot, 'state')).filter((n) => TASK_FILE.test(n)).sort();
  } catch {
    return [];
  }
  const out: TaskHead[] = [];
  for (const name of names) {
    const head = readTaskHead(contextRoot, name);
    if (head) out.push(head);
  }
  return out;
}

/** Tests only: forget every memoized head. */
export function resetTaskHeadsForTests(): void {
  memo.clear();
}
