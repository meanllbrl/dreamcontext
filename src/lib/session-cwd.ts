import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { gitCommonDir } from './session-facts.js';
import { resolveLinkedRepos } from './linked-repos.js';

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
 * checkout of a repository this vault GOVERNS — its own, or one of its linked code repos
 * ({@link governedCommonDirs}). git's own `--git-common-dir` is identical across every
 * worktree of one repo and never collides across two, so the blast radius of a bad frame is
 * "a checkout of a project the user already has open", which is precisely the set the feature
 * is for.
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

/**
 * Insertion-ordered, which is what makes the oldest-first eviction below a one-liner.
 *
 * `claim` separates the two ways a session gets an override, and the difference decides who
 * WINS against the transcript (agent-shelf.ts's `resolveSessionDir`):
 *
 *  - `claim: false` — OBSERVED. An `EnterWorktree` frame moved the session. The transcript's
 *    own `cwd` sees the same move and every move after it, so where the two disagree the
 *    transcript is the fresher witness and outranks this.
 *  - `claim: true` — DECLARED. The agent said, in its answer, which checkout its work belongs
 *    to (checkout-directive.ts). The transcript CANNOT contradict this usefully: the whole
 *    reason to declare is that the session is standing somewhere else, which is precisely
 *    what the transcript would report. So a claim outranks it until it is withdrawn.
 */
interface Checkout { dir: string; claim: boolean }
const checkouts = new Map<string, Checkout>();

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

/**
 * How long the governed set is reused for one project root.
 *
 * Longer than {@link SESSION_FACTS_TTL_MS}'s 12s on purpose: linking a repo is a deliberate
 * `dreamcontext link` a user runs once, not something that changes under a running shelf, and
 * this memo is what keeps two JSON reads off a 15s-per-pane poll. Short enough that a link
 * made while the app is open is picked up without a restart.
 */
export const GOVERNED_ROOTS_TTL_MS = 30_000;

/** Keyed by project root — the handful this server serves — so it needs no eviction bound of
 *  its own, unlike the frame-named directories in `commonDirCache`. */
const governedRoots = new Map<string, { dirs: string[]; at: number }>();

/**
 * The git identities of every repository this vault GOVERNS: its own, plus each LINKED code
 * repo that is present on this machine.
 *
 * ── Why the vault's own repo is not the whole set ─────────────────────────────────────
 * A brain that has been split from its code (knowledge/brain-koddan-ayirma-playbook.md, and
 * Tilki on this machine) governs bare code repos through `linkedRepos` — the brain repo holds
 * `_dream_context/` and no product code, the linked repo holds the code and no brain. Every
 * worktree an agent opens for real work is then a worktree of the LINKED repo, which the
 * same-repository gate refused: the shelf fell back to the brain repo and reported its `main`
 * for a session working in `…/.claude-worktrees/<name>` on a feature branch. Photographed by
 * the owner on 2026-08-28 — three panes, three worktrees, three chips reading `main`.
 *
 * ── Why this is still a gate and not an open door ─────────────────────────────────────
 * The widened set is exactly the repos the user has already bound to this vault with
 * `dreamcontext link` (`.config.json` + the machine-global registry). A directory in any other
 * repository is still refused, so the blast radius of a bad frame or a stale transcript stays
 * "a checkout of a project this vault already governs".
 *
 * A malformed config costs the vault its LINKED repos, never its own: the resolution is
 * wrapped, and `projectRoot` is seeded before it runs.
 *
 * `home` and `now` are TEST SEAMS. Production callers pass neither.
 */
export function governedCommonDirs(
  projectRoot: string,
  opts: { home?: string; now?: number } = {},
): string[] {
  const now = opts.now ?? Date.now();
  const hit = governedRoots.get(projectRoot);
  if (hit && now - hit.at < GOVERNED_ROOTS_TTL_MS) return hit.dirs;

  const roots = [projectRoot];
  try {
    for (const repo of resolveLinkedRepos(projectRoot, opts.home)) {
      if (repo.path) roots.push(repo.path);
    }
  } catch { /* an unreadable or malformed config leaves the vault's own repo governed */ }

  const dirs: string[] = [];
  for (const root of roots) {
    const dir = gitCommonDir(root);
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  }
  governedRoots.set(projectRoot, { dirs, at: now });
  return dirs;
}

/** Is `dir` a checkout of a repository this vault governs — its own, or a linked one?
 *
 *  Same totality contract as {@link isSameRepository}: a plain directory, a missing path, a
 *  file and a foreign repository all answer false. */
export function isGovernedCheckout(
  dir: string,
  projectRoot: string,
  opts: { home?: string; now?: number } = {},
): boolean {
  const theirs = gitCommonDir(dir);
  if (!theirs) return false;
  return governedCommonDirs(projectRoot, opts).includes(theirs);
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
 *
 * `opts.home` is a TEST SEAM for the linked-repo half of the gate. Production callers omit it.
 */
export function enterSessionCheckout(
  sessionKey: string,
  dir: string,
  projectRoot: string,
  opts: { home?: string; claim?: boolean } = {},
): boolean {
  if (!sessionKey || !dir || !isAbsolute(dir)) return false;
  if (!isDirectory(dir)) return false;
  if (!isGovernedCheckout(dir, projectRoot, opts)) return false;

  // Re-insert so the entry counts as the newest for eviction, not as whenever the session
  // first moved. A long-lived session that keeps working is not the one to drop.
  checkouts.delete(sessionKey);
  checkouts.set(sessionKey, { dir, claim: opts.claim === true });
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
export function sessionCheckout(
  sessionKey: string | null,
  projectRoot: string,
  opts: { home?: string } = {},
): string {
  return liveCheckout(sessionKey, projectRoot, opts)?.dir ?? projectRoot;
}

/**
 * The checkout this session DECLARED, or null.
 *
 * Separate from {@link sessionCheckout} because it answers a different question and outranks
 * a different source: this is the agent's own statement about where its work lives, and
 * `resolveSessionDir` asks it BEFORE the transcript. An observed move answers null here —
 * `sessionCheckout` is where that one is read, after the transcript has had its say.
 */
export function claimedCheckout(
  sessionKey: string | null,
  projectRoot: string,
  opts: { home?: string } = {},
): string | null {
  const live = liveCheckout(sessionKey, projectRoot, opts);
  return live && live.claim ? live.dir : null;
}

/** The override, re-validated on read, or null. Shared by the two readers above so the
 *  drop-on-stale rule cannot drift between them. */
function liveCheckout(
  sessionKey: string | null,
  projectRoot: string,
  opts: { home?: string },
): Checkout | null {
  if (!sessionKey) return null;
  const entry = checkouts.get(sessionKey);
  if (!entry) return null;
  if (!isDirectory(entry.dir) || !isGovernedCheckout(entry.dir, projectRoot, opts)) {
    checkouts.delete(sessionKey);
    return null;
  }
  return entry;
}

/** TEST SEAM. The registry is module state by design — one server, one map — so a test that
 *  wants a clean slate needs a way to ask for one. Production code never calls this. */
export function resetSessionCheckouts(): void {
  checkouts.clear();
  governedRoots.clear();
}
