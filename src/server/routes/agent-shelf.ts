import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sendJson, sendError } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import { projectRootOf, sanitizeUuid } from './agent-spawn-shared.js';
import { countCheckboxes, firstUnticked, listCheckboxes, readSection } from '../../lib/markdown.js';
import { isSafeTaskSlug } from '../../lib/task-backend/local.js';
import { readSessionFacts, UNKNOWN_SESSION_FACTS } from '../../lib/session-facts.js';
import { sessionCheckout } from '../../lib/session-cwd.js';
import { transcriptCheckout } from '../../lib/session-transcript-cwd.js';

/**
 * The two reads behind the chat's PINNED SHELF — the surface docked to the composer's top
 * edge that holds facts a transcript would scroll away.
 *
 *   • `/api/agent/task-progress` — how far a run has got, DERIVED FROM DISK. The whole
 *     point of the progress row is that the user can check the number, so it is counted
 *     from the task file's own acceptance-criteria checkboxes and an agent-supplied percent
 *     is rejected upstream (chatViewSpec.ts) rather than trusted here.
 *   • `/api/agent/session-facts` — which branch/worktree this session acts on.
 *
 * Both are VAULT-SCOPED (they read one project's brain), so neither belongs in
 * `VAULT_AGNOSTIC_PREFIXES`. Both take `contextRoot: string | null` and answer their own
 * empty shape when it is null, and both carry the `isDesktop()` gate — the same contract
 * `handleAgentGoalLive` follows (agent-terminal.ts:1456-1459). A shelf that cannot read
 * shows nothing; it never shows a 500.
 */

// ─── GET /api/agent/task-progress ───────────────────────────────────────────────────

/**
 * Why a run's progress could not simply be reported:
 *  • `unknown-slug` — the slug is well-formed but no such task file exists here;
 *  • `no-criteria`  — the task has no `## Acceptance Criteria` section, or one with no
 *                     checkboxes. There is nothing to divide by, so there is no percent;
 *  • `all-done`     — every criterion is ticked. A real reading (100%), but one the row
 *                     must SAY rather than leave the user to infer from a full bar;
 *  • `unreadable`   — the environment cannot answer (off-desktop, no project pinned, or the
 *                     file exists but could not be parsed).
 * Every one of them carries a `notice`. "Degrade loudly" is the contract: no NaN, no silent
 * empty row.
 */
export type TaskProgressState = 'ok' | 'unknown-slug' | 'no-criteria' | 'all-done' | 'unreadable';

/**
 * ONE acceptance criterion, as the popover draws it.
 *
 * This list is why the route exists in its current shape. It used to send two strings — the
 * criterion in flight and the newest changelog bullet — under a header reading `8/20`, so the
 * panel promised twenty lines and drew two (owner, 2026-08-24: "genelde iki madde var 20
 * görünüyor … live progress izleme gibi durmuyor"). The other eighteen were never hidden;
 * they were never sent.
 */
export interface ProgressCriterion {
  done: boolean;
  /** One line, capped like `now`/`last`. Empty only for a malformed `- [ ]` in the task
   *  file — see `listCheckboxes`, which keeps it so the list length matches `total`. */
  text: string;
  /** The `### ` milestone heading this criterion sits under, or null when ungrouped. */
  group: string | null;
}

export interface TaskProgress {
  slug: string;
  state: TaskProgressState;
  /** 0-100 for `ok` and `all-done`; NULL for every degenerate state. Never NaN — the
   *  zero-criteria case is the reason this is nullable rather than a number. */
  percent: number | null;
  done: number;
  total: number;
  /** The first unticked criterion — what is in flight. Null when there is none. */
  now: string | null;
  /** The newest task-changelog bullet — what was just done. Null when there is none. */
  last: string | null;
  /** EVERY criterion, in document order — `criteria.length === total` for any readable task,
   *  including a malformed one. Empty for every degenerate state. */
  criteria: ProgressCriterion[];
  /** How many criteria were dropped to stay under {@link MAX_CRITERIA}. 0 almost always; when
   *  it is not, the popover SAYS so — a short list under an honest total is precisely the
   *  defect this field exists to keep from coming back in at the cap. It is deliberately not
   *  folded into `notice`, whose contract ("set iff the reading is degenerate") still holds:
   *  a truncated list is a complete READING, just an abbreviated drawing of it. */
  truncated: number;
  /** The task file's mtime in ms, so a poller can see the file change. 0 when unknown. */
  updatedAt: number;
  /** Always set when `state !== 'ok'`; always null when it is. */
  notice: string | null;
}

