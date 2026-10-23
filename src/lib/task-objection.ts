import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nanoid } from 'nanoid';
import { acquireFileLockWithin, releaseFileLock } from './file-lock.js';
import { slugify, today } from './id.js';
import { loadStatuses } from './overrides.js';
import { isSleepCycleLive } from './task-filing-bar.js';
import { DECLINED_REL_PATH, MAX_DECLINED, type DeclinedIdea } from './task-declined.js';
import { readRules, ruleFor, type RulesDoc } from './task-filing-rules.js';
import { openChildren, validateParentLink } from './task-parent.js';
import { isCancelled, isTerminal, type StatusDef } from './task-status.js';
import type { TaskBackend, TaskData } from './task-backend/types.js';

/**
 * task-objection — "Object to this task": the owner says a task an agent opened was wrong, and
 * says how. ONE engine; `POST /api/tasks/:slug/objection` and `dreamcontext tasks object` both
 * call {@link objectToTask}.
 *
 *   subtask-of     it belongs under another task      → parent_task set (the task stays open)
 *   criterion-on   it was a criterion of another task → `- [ ] <name> (itiraz obj_…)` there, task cancelled
 *   duplicate-of   another task already is this       → a log line there, task cancelled
 *   not-a-task     nothing to do                      → declined (never re-filed), task cancelled
 *   wrong-project  another project's work             → declined, task cancelled
 *
 * The objected task is NEVER deleted: it stays (cancelled) so its objection box always has a
 * page to sit on. The next sleep distils applied objections into rules (task-filing-rules.ts).
 *
 * CRASH-SAFE BY CONSTRUCTION. The whole engine runs under one lock. A record is written first,
 * then each step runs and is appended to `steps` (every step is idempotent: it checks before it
 * writes), cancelling comes LAST, and `applied` is stamped only after the last step. A run that
 * dies midway leaves `applied: null`; calling again with the same kind and target CONTINUES the
 * same record (the UI's "Finish" button, `tasks object --resume`) and never opens a second one.
 *
 * THE LEDGER (`state/.task-objections.json`) is written through a temp file under the gitignored
 * `state/.locks/` and renamed, so a sync never commits half a file. A ledger that exists but does
 * not parse is refused loudly and never overwritten.
 */

export const OBJECTIONS_REL_PATH = 'state/.task-objections.json';
export const OBJECTION_LOCK_REL_PATH = 'state/.locks/.task-objections.lock';
export const MIN_OBJECTION_NOTE_CHARS = 15;
const MAX_NOTE_CHARS = 2000;

export const OBJECTION_KINDS = ['subtask-of', 'criterion-on', 'duplicate-of', 'not-a-task', 'wrong-project'] as const;
export type ObjectionKind = typeof OBJECTION_KINDS[number];

/** Kinds that point at another task. */
const NEEDS_TARGET: ReadonlySet<ObjectionKind> = new Set(['subtask-of', 'criterion-on', 'duplicate-of']);

export function isObjectionKind(v: unknown): v is ObjectionKind {
  return typeof v === 'string' && (OBJECTION_KINDS as readonly string[]).includes(v);
}

export interface ObjectionRecord {
  id: string;
  task: string;
  /** The task as it was objected to: the rule-learning pass reads it, even after edits. */
  snapshot: {
    name: string;
    description: string;
    why: string;
    filing_basis: unknown;
    filed_by: string | null;
    created_at: string;
  };
  as: ObjectionKind;
  target: string | null;
  note: string;
  by: string;
  via: 'ui' | 'agent';
  /** ISO timestamp the objection was made. */
  at: string;
  /** Steps finished so far, in order. */
  steps: string[];
  /** Why the last attempt stopped; `superseded` when a newer objection replaced it. */
  error: string | null;
  applied: { action: string; at: string } | null;
}

export class ObjectionLedgerError extends Error {}

function ledgerPath(contextRoot: string): string {
  return join(contextRoot, OBJECTIONS_REL_PATH);
}

function isRecord(v: unknown): v is ObjectionRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.task === 'string' && isObjectionKind(r.as)
    && typeof r.at === 'string' && Array.isArray(r.steps);
}

/**
 * The ledger, strictly: absent = empty; present but unparseable = {@link ObjectionLedgerError}.
 * Every writer reads through this, so a broken file is reported, never replaced.
 */
export function readObjectionsStrict(contextRoot: string): ObjectionRecord[] {
  const path = ledgerPath(contextRoot);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new ObjectionLedgerError(`${OBJECTIONS_REL_PATH} does not parse (${(err as Error).message}); fix or move it by hand, it is never overwritten.`);
  }
  if (!Array.isArray(parsed)) {
    throw new ObjectionLedgerError(`${OBJECTIONS_REL_PATH} is not a list; fix or move it by hand, it is never overwritten.`);
  }
  return parsed.filter(isRecord);
}

