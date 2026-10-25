import { today } from './id.js';
import { isCancelled, isDone, type StatusDef } from './task-status.js';
import type { TaskBackend } from './task-backend/types.js';
import { oneDataLine } from './automations/runner.js';
import { isSafeAutomationSlug } from './agents/slot.js';

/**
 * Who changed a task's status (AI Team v2 C1-13). Every path that moves a status writes ONE
 * changelog entry in the CLI's own shape, with its author in the heading:
 *
 *   ### 2026-10-25 - Status → in_review (by agent:scout)
 *   - Delivered round 1.
 *
 * Done and cancelled keep their words (`Completed`, `Cancelled`) so the board, the journal fold
 * and every reader of older entries see the heading they always saw; the `(by …)` suffix is what
 * the task drawer's History reads back. Paths: the dashboard PATCH, `tasks status`/`complete`,
 * an assignment, an objection, a delivery, a review verdict.
 */

export type StatusAuthor =
  | { kind: 'owner' }
  | { kind: 'agent'; slug: string }
  | { kind: 'reviewer'; slug: string }
  | { kind: 'claude' }
  | { kind: 'sleep' };

export function authorLabel(who: StatusAuthor): string {
  switch (who.kind) {
    case 'agent':
    case 'reviewer':
      return `${who.kind}:${isSafeAutomationSlug(who.slug) ? who.slug : 'unknown'}`;
    default:
      return who.kind;
  }
}

/** The heading's words for `to`: `Completed`, `Cancelled`, or `Status → <to>`. */
export function statusHeading(to: string, defs: readonly StatusDef[]): string {
  if (isDone(defs, to)) return 'Completed';
  if (isCancelled(defs, to)) return 'Cancelled';
  return `Status → ${to}`;
}

/** The changelog entry for a status change, author included. `reason` is one flattened line. */
export function statusChangeEntry(
  to: string,
  who: StatusAuthor,
  defs: readonly StatusDef[],
  reason?: string | null,
  date: string = today(),
): string {
  const head = `### ${date} - ${statusHeading(to, defs)} (by ${authorLabel(who)})`;
  const why = reason ? oneDataLine(reason, 500) : '';
  return why ? `${head}\n- ${why}` : head;
}

/**
 * Who is calling the CLI, read from the environment the caller cannot fake into a stronger
 * label than it has: an agent's run carries its slug (`DREAMCONTEXT_AUTOMATION_SLUG`), a sleep
 * consolidation its own marker, a Claude Code session `CLAUDECODE`; anything else is the owner
 * at their terminal.
 */
export function cliStatusAuthor(env: NodeJS.ProcessEnv = process.env): StatusAuthor {
  const slug = env.DREAMCONTEXT_AUTOMATION_SLUG;
  if (env.DREAMCONTEXT_AUTOMATION_RUN !== undefined && slug && isSafeAutomationSlug(slug)) return { kind: 'agent', slug };
  if (env.DREAMCONTEXT_SLEEP_EVAL !== undefined || env.DREAMCONTEXT_SLEEP !== undefined) return { kind: 'sleep' };
  if (env.CLAUDECODE !== undefined) return { kind: 'claude' };
  return { kind: 'owner' };
}

/** Write the entry through the task's backend (local file or a remote mirror). */
export async function recordStatusChange(
  backend: Pick<TaskBackend, 'addChangelog'>,
  slug: string,
  change: { to: string; who: StatusAuthor; reason?: string | null; defs: readonly StatusDef[] },
): Promise<void> {
  await backend.addChangelog(slug, statusChangeEntry(change.to, change.who, change.defs, change.reason), { createIfMissing: true });
}

export interface StatusHistoryRow {
  date: string;
  /** `completed`/`cancelled` for their word headings, else the status key. */
  to: string;
  by: string | null;
  reason: string | null;
}

const ENTRY = /^### (\d{4}-\d{2}-\d{2}) - (Completed|Cancelled|Status → ([\w-]+)|Status: ([\w-]+))(?: \(by ([a-z]+(?::[a-z0-9-]+)?)\))?\s*$/;

/** The status changes a changelog records, newest first (the changelog's own order). */
export function parseStatusHistory(changelog: string): StatusHistoryRow[] {
  const rows: StatusHistoryRow[] = [];
  const lines = changelog.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = ENTRY.exec(lines[i]);
    if (!m) continue;
    const to = m[3] ?? m[4] ?? (m[2] === 'Completed' ? 'completed' : 'cancelled');
    const next = lines[i + 1] ?? '';
    rows.push({ date: m[1], to, by: m[5] ?? null, reason: next.startsWith('- ') ? next.slice(2).trim() : null });
  }
  return rows;
}
