import { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { lstatSync } from 'node:fs';
import { sendJson, sendError, parseJsonBody } from '../middleware.js';
import { refuseNotOwner, sendIfNotOwner } from './owner-guard.js';
import { ownerLabel } from '../../lib/agents/owner.js';
import { placement } from '../../lib/agents/active.js';
import { GLOBAL_REGISTRY_KEY, hasProjectMember } from '../../lib/agents/scope.js';
import { composeRun } from '../../lib/agents/compose.js';
import { agentSyncSwitchOn, createdLocally, loginFromEmail } from '../../lib/agents/agent-sync.js';
import { lastAuthorEmail as gitLastAuthorEmail } from '../../lib/git-sync/git.js';
import {
  agentUsage,
  createAgent,
  createGlobalAgent,
  getAgent,
  listGlobalAgents,
  listAgents,
  listAgentTargets,
  removeAgent,
  setAgentPlacement,
  updateAgent,
  withRestamp,
} from '../../lib/agents/store.js';
import {
  DEFAULT_CALL_SETTINGS,
  type AgentIdentityPatch,
  type AgentManifest,
  type AgentPlacementPatch,
} from '../../lib/agents/types.js';
import { isSafeAutomationSlug, readManifestFrontmatter } from '../../lib/agents/slot.js';
import { cadenceLabel, getRunTarget, listAutomations, parsePattern, resolveAutomationPhoto } from '../../lib/automations/store.js';
import { readThread } from '../../lib/automations/threads.js';
import { listInboxRows, type InboxRow } from '../../lib/owner-inbox.js';
import { findTaskHead, readTaskJobs } from '../../lib/agents/task-jobs.js';
import { readStageHomeSession } from '../../lib/local-store.js';
import { findTranscriptBySessionId } from '../../lib/transcript-locate.js';
import { faceOf, parseFace, type AgentFace } from '../../lib/agents/figure.js';
import { agentActivity } from '../automation-job.js';
import { isAgentRequest } from '../desktop.js';
import { isPhoneSocket } from '../phone-origin.js';
import { findLiveChat } from './agent-chat-live.js';
import { roleLineOf, soulExcerpt } from '../../lib/agents/soul.js';
import {
  approvalFields,
  approveAutomation,
  checkApproval,
  registerProject,
  renderApprovalReview,
} from '../../lib/automations/registry.js';
import { nextFire } from '../../lib/automations/schedule.js';
import { loadStatuses } from '../../lib/overrides.js';
import { isSafeTaskSlug, readTaskFile } from '../../lib/task-backend/local.js';
import { isValidWhiteboardSlug } from '../../lib/whiteboards/validate.js';
import {
  AGENT_AUTONOMY_LEVELS,
  AutomationError,
  DEFAULT_AGENT_AUTONOMY,
  EFFORT_LEVELS,
  type AgentAutonomy,
  type AutomationManifest,
  type EffortLevel,
} from '../../lib/automations/types.js';
import {
  isPreviewTruncation,
  receivePhoto,
  sendPhotoFile,
  storeAgentPhoto,
} from './automations.js';

/**
 * `/api/agents` — the agents themselves, independent of any schedule.
 *
 * EVERY summary is computed from `listAgentTargets` (the call target of every
 * agent, the agents of same-slug pairs included). Two verdicts ride on it and
 * are never conflated:
 *  - `approvedForChat` = `checkApproval(…, 'identity')`: Chat, card chat and
 *    sub-agents may speak as it (a bound automation's approval lends this);
 *  - `approvedToRun` = `checkApproval(…, 'run')`: anything that EXECUTES the
 *    call target (a task assignment, an @mention of an agent with no
 *    automation) needs this Mac's direct grant.
 *
 * Nothing here edits call settings. Security is inherited from `index.ts`
 * (network-auth gate, CORS, the cross-site write guard on POSTs).
 */

const DESCRIPTION_MAX_CHARS = 600;

export interface AgentSummary {
  slug: string;
  title: string;
  hasPhoto: boolean;
  description: string;
  /** The soul on one line, at most 160 chars; '' when it has none. */
  soulExcerpt: string;
  /** The prompt's first non-empty line, markdown markers stripped, at most 90 chars. */
  roleLine: string;
  model: string | null;
  effort: EffortLevel | null;
  whiteboard: string | null;
  shared: boolean;
  /** `reports_to` as written (the dashboard's tree applies the read rules). Unhashed. */
  reportsTo: string | null;
  /** `team` as written; drawn only on a lead. Unhashed. */
  team: string | null;
  /** How much it decides alone; decides the permission mode of its sessions. */
  autonomy: AgentAutonomy;
  /** Its figure: the stamped face, else the bare hash of its slug. */
  face: AgentFace;
  approvedForChat: boolean;
  approvedToRun: boolean;
  /** Why it may not run, when it may not (`approvedToRun` false). */
  approvalReason: string | null;
  /** Its creator's login (`machine:<id>`, `unowned`), null on an unstamped file (B1-3). */
  owner: string | null;
  /** How the owner reads in a sentence ("nobody (unowned)" …), null when it has none. */
  ownerLabel: string | null;
  /** Someone else's agent: read-only here, never "needs approval" (B1-4). The approval fields
   *  above are then all false and say nothing about this machine. */
  readOnly: boolean;
  /** `global`: this machine's agent, listed in every project and kept out of every brain (D1). */
  scope: 'project' | 'global';
  /** Same login, several machines (B1-7): where it runs, when that is not this machine. */
  runsElsewhere: { machine: string; name: string } | null;
  /** It arrived by sync and was not created on this machine (the approval view marks it). */
  arrivedBySync: boolean;
  /** When it needs a re-approval after a synced change: who authored that change (login, or the
   *  commit email), so the approval prompt names them beside the diff. */
  syncedChangeBy: string | null;
  /** Synthesised from a not-yet-split legacy automation file. */
  implicit: boolean;
  /** Its call settings differ from the defaults (a migrated on-call agent). */
  hasCallSettings: boolean;
  usedBy: {
    automations: { slug: string; title: string; enabled: boolean; nextFireAt: string | null }[];
    boards: string[];
    tasks: { slug: string; name: string; status: string }[];
  };
}

function hasCallSettings(a: AgentManifest): boolean {
  const c = a.call;
  const d = DEFAULT_CALL_SETTINGS;
  return c.timeoutMinutes !== d.timeoutMinutes || c.outputDir !== d.outputDir || c.review !== d.review
    || c.outputInstructions.trim() !== d.outputInstructions || c.flow !== d.flow;
}

function taskSummary(contextRoot: string, slug: string): { slug: string; name: string; status: string } | null {
  if (!isSafeTaskSlug(slug)) return null;
  const path = join(contextRoot, 'state', `${slug}.md`);
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const t = readTaskFile(path, loadStatuses(contextRoot));
    return { slug: t.slug, name: t.name, status: t.status };
  } catch {
    return null;
  }
}

