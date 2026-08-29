import { realpathSync, statSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { repoToplevel } from './git-sync/git.js';
import { isGovernedCheckout } from './session-cwd.js';

/**
 * WHERE a session's WRITES are landing, counted per checkout.
 *
 * `session-cwd.ts` and `session-transcript-cwd.ts` answer where the session IS, and
 * `checkout-directive.ts` lets it say where its work BELONGS. This module exists for the
 * question the owner asked of all three: what if the agent never says anything?
 *
 * ── Why this watches, and does not steer ──────────────────────────────────────────────
 * It would be easy to point the shelf at whichever checkout was edited last. That was
 * considered and refused (2026-08-28): a file path is a side effect, not a statement. One turn
 * routinely writes into several checkouts, so "the newest edit" makes the chip flicker between
 * them mid-run, and a chip that moves on its own is a chip nobody can rely on.
 *
 * So this module never changes the answer. It only makes a DISAGREEMENT visible: the shelf says
 * A, the writes went to B, and the user is told so on the chip they were already reading. What
 * it reports is a measurement, not an inference — the path came off the wire, and either it is
 * inside another checkout or it is not.
 *
 * ── The one exclusion, and why it is not optional ─────────────────────────────────────
 * Writes under `_dream_context/` are NOT counted. A session working in a worktree still logs
 * tasks, changelog entries and knowledge into the brain, from the brain's own checkout, because
 * `state/` is gitignored and a worktree's copy of the brain is a second brain nobody merges
 * (knowledge/worktrees-and-the-brain.md). That traffic is the system working as designed —
 * counted, it would fire this warning during every correctly-behaving session, and a warning
 * that is always on is a warning nobody reads. Measured on this machine the same day: 19 of 19
 * write frames across the live Tilki sessions were brain writes.
 */

/** What the shelf is told: writes are landing somewhere other than the checkout it names. */
export interface EditsElsewhere {
  /** The checkout root those writes went to. */
  dir: string;
  /** Its directory name — the word the chip's note can actually use. */
  name: string;
  /** How many write frames landed there this session. */
  count: number;
}

/** Far above any real session's spread (a turn touches one or two checkouts), far below
 *  anything that matters for memory. */
const MAX_TRACKED_SESSIONS = 64;
const MAX_ROOTS_PER_SESSION = 8;

/** `dirname` → checkout root, memoized: consecutive edits in one directory are the norm, and
 *  each miss costs a `git` fork. Bounded, oldest-first, and deliberately NOT time-limited —
 *  a directory does not change repositories while a session is open, and the governed check
 *  that follows it is re-run on every read anyway. */
const rootOfDir = new Map<string, string | null>();
const MAX_DIR_CACHE = 256;

/** sessionKey → (checkout root → write count). Insertion-ordered for the same
 *  oldest-first eviction the other registries use. */
const edits = new Map<string, Map<string, number>>();

function remember<K, V>(map: Map<K, V>, key: K, value: V, cap: number): V {
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
 * The deepest ANCESTOR of `dir` that exists on disk, or null.
 *
 * A `Write` legitimately names a file in a directory that does not exist yet — that is what
 * `Write` is for — and `git -C <missing dir>` answers nothing at all. Without this, the first
 * file of a new feature is invisible to the warning and every file after it is not, which is
 * the confusing half of a bug rather than the safe half. Bounded so a pathological path cannot
 * walk to `/` one syscall at a time.
 */
function nearestExisting(dir: string): string | null {
  let cur = dir;
  for (let i = 0; i < 24; i += 1) {
    try { if (statSync(cur).isDirectory()) return cur; } catch { /* keep walking up */ }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

/** A path as the filesystem itself spells it.
 *
 *  `repoToplevel` answers a REALPATH (git canonicalises), while a checkout the shelf resolved
 *  through the override registry is whatever string the frame carried. On macOS those are
 *  `/private/var/…` and `/var/…` for one directory, and comparing them raw would report every
 *  session under a symlinked path as writing "elsewhere" — into the checkout it is standing in.
 *  Exactly the trap `session-facts.ts`'s `readWorktree` documents. */
function canonical(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/** Is this path one of the brain's own files? See the header — this is the exclusion that
 *  keeps the warning meaningful. Matched on a PATH SEGMENT, so a directory merely ending in
 *  `_dream_context` (or a file named that) is not swept up with it. */
export function isBrainPath(path: string): boolean {
  return path.split(sep).includes('_dream_context');
}

/**
 * Record that `path` was written by `sessionKey`, if it is a write worth counting.
 *
 * Returns the checkout root it was attributed to, or null when the write was not counted —
 * a brain file, a relative path, a file outside every repository this vault governs, or one
 * git cannot resolve. Never throws.
 */
export function recordSessionEdit(
  sessionKey: string,
  path: string,
  projectRoot: string,
): string | null {
  if (!sessionKey || !path || !path.startsWith('/')) return null;
  if (isBrainPath(path)) return null;

  const dir = dirname(path);
  let root: string | null | undefined = rootOfDir.get(dir);
  if (root === undefined) {
    const from = nearestExisting(dir);
    root = remember(rootOfDir, dir, from ? repoToplevel(from) : null, MAX_DIR_CACHE);
  }
  if (!root || !isGovernedCheckout(root, projectRoot)) return null;

  const counts = edits.get(sessionKey) ?? new Map<string, number>();
  counts.set(root, (counts.get(root) ?? 0) + 1);
  while (counts.size > MAX_ROOTS_PER_SESSION) {
    const oldest = counts.keys().next();
    if (oldest.done) break;
    counts.delete(oldest.value);
  }
  remember(edits, sessionKey, counts, MAX_TRACKED_SESSIONS);
  return root;
}

/**
 * The checkout this session has been WRITING to, when that is not `current` — else null.
 *
 * `current` is whatever the shelf is about to report, from whichever source won
 * (`resolveSessionDir`). Comparing against the resolved answer rather than against the project
 * root is what makes this useful after a claim too: an agent that declared checkout A and then
 * wrote into B is exactly as wrong as one that declared nothing, and the shelf should say so
 * either way.
 *
 * The BUSIEST other checkout wins, not the newest. A single stray write into a sibling repo is
 * still reported (it did happen, and the chip does not describe it), but where a session spans
 * two, the one it is actually working in is the one named.
 */
export function editsElsewhere(
  sessionKey: string | null,
  current: string,
): EditsElsewhere | null {
  if (!sessionKey) return null;
  const counts = edits.get(sessionKey);
  if (!counts) return null;

  const here = canonical(current);
  let best: EditsElsewhere | null = null;
  for (const [dir, count] of counts) {
    if (dir === here) continue;
    if (!best || count > best.count) {
      best = { dir, name: dir.split(sep).filter(Boolean).pop() ?? dir, count };
    }
  }
  return best;
}

/** The session is gone. Same reasoning as `clearSessionCheckout`: an entry outlives its
 *  session only until the bound above evicts it, and that is too long to leave a count keyed
 *  by an id a new pane could be handed. */
export function clearSessionEdits(sessionKey: string): void {
  edits.delete(sessionKey);
}

/** TEST SEAM, same contract as the other registries' resets. Production never calls it. */
export function resetSessionEdits(): void {
  edits.clear();
  rootOfDir.clear();
}
