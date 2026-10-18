import { join } from 'node:path';
import { today } from './id.js';
import { checkCloseGate } from './sleep-eval/report.js';
import { ensureLocalStateIgnored, recordAudit, type AuditVia } from './task-audit.js';
import { TaskFileBusyError } from './task-file-lock.js';
import type { TaskBackend } from './task-backend/types.js';
import { dateUpdatesForStatus } from './task-dates.js';
import { loadFamily, parentCloseBlock } from './task-parent.js';
import { DONE_STATUS_KEY, isActive, isReview, type StatusDef } from './task-status.js';

/**
 * The owner's verdict on a task in review (plan r3 § W4, owner decision 2): approve
 * (review → done) or send it back with a note (review → the first active status).
 * One function for the CLI (`tasks approve`, `tasks send-back`) and the dashboard
 * verdict route, so the two can never disagree.
 *
 * Every verdict is journaled on the task and recorded in the task audit with WHO and
 * THROUGH WHAT. The order is the commit protocol:
 *  1. preflight — the ignore entries the audit needs are ensured; a failure throws
 *     {@link VerdictPreflightError} and nothing is done;
 *  2. the status write — the commit point. A card that is busy (another writer holds its
 *     lock) refuses with `busy` and nothing written;
 *  3. the journal entry, then the audit record. These come after the commit point, so a
 *     failure there never turns into a refusal: the verdict happened, and the result says
 *     which record is missing (`journal_not_recorded`, `audit_not_recorded`), logged too.
 */

export type Verdict = 'approve' | 'send_back';

export interface VerdictInput {
  verdict: Verdict;
  note?: string;
  /** The person acting (a journal actor); null when nobody is resolved. */
  actor: string | null;
  via: AuditVia;
}

export type VerdictRefusal = 'not_found' | 'not_in_review' | 'subtasks_open' | 'sleep_eval_gate' | 'note_required' | 'busy';

/** A record the verdict could not write after it had happened. */
export type VerdictWarning = 'journal_not_recorded' | 'audit_not_recorded';

export type VerdictResult =
  | {
    ok: true;
    status: string;
    /** The sleep-eval gate's pass message, when the gate applied. */
    gateMessage: string | null;
    /** Records missing after the commit point; empty when everything was written. */
    warnings: VerdictWarning[];
  }
  | { ok: false; code: VerdictRefusal; message: string };

/** The verdict could not even start: the audit's ignore entries cannot be ensured. Nothing was written. */
export class VerdictPreflightError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'VerdictPreflightError';
  }
}

const BUSY_MESSAGE = (slug: string) => `${slug} is being written by another process (a sleep cycle may be running). Nothing was changed; try again in a moment.`;

/** The status a task sent back returns to: the first active-kind status in pipeline order. */
export function sendBackStatus(defs: readonly StatusDef[]): string {
  const active = [...defs].filter((d) => isActive(defs, d.key)).sort((a, b) => a.order - b.order)[0];
  return active?.key ?? 'in_progress';
}

export async function applyVerdict(
  backend: TaskBackend,
  contextRoot: string,
  defs: readonly StatusDef[],
  slug: string,
  v: VerdictInput,
): Promise<VerdictResult> {
  try {
    ensureLocalStateIgnored(contextRoot);
  } catch (err) {
    throw new VerdictPreflightError(err);
  }
  const cur = await backend.get(slug);
  if (!cur) return { ok: false, code: 'not_found', message: `Task not found: ${slug}` };
  const what = v.verdict === 'approve' ? 'approved' : 'sent back';
  if (!isReview(defs, cur.status)) {
    return { ok: false, code: 'not_in_review', message: `${slug} is ${cur.status}; only a task in review is ${what}.` };
  }
  const note = v.note?.trim() ?? '';
  const auditActor = v.actor ?? 'owner';

  if (v.verdict === 'send_back') {
    if (!note) return { ok: false, code: 'note_required', message: 'Sending a task back needs a note: what is missing or wrong.' };
    const target = sendBackStatus(defs);
    const committed = await commitStatus(backend, slug, { status: target, updated_at: today() });
    if (committed) return committed;
    const warnings = await recordAfterCommit(backend, contextRoot, slug,
      { kind: 'approval', label: 'sent back', actor: v.actor, body: `- sent back: ${note}` },
      { kind: 'send_back', slug, actor: auditActor, via: v.via, note });
    return { ok: true, status: target, gateMessage: null, warnings };
  }

  const block = parentCloseBlock(loadFamily(join(contextRoot, 'state')), defs, slug, DONE_STATUS_KEY);
  if (block) return { ok: false, code: 'subtasks_open', message: block };
  const gate = checkCloseGate(contextRoot, slug, cur.parent_task ?? null);
  if (gate.applies && !gate.ok) return { ok: false, code: 'sleep_eval_gate', message: gate.message };

  const now = today();
  const dates = dateUpdatesForStatus(DONE_STATUS_KEY, cur, now, defs);
  const committed = await commitStatus(backend, slug, { status: DONE_STATUS_KEY, updated_at: now, ...dates });
  if (committed) return committed;
  const warnings = await recordAfterCommit(backend, contextRoot, slug,
    { kind: 'approval', actor: v.actor, body: `- approved${note ? `: ${note}` : ''}` },
    { kind: 'approval', slug, actor: auditActor, via: v.via, note: note || null });
  return { ok: true, status: DONE_STATUS_KEY, gateMessage: gate.applies ? gate.message : null, warnings };
}

/** The commit point. A busy card refuses (nothing written); null means the status is written. */
async function commitStatus(
  backend: TaskBackend,
  slug: string,
  fields: Record<string, unknown>,
): Promise<Extract<VerdictResult, { ok: false }> | null> {
  try {
    await backend.updateFields(slug, fields);
    return null;
  } catch (err) {
    if (err instanceof TaskFileBusyError) return { ok: false, code: 'busy', message: BUSY_MESSAGE(slug) };
    throw err;
  }
}

/**
 * The journal entry, then the audit record, after the commit point. Neither may undo or deny
 * the verdict: a failure is logged to stderr and returned as a warning.
 */
async function recordAfterCommit(
  backend: TaskBackend,
  contextRoot: string,
  slug: string,
  journal: Parameters<TaskBackend['addJournal']>[1],
  audit: Omit<Parameters<typeof recordAudit>[1], 'journalId'>,
): Promise<VerdictWarning[]> {
  const warnings: VerdictWarning[] = [];
  let journalId: string | null = null;
  try {
    journalId = (await backend.addJournal(slug, journal)).id;
  } catch (err) {
    warnings.push('journal_not_recorded');
    console.error(`[task-verdict] ${slug}: the verdict is recorded on the card, but its journal entry is not (${err instanceof Error ? err.message : String(err)}).`);
  }
  try {
    recordAudit(contextRoot, { ...audit, journalId });
  } catch (err) {
    warnings.push('audit_not_recorded');
    console.error(`[task-verdict] ${slug}: the verdict is recorded on the card, but not in the task audit (${err instanceof Error ? err.message : String(err)}).`);
  }
  return warnings;
}