/** Who authored the newest synced change to an agent's file (login when the email says so). */
function syncedChangeAuthor(contextRoot: string, slug: string): string | null {
  const email = gitLastAuthorEmail(dirname(contextRoot), join('_dream_context', 'agents', `${slug}.md`));
  return email ? loginFromEmail(contextRoot, email) ?? email : null;
}

/** One agent's summary, from its call target as the store composed it. */
export function summarizeAgent(
  contextRoot: string,
  target: AutomationManifest,
  agent: AgentManifest | null,
  home?: string,
): AgentSummary {
  const projectRoot = dirname(contextRoot);
  const global = target.agentScope === 'global';
  const forChat = checkApproval(projectRoot, target, home, 'identity');
  const toRun = checkApproval(projectRoot, target, home, 'run');
  const readOnly = !toRun.approved && toRun.reason === 'not_owner';
  const where = readOnly ? { here: true as const } : placement(contextRoot, target.slug, target.owner ?? null, home);
  const owner = agent?.owner ?? target.owner ?? null;
  const usage = agentUsage(contextRoot, target.slug);
  const now = new Date();
  return {
    slug: target.slug,
    title: target.agentTitle || target.title,
    hasPhoto: resolveAutomationPhoto(contextRoot, target.photo) !== null,
    description: target.prompt.trim().slice(0, DESCRIPTION_MAX_CHARS),
    soulExcerpt: soulExcerpt(target.soul ?? ''),
    roleLine: roleLineOf(target.prompt),
    model: target.model,
    effort: target.effort,
    whiteboard: target.whiteboard ?? null,
    shared: agent?.shared ?? false,
    reportsTo: agent?.reportsTo ?? null,
    team: agent?.team ?? null,
    autonomy: target.autonomy ?? DEFAULT_AGENT_AUTONOMY,
    face: faceOf(target.slug, agent?.face ?? null),
    approvedForChat: forChat.approved,
    approvedToRun: toRun.approved,
    approvalReason: toRun.approved || readOnly ? null : toRun.reason,
    owner,
    ownerLabel: owner ? ownerLabel(owner) : null,
    readOnly,
    scope: global ? 'global' : 'project',
    runsElsewhere: where.here ? null : { machine: where.machine, name: where.name },
    // A global agent never arrives by sync: it is this machine's (D1).
    arrivedBySync: !global && !!agent && !agent.implicit && agentSyncSwitchOn(contextRoot)
      && !createdLocally(contextRoot, `agents/${target.slug}.md`, home),
    syncedChangeBy: !global && !toRun.approved && !readOnly && agentSyncSwitchOn(contextRoot) ? syncedChangeAuthor(contextRoot, target.slug) : null,
    implicit: agent?.implicit ?? false,
    hasCallSettings: agent ? hasCallSettings(agent) : false,
    usedBy: {
      automations: usage.automations.flatMap((slug) => {
        const m = getRunTarget(contextRoot, slug, 'automation');
        if (!m) return [];
        const nextFireAt = m.mode === 'call' || !m.enabled || m.schedule === null
          ? null
          : (nextFire(m.schedule, now)?.toISOString() ?? null);
        return [{ slug: m.slug, title: m.title, enabled: m.enabled, nextFireAt }];
      }),
      boards: usage.boards,
      tasks: usage.tasks.flatMap((slug) => {
        const t = taskSummary(contextRoot, slug);
        return t ? [t] : [];
      }),
    },
  };
}

