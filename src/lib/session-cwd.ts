import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { gitCommonDir } from './session-facts.js';

/**
 * WHICH CHECKOUT a chat session is currently working in.
 *
 * `session-facts.ts` answers "what is true of this directory". This module answers the
 * question in front of it — WHICH directory — and it is the one the shelf was getting wrong.
 *
 * ── The bug this exists to fix ────────────────────────────────────────────────────────
 * `claude` is spawned in the vault's project root (`agent-chat.ts`, `cwd: projectRoot`) and
 * `GET /api/agent/session-facts` re-read git in that same folder every 15s for the life of
 * the session. Correct at t=0 and never again: Develop mode's own briefing invites the agent
 * to open a worktree, and the harness's `EnterWorktree` tool moves it there — after which the
 * shelf kept reporting the checkout the session had LEFT. Photographed twice by the owner on
 * 2026-08-24, once with a whole run in a worktree under a tag that still read `main`.
 *
 * ── Why a directory from a frame must be validated ────────────────────────────────────
 * The path arrives in a tool-result string on the model's stream. It is not user input and it
 * is not attacker-controlled in the usual sense, but it is not something to hand to `git` in
 * a server either. {@link enterSessionCheckout} accepts a directory only when it is a
 * checkout of the SAME REPOSITORY the vault already points at — git's own `--git-common-dir`
 * is identical across every worktree of one repo and never collides across two. So the blast
 * radius of a bad frame is "a sibling worktree of the project the user already has open",
 * which is precisely the set the feature is for.
 *
 * ── Never throws, and never guesses ───────────────────────────────────────────────────
 * A rejected move leaves the session on its previous checkout, which is the pre-existing
 * behaviour — the shelf degrades to the old answer rather than to a wrong new one. There is
 * deliberately no heuristic fallback (no "find the newest worktree and assume"): a fact
 * surface whose whole promise is that the user never has to re-ask cannot afford a guess.
 */

/**
 * How many sessions may hold an override at once.
 *
 * An entry is dropped when its session closes ({@link clearSessionCheckout}), so this bound
 * is not the normal path — it is the backstop for the abnormal one, a client that opens
 * panes and never closes them cleanly. Well above any real pane count, far below anything
 * that matters for memory. Eviction is oldest-first, and an evicted session simply falls
 * back to the project root.
 */
export const MAX_TRACKED_SESSIONS = 64;

/** Insertion-ordered, which is what makes the oldest-first eviction below a one-liner. */
const checkouts = new Map<string, string>();

/** Is `dir` a checkout of the same repository as `projectRoot`?
 *
 *  Both must be work trees, and their SHARED git directory must be the same one. A different
 *  repo, a plain directory, a path that does not exist and a path that exists but is a file
 *  all answer false — `gitCommonDir` is total and returns null for every one of them. */
export function isSameRepository(dir: string, projectRoot: string): boolean {
  const theirs = gitCommonDir(dir);
  if (!theirs) return false;
  return theirs === gitCommonDir(projectRoot);
}

/** A directory that exists and is a directory. `statSync` rather than `existsSync` because a
 *  FILE at that path would pass an existence check and then be handed to `git -C`. */
function isDirectory(dir: string): boolean {
  try { return statSync(dir).isDirectory(); } catch { return false; }
}

/**
 * Point `sessionKey` at `dir`, if `dir` earns it.
 *
 * Returns true when the move was accepted. A rejected move is not an error the caller has to
 * handle — the session keeps whatever checkout it had — but the boolean is returned so the
 * frame watcher's tests can assert the refusal rather than infer it.
 *
 * The path must be ABSOLUTE. A relative one would be resolved against the server's cwd, which
 * is not the session's, and "resolve it against the project root instead" is a guess.
 */
export function enterSessionCheckout(sessionKey: string, dir: string, projectRoot: string): boolean {
  if (!sessionKey || !dir || !isAbsolute(dir)) return false;
  if (!isDirectory(dir)) return false;
  if (!isSameRepository(dir, projectRoot)) return false;

  // Re-insert so the entry counts as the newest for eviction, not as whenever the session
  // first moved. A long-lived session that keeps working is not the one to drop.
  checkouts.delete(sessionKey);
  checkouts.set(sessionKey, dir);
  while (checkouts.size > MAX_TRACKED_SESSIONS) {
    const oldest = checkouts.keys().next();
    if (oldest.done) break;
    checkouts.delete(oldest.value);
  }
  return true;
}

/** The session left its worktree: it is back in the project root, which is the absence of an
 *  override rather than a second kind of value. */
export function exitSessionCheckout(sessionKey: string): void {
  checkouts.delete(sessionKey);
}

/** The session is gone. Same operation as {@link exitSessionCheckout}, named for the other
 *  reason it happens so a reader of `agent-chat.ts`'s teardown does not have to work out
 *  whether the socket closing means the agent walked out of a worktree. */
export function clearSessionCheckout(sessionKey: string): void {
  checkouts.delete(sessionKey);
}

/**
 * The directory `sessionKey` is working in — its override, or `projectRoot`.
 *
 * An unknown session answers `projectRoot`, which is what EVERY caller answered before this
 * module existed. That is the compatibility contract: a pane that never moved, a terminal
 * session that sends no id at all, and a resumed conversation the server has not seen a frame
 * from yet all keep the old behaviour instead of losing the branch chip.
 *
 * The override is re-checked on read, not trusted from write time. A worktree can be REMOVED
 * while the session that opened it is still on screen (`git worktree remove` in another
 * terminal), and a stale directory would otherwise leave the tag frozen on a branch that no
 * longer has a checkout. When the override stops being a live sibling of the project, it is
 * dropped and the answer falls back — the same degradation as never having moved.
 */
export function sessionCheckout(sessionKey: string | null, projectRoot: string): string {
  if (!sessionKey) return projectRoot;
  const dir = checkouts.get(sessionKey);
  if (!dir) return projectRoot;
  if (!isDirectory(dir) || !isSameRepository(dir, projectRoot)) {
    checkouts.delete(sessionKey);
    return projectRoot;
  }
  return dir;
}

/** TEST SEAM. The registry is module state by design — one server, one map — so a test that
 *  wants a clean slate needs a way to ask for one. Production code never calls this. */
export function resetSessionCheckouts(): void {
  checkouts.clear();
}
