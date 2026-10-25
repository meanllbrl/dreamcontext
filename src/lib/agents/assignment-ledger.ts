import { readLocalJson, updateLocalJson } from '../local-store.js';

/**
 * The assignment ledger and armed starts (M0, AI Team v2 B1-5): written ONLY by a local action on
 * this machine, never by the brain sync. A task's synced `agent:` / `reviewer:` / `agent_state` /
 * `agent_step` fields are display; nothing starts from them alone.
 *
 *  - The LEDGER says who this machine assigned: `(taskId, role, agent)`, plus the workspace and
 *    repo the work runs in (the synced `agent_repo` is display only).
 *  - An ARMED entry `(taskId, step, round)` is the one-time ticket a queued step needs; the claim
 *    that starts the step consumes it.
 *
 * Every key has a death: a task's entries go when it is unassigned, completed, cancelled or
 * deleted (`forgetTaskAssignments`), an agent's when it is deleted or renamed.
 */

export type AssignmentRole = 'doer' | 'reviewer';

export interface LedgerRecord {
  taskId: string;
  taskSlug: string;
  role: AssignmentRole;
  agent: string;
  workspace?: string | null;
  repo?: string | null;
  at: string;
}

export interface ArmedStart {
  taskId: string;
  step: string;
  round: number;
  at: string;
}

interface LedgerFile {
  records: LedgerRecord[];
  armed: ArmedStart[];
  /** Owner-inbox rows the owner answered "Ignore": never raised again for that key. */
  ignored?: string[];
  /** The upgrade seeded the ledger from the assignments that existed before it (once). */
  seeded?: boolean;
}

const FILE = 'agent-assignments.json';
const EMPTY: LedgerFile = { records: [], armed: [] };

function clean(file: LedgerFile): LedgerFile {
  return {
    records: Array.isArray(file.records) ? file.records.filter((r) => r && typeof r.taskId === 'string' && typeof r.agent === 'string') : [],
    armed: Array.isArray(file.armed) ? file.armed.filter((a) => a && typeof a.taskId === 'string' && typeof a.step === 'string') : [],
    ignored: Array.isArray(file.ignored) ? file.ignored.filter((k) => typeof k === 'string').slice(-500) : [],
    ...(file.seeded === true ? { seeded: true } : {}),
  };
}

export function readAssignmentLedger(projectRoot: string, home?: string): LedgerFile {
  return clean(readLocalJson<LedgerFile>(projectRoot, FILE, EMPTY, home));
}

/** Record that THIS machine assigned `agent` to the task in `role`. Replaces the task's earlier
 *  record for that role: one doer and one reviewer at a time. */
export function recordAssignment(projectRoot: string, rec: Omit<LedgerRecord, 'at'>, home?: string, now: Date = new Date()): void {
  updateLocalJson<LedgerFile>(projectRoot, FILE, EMPTY, (cur) => {
    const file = clean(cur);
    const records = file.records.filter((r) => !(r.taskId === rec.taskId && r.role === rec.role));
    records.push({ ...rec, at: now.toISOString() });
    return { ...file, records };
  }, home);
}

/** Arm one start of `step` (round `round`) for the task: the local action that queued it. */
export function armStart(projectRoot: string, taskId: string, step: string, round = 0, home?: string, now: Date = new Date()): void {
  updateLocalJson<LedgerFile>(projectRoot, FILE, EMPTY, (cur) => {
    const file = clean(cur);
    const armed = file.armed.filter((a) => !(a.taskId === taskId && a.step === step && a.round === round));
    armed.push({ taskId, step, round, at: now.toISOString() });
    return { ...file, armed };
  }, home);
}

/** Consume the armed entry for `(taskId, step, round)`. True when there was one: the step may start. */
export function consumeArmedStart(projectRoot: string, taskId: string, step: string, round = 0, home?: string): boolean {
  let had = false;
  updateLocalJson<LedgerFile>(projectRoot, FILE, EMPTY, (cur) => {
    const file = clean(cur);
    const armed = file.armed.filter((a) => {
      const hit = a.taskId === taskId && a.step === step && a.round === round;
      if (hit) had = true;
      return !hit;
    });
    return { ...file, armed };
  }, home);
  return had;
}