/** Every agent's summary, sorted by slug (the store's order). */
export function listAgentSummaries(contextRoot: string, home?: string): AgentSummary[] {
  const agents = new Map(listAgents(contextRoot).map((a) => [a.slug, a]));
  return listAgentTargets(contextRoot).map((t) => summarizeAgent(contextRoot, t, agents.get(t.slug) ?? null, home));
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function readEffort(v: unknown): EffortLevel | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v)) return v as EffortLevel;
  throw new AutomationError(`Invalid effort: expected one of ${EFFORT_LEVELS.join(', ')}.`);
}

/** A soul from a request body: absent passes through, '' clears, anything not
 *  text is refused. The store validates the text itself (cap, `## ` lines). */
function readSoul(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new AutomationError('Invalid soul: expected text.');
  return v;
}

/** An autonomy level from a request body: absent passes through, anything else must be a level.
 *  The agent-run refusal lives on the CLI verb (`insideAgentRun`): this server cannot see the
 *  environment of whoever sent the request, so a run that reaches the local API directly is the
 *  named residual of plan-r9 (an agent can raise its own autonomy by escaping the check). */
function readAutonomy(v: unknown): AgentAutonomy | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !(AGENT_AUTONOMY_LEVELS as readonly string[]).includes(v)) {
    throw new AutomationError(`Invalid autonomy: expected one of ${AGENT_AUTONOMY_LEVELS.join(', ')}.`);
  }
  return v as AgentAutonomy;
}

function readWhiteboard(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !isValidWhiteboardSlug(v.trim())) {
    throw new AutomationError('Invalid whiteboard: expected a board slug.');
  }
  return v.trim();
}

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function agentTarget(contextRoot: string, slug: string): AutomationManifest | null {
  return isSafeAutomationSlug(slug) ? getRunTarget(contextRoot, slug, 'agent') : null;
}

function sendSummary(res: ServerResponse, contextRoot: string, slug: string, status = 200): void {
  const target = getRunTarget(contextRoot, slug, 'agent');
  if (!target) {
    sendError(res, 500, 'read_back_failed', 'The agent could not be read back.');
    return;
  }
  sendJson(res, status, { agent: summarizeAgent(contextRoot, target, getAgent(contextRoot, slug)) });
}