/** For READERS that must not break a page (the task list): a broken ledger reads as empty. */
export function readObjectionsSafe(contextRoot: string): ObjectionRecord[] {
  try {
    return readObjectionsStrict(contextRoot);
  } catch {
    return [];
  }
}

function writeLedger(contextRoot: string, records: ObjectionRecord[]): void {
  const path = ledgerPath(contextRoot);
  const tmpDir = join(contextRoot, 'state', '.locks');
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(tmpDir, `.task-objections.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(records, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
}

/** Applied objection ids, oldest first. */
export function appliedObjectionIds(records: readonly ObjectionRecord[]): string[] {
  return records.filter((r) => r.applied).map((r) => r.id);
}

// ─── Read contract ───────────────────────────────────────────────────────────

export interface ObjectionView {
  id: string;
  as: ObjectionKind;
  target: string | null;
  targetName: string | null;
  note: string;
  at: string;
  /** Not finished: the page shows "Unfinished · Finish" (the same POST). */
  pending: boolean;
  error: string | null;
  applied: { action: string; at: string } | null;
  /** The rule that rests on this objection, or null (none yet, or deleted by hand). */
  rule: { id: string; title: string; dont: string; do: string } | null;
}

/** The record a task's page shows: its newest (by `applied.at`, else `at`), superseded ones skipped. */
export function currentObjection(records: readonly ObjectionRecord[], slug: string): ObjectionRecord | null {
  const mine = records.filter((r) => r.task === slug && r.error !== 'superseded');
  if (mine.length === 0) return null;
  const key = (r: ObjectionRecord): string => r.applied?.at ?? r.at;
  return mine.reduce((a, b) => (key(b) > key(a) ? b : a));
}

export function objectionView(
  records: readonly ObjectionRecord[],
  slug: string,
  rules: RulesDoc,
  nameOf: (slug: string) => string | null,
): ObjectionView | null {
  const r = currentObjection(records, slug);
  if (!r) return null;
  const rule = r.applied ? ruleFor(rules, r.id) : null;
  return {
    id: r.id,
    as: r.as,
    target: r.target,
    targetName: r.target ? nameOf(r.target) : null,
    note: r.note,
    at: r.at,
    pending: r.applied === null,
    error: r.error,
    applied: r.applied,
    rule: rule ? { id: rule.id, title: rule.title, dont: rule.dont, do: rule.do } : null,
  };
}

/** The rules a reader resolves views against: an unreadable file resolves no rule. */
export function rulesForView(contextRoot: string): RulesDoc {
  const read = readRules(contextRoot);
  return read.state === 'unreadable' ? { rules: [], dismissed: [] } : read.doc;
}

// ─── The engine ──────────────────────────────────────────────────────────────

export interface ObjectionInput {
  task: string;
  as: string;
  target?: string | null;
  note: string;
  by?: string;
  via: 'ui' | 'agent';
  /** Continue this exact record (`tasks object --resume obj_…`). */
  resume?: string;
}

export type ObjectionResult =
  | { ok: true; record: ObjectionRecord; outcome: 'applied' | 'already_applied' }
  | { ok: false; status: number; code: string; message: string; record?: ObjectionRecord };

export interface ObjectionDeps {
  /** Tests: throw right after this step finishes (simulates a crash mid-run). */
  crashAfter?: string;
  /** Tests: the lock wait. */
  lockWaitMs?: number;
}

const fail = (status: number, code: string, message: string, record?: ObjectionRecord): ObjectionResult =>
  ({ ok: false, status, code, message, ...(record ? { record } : {}) });

function cancelledStatus(defs: readonly StatusDef[]): string | null {
  return defs.find((d) => d.kind === 'cancelled')?.key ?? null;
}

/** Make an objection, or continue an unfinished one. */
export async function objectToTask(
  contextRoot: string,
  backend: TaskBackend,
  input: ObjectionInput,
  deps: ObjectionDeps = {},
): Promise<ObjectionResult> {
  const lock = join(contextRoot, OBJECTION_LOCK_REL_PATH);
  const got = await acquireFileLockWithin(lock, {
    waitMs: deps.lockWaitMs ?? 15_000,
    staleMs: 120_000,
    verifyPidLiveness: true,
  });
  if (!got) return fail(409, 'objection_busy', 'Another objection is being applied; try again in a moment.');
  try {
    return await runLocked(contextRoot, backend, input, deps);
  } finally {
    releaseFileLock(lock);
  }
}

async function runLocked(
  contextRoot: string,
  backend: TaskBackend,
  input: ObjectionInput,
  deps: ObjectionDeps,
): Promise<ObjectionResult> {
  if (isSleepCycleLive(contextRoot)) {
    return fail(409, 'sleep_running', 'A sleep cycle is running; object after it finishes, so it does not file against a moving board.');
  }
  let records: ObjectionRecord[];
  try {
    records = readObjectionsStrict(contextRoot);
  } catch (err) {
    return fail(500, 'objection_ledger_unreadable', (err as Error).message);
  }
  const defs = loadStatuses(contextRoot);
  const task = await backend.get(input.task);
  if (!task) return fail(404, 'not_found', `Task not found: ${input.task}`);
  // A resume carries no kind of its own: the record does.
  const as = input.as;
  if (!input.resume && !isObjectionKind(as)) {
    return fail(400, 'invalid_kind', `The kind must be one of: ${OBJECTION_KINDS.join(', ')}.`);
  }
  const target = isObjectionKind(as) && NEEDS_TARGET.has(as) ? (input.target ?? '').trim() || null : null;

  // 1. Continue before anything else: a double click or a retry must never open a second record,
  //    and an unfinished record must finish even though step 1 may already have cancelled the task.
  let record: ObjectionRecord | null = null;
  if (input.resume) {
    record = records.find((r) => r.id === input.resume && r.task === task.slug) ?? null;
    if (!record) return fail(404, 'objection_not_found', `No objection ${input.resume} on ${task.slug}.`);
    if (record.applied) return { ok: true, record, outcome: 'already_applied' };
  } else {
    const pending = records
      .filter((r) => r.task === task.slug && r.applied === null && r.error !== 'superseded')
      .sort((a, b) => (a.at < b.at ? 1 : -1))[0];
    if (pending) {
      if (pending.as === as && pending.target === target) {
        record = pending;
      } else if (pending.target !== null && (await backend.get(pending.target)) === null) {
        pending.error = 'superseded';
        writeLedger(contextRoot, records);
      } else {
        return fail(409, 'objection_pending',
          `${pending.id} on this task is unfinished (${pending.as}${pending.target ? ` → ${pending.target}` : ''}). Finish it first: the same objection again, or dreamcontext tasks object ${task.slug} --resume ${pending.id}.`,
          pending);
      }
    }
    if (!record) {
      const done = records.find((r) => r.task === task.slug && r.applied && r.as === as && r.target === target);
      if (done) return { ok: true, record: done, outcome: 'already_applied' };
    }
  }

  // 2. A new objection: check everything before the first write.
  if (!record) {
    if (!isObjectionKind(as)) return fail(400, 'invalid_kind', `The kind must be one of: ${OBJECTION_KINDS.join(', ')}.`);
    const pre = await precheck(backend, task, as, target, input.note, defs);
    if (pre) return pre;
    if (records.some((r) => r.task === task.slug && r.applied)) {
      return fail(409, 'already_objected', `${task.slug} already has an applied objection.`);
    }
    record = {
      id: `obj_${nanoid(10)}`,
      task: task.slug,
      snapshot: {
        name: task.name,
        description: task.description,
        why: task.why.trim(),
        filing_basis: task.filing_basis,
        filed_by: task.filed_by,
        created_at: task.created_at,
      },
      as,
      target,
      note: input.note.trim().slice(0, MAX_NOTE_CHARS),
      by: input.by ?? 'owner',
      via: input.via,
      at: new Date().toISOString(),
      steps: [],
      error: null,
      applied: null,
    };
    records.push(record);
    writeLedger(contextRoot, records);
  }

  // 3. The steps, each idempotent; cancelling last.
  const rec = record;
  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    await run();
    if (!rec.steps.includes(name)) rec.steps.push(name);
    rec.error = null;
    writeLedger(contextRoot, records);
    if (deps.crashAfter === name) throw new Error(`crash after ${name} (test)`);
  };
  try {
    const marker = `itiraz ${rec.id}`;
    if (rec.as === 'subtask-of' && rec.target) {
      const t = rec.target;
      await step('parent', async () => {
        const cur = await backend.get(rec.task);
        if (cur && cur.parent_task !== t) await backend.updateFields(rec.task, { parent_task: t, updated_at: today() });
      });
    }
    if (rec.as === 'criterion-on' && rec.target) {
      const t = rec.target;
      await step('criterion', async () => {
        const target = await backend.get(t);
        if (!target) throw new Error(`target ${t} is gone`);
        if (!target.acceptance_criteria.includes(rec.id)) {
          await backend.insertSection(t, 'Acceptance Criteria', `- [ ] ${rec.snapshot.name} (${marker})`, { position: 'bottom', replacePlaceholders: true });
        }
      });
    }
    if (rec.as === 'duplicate-of' && rec.target) {
      const t = rec.target;
      await step('duplicate-log', async () => {
        const target = await backend.get(t);
        if (!target) throw new Error(`target ${t} is gone`);
        if (!target.changelog.includes(marker)) {
          await backend.addChangelog(t, `### ${today()} - Objection\n- ${marker}: «${rec.snapshot.name}» (\`${rec.task}\`) was a copy of this task.`, { createIfMissing: true });
        }
      });
    }
    if (rec.as === 'not-a-task' || rec.as === 'wrong-project') {
      await step('decline', async () => declineStrict(contextRoot, rec));
    }
    await step('log', async () => {
      const cur = await backend.get(rec.task);
      if (cur && !cur.changelog.includes(marker)) {
        await backend.addChangelog(rec.task, `### ${today()} - Objection\n- ${marker} (${rec.as}${rec.target ? ` → ${rec.target}` : ''}): ${rec.note}`, { createIfMissing: true });
      }
    });
    if (rec.as !== 'subtask-of') {
      await step('cancel', async () => {
        const cur = await backend.get(rec.task);
        const key = cancelledStatus(defs);
        if (!key) throw new Error('this project declares no cancelled-kind status');
        if (cur && !isCancelled(defs, cur.status)) await backend.updateFields(rec.task, { status: key, updated_at: today() });
      });
    }
    rec.applied = { action: rec.as, at: new Date().toISOString() };
    rec.error = null;
    writeLedger(contextRoot, records);
    return { ok: true, record: rec, outcome: 'applied' };
  } catch (err) {
    rec.error = (err as Error).message;
    try { writeLedger(contextRoot, records); } catch { /* the error is reported below either way */ }
    return fail(500, 'objection_step_failed', `${rec.id} stopped: ${rec.error}. Run the same objection again to finish it.`, rec);
  }
}

