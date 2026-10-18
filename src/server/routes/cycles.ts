import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { loadStatuses } from '../../lib/overrides.js';
import { getTaskBackend } from '../../lib/task-backend/index.js';
import { loadFamily } from '../../lib/task-parent.js';
import {
  activeCycle,
  CycleError,
  cycleProgress,
  daysLeft,
  defaultLengthDays,
  newCycle,
  readCycles,
  startCycle,
  type CycleView,
} from '../../lib/cycles.js';
import { closeCycle, CloseError, closePlanView } from '../../lib/cycle-close.js';
import { recordDashboardChange } from '../change-tracker.js';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';

/**
 * Cycles for the Planning screen and the Close deck (plan r3 § W4). The same library
 * the `dreamcontext cycle` commands use: create, start, and a close whose decisions
 * are recorded before any card moves.
 */

/** Closed cycles the capacity hint averages over (the newest first). */
const CAPACITY_WINDOW = 3;

/** Average leaves done per closed cycle over the last few, or null when none closed yet. */
export function capacityHint(cycles: CycleView[], doneOf: (c: CycleView) => number): number | null {
  const closed = cycles.filter((c) => c.status === 'closed').sort((a, b) => b.start.localeCompare(a.start)).slice(0, CAPACITY_WINDOW);
  if (closed.length === 0) return null;
  return Math.round(closed.reduce((n, c) => n + doneOf(c), 0) / closed.length);
}

const CYCLE_ID = /^cy_[A-Za-z0-9_-]{1,40}$/;

/** GET /api/cycles */
export async function handleCyclesList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { cycles } = readCycles(contextRoot);
  const defs = loadStatuses(contextRoot);
  const family = loadFamily(join(contextRoot, 'state'));
  const progressOf = (c: CycleView) => cycleProgress(family, defs, c.id);
  sendJson(res, 200, {
    cycles: cycles.map((c) => {
      const p = progressOf(c);
      return {
        ...c,
        progress: c.status === 'closed' && c.result ? { ...c.result, open: [] } : p,
        daysLeft: daysLeft(c),
      };
    }),
    active: activeCycle(cycles)?.id ?? null,
    defaultWeeks: defaultLengthDays(contextRoot, cycles) / 7,
    capacityHint: capacityHint(cycles, (c) => c.result?.done ?? progressOf(c).done),
  });
}

/** POST /api/cycles — { goal, start?, weeks? } */
export async function handleCyclesCreate(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = (await parseJsonBody(req)) ?? {};
  if (typeof body.goal !== 'string') { sendError(res, 400, 'invalid', 'goal (one sentence) is required.'); return; }
  if (body.start !== undefined && typeof body.start !== 'string') { sendError(res, 400, 'invalid', 'start must be YYYY-MM-DD.'); return; }
  if (body.weeks !== undefined && (typeof body.weeks !== 'number' || !Number.isFinite(body.weeks))) { sendError(res, 400, 'invalid', 'weeks must be a number.'); return; }
  try {
    const cycle = newCycle(contextRoot, {
      goal: body.goal,
      ...(typeof body.start === 'string' ? { start: body.start } : {}),
      ...(typeof body.weeks === 'number' ? { weeks: body.weeks } : {}),
    });
    recordDashboardChange(contextRoot, { entity: 'core', action: 'create', target: 'core/CYCLES.json', summary: `Opened cycle #${cycle.number}: ${cycle.goal}` });
    sendJson(res, 200, { cycle });
  } catch (err) {
    if (err instanceof CycleError) { sendError(res, 400, 'invalid', err.message); return; }
    throw err;
  }
}

/** POST /api/cycles/:id/start */
export async function handleCycleStart(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { id } = params;
  if (!CYCLE_ID.test(id)) { sendError(res, 400, 'invalid', `Invalid cycle id: ${id}`); return; }
  try {
    const cycle = startCycle(contextRoot, id);
    recordDashboardChange(contextRoot, { entity: 'core', action: 'update', target: 'core/CYCLES.json', summary: `Started cycle #${cycle.number}` });
    sendJson(res, 200, { cycle });
  } catch (err) {
    if (err instanceof CycleError) { sendError(res, 400, 'invalid', err.message); return; }
    throw err;
  }
}

/** GET /api/cycles/:id/close-plan — what the Close deck shows. */
export async function handleCycleClosePlan(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { id } = params;
  if (!CYCLE_ID.test(id)) { sendError(res, 400, 'invalid', `Invalid cycle id: ${id}`); return; }
  try {
    const plan = closePlanView(contextRoot, id);
    sendJson(res, 200, { cycle: plan.cycle, into: plan.into, groups: plan.groups, resuming: plan.resuming });
  } catch (err) {
    if (err instanceof CloseError) { sendError(res, err.code === 'closed' ? 409 : 404, err.code, err.message); return; }
    throw err;
  }
}

/**
 * POST /api/cycles/:id/close — { decisions: { <slug>: 'carry' | 'back' | 'cancel' }, into? }.
 * A decision for a slug that is not an unfinished leaf of this cycle is ignored; an
 * unfinished leaf without one refuses the close (400 `undecided`, naming them).
 */
export async function handleCycleClose(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { id } = params;
  if (!CYCLE_ID.test(id)) { sendError(res, 400, 'invalid', `Invalid cycle id: ${id}`); return; }
  const body = (await parseJsonBody(req)) ?? {};
  const decisions = body.decisions && typeof body.decisions === 'object' && !Array.isArray(body.decisions)
    ? body.decisions as Record<string, unknown>
    : {};
  if (body.into !== undefined && typeof body.into !== 'string') { sendError(res, 400, 'invalid', 'into must be a cycle id or number.'); return; }
  try {
    const r = await closeCycle(contextRoot, getTaskBackend(contextRoot), id, decisions, body.into as string | undefined);
    recordDashboardChange(contextRoot, {
      entity: 'core', action: 'update', target: 'core/CYCLES.json',
      summary: `Closed cycle #${r.cycle.number}: ${r.result.done}/${r.result.total} done, ${r.moved.carry.length} carried, ${r.moved.back.length} back, ${r.moved.cancel.length} cancelled`,
    });
    sendJson(res, 200, { cycle: r.cycle, moved: r.moved });
  } catch (err) {
    if (err instanceof CloseError) {
      if (err.code === 'undecided') { sendJson(res, 400, { error: 'undecided', message: err.message, slugs: err.slugs }); return; }
      const status = err.code === 'closed' ? 409 : err.code === 'not_found' ? 404 : 400;
      sendError(res, status, err.code, err.message);
      return;
    }
    throw err;
  }
}