/**
 * A global agent is this machine's for every project (D1): nothing on the phone or the tunnel
 * creates, edits, approves or deletes one, as the launcher's own routes are denied there. Sends
 * 403 and returns true when refused.
 */
function refuseGlobalOnPhone(req: IncomingMessage, res: ServerResponse, global: boolean): boolean {
  if (!global || !isPhoneSocket(req)) return false;
  sendError(res, 403, 'phone_unavailable', 'Global agents are changed on the Mac itself.');
  return true;
}

function isGlobalHere(contextRoot: string, slug: string): boolean {
  return isSafeAutomationSlug(slug) && getAgent(contextRoot, slug)?.scope === 'global';
}

function sendWriteError(res: ServerResponse, err: unknown, code: string, message: string): void {
  // Someone else's agent: read-only here, 403 with the owner named (B1-4).
  if (sendIfNotOwner(res, err)) return;
  if (err instanceof AutomationError) {
    sendError(res, 400, 'invalid', err.message);
    return;
  }
  console.error(`[agents] ${code}`, err);
  sendError(res, 500, code, message);
}

/** GET /api/agents */
export async function handleAgentsList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    sendJson(res, 200, { agents: listAgentSummaries(contextRoot) });
  } catch (err) {
    console.error('[agents] list failed', err);
    sendError(res, 500, 'list_failed', 'Failed to list the agents.');
  }
}

/**
 * GET /api/agents/:slug — the summary, the full prompt and soul, the parsed
 * pattern (read-only, newest lesson first), and the call-target
 * review: every hashed field, call settings included, exactly what an approve
 * grants (the same `renderApprovalReview` the CLI shows).
 */
export async function handleAgentsShow(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const target = agentTarget(contextRoot, params.slug);
  if (!target) {
    sendError(res, 404, 'not_found', `Agent not found: ${params.slug}`);
    return;
  }
  const agent = getAgent(contextRoot, params.slug);
  sendJson(res, 200, {
    agent: summarizeAgent(contextRoot, target, agent),
    prompt: target.prompt,
    soul: target.soul ?? '',
    learning: target.learning,
    pattern: parsePattern(agent?.pattern ?? target.pattern),
    review: renderApprovalReview(approvalFields(target)),
  });
}

/** POST /api/agents {title, prompt, slug?, soul?, model?, effort?, whiteboard?, learning?} —
 *  create an agent and grant it directly on this machine (the local author consents). */
export async function handleAgentsCreate(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'bad_body', 'Expected a JSON body.');
    return;
  }
  if (refuseGlobalOnPhone(req, res, body.scope === 'global')) return;
  try {
    const title = (str(body.title) ?? '').trim();
    if (!title) throw new AutomationError('Give the agent a name.');
    const prompt = (str(body.prompt) ?? '').trim();
    if (!prompt) throw new AutomationError('Describe who the agent is — that description is its prompt.');
    const slug = (str(body.slug) ?? '').trim() || slugifyTitle(title);
    if (!isSafeAutomationSlug(slug)) {
      throw new AutomationError(`"${title}" does not make a usable name — try plain letters and numbers.`);
    }
    const projectRoot = dirname(contextRoot);
    registerProject(projectRoot);
    const input = {
      slug,
      title,
      prompt,
      soul: readSoul(body.soul) ?? '',
      model: str(body.model) ?? null,
      effort: readEffort(body.effort) ?? null,
      whiteboard: readWhiteboard(body.whiteboard) ?? null,
      ...(typeof body.learning === 'boolean' ? { learning: body.learning } : {}),
    };
    if (body.scope === 'global') {
      // Listed in every project; here too, so no member of this project may already hold the name.
      if (hasProjectMember(contextRoot, slug)) throw new AutomationError(`"${slug}" is already the name of an agent or an automation in this project.`);
      createGlobalAgent(input, { approve: { now: new Date() } });
    } else {
      createAgent(contextRoot, input, { approve: { now: new Date() } });
    }
    sendSummary(res, contextRoot, slug);
  } catch (err) {
    sendWriteError(res, err, 'create_failed', 'Failed to create the agent.');
  }
}