/** The ledger record for `(taskId, role, agent)`, or null. */
export function ledgerRecordFor(projectRoot: string, taskId: string, role: AssignmentRole, agent: string, home?: string): LedgerRecord | null {
  return readAssignmentLedger(projectRoot, home).records.find((r) => r.taskId === taskId && r.role === role && r.agent === agent) ?? null;
}

/** Whether an armed entry exists for the task (any step), without consuming it. */
export function hasArmedStart(projectRoot: string, taskId: string, home?: string): boolean {
  return readAssignmentLedger(projectRoot, home).armed.some((a) => a.taskId === taskId);
}

/** The death of a task's entries (unassigned, completed, cancelled, deleted). Never throws. */
export function forgetTaskAssignments(projectRoot: string, taskId: string, home?: string): void {
  try {
    const file = readAssignmentLedger(projectRoot, home);
    if (!file.records.some((r) => r.taskId === taskId) && !file.armed.some((a) => a.taskId === taskId)) return;
    updateLocalJson<LedgerFile>(projectRoot, FILE, EMPTY, (cur) => {
      const f = clean(cur);
      return {
        records: f.records.filter((r) => r.taskId !== taskId),
        armed: f.armed.filter((a) => a.taskId !== taskId),
        ignored: (f.ignored ?? []).filter((k) => !k.includes(`:${taskId}:`)),
      };
    }, home);
  } catch {
    // a stale record only lets a hand edit of this task start where the owner already started it
  }
}

/** The death of an agent's records (deleted), or their move (renamed). Never throws. */
export function renameOrForgetAgentAssignments(projectRoot: string, agent: string, to: string | null, home?: string): void {
  try {
    const file = readAssignmentLedger(projectRoot, home);
    if (!file.records.some((r) => r.agent === agent)) return;
    updateLocalJson<LedgerFile>(projectRoot, FILE, EMPTY, (cur) => {
      const f = clean(cur);
      const records = to === null
        ? f.records.filter((r) => r.agent !== agent)
        : f.records.map((r) => (r.agent === agent ? { ...r, agent: to } : r));
      return { ...f, records };
    }, home);
  } catch {
    // see forgetTaskAssignments
  }
}

/** The owner answered "Ignore" on an "assigned outside the app" row: never raise that key again. */
export function ignoreOutsideKey(projectRoot: string, key: string, home?: string): void {
  updateLocalJson<LedgerFile>(projectRoot, FILE, EMPTY, (cur) => {
    const f = clean(cur);
    return { ...f, ignored: [...new Set([...(f.ignored ?? []), key])] };
  }, home);
}

export function isIgnoredOutsideKey(projectRoot: string, key: string, home?: string): boolean {
  return (readAssignmentLedger(projectRoot, home).ignored ?? []).includes(key);
}

/**
 * The upgrade's one-time seed (migration 0.34.5): every assignment that exists when this version
 * first runs was made the only way there was, by an action on a machine, so it is recorded as this
 * machine's (for the agents this machine owns). Without it, the first scan after an upgrade would
 * raise "assigned outside the app" for every task already in flight. Returns how many it recorded.
 */
export function seedAssignmentLedger(
  projectRoot: string,
  assignments: { taskId: string; taskSlug: string; role: AssignmentRole; agent: string }[],
  home?: string,
  now: Date = new Date(),
): number {
  let added = 0;
  updateLocalJson<LedgerFile>(projectRoot, FILE, EMPTY, (cur) => {
    const f = clean(cur);
    if (f.seeded) return f;
    const records = [...f.records];
    for (const a of assignments) {
      if (records.some((r) => r.taskId === a.taskId && r.role === a.role)) continue;
      records.push({ ...a, at: now.toISOString() });
      added++;
    }
    return { ...f, records, seeded: true };
  }, home);
  return added;
}