/** One line of UI. A changelog bullet in this repo routinely runs past 2 KB, and this route
 *  is polled every few seconds during a run — so both strings are capped at the boundary
 *  rather than shipped in full for CSS to hide. */
const MAX_LINE_CHARS = 240;

/**
 * The list is bounded because it is polled: a task with a runaway Acceptance Criteria section
 * would otherwise put an unbounded payload on a 4-second timer. 200 is far above anything in
 * this repo (the largest task here has 26) and the overflow is REPORTED via `truncated`, never
 * swallowed — the whole point of the list is that the count beside it can be checked.
 */
const MAX_CRITERIA = 200;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_LINE_CHARS ? `${flat.slice(0, MAX_LINE_CHARS - 1)}…` : flat;
}

function degraded(slug: string, state: TaskProgressState, notice: string, updatedAt = 0): TaskProgress {
  return {
    slug, state, percent: null, done: 0, total: 0,
    now: null, last: null, criteria: [], truncated: 0, updatedAt, notice,
  };
}

/**
 * The newest entry in a task's `## Changelog`. The section is LIFO (newest at top, see the
 * task template), so the first bullet is the newest — but it is preceded by an HTML comment
 * and `### <date> - <kind>` headers, which are skipped.
 */
function newestChangelogEntry(body: string): string | null {
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*[-*]\s+(.+)$/);
    if (!m) continue;
    const text = oneLine(m[1]);
    if (text) return text;
  }
  return null;
}

/**
 * GET /api/agent/task-progress?slug=<task-slug>
 *
 * READS THE LOCAL FILE, not `backendFor(contextRoot)`. That is deliberate: a project synced
 * to ClickUp or GitHub has a backend whose task objects carry no checkbox body, and the
 * number this row promises is specifically the one `dreamcontext tasks doctor` reports
 * (tasks.ts:1697-1702) — which counts `_dream_context/state/<slug>.md`. Reading anywhere
 * else would put a second, quietly different number on screen.
 *
 * The slug arms are unambiguous on purpose:
 *   • malformed / traversal / empty → 400 `invalid_slug`, decided BEFORE any filesystem
 *     access, mirroring `handleTasksGet` (tasks.ts:699). A hostile slug is a client error.
 *   • well-formed but no such file  → 200 with `state:'unknown-slug'`. That is a state the
 *     shelf renders, not a request that failed.
 */
export async function handleAgentTaskProgress(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string | null,
): Promise<void> {
  let slug = '';
  try {
    slug = new URL(req.url || '/', `http://${req.headers.host}`).searchParams.get('slug') ?? '';
  } catch { /* unparseable URL — falls through to the invalid-slug arm below */ }

  // FIRST, and before anything touches the disk: a slug that could escape the state dir is
  // rejected outright rather than being handed to `join`.
  if (!isSafeTaskSlug(slug)) {
    sendError(res, 400, 'invalid_slug', 'Task slug is missing or not a safe file name.');
    return;
  }

  if (!isDesktop()) {
    sendJson(res, 200, degraded(slug, 'unreadable', 'Task progress is only available in the desktop app.'));
    return;
  }
  if (!contextRoot) {
    sendJson(res, 200, degraded(slug, 'unreadable', 'No project is open, so there is no task file to read.'));
    return;
  }

  const file = join(contextRoot, 'state', `${slug}.md`);
  if (!existsSync(file)) {
    sendJson(res, 200, degraded(slug, 'unknown-slug', `No task named "${slug}" exists in this project.`));
    return;
  }

  let updatedAt = 0;
  let criteria: string | null;
  let changelog: string | null;
  try {
    updatedAt = statSync(file).mtimeMs;
    criteria = readSection(file, 'Acceptance Criteria');
    changelog = readSection(file, 'Changelog');
  } catch {
    sendJson(res, 200, degraded(slug, 'unreadable', `"${slug}" could not be read from disk.`, updatedAt));
    return;
  }

  if (criteria === null) {
    sendJson(res, 200, degraded(slug, 'no-criteria',
      `"${slug}" has no "## Acceptance Criteria" section — there is nothing to derive a percentage from.`,
      updatedAt));
    return;
  }

  const { total, done } = countCheckboxes(criteria);
  if (total === 0) {
    sendJson(res, 200, degraded(slug, 'no-criteria',
      `"${slug}" has an Acceptance Criteria section with no checkboxes — there is nothing to count.`,
      updatedAt));
    return;
  }

  const last = changelog ? newestChangelogEntry(changelog) : null;
  const percent = Math.round((done / total) * 100);

  // Read from the SAME section text `countCheckboxes` just counted, by the same reader — so
  // the rows the popover draws and the fraction above them cannot describe different lines.
  // `oneLine` is applied here rather than in `listCheckboxes` for the reason it caps `now`
  // and `last`: a criterion in this repo routinely runs past 2 KB and this route is polled.
  const all = listCheckboxes(criteria);
  const listing = {
    criteria: all.slice(0, MAX_CRITERIA).map((c) => ({ ...c, text: oneLine(c.text) })),
    truncated: Math.max(0, all.length - MAX_CRITERIA),
  };

  if (done === total) {
    sendJson(res, 200, {
      slug, state: 'all-done', percent: 100, done, total,
      now: null, last, ...listing, updatedAt,
      notice: `Every one of "${slug}"'s ${total} criteria is ticked — this task reads as complete.`,
    } satisfies TaskProgress);
    return;
  }

  const nextUp = firstUnticked(criteria);
  sendJson(res, 200, {
    slug, state: 'ok', percent, done, total,
    now: nextUp ? oneLine(nextUp) : null,
    last, ...listing, updatedAt, notice: null,
  } satisfies TaskProgress);
}