/** A global agent as the launcher lists it: no project, so no usage and no project approval (D1). */
export interface GlobalAgentRow {
  slug: string;
  title: string;
  roleLine: string;
  description: string;
  face: AgentFace;
  autonomy: string;
  model: string | null;
  approvedToRun: boolean;
}

function globalAgentRow(agent: AgentManifest): GlobalAgentRow {
  const target = composeRun(agent, null, [], false);
  return {
    slug: agent.slug,
    title: agent.title,
    roleLine: roleLineOf(agent.prompt),
    description: agent.prompt.trim().slice(0, DESCRIPTION_MAX_CHARS),
    face: faceOf(agent.slug, agent.face),
    autonomy: agent.autonomy,
    model: agent.model,
    approvedToRun: checkApproval(GLOBAL_REGISTRY_KEY, target, undefined, 'run').approved,
  };
}

/** GET /api/launcher/global-agents — this machine's global agents (vault-agnostic, D1). */
export async function handleLauncherGlobalAgents(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string | null,
): Promise<void> {
  try {
    sendJson(res, 200, { agents: listGlobalAgents().map(globalAgentRow) });
  } catch (err) {
    console.error('[agents] global list failed', err);
    sendError(res, 500, 'list_failed', 'Failed to list the global agents.');
  }
}

/** POST /api/launcher/global-agents {title, prompt, slug?, soul?, model?, effort?, learning?} —
 *  create a global agent from the launcher, granted on this machine (vault-agnostic, D1). */
export async function handleLauncherGlobalAgentsCreate(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string | null,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'bad_body', 'Expected a JSON body.');
    return;
  }
  try {
    const title = (str(body.title) ?? '').trim();
    if (!title) throw new AutomationError('Give the agent a name.');
    const prompt = (str(body.prompt) ?? '').trim();
    if (!prompt) throw new AutomationError('Describe who the agent is — that description is its prompt.');
    const slug = (str(body.slug) ?? '').trim() || slugifyTitle(title);
    if (!isSafeAutomationSlug(slug)) throw new AutomationError(`"${title}" does not make a usable name — try plain letters and numbers.`);
    const agent = createGlobalAgent({
      slug,
      title,
      prompt,
      soul: readSoul(body.soul) ?? '',
      model: str(body.model) ?? null,
      effort: readEffort(body.effort) ?? null,
      ...(typeof body.learning === 'boolean' ? { learning: body.learning } : {}),
    }, { approve: { now: new Date() } });
    sendJson(res, 201, { agent: globalAgentRow(agent) });
  } catch (err) {
    sendWriteError(res, err, 'create_failed', 'Failed to create the global agent.');
  }
}

/**
 * POST /api/agents/:slug/update — an identity edit through `withRestamp`: what
 * was directly approved before, and is still exactly what this edit produced,
 * is re-approved; nothing else is. Identity fields only: no call setting is
 * editable here.
 */
export async function handleAgentsUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (refuseGlobalOnPhone(req, res, isGlobalHere(contextRoot, params.slug))) return;
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'bad_body', 'Expected a JSON body.');
    return;
  }
  const current = isSafeAutomationSlug(params.slug) ? getAgent(contextRoot, params.slug) : null;
  if (!current) {
    sendError(res, 404, 'not_found', `Agent not found: ${params.slug}`);
    return;
  }
  try {
    const patch: AgentIdentityPatch = {};
    if (str(body.title) !== undefined) patch.title = str(body.title);
    const prompt = str(body.prompt);
    if (prompt !== undefined) {
      if (isPreviewTruncation(prompt, current.prompt)) {
        sendError(res, 409, 'prompt_truncated',
          'This save would replace the prompt with its first 600 characters. Reopen the agent so the full prompt loads, then save again.');
        return;
      }
      patch.prompt = prompt;
    }
    if (body.model !== undefined) patch.model = str(body.model) ?? null;
    const effort = readEffort(body.effort);
    if (effort !== undefined) patch.effort = effort;
    const whiteboard = readWhiteboard(body.whiteboard);
    if (whiteboard !== undefined) patch.whiteboard = whiteboard;
    if (typeof body.learning === 'boolean') patch.learning = body.learning;
    // No preview-truncation guard: the dialog always loads the full soul from
    // GET detail, and the summary's excerpt is never a form source. '' clears.
    const soul = readSoul(body.soul);
    if (soul !== undefined) patch.soul = soul;
    const autonomy = readAutonomy(body.autonomy);
    if (autonomy !== undefined) patch.autonomy = autonomy;
    if (Object.keys(patch).length > 0) withRestamp(contextRoot, dirname(contextRoot), params.slug, patch);
    sendSummary(res, contextRoot, params.slug);
  } catch (err) {
    sendWriteError(res, err, 'update_failed', 'Failed to save the agent.');
  }
}

