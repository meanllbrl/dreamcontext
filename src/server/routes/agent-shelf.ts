import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sendJson, sendError } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import { projectRootOf } from './agent-spawn-shared.js';
import { countCheckboxes, firstUnticked, readSection } from '../../lib/markdown.js';
import { isSafeTaskSlug } from '../../lib/task-backend/local.js';
import { readSessionFacts, UNKNOWN_SESSION_FACTS } from '../../lib/session-facts.js';

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
  /** The task file's mtime in ms, so a poller can see the file change. 0 when unknown. */
  updatedAt: number;
  /** Always set when `state !== 'ok'`; always null when it is. */
  notice: string | null;
}

/** One line of UI. A changelog bullet in this repo routinely runs past 2 KB, and this route
 *  is polled every few seconds during a run — so both strings are capped at the boundary
 *  rather than shipped in full for CSS to hide. */
const MAX_LINE_CHARS = 240;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_LINE_CHARS ? `${flat.slice(0, MAX_LINE_CHARS - 1)}…` : flat;
}

function degraded(slug: string, state: TaskProgressState, notice: string, updatedAt = 0): TaskProgress {
  return { slug, state, percent: null, done: 0, total: 0, now: null, last: null, updatedAt, notice };
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

  if (done === total) {
    sendJson(res, 200, {
      slug, state: 'all-done', percent: 100, done, total,
      now: null, last, updatedAt,
      notice: `Every one of "${slug}"'s ${total} criteria is ticked — this task reads as complete.`,
    } satisfies TaskProgress);
    return;
  }

  const nextUp = firstUnticked(criteria);
  sendJson(res, 200, {
    slug, state: 'ok', percent, done, total,
    now: nextUp ? oneLine(nextUp) : null,
    last, updatedAt, notice: null,
  } satisfies TaskProgress);
}

// ─── GET /api/agent/session-facts ────────────────────────────────────────────────────

/**
 * GET /api/agent/session-facts — the branch and worktree marker for THIS project's checkout,
 * for the shelf's resting tag line. See src/lib/session-facts.ts for why these two are
 * server-derived while the dev-server port is not.
 *
 * `projectRootOf` because git runs in the CODE checkout, not in `_dream_context/` — which in
 * the default layout is a subdirectory of it, and in `full-repo` mode is a different repo
 * entirely.
 */
export async function handleAgentSessionFacts(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string | null,
): Promise<void> {
  if (!isDesktop() || !contextRoot) { sendJson(res, 200, UNKNOWN_SESSION_FACTS); return; }
  sendJson(res, 200, readSessionFacts(projectRootOf(contextRoot)));
}