// ─── GET /api/agent/session-facts ────────────────────────────────────────────────────

/**
 * GET /api/agent/session-facts?session=<uuid> — the branch and worktree marker for the
 * checkout THIS SESSION is working in, for the shelf's resting tag line. See
 * src/lib/session-facts.ts for why these two are server-derived while the dev-server port
 * is not.
 *
 * ── Why the session id, and why it is optional ────────────────────────────────────────
 * This route used to answer for `projectRootOf(contextRoot)` unconditionally — the folder the
 * app has open. That is where `claude` is SPAWNED, so it was right until the agent moved, and
 * Develop mode's own briefing is what invites it to move. `sessionCheckout` resolves the id to
 * the directory the session is actually in (src/lib/session-cwd.ts), falling back to the
 * project root for an id it has never seen a move from — so a fresh pane, a resumed
 * conversation and a caller that sends no id at all all keep the previous behaviour rather
 * than losing the branch chip.
 *
 * The id is held to `sanitizeUuid` before it is used as a map key. It never reaches a shell
 * and never reaches the filesystem, so this is hygiene rather than an injection boundary — but
 * an unbounded string from a client is not something to key server state on either.
 *
 * `projectRootOf` because git runs in the CODE checkout, not in `_dream_context/` — which in
 * the default layout is a subdirectory of it, and in `full-repo` mode is a different repo
 * entirely.
 */
export async function handleAgentSessionFacts(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string | null,
): Promise<void> {
  if (!isDesktop() || !contextRoot) { sendJson(res, 200, UNKNOWN_SESSION_FACTS); return; }

  let session = '';
  try {
    session = sanitizeUuid(new URL(req.url || '/', `http://${req.headers.host}`).searchParams.get('session'));
  } catch { /* unparseable URL — falls back to the project root, same as no id */ }

  const projectRoot = projectRootOf(contextRoot);
  sendJson(res, 200, readSessionFacts(resolveSessionDir(session || null, projectRoot)));
}

/**
 * WHICH directory this session's facts are read from — the transcript's answer, then the tool
 * frames', then the project root.
 *
 * The order is the point. `sessionCheckout` (src/lib/session-cwd.ts) is fed by the harness's
 * `EnterWorktree`/`ExitWorktree` frames on the stdout stream, so it is precise about the moves
 * it can see and BLIND to every other one. `transcriptCheckout` reads the conversation's own
 * `cwd`, which the CLI rewrites on every entry, so it sees all of them — a manual
 * `git worktree add` + `cd`, a plain `git checkout -b`, and a `cd` back OUT of a worktree the
 * override registry is still holding. Where the two disagree the transcript is the one that
 * observed the session rather than one tool call inside it, so it wins.
 *
 * The registry is not now redundant: it is written the instant the tool result crosses the
 * stream, while the transcript entry is a file the CLI has yet to flush. So it remains the
 * answer for the window between those two, and the fallback whenever a conversation has no
 * transcript at all (a pane opened and never used).
 *
 * Exported, with a `home` TEST SEAM, because the ORDER is the behaviour worth pinning and the
 * handler's own signature is fixed by the router. Production callers pass no options.
 */
export function resolveSessionDir(
  session: string | null,
  projectRoot: string,
  opts: { home?: string } = {},
): string {
  return transcriptCheckout(session, projectRoot, opts) ?? sessionCheckout(session, projectRoot);
}
