import { IncomingMessage, ServerResponse } from 'node:http';
import { readSleepState, writeSleepState } from '../../cli/commands/sleep.js';
import { effectiveDebt } from '../../lib/sleep-consolidation.js';
import type { SleepState } from '../../lib/sleep-consolidation.js';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import { recordDashboardChange, buildFieldSummary } from '../change-tracker.js';
import type { FieldChange } from '../change-tracker.js';

/** Allowed recall modes — mirrors RECALL_MODES in src/cli/commands/sleep.ts. */
const RECALL_MODES = ['haiku', 'raw', 'hybrid', 'off'] as const;
type RecallMode = typeof RECALL_MODES[number];

/** The persisted state plus the derived effective-debt trio the UI levels on. */
export interface SleepStatePayload extends SleepState {
  /** persisted + provisional — the value directives and the UI threshold on. */
  effective_debt: number;
  /** Estimated debt for sessions still awaiting analysis (score === null). */
  provisional_debt: number;
  /** How many sessions that estimate covers. */
  pending_sessions: number;
}

/**
 * Decorate the persisted state with the DERIVED effective debt that
 * `getConsolidationDirective` already thresholds on, so the dashboard and the
 * terminal cannot disagree. Claude Code flushes transcripts lazily: until a
 * session's transcript lands, its score is `null` and it contributes ZERO to
 * the persisted ledger, so a raw `debt` under-reads real work for hours.
 *
 * `debt` stays the exact persisted ledger — it is what PATCH writes and what
 * `sleep done` resets. The provisional estimate is display-only and never
 * written to disk (see effectiveDebt in src/lib/sleep-consolidation.ts).
 */
function withEffectiveDebt(state: SleepState): SleepStatePayload {
  const eff = effectiveDebt(state);
  return {
    ...state,
    effective_debt: eff.effective,
    provisional_debt: eff.provisional,
    pending_sessions: eff.pendingCount,
  };
}

/**
 * GET /api/sleep - Get sleep state
 */
export async function handleSleepGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const state = readSleepState(contextRoot);
  sendJson(res, 200, withEffectiveDebt(state));
}

/**
 * PATCH /api/sleep - Update sleep state (manual debt add, etc.)
 */
export async function handleSleepUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be JSON.');
    return;
  }

  // Validate before touching state so a bad value never partially persists.
  if (body.recall_mode !== undefined && !RECALL_MODES.includes(body.recall_mode as RecallMode)) {
    sendError(res, 400, 'invalid_value', `recall_mode must be one of: ${RECALL_MODES.join(', ')}.`);
    return;
  }

  const state = readSleepState(contextRoot);
  const oldDebt = state.debt;
  const fieldChanges: FieldChange[] = [];

  if (typeof body.debt === 'number' && body.debt !== oldDebt) {
    state.debt = body.debt;
    fieldChanges.push({ field: 'debt', from: oldDebt, to: body.debt });
  }

  if (body.recall_mode !== undefined) {
    const oldMode = state.recall_mode ?? 'haiku';
    if (body.recall_mode !== oldMode) {
      state.recall_mode = body.recall_mode as RecallMode;
      fieldChanges.push({ field: 'recall_mode', from: oldMode, to: body.recall_mode as RecallMode });
    }
  }

  writeSleepState(contextRoot, state);

  if (fieldChanges.length > 0) {
    recordDashboardChange(contextRoot, {
      entity: 'sleep',
      action: 'update',
      target: 'state/.sleep.json',
      field: fieldChanges.map(f => f.field).join(', '),
      fields: fieldChanges,
      summary: buildFieldSummary('sleep', 'state/.sleep.json', fieldChanges),
    });
  }

  const updatedState = readSleepState(contextRoot);
  sendJson(res, 200, withEffectiveDebt(updatedState));
}