/** A placement value from a request body: absent passes through, null or '' clears, anything
 *  not text is refused. The store validates the value itself. */
function readPlacementValue(v: unknown, what: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw new AutomationError(`Invalid ${what}: expected text.`);
  return v;
}

/**
 * POST /api/agents/:slug/place {reportsTo?, team?} — where the agent sits in the team. Both
 * keys are unhashed, so this never re-approves and never blocks anything; a loop, an unknown
 * manager or an agent not yet split is refused (400).
 */
export async function handleAgentsPlace(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (refuseGlobalOnPhone(req, res, isGlobalHere(contextRoot, params.slug))) return;
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'bad_body', 'Expected a JSON body.');
    return;
  }
  if (!isSafeAutomationSlug(params.slug) || !getAgent(contextRoot, params.slug)) {
    sendError(res, 404, 'not_found', `Agent not found: ${params.slug}`);
    return;
  }
  try {
    const patch: AgentPlacementPatch = {};
    const reportsTo = readPlacementValue(body.reportsTo, 'manager');
    if (reportsTo !== undefined) patch.reportsTo = reportsTo;
    const team = readPlacementValue(body.team, 'team');
    if (team !== undefined) patch.team = team;
    setAgentPlacement(contextRoot, params.slug, patch);
    sendSummary(res, contextRoot, params.slug);
  } catch (err) {
    sendWriteError(res, err, 'place_failed', 'Failed to place the agent in the team.');
  }
}

/** POST /api/agents/:slug/delete — refused (409 `agent_in_use`) while an
 *  automation runs as it; otherwise removed under the registry's revoke rule. */
export async function handleAgentsDelete(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (refuseGlobalOnPhone(req, res, isGlobalHere(contextRoot, params.slug))) return;
  if (!isSafeAutomationSlug(params.slug) || !getAgent(contextRoot, params.slug)) {
    sendError(res, 404, 'not_found', `Agent not found: ${params.slug}`);
    return;
  }
  try {
    const result = removeAgent(contextRoot, params.slug);
    if (!result.removed) {
      sendJson(res, 409, {
        error: 'agent_in_use',
        message: `This agent still runs ${result.usedBy.join(', ')}. Delete or move those automations first.`,
        usedBy: result.usedBy,
      });
      return;
    }
    sendJson(res, 200, { ok: true, slug: params.slug });
  } catch (err) {
    sendWriteError(res, err, 'delete_failed', 'Failed to delete the agent.');
  }
}

/** POST /api/agents/:slug/approve — grant the agent's CALL target as it stands
 *  right now, on this machine (the owner reviewed it on the AI Team page). */
export async function handleAgentsApprove(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (refuseGlobalOnPhone(req, res, isGlobalHere(contextRoot, params.slug))) return;
  const target = agentTarget(contextRoot, params.slug);
  if (!target) {
    sendError(res, 404, 'not_found', `Agent not found: ${params.slug}`);
    return;
  }
  try {
    const projectRoot = dirname(contextRoot);
    registerProject(projectRoot);
    approveAutomation(projectRoot, target, new Date());
    sendSummary(res, contextRoot, params.slug);
  } catch (err) {
    sendWriteError(res, err, 'approve_failed', 'Failed to approve the agent.');
  }
}

/** GET /api/agents/:slug/photo — through `resolveAutomationPhoto`, or 404. */
export async function handleAgentsPhotoGet(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const agent = isSafeAutomationSlug(params.slug) ? getAgent(contextRoot, params.slug) : null;
    sendPhotoFile(res, agent ? resolveAutomationPhoto(contextRoot, agent.photo) : null);
  } catch {
    sendError(res, 404, 'no_photo', 'This agent has no photo.');
  }
}

