import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import matter from 'gray-matter';
import { loadStatuses } from '../overrides.js';
import { statusKind } from '../task-status.js';
import { readVaultFileSafe } from '../vault-read.js';
import { closeInboxRows, raiseInboxRow } from '../owner-inbox.js';
import { getAgent } from './store.js';
import { currentLogin, ownedBy } from './owner.js';
import { placement, readActive } from './active.js';
import { isSafeAutomationSlug } from './slot.js';
import {
  forgetTaskAssignments,
  isIgnoredOutsideKey,
  readAssignmentLedger,
  type AssignmentRole,
} from './assignment-ledger.js';

/**
 * Hand edits arriving by sync never start anything (AI Team v2 B1-5, AC-B1-3). A task's `agent:`,
 * `reviewer:`, `agent_state` and `agent_step` sync like the rest of the task; what may START work
 * on this machine is only the M0 ledger and its armed entries, which only local actions write.
 *
 * This scan finds the difference and turns it into owner-inbox rows ("assigned outside the app:
 * Start / Ignore") instead of runs, and it is the death of ledger records whose task moved on
 * (deleted, done, cancelled, reassigned). The drain order is the plan's: an agent this login owns,
 * then this machine is where it runs, then ledger + armed, so a teammate's machine raises no row
 * for agents it does not own. Called on every tick and every inbox read. Never throws.
 */

const ROLE_FIELD: Record<AssignmentRole, string> = { doer: 'agent', reviewer: 'reviewer' };

interface TaskHead {
  slug: string;
  id: string;
  name: string;
  data: Record<string, unknown>;
}

function readTaskHeads(contextRoot: string): TaskHead[] {
  let names: string[] = [];
  try { names = readdirSync(join(contextRoot, 'state')).filter((n) => /^[a-z0-9][a-z0-9-]*\.md$/.test(n)); } catch { return []; }
  const out: TaskHead[] = [];
  for (const name of names) {
    const raw = readVaultFileSafe(contextRoot, join('state', name));
    if (!raw) continue;
    try {
      const data = (matter(raw, {}).data ?? {}) as Record<string, unknown>;
      const slug = name.slice(0, -3);
      out.push({ slug, id: typeof data.id === 'string' && data.id.trim() ? data.id.trim() : slug, name: typeof data.name === 'string' ? data.name : slug, data });
    } catch {
      // an unparseable task assigns nobody
    }
  }
  return out;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function scanOutsideAssignments(contextRoot: string, home?: string): number {
  const projectRoot = dirname(contextRoot);
  let raised = 0;
  try {
    const login = currentLogin();
    const defs = loadStatuses(contextRoot);
    const tasks = readTaskHeads(contextRoot);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const ledger = readAssignmentLedger(projectRoot, home);

    // Death first: a record whose task is gone, finished, or now names someone else.
    for (const rec of ledger.records) {
      const t = byId.get(rec.taskId);
      const kind = t ? statusKind(defs, t.data.status) : null;
      if (!t || kind === 'done' || kind === 'cancelled' || str(t.data[ROLE_FIELD[rec.role]]) !== rec.agent) {
        forgetTaskAssignments(projectRoot, rec.taskId, home);
      }
    }
    const fresh = readAssignmentLedger(projectRoot, home);
    const has = (taskId: string, role: AssignmentRole, agent: string): boolean =>
      fresh.records.some((r) => r.taskId === taskId && r.role === role && r.agent === agent);
    const armed = (taskId: string): boolean => fresh.armed.some((a) => a.taskId === taskId);

    const keys = new Set<string>();
    const elsewhere = new Map<string, { from: string; tasks: string[] }>();
    for (const t of tasks) {
      const kind = statusKind(defs, t.data.status);
      if (kind === 'done' || kind === 'cancelled') continue;
      for (const role of ['doer', 'reviewer'] as const) {
        const agentSlug = str(t.data[ROLE_FIELD[role]]);
        if (!agentSlug || !isSafeAutomationSlug(agentSlug)) continue;
        const agent = getAgent(contextRoot, agentSlug);
        if (!agent || !ownedBy(agent.owner, login)) continue;
        if (!placement(contextRoot, agentSlug, agent.owner, home).here) continue;
        const queuedNoTicket = role === 'doer' && str(t.data.agent_state) === 'queued' && !armed(t.id);
        if (has(t.id, role, agentSlug) && !queuedNoTicket) continue;
        const key = queuedNoTicket && has(t.id, role, agentSlug)
          ? `assigned-outside:${t.id}:queued:${str(t.data.agent_step) ?? 'work'}`
          : `assigned-outside:${t.id}:${role}:${agentSlug}`;
        if (isIgnoredOutsideKey(projectRoot, key, home)) continue;
        const from = readActive(contextRoot, agentSlug, agent.owner)?.from;
        if (from && role === 'doer') {
          const g = elsewhere.get(agentSlug) ?? { from: from.name, tasks: [] };
          g.tasks.push(t.slug);
          elsewhere.set(agentSlug, g);
          continue;
        }
        keys.add(key);
        raiseInboxRow(projectRoot, {
          kind: 'assigned-outside',
          ref: t.slug,
          agent: agentSlug,
          title: role === 'reviewer'
            ? `${t.name}: ${agent.title} was made its reviewer outside the app. It does not start until you say so.`
            : `${t.name} was assigned to ${agent.title} outside the app. It does not start until you say so.`,
          actions: ['start', 'ignore'],
          dedupeKey: key,
        }, home);
        raised++;
      }
    }
    for (const [agentSlug, g] of elsewhere) {
      const key = `assigned-elsewhere:${agentSlug}`;
      keys.add(key);
      raiseInboxRow(projectRoot, {
        kind: 'assigned-elsewhere',
        ref: agentSlug,
        agent: agentSlug,
        title: `${g.tasks.length} task${g.tasks.length === 1 ? ' was' : 's were'} assigned to ${agentSlug} on ${g.from}.`,
        detail: g.tasks.join(', '),
        actions: ['start-all', 'review'],
        dedupeKey: key,
      }, home);
      raised++;
    }
    closeInboxRows(projectRoot, (r) => (r.kind === 'assigned-outside' || r.kind === 'assigned-elsewhere') && !keys.has(r.dedupeKey), home);
  } catch {
    // the next tick scans again
  }
  return raised;
}

/** The tasks open right now that name an agent this machine owns, as doer or reviewer. */
export function currentOwnAssignments(contextRoot: string): { taskId: string; taskSlug: string; role: AssignmentRole; agent: string }[] {
  const out: { taskId: string; taskSlug: string; role: AssignmentRole; agent: string }[] = [];
  try {
    const login = currentLogin();
    const defs = loadStatuses(contextRoot);
    for (const t of readTaskHeads(contextRoot)) {
      const kind = statusKind(defs, t.data.status);
      if (kind === 'done' || kind === 'cancelled') continue;
      for (const role of ['doer', 'reviewer'] as const) {
        const agent = str(t.data[ROLE_FIELD[role]]);
        if (!agent || !isSafeAutomationSlug(agent)) continue;
        const a = getAgent(contextRoot, agent);
        if (a && ownedBy(a.owner, login)) out.push({ taskId: t.id, taskSlug: t.slug, role, agent });
      }
    }
  } catch {
    // nothing seeded: the scan raises rows, which the owner can Start or Ignore
  }
  return out;
}
