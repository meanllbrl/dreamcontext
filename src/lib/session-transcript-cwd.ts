import { openSync, closeSync, readSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { repoToplevel } from './git-sync/git.js';
import { isSameRepository } from './session-cwd.js';
import { findTranscriptBySessionId, isSafeSessionId } from './transcript-locate.js';

/**
 * WHICH CHECKOUT a chat session is in, read from the conversation's own TRANSCRIPT.
 *
 * `session-cwd.ts` answers the same question from the stdout stream, and it can only follow a
 * move it has a frame for — the harness's `EnterWorktree`/`ExitWorktree` tools. This module is
 * the answer for every OTHER way a session changes checkout, and there are several:
 *
 *   • a manual `git worktree add` + `cd` (no tool frame at all — the case the owner
 *     photographed on 2026-08-25, a run in `eur-multicurrency` under a tag reading `main`);
 *   • a plain `git checkout -b` in the main checkout (not a move at all, a BRANCH change, and
 *     the tool-frame reader is structurally blind to it);
 *   • a `cd` back OUT of a worktree, which leaves the override registry holding a directory
 *     the session has left.
 *
 * ── Why the transcript and not the stream ─────────────────────────────────────────────
 * Measured on this machine, 2026-08-25, against `claude -p --output-format stream-json`: the
 * stdout stream carries `cwd` on ONE frame, `system:init`, and never again — so a stream reader
 * learns the spawn directory and nothing after it. The transcript JSONL is the opposite: every
 * substantive entry carries `cwd` AND `gitBranch`, and both UPDATE mid-session. Verified across
 * 17 transcripts in this project's history, e.g.
 *
 *   0fa06136 → cwd {projectRoot, …/dashboard/src/components/sleepy/chat}, gitBranch {main,
 *              feat/shelf-pin-drop}          ← a branch change with no move
 *   dd1cf0b2 → cwd {projectRoot, …/.claude/worktrees/claude-auth-live-refresh}, gitBranch
 *              {main, worktree-claude-auth-live-refresh}   ← a move
 *
 * Only `cwd` is read here. The BRANCH is deliberately re-read from git at the resolved
 * directory (`session-facts.ts`) rather than taken from the transcript's `gitBranch`: the
 * transcript records what was true when the entry was written, and a fact surface whose whole
 * promise is "you never have to re-ask" must not serve a branch from a log line.
 *
 * ── Why a subdirectory is not the answer ──────────────────────────────────────────────
 * The Bash tool's working directory persists between calls, so `cwd` routinely drifts DOWN into
 * the tree — `…/dashboard`, `…/dashboard/src/components/sleepy/chat` in the capture above. Git
 * answers the same branch from a subdirectory, so a naive pass would look correct; but
 * `worktreeName` is `basename(dir)`, and the shelf would have gone on to name the checkout
 * `chat`. Every directory is therefore resolved to its checkout ROOT before it is returned.
 *
 * ── Never throws, and never guesses ───────────────────────────────────────────────────
 * Same contract as `session-cwd.ts`: a missing transcript, an unreadable file, a truncated
 * line, a directory in a FOREIGN repository and a directory that has since been removed all
 * answer `null`, and `null` means "this module has nothing to say" — the caller falls back to
 * the override registry and then to the project root. It never invents a checkout.
 */

/**
 * How far back from the end of the transcript to look for an entry carrying `cwd`, in bytes,
 * in escalation order.
 *
 * A transcript's last entries are usually small (a `result`, a `queue-operation`) but ONE of
 * them can be enormous — a tool result holding a whole file is routine in this repo, and a
 * fixed 64 KB tail would then contain no complete entry at all. So the tail grows until an
 * answer is found or the whole file has been read. The escalation stops mattering after the
 * first hit, which in practice is the first chunk.
 */
export const TAIL_STEPS_BYTES = [64 * 1024, 1024 * 1024, 8 * 1024 * 1024];

/** How long a resolved directory is reused for one raw `cwd` string. Mirrors
 *  `SESSION_FACTS_TTL_MS`'s reasoning: shorter than the shelf's 15s poll, so it can never mask
 *  a real change, and its job is the concurrent case (several panes, one tick). */
const RESOLVE_TTL_MS = 12_000;

/** Bounded because it is keyed by any directory a transcript names, not by the handful of
 *  project roots this server serves. Oldest-first eviction; a dropped entry costs one fork. */
const MAX_RESOLVE_CACHE = 128;

interface TailMemo { mtimeMs: number; size: number; cwd: string | null }
interface ResolveMemo { root: string | null; at: number }

const tails = new Map<string, TailMemo>();
const resolved = new Map<string, ResolveMemo>();

/** Same bound and reasoning as `session-cwd.ts`'s `MAX_TRACKED_SESSIONS`: far above any real
 *  pane count, far below anything that matters for memory. */
const MAX_TRACKED_TRANSCRIPTS = 64;

function remember<T>(map: Map<string, T>, key: string, value: T, cap: number): T {
  map.delete(key);
  map.set(key, value);
  while (map.size > cap) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
  return value;
}

/**
 * Read the last `bytes` of `file`, or the whole file when it is shorter.
 *
 * `openSync`/`readSync` rather than `readFileSync`: the point of this module's tail is that a
 * 40 MB transcript is not loaded to answer a question the last kilobyte settles.
 */
function readTail(file: string, size: number, bytes: number): { text: string; fromStart: boolean } | null {
  const want = Math.min(bytes, size);
  const start = size - want;
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.allocUnsafe(want);
    let filled = 0;
    while (filled < want) {
      const n = readSync(fd, buf, filled, want - filled, start + filled);
      if (n <= 0) break;
      filled += n;
    }
    return { text: buf.subarray(0, filled).toString('utf-8'), fromStart: start === 0 };
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

/**
 * The newest absolute `cwd` in `text`, scanning entries NEWEST-FIRST.
 *
 * The backward scan is not an optimisation, it is the semantics: the last line of a transcript
 * is frequently a `queue-operation` or a `system` entry that carries no `cwd` at all (measured:
 * the two leading entries of every transcript in this project), so "the last line" is the wrong
 * answer and "the last line that says something" is the right one.
 *
 * When the tail did not start at byte 0 its FIRST line is a fragment of an entry that began
 * before the window. It is dropped rather than parsed — a half-line cannot be valid JSON, so
 * parsing it would merely be a guaranteed-failed `JSON.parse` per call, but dropping it is also
 * what makes `fromStart` meaningful to the caller's escalation.
 */
export function newestCwdIn(text: string, fromStart: boolean): string | null {
  const lines = text.split('\n');
  const floor = fromStart ? 0 : 1;
  for (let i = lines.length - 1; i >= floor; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj: unknown;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    const cwd = (obj as { cwd?: unknown }).cwd;
    if (typeof cwd === 'string' && isAbsolute(cwd)) return cwd;
  }
  return null;
}

/** The raw newest `cwd` for a conversation, memoized on the transcript's mtime AND size.
 *  Both, because a same-millisecond append is the normal case during a live turn and size is
 *  what actually moves then. */
function newestCwd(conversationId: string, home?: string): string | null {
  const file = home
    ? findTranscriptBySessionId([conversationId], home)
    : findTranscriptBySessionId([conversationId]);
  if (!file) return null;

  let stat: { mtimeMs: number; size: number };
  try { stat = statSync(file); } catch { return null; }

  const hit = tails.get(conversationId);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.cwd;
  if (stat.size === 0) {
    return remember(tails, conversationId, { ...stat, cwd: null }, MAX_TRACKED_TRANSCRIPTS).cwd;
  }

  for (const bytes of TAIL_STEPS_BYTES) {
    const tail = readTail(file, stat.size, bytes);
    if (!tail) break;
    const cwd = newestCwdIn(tail.text, tail.fromStart);
    if (cwd) return remember(tails, conversationId, { ...stat, cwd }, MAX_TRACKED_TRANSCRIPTS).cwd;
    if (tail.fromStart) break; // the whole file has been read; there is no cwd in it
  }
  return remember(tails, conversationId, { ...stat, cwd: null }, MAX_TRACKED_TRANSCRIPTS).cwd;
}

/** A raw `cwd` resolved to its checkout ROOT and gated to `projectRoot`'s repository, or null.
 *  Memoized because it forks git and the answer for a given directory does not change while
 *  the directory exists — and the case where it DOES (the worktree was removed) is caught by
 *  the TTL rather than by a watcher. */
function checkoutRootOf(cwd: string, projectRoot: string, now: number): string | null {
  const key = `${cwd} ${projectRoot}`;
  const hit = resolved.get(key);
  if (hit && now - hit.at < RESOLVE_TTL_MS) return hit.root;

  const top = repoToplevel(cwd);
  const root = top && isSameRepository(top, projectRoot) ? top : null;
  return remember(resolved, key, { root, at: now }, MAX_RESOLVE_CACHE).root;
}

/**
 * The checkout `conversationId` is working in according to its transcript, or `null`.
 *
 * `null` is not a failure the caller handles as an error — it is "ask the next source". A
 * conversation with no transcript yet (a pane opened and never used), a transcript whose
 * entries carry no `cwd`, a directory outside this repository and a directory that has been
 * removed all answer `null`, and the caller falls back exactly as it did before this module
 * existed.
 *
 * Consequence worth knowing at the call site: the returned path is a REALPATH, because it comes
 * from `git rev-parse --show-toplevel`. Same property `session-facts.ts` documents for
 * `mainRoot`, and for the same reason — do not compare it to a vault path by string equality
 * without canonicalising that too. Nothing downstream needs to: `readSessionFacts` only runs
 * `git` inside it, and on macOS (`/var` → `/private/var`) the un-canonicalised form is the one
 * that would have been the surprise.
 *
 * `home` and `now` are TEST SEAMS. Production callers pass neither.
 */
export function transcriptCheckout(
  conversationId: string | null,
  projectRoot: string,
  opts: { home?: string; now?: number } = {},
): string | null {
  if (!conversationId || !isSafeSessionId(conversationId)) return null;
  const cwd = newestCwd(conversationId, opts.home);
  if (!cwd) return null;
  return checkoutRootOf(cwd, projectRoot, opts.now ?? Date.now());
}

/** TEST SEAM, same contract as `resetSessionCheckouts`/`resetSessionFactsCaches`: the two
 *  memos above are process-global by design, so a test that appends to a real transcript
 *  inside one TTL window needs a way to ask for a clean read. Production code never calls it. */
export function resetTranscriptCheckoutCaches(): void {
  tails.clear();
  resolved.clear();
}