/** POST /api/agents/:slug/photo — raw image bytes; the photo is unhashed, so
 *  this never re-approves and never blocks anything. */
export async function handleAgentsPhotoUpload(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (refuseGlobalOnPhone(req, res, isGlobalHere(contextRoot, params.slug))) return;
  const slug = params.slug;
  const agent = isSafeAutomationSlug(slug) ? getAgent(contextRoot, slug) : null;
  if (!agent) {
    sendError(res, 404, 'not_found', `Agent not found: ${slug}`);
    return;
  }
  if (refuseNotOwner(res, { slug, owner: agent.owner, title: agent.title })) return;
  const image = await receivePhoto(req, res);
  if (!image) return;
  try {
    const rel = storeAgentPhoto(contextRoot, slug, image);
    updateAgent(contextRoot, slug, { photo: rel });
    sendSummary(res, contextRoot, slug);
  } catch (err) {
    sendWriteError(res, err, 'photo_failed', 'Failed to save the photo.');
  }
}

// ─── The agent's STAGE (AI Team v2) ─────────────────────────────────────────────────────────

const STAGE_REPORTS = 5;
const STAGE_FILES = 8;
/** How many day files of each thread a stage read looks at: a bound, not a filter. */
const STAGE_THREAD_DAYS = 14;

/**
 * Home conversations known to have a transcript. Only the positive is kept: a transcript, once
 * written, stays, so the stage poll scans `~/.claude/projects` only while a home is still empty.
 */
const HOME_WITH_TURNS = new Set<string>();

function homeHasTurns(home: string | null): boolean {
  if (!home) return false;
  if (HOME_WITH_TURNS.has(home)) return true;
  if (findTranscriptBySessionId([home]) === null) return false;
  HOME_WITH_TURNS.add(home);
  return true;
}

export type StageFileKind = 'doc' | 'board' | 'image' | 'data' | 'other';

/** A posted file's kind, from its brain-relative path. */
export function stageFileKind(path: string): StageFileKind {
  const p = path.toLowerCase();
  if (p.endsWith('.excalidraw.md') || p.startsWith('whiteboards/')) return 'board';
  if (/\.(md|markdown|txt|pdf|html?)$/.test(p)) return 'doc';
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(p)) return 'image';
  if (/\.(json|csv|tsv|ya?ml)$/.test(p)) return 'data';
  return 'other';
}

export interface StageView {
  slug: string;
  title: string;
  face: AgentFace;
  autonomy: AgentAutonomy;
  /** The conversation the stage's chat resumes; null before its first one. Machine-local. */
  homeSessionId: string | null;
  /** A live, ATTACHED process holds the home session right now (a stage, or a Chat tab). */
  homeLive: boolean;
  /** The home conversation has at least one turn: Claude keeps a transcript only after the first
   *  one, so a stage that was opened and never spoken to has none. The page opens such an agent on
   *  its activity, where its routines' messages are, instead of an empty chat. */
  homeHasTurns: boolean;
  /** Whose agent it is (arrives with the brain sync); null on this build. */
  owner: string | null;
  /** What it is doing right now: one row per target of it holding its run lock. */
  liveJobs: { slug: string; title: string; since: number; runId: string | null; lastLine: string | null }[];
  /** Its latest posts, newest first. */
  reports: { slug: string; id: string; runId: string; at: string; text: string; files: string[] }[];
  /** The latest files it posted, newest first, de-duplicated. */
  files: { path: string; kind: StageFileKind; at: string; slug: string }[];
  /** Its routines (scheduled automations that run as it). */
  routines: { slug: string; title: string; enabled: boolean; nextFireAt: string | null; cadence: string; face: AgentFace }[];
  /** Rows waiting on the owner about this agent (M1). */
  inbox: InboxRow[];
  /** Its task-job steps on this machine (M0 claims): task steps run in detached hosts, not as
   *  server jobs, so the stage reads them here. A task session is shown read-only, never chatted. */
  taskJobs: { taskId: string; taskSlug: string; taskName: string; step: string; role: string; round: number; phase: string; sessionId: string | null; claimedAt: string }[];
}

