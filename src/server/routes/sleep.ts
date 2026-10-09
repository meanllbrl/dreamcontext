import { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { readSleepState, writeSleepState } from '../../cli/commands/sleep.js';
import { effectiveDebt, resolveSleepThresholds } from '../../lib/sleep-consolidation.js';
import type { SleepState, SleepThresholds } from '../../lib/sleep-consolidation.js';
import { readSetupConfig, readBrainLocal, writeBrainLocal, SLEEP_SPECIALISTS } from '../../lib/setup-config.js';
import { readInstalledSpecialistDefaults } from '../../lib/sleep-settings.js';
import {
  currentAutoSleepFingerprint,
  readAutoSleepSidecar,
  liveAutoSleepJob,
} from '../../lib/auto-sleep.js';
import { cancelAutoSleep } from '../../lib/auto-sleep-runner.js';
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
  /**
   * The brain's RESOLVED debt ladder. Shipped so the dashboard levels on the
   * same numbers the hook does instead of its own copy of the constants — that
   * copy drifted twice before `sleep.thresholds` became tunable at all.
   */
  thresholds: SleepThresholds;
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
function withEffectiveDebt(state: SleepState, contextRoot: string): SleepStatePayload {
  const eff = effectiveDebt(state);
  return {
    ...state,
    effective_debt: eff.effective,
    provisional_debt: eff.provisional,
    pending_sessions: eff.pendingCount,
    thresholds: resolveSleepThresholds(readSetupConfig(dirname(contextRoot))?.sleep),
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
  sendJson(res, 200, withEffectiveDebt(state, contextRoot));
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
  sendJson(res, 200, withEffectiveDebt(updatedState, contextRoot));
}


// ─── Background auto-sleep (machine-local) ───────────────────────────────────

/**
 * GET /api/sleep/auto — this machine's background-sleep setting plus any job.
 *
 * Deliberately reports `consentStale` as a first-class field rather than just
 * `enabled`: a paused brain looks identical to an armed one from the setting
 * alone, and "it says ON but nothing ever runs" is the worst possible state to
 * be silent about.
 */
export async function handleSleepAutoGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const projectRoot = dirname(contextRoot);
  const local = readBrainLocal(projectRoot);
  const cfg = local?.autoSleep ?? null;
  const consentStale = !!cfg?.enabled && cfg.approvedFingerprint !== currentAutoSleepFingerprint(projectRoot);
  sendJson(res, 200, {
    enabled: !!cfg?.enabled,
    trigger: cfg?.trigger ?? 'must-sleep',
    approvedAt: cfg?.approvedAt ?? null,
    consentStale,
    job: readAutoSleepSidecar(contextRoot),
    jobLive: !!liveAutoSleepJob(contextRoot),
  });
}

/** PUT /api/sleep/auto — enable/disable, or change the trigger (re-approves). */
export async function handleSleepAutoPut(
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
  if (typeof body.enabled !== 'boolean') {
    sendError(res, 400, 'invalid_value', 'enabled must be a boolean.');
    return;
  }
  const trigger = body.trigger === undefined ? 'must-sleep' : body.trigger;
  if (trigger !== 'must-sleep' && trigger !== 'sleepy') {
    sendError(res, 400, 'invalid_value', 'trigger must be "must-sleep" or "sleepy".');
    return;
  }

  const projectRoot = dirname(contextRoot);
  const local = readBrainLocal(projectRoot) ?? {};
  if (!body.enabled) {
    writeBrainLocal(projectRoot, {
      ...local,
      ...(local.autoSleep ? { autoSleep: { ...local.autoSleep, enabled: false } } : {}),
    });
    sendJson(res, 200, { enabled: false, trigger, consentStale: false });
    return;
  }

  // Store the trigger BEFORE fingerprinting — the fingerprint covers it, so
  // computing it first would bake in the previous value and read as stale.
  writeBrainLocal(projectRoot, {
    ...local,
    autoSleep: { enabled: true, trigger, approvedAt: new Date().toISOString(), approvedFingerprint: 'pending' },
  });
  const fingerprint = currentAutoSleepFingerprint(projectRoot);
  const approvedAt = new Date().toISOString();
  writeBrainLocal(projectRoot, {
    ...(readBrainLocal(projectRoot) ?? {}),
    autoSleep: { enabled: true, trigger, approvedAt, approvedFingerprint: fingerprint },
  });
  sendJson(res, 200, { enabled: true, trigger, approvedAt, consentStale: false });
}

/**
 * POST /api/sleep/auto/cancel — stop a running background cycle.
 *
 * The dashboard shows the pid and start time on the button and asks once, which
 * is the human confirmation this subsystem requires before any process-group
 * kill (see `cancelAutoSleep`).
 */
export async function handleSleepAutoCancel(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const result = cancelAutoSleep(contextRoot);
  if (!result.found) {
    sendError(res, 404, 'not_found', 'No background sleep is running.');
    return;
  }
  if (!result.killed) {
    sendError(res, 409, 'refused', result.refusedReason ?? 'Could not stop the background sleep.');
    return;
  }
  sendJson(res, 200, { cancelled: true, pgid: result.pgid });
}


/**
 * GET /api/sleep/specialists — what each INSTALLED sleep agent currently declares.
 *
 * The Settings dropdowns offer "Package default" as the empty option, and a
 * default nobody can see is a setting nobody can reason about: six rows all
 * reading "Package default" tell you the brain is unconfigured, not what it will
 * actually run. This reports the real frontmatter values so the UI can say
 * "Package default (claude-opus-5)" — the same thing `dreamcontext sleep config`
 * prints in the terminal, from the same source.
 */
export async function handleSleepSpecialistsGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const projectRoot = dirname(contextRoot);
  const out: Record<string, { model: string | null; effort: string | null }> = {};
  for (const name of SLEEP_SPECIALISTS) {
    const installed = readInstalledSpecialistDefaults(projectRoot, name);
    out[name] = { model: installed.model ?? null, effort: installed.effort ?? null };
  }
  sendJson(res, 200, { defaults: out });
}