/** Everything a new objection must satisfy, or the refusal. */
async function precheck(
  backend: TaskBackend,
  task: TaskData,
  as: ObjectionKind,
  target: string | null,
  note: string,
  defs: readonly StatusDef[],
): Promise<ObjectionResult | null> {
  if (note.trim().length < MIN_OBJECTION_NOTE_CHARS) {
    return fail(400, 'note_too_short', `Say why in at least ${MIN_OBJECTION_NOTE_CHARS} characters: sleep learns the rule from this note.`);
  }
  if (isCancelled(defs, task.status)) return fail(409, 'task_cancelled', `${task.slug} is already cancelled.`);
  const cancels = as !== 'subtask-of';
  if (cancels && !cancelledStatus(defs)) {
    return fail(400, 'no_cancelled_status', 'This project declares no cancelled-kind status, so an objection cannot cancel the task. Declare one in overrides/task.md first.');
  }
  const all = (await backend.list()).map((t) => ({ slug: t.name, parent_task: t.parent_task, status: t.status }));
  if (NEEDS_TARGET.has(as)) {
    if (!target) return fail(400, 'target_required', `"${as}" needs the task it points at.`);
    if (target === task.slug) return fail(400, 'self', 'A task cannot point at itself.');
    const t = await backend.get(target);
    if (!t) return fail(400, 'target_missing', `Task not found: ${target}`);
    if (isTerminal(defs, t.status)) return fail(400, 'target_closed', `${target} is ${t.status}; pick an open task.`);
    if (as === 'subtask-of') {
      const link = validateParentLink(all, task.slug, target, defs);
      if (!link.ok) return fail(400, link.code, link.message);
    }
  }
  if (cancels) {
    const open = openChildren(all, task.slug, defs);
    if (open.length > 0) {
      return fail(409, 'has_open_children',
        `${task.slug} has open sub-tasks (${open.map((c) => c.slug).join(', ')}); move them first, then object.`);
    }
  }
  return null;
}

/** The decline step: strict about the declined ledger (a broken file is an error, never replaced). */
function declineStrict(contextRoot: string, rec: ObjectionRecord): void {
  const path = join(contextRoot, DECLINED_REL_PATH);
  let list: DeclinedIdea[] = [];
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      throw new Error(`${DECLINED_REL_PATH} does not parse; fix it by hand, it is never overwritten`);
    }
    if (!Array.isArray(parsed)) throw new Error(`${DECLINED_REL_PATH} is not a list; fix it by hand`);
    list = parsed as DeclinedIdea[];
  }
  const key = slugify(rec.snapshot.name) || rec.task;
  if (list.some((d) => d && d.key === key)) return;
  const idea: DeclinedIdea = {
    key,
    topic: rec.snapshot.name,
    declinedAt: rec.at,
    reason: `${rec.as === 'wrong-project' ? 'Another project\'s work' : 'Not a task'} (objection ${rec.id}): ${rec.note}`,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify([idea, ...list].slice(0, MAX_DECLINED), null, 2) + '\n', 'utf-8');
}