/** The stage view of `slug`, or null when there is no such agent. Read-only. */
export function buildStageView(contextRoot: string, slug: string, now: Date = new Date()): StageView | null {
  const target = agentTarget(contextRoot, slug);
  if (!target) return null;
  const agent = getAgent(contextRoot, slug);
  const routines = listAutomations(contextRoot).filter((m) => m.runKind !== 'agent' && m.mode === 'sched' && (m.agent ?? m.slug) === slug);
  // Its own call target and every routine that runs as it: the slugs its work happens under.
  const slugs = [slug, ...routines.map((m) => m.slug).filter((s) => s !== slug)];
  const titleOf = (s: string): string => (s === slug ? target.agentTitle || target.title : routines.find((m) => m.slug === s)?.title ?? s);

  const liveJobs: StageView['liveJobs'] = [];
  for (const s of slugs) {
    const a = agentActivity(contextRoot, s, now.getTime());
    if (a) liveJobs.push({ slug: s, title: titleOf(s), since: a.since, runId: a.runId, lastLine: null });
  }

  const posts = slugs.flatMap((s) => readThread(contextRoot, s, { days: STAGE_THREAD_DAYS })
    .filter((e) => e.kind === 'agent')
    .map((e) => ({ slug: s, e })));
  posts.sort((a, b) => (a.e.id < b.e.id ? 1 : a.e.id > b.e.id ? -1 : 0));
  const reports = posts.slice(0, STAGE_REPORTS).map(({ slug: s, e }) => ({
    slug: s, id: e.id, runId: e.runId, at: e.at, text: e.text, files: e.files ?? [],
  }));
  const seen = new Set<string>();
  const files: StageView['files'] = [];
  for (const { slug: s, e } of posts) {
    for (const path of e.files ?? []) {
      if (seen.has(path)) continue;
      seen.add(path);
      files.push({ path, kind: stageFileKind(path), at: e.at, slug: s });
      if (files.length >= STAGE_FILES) break;
    }
    if (files.length >= STAGE_FILES) break;
  }

  const home = readStageHomeSession(dirname(contextRoot), slug);
  return {
    slug,
    title: target.agentTitle || target.title,
    face: faceOf(slug, agent?.face ?? null),
    autonomy: target.autonomy ?? DEFAULT_AGENT_AUTONOMY,
    homeSessionId: home,
    // Held = a live child with a socket bound to it right now. A detached one (its pane closed a
    // moment ago) is not held: the stage adopts it.
    homeLive: !!home && !!findLiveChat(home)?.holder?.(),
    homeHasTurns: homeHasTurns(home),
    owner: null,
    liveJobs,
    reports,
    files,
    routines: routines.map((m) => ({
      slug: m.slug,
      title: m.title,
      enabled: m.enabled,
      nextFireAt: !m.enabled || m.schedule === null ? null : (nextFire(m.schedule, now)?.toISOString() ?? null),
      cadence: cadenceLabel(m),
      face: faceOf(m.slug, parseFace(readManifestFrontmatter(m.path)?.data.face)),
    })),
    inbox: listInboxRows(dirname(contextRoot)).filter((r) => r.agent === slug),
    taskJobs: readTaskJobs(dirname(contextRoot)).claims
      .filter((c) => c.agent === slug && c.phase !== 'claiming')
      .map((c) => ({
        taskId: c.taskId,
        taskSlug: c.taskSlug,
        taskName: findTaskHead(contextRoot, c.taskId)?.name ?? c.taskSlug,
        step: c.step, role: c.role, round: c.round, phase: c.phase, sessionId: c.sessionId, claimedAt: c.claimedAt,
      })),
  };
}

/** GET /api/agents/:slug/stage — the stage's data, read-only. The desktop app only: the stage
 *  opens a live conversation, which only the desktop hosts. */
export async function handleAgentsStage(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!isAgentRequest(req)) {
    sendError(res, 403, 'forbidden', 'An agent\'s stage is available in the desktop app only.');
    return;
  }
  try {
    const view = buildStageView(contextRoot, params.slug);
    if (!view) {
      sendError(res, 404, 'not_found', `Agent not found: ${params.slug}`);
      return;
    }
    sendJson(res, 200, { stage: view });
  } catch (err) {
    console.error('[agents] stage failed', err);
    sendError(res, 500, 'stage_failed', 'Failed to read the agent\'s stage.');
  }
}
