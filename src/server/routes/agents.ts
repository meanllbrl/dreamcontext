import { notifyAgentLevel } from '../../lib/agents/level-follow.js';
import { agentLevelInForce } from '../../lib/whiteboards/card-chat.js';
import { isCodexAccountId } from '../../lib/t3-bridge/accounts.js';
import { telegramHub } from '../telegram/hub.js';
import { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { lstatSync } from 'node:fs';
import { sendJson, sendError, parseJsonBody } from '../middleware.js';
import { refuseUnlessOwnerPage } from '../owner-page.js';
import { refuseNotOwner, sendIfNotOwner } from './owner-guard.js';
import { fromOwnerPage, ownerRefusalMessage } from './assistant.js';
import { narrowLiveMember } from './crew-binding.js';
import { levelChatMode, narrowerMode } from '../../lib/agents/permission.js';
import { ownerLabel } from '../../lib/agents/owner.js';
import { AmendmentRefused, listAmendments, ownerEdit, revertAmendment } from '../../lib/agents/amendments.js';
import { settleApprovalQuestions } from '../../lib/automations/hitl.js';
import { tellSuperAutomationDecision } from '../../lib/super/automation-event.js';
import { placement } from '../../lib/agents/active.js';
import { GLOBAL_REGISTRY_KEY, globalAgentExists, hasProjectMember } from '../../lib/agents/scope.js';
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
  setAgentCallEnabled,
  setAgentPlacement,
  updateAgent,
} from '../../lib/agents/store.js';
import {
  DEFAULT_CALL_SETTINGS,
  type AgentIdentityPatch,
  type AgentManifest,
  type AgentPlacementPatch,
} from '../../lib/agents/types.js';
import { isSafeAutomationSlug, readManifestFrontmatter } from '../../lib/agents/slot.js';
import { cadenceLabel, getRunTarget, listAutomations, parsePattern, resolveAutomationPhoto, runChildAlive } from '../../lib/automations/store.js';
import { readThread } from '../../lib/automations/threads.js';
import { listInboxRows, type InboxRow } from '../../lib/owner-inbox.js';
import { findTaskHead, readTaskJobs } from '../../lib/agents/task-jobs.js';
import { latestStageSession, readStageHomeSession } from '../../lib/local-store.js';
import { lastTalkAt } from '../../lib/agents/history.js';
import { listAgentHistory } from '../../lib/agents/history.js';
import { sanitizeUuid } from './agent-spawn-shared.js';
import { faceOf, parseFace, type AgentFace } from '../../lib/agents/figure.js';
import { agentActivity, runIsActive, type AgentActivity } from '../automation-job.js';
import { isAgentRequest } from '../desktop.js';
import { isPhoneSocket } from '../phone-origin.js';
import { findLiveChat } from './agent-chat-live.js';
import { deleteMember, planMemberDelete } from '../member-delete.js';
import { roleLineOf, soulExcerpt } from '../../lib/agents/soul.js';
import {
  approvalFields,
  approveAutomation,
  changedApprovalFields,
  approvedTarget,
  checkApproval,
  registerProject,
  renderApprovalReview,
} from '../../lib/automations/registry.js';
import { nextFireIso } from '../../lib/automations/approval-card.js';
import { describePendingChange, type PendingChangeInfo } from '../../lib/agents/pending-change.js';
import { loadStatuses } from '../../lib/overrides.js';
import { isSafeTaskSlug, readTaskFile } from '../../lib/task-backend/local.js';
import { isValidWhiteboardSlug } from '../../lib/whiteboards/validate.js';
import {
  AGENT_AUTONOMY_LEVELS,
  AutomationError,
  EFFORT_LEVELS,
  type AgentAutonomy,
  type AutomationManifest,
  type EffortLevel,
} from '../../lib/automations/types.js';
import { agentBoardView, answerBoardScope } from '../../lib/agents/board-question.js';
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
  tool: 'claude' | 'codex' | 'antigravity';
  account: string | null;
  whiteboard: string | null;
  /** `scope: board`: limited to its home board by its own file. */
  boardOnly: boolean;
  /** Limited to its board right now: its `scope: board` (or a `board` mark here). An older board
   *  agent with `boardQuestion` open is NOT limited (2026-11-09). */
  boardLimited: boolean;
  /** The one offer an older board agent carries: keep it limited to its board? */
  boardQuestion: boolean;
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
  /** Its `call.enabled` (the AI Team on/off switch). */
  enabled: boolean;
  /** Why it may not run, when it may not (`approvedToRun` false). */
  approvalReason: string | null;
  /** A newer version that waits for the owner's card: who wrote it, when, which fields, what was
   *  flagged, and whether the member keeps working on its last approved text meanwhile. */
  pendingChange: PendingChangeInfo | null;
  /** Its creator's login (`machine:<id>`, `unowned`), null on an unstamped file (B1-3). */
  owner: string | null;
  /** How the owner reads in a sentence ("nobody (unowned)" …), null when it has none. */
  ownerLabel: string | null;
  /** Someone else's agent: read-only here, never "needs approval" (B1-4). The approval fields
   *  above are then all false and say nothing about this machine. */
  readOnly: boolean;
  /** `global`: this machine's agent, listed in every project and kept out of every brain (D1). */
  scope: 'project' | 'global';
  /** A global agent: when it was last talked with in THIS project. Null when never, or a project member. */
  lastTalkAt: string | null;
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
  // The one question every run and conversation asks (`approvedTarget`): a change waiting for the
  // owner's card leaves the member working on its last approved text.
  const forChat = approvedTarget(projectRoot, target, home, 'identity').verdict;
  const runView = approvedTarget(projectRoot, target, home, 'run');
  const toRun = runView.verdict;
  const waiting = runView.pending !== null || (!toRun.approved && toRun.reason === 'manifest-changed');
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
    tool: target.tool ?? 'claude',
    account: target.account ?? null,
    whiteboard: target.whiteboard ?? null,
    boardOnly: target.boardOnly === true,
    ...boardFacts(contextRoot, target, readOnly, home),
    shared: agent?.shared ?? false,
    reportsTo: agent?.reportsTo ?? null,
    team: agent?.team ?? null,
    // The level its conversations run at (the last approved text), so the label never shows a
    // level a waiting change has not put in force yet.
    autonomy: agentLevelInForce(contextRoot, target, home),
    face: faceOf(target.slug, agent?.face ?? null),
    approvedForChat: forChat.approved,
    approvedToRun: toRun.approved,
    approvalReason: toRun.approved || readOnly ? null : toRun.reason,
    pendingChange: waiting && !readOnly ? describePendingChange(contextRoot, target, runView.pending !== null, home) : null,
    enabled: target.enabled,
    owner,
    ownerLabel: owner ? ownerLabel(owner) : null,
    readOnly,
    scope: global ? 'global' : 'project',
    lastTalkAt: global ? lastTalkAt(contextRoot, target.slug, home) : null,
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
        const nextFireAt = nextFireIso(m, now, { projectRoot, home });
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
 *  The agent-run refusal lives on the CLI verb (`insideAgentRun`); a run that reaches the local
 *  API directly (plan-r9's residual) is stopped by the update route itself: a level CHANGE needs
 *  the owner's proof there (uye-bildirim K3 "Level"), which no agent holds. */
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

function sendSummary(res: ServerResponse, contextRoot: string, slug: string, status = 200, extra?: Record<string, unknown>): void {
  const target = getRunTarget(contextRoot, slug, 'agent');
  if (!target) {
    sendError(res, 500, 'read_back_failed', 'The agent could not be read back.');
    return;
  }
  sendJson(res, status, { agent: summarizeAgent(contextRoot, target, getAgent(contextRoot, slug)), ...(extra ?? {}) });
}

/**
 * A global agent is this machine's for every project (D1): nothing on the phone or the tunnel
 * creates, edits, approves or deletes one, as the launcher's own routes are denied there. Sends
 * 403 and returns true when refused.
 */
function refuseGlobalOnPhone(req: IncomingMessage, res: ServerResponse, global: boolean): boolean {
  if (!global || !isPhoneSocket(req)) return false;
  sendError(res, 403, 'phone_unavailable', 'Teammates in all projects are changed on the Mac itself.');
  return true;
}

/** The app's own words for a name one of them holds (the store's sentence is also the CLI's). */
function refuseGlobalName(slug: string): void {
  if (globalAgentExists(slug)) throw new AutomationError(`"${slug}" is already the name of one of your teammates in all projects.`);
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
    // The fields the one approval card names (a synced or waiting change, plan-r10 1e); null when
    // nothing waits or this Mac never stamped it with field hashes.
    changedFields: changedApprovalFields(dirname(contextRoot), target),
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
  if (refuseUnlessOwnerPage(req, res, 'creates an agent approved on this machine')) return;
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
    refuseGlobalName(slug);
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
      ...(body.boardOnly === true ? { boardOnly: true } : {}),
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
    sendError(res, 500, 'list_failed', 'Failed to list the teammates in all projects.');
  }
}

/** POST /api/launcher/global-agents {title, prompt, slug?, soul?, model?, effort?, learning?} —
 *  create a global agent, granted on this machine (D1). Works with no project (the launcher) and
 *  from a project's "+ New", which names its project. */
export async function handleLauncherGlobalAgentsCreate(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string | null,
): Promise<void> {
  if (refuseUnlessOwnerPage(req, res, 'creates a teammate approved on this machine')) return;
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
    refuseGlobalName(slug);
    // Sent from a project's "+ New": that project's member would hide the new one here.
    if (contextRoot && hasProjectMember(contextRoot, slug)) throw new AutomationError(`"${slug}" is already the name of an agent or an automation in this project.`);
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
    sendWriteError(res, err, 'create_failed', 'Failed to create the teammate.');
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
  if (refuseUnlessOwnerPage(req, res, 'edits an agent and re-approves it')) return;
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
    if (body.tool !== undefined) {
      if (body.tool !== null && body.tool !== '' && body.tool !== 'claude' && body.tool !== 'codex' && body.tool !== 'antigravity') throw new AutomationError('Invalid tool: Claude, Codex or Antigravity.');
      patch.tool = body.tool === 'codex' || body.tool === 'antigravity' ? body.tool : null;
    }
    if (body.account !== undefined) {
      if (body.account !== null && body.account !== '' && !(typeof body.account === 'string' && isCodexAccountId(body.account))) throw new AutomationError('Invalid account.');
      patch.account = (body.account as string) || null;
    }
    const whiteboard = readWhiteboard(body.whiteboard);
    if (whiteboard !== undefined) patch.whiteboard = whiteboard;
    if (typeof body.boardOnly === 'boolean') patch.boardOnly = body.boardOnly;
    if (typeof body.learning === 'boolean') patch.learning = body.learning;
    // No preview-truncation guard: the dialog always loads the full soul from
    // GET detail, and the summary's excerpt is never a form source. '' clears.
    const soul = readSoul(body.soul);
    if (soul !== undefined) patch.soul = soul;
    const autonomy = readAutonomy(body.autonomy);
    // A level CHANGE is the owner's alone (uye-bildirim K3 "Level"): the shell's owner key on the
    // desktop, or the phone's own signed-in session; Origin alone is a header any process can
    // write. A save that leaves the level as it is keeps the guard above.
    const levelChange = autonomy !== undefined && autonomy !== current.autonomy;
    if (levelChange && !fromOwnerPage(req) && !isPhoneSocket(req)) {
      sendError(res, 403, 'owner_page_only', ownerRefusalMessage(req, 'Only the owner, in the app, changes an AI Team member\'s autonomy level. An agent or a script cannot.'));
      return;
    }
    if (autonomy !== undefined) patch.autonomy = autonomy;
    if (Object.keys(patch).length > 0) {
      // His save is his consent (owner 2026-11-07: nothing made on this Mac asks), a widening one and
      // another tool included: stamped (`consent`) and traced, so he can take it back. Only what
      // was approved as it stood before the save is stamped (`withRestamp`): a teammate's change
      // waiting for its card stays waiting.
      ownerEdit(contextRoot, params.slug, patch, { consent: true, why: 'edited on the AI Team page' });
      // Its open chats switch to the new level now (idle) or at their turn's end.
      notifyAgentLevel(contextRoot, params.slug);
      // A new title is the bot's new name in Telegram.
      if (patch.title !== undefined && patch.title !== current.title) telegramHub()?.refreshIdentity(params.slug);
    }
    // Where the new level holds: a narrower one reaches the member's running sessions now (the
    // live mode switch), a wider one only its next session start. The profile says which.
    const applies = levelChange && autonomy !== undefined
      ? levelApplies(params.slug, current.autonomy, autonomy, isGlobalHere(contextRoot, params.slug) ? undefined : dirname(contextRoot))
      : undefined;
    sendSummary(res, contextRoot, params.slug, 200, applies ? { applies } : undefined);
  } catch (err) {
    sendWriteError(res, err, 'update_failed', 'Failed to save the agent.');
  }
}

/** A level change takes effect: `now` when it narrowed and every running session of the member
 *  took the narrower mode live, else `next_session`. */
export function levelApplies(member: string, from: AgentAutonomy, to: AgentAutonomy, project?: string): 'now' | 'next_session' {
  const target = levelChatMode(to);
  const narrowing = narrowerMode(target, levelChatMode(from)) === target && target !== levelChatMode(from);
  if (!narrowing) return 'next_session';
  return narrowLiveMember(member, target, project).now ? 'now' : 'next_session';
}

/**
 * POST /api/agents/:slug/enabled {enabled} — the Ekip list's on/off switch (plan-r10 1d): the
 * member's `call.enabled` and nothing else, so it stays exactly as approved. The owner's page only
 * (an agent never turns a member back on, plan-r10 1e), never a teammate's member (`not_owner`). A
 * global member's switch writes the global manifest: off in every project.
 */
export async function handleAgentsSetEnabled(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (refuseUnlessOwnerPage(req, res, 'turns a member on or off')) return;
  if (refuseGlobalOnPhone(req, res, isGlobalHere(contextRoot, params.slug))) return;
  const agent = isSafeAutomationSlug(params.slug) ? getAgent(contextRoot, params.slug) : null;
  if (!agent) {
    sendError(res, 404, 'not_found', `Agent not found: ${params.slug}`);
    return;
  }
  if (refuseNotOwner(res, { slug: agent.slug, owner: agent.owner, title: agent.title })) return;
  const body = await parseJsonBody(req);
  if (!body || typeof body.enabled !== 'boolean') {
    sendError(res, 400, 'bad_body', 'Expected { enabled: true | false }.');
    return;
  }
  try {
    setAgentCallEnabled(contextRoot, params.slug, body.enabled);
    // Turned off from the Super Agent's approval card (its Decline): the super hears the NO.
    if (body.enabled === false) await tellSuperMember(contextRoot, body.sessionId, params.slug, 'rejected');
    // Turned off: its live member Super stops (plan-r10 1, security r8-3), its keys die. Only a
    // member that has a Super record here; a pending request then waits and main hears it once.
    if (body.enabled === false) {
      const { listMemberSupers } = await import('../../lib/super/store.js');
      if ((await listMemberSupers(contextRoot)).includes(params.slug)) {
        const { stopMemberSuper } = await import('./super.js');
        await stopMemberSuper(contextRoot, params.slug).catch((err: unknown) => console.warn(`[super] ${params.slug}: its Super did not stop: ${(err as Error).message}`));
      }
    }
    sendSummary(res, contextRoot, params.slug);
  } catch (err) {
    sendWriteError(res, err, 'enable_failed', 'Failed to switch the member.');
  }
}

/** Queue an owner's decision on a member's approval for the Super Agent, when the card he used
 *  sits in its chat (`sessionId` is the super's or a child's session). Never throws: the decision
 *  itself is written either way. */
async function tellSuperMember(contextRoot: string, sessionId: unknown, slug: string, decision: 'approved' | 'rejected'): Promise<boolean> {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) return false;
  try {
    return await tellSuperAutomationDecision(contextRoot, sessionId, slug, decision, Date.now(), 'member');
  } catch {
    return false;
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
  // The member's own delete from its stage (plan r4 R4, F2-F5): `{ withRoutines: true }` removes
  // every routine that runs as it too (in every project for a global member), all or nothing,
  // with a trash copy; `dryRun` answers the plan the dialog shows and changes nothing. Mac only,
  // from the owner's own page. Without the flag the old 409 `agent_in_use` stands.
  const body = (await parseJsonBody(req)) ?? {};
  if (body.withRoutines === true) {
    if (refuseUnlessOwnerPage(req, res, 'deletes a member')) return;
    if (isPhoneSocket(req)) { sendError(res, 403, 'phone_unavailable', 'A member is deleted on the Mac itself.'); return; }
    try {
      if (body.dryRun === true) {
        const plan = await planMemberDelete(contextRoot, params.slug);
        if (!plan) { sendError(res, 404, 'not_found', `Agent not found: ${params.slug}`); return; }
        sendJson(res, 200, { ok: true, plan });
        return;
      }
      const { stopMemberSuper } = await import('./super.js');
      const { retireMemberSuper } = await import('../../lib/super/inbox.js');
      const out = await deleteMember(contextRoot, params.slug, { stopSuper: stopMemberSuper, retireSuper: (root, slug) => retireMemberSuper(root, slug) });
      if (!out) { sendError(res, 404, 'not_found', `Agent not found: ${params.slug}`); return; }
      if (out.plan.blockers.length) {
        sendJson(res, 409, { error: out.plan.blockers.includes('read_only') ? 'read_only' : 'member_working', message: 'The member cannot be deleted right now.', plan: out.plan });
        return;
      }
      if (!out.ok) {
        sendJson(res, 500, { error: 'delete_incomplete', message: `Not everything could be deleted: ${out.left.join(', ')}.`, left: out.left, trash: out.trash });
        return;
      }
      sendJson(res, 200, { ok: true, slug: params.slug, routines: out.plan.routines, trash: out.trash });
    } catch (err) {
      sendWriteError(res, err, 'delete_failed', 'Failed to delete the member.');
    }
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
  if (refuseUnlessOwnerPage(req, res, 'approves an agent')) return;
  if (refuseGlobalOnPhone(req, res, isGlobalHere(contextRoot, params.slug))) return;
  const target = agentTarget(contextRoot, params.slug);
  if (!target) {
    sendError(res, 404, 'not_found', `Agent not found: ${params.slug}`);
    return;
  }
  try {
    const body = (await parseJsonBody(req)) ?? {};
    const projectRoot = dirname(contextRoot);
    registerProject(projectRoot);
    approveAutomation(projectRoot, target, new Date());
    settleApprovalQuestions(contextRoot, params.slug);
    // An approved change may move its level: its open chats follow.
    notifyAgentLevel(contextRoot, params.slug);
    // Approved on the Super Agent's own card: it hears the decision as an event.
    await tellSuperMember(contextRoot, body.sessionId, params.slug, 'approved');
    sendSummary(res, contextRoot, params.slug);
  } catch (err) {
    sendWriteError(res, err, 'approve_failed', 'Failed to approve the agent.');
  }
}

/**
 * POST /api/agents/:slug/board-scope {keep: boolean} — the owner's answer to "Should <title> still
 * be limited to its board?" (`agents/board-question.ts`). Owner page only, like approve: keep writes
 * `scope: board` by his own edit, lift opens its held approvals on this Mac.
 */
export async function handleAgentsBoardScope(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (refuseUnlessOwnerPage(req, res, 'answers whether an agent stays on its board')) return;
  try {
    const body = (await parseJsonBody(req)) ?? {};
    if (typeof body.keep !== 'boolean') {
      sendError(res, 400, 'bad_board_scope', 'Body must be { keep: true | false }.');
      return;
    }
    answerBoardScope(contextRoot, params.slug, body.keep);
    settleApprovalQuestions(contextRoot, params.slug);
    sendSummary(res, contextRoot, params.slug);
  } catch (err) {
    sendWriteError(res, err, 'board_scope_failed', 'Failed to record the answer.');
  }
}

/** The board facts of one member for the AI Team: limited now, and the question it owes. A
 *  teammate's read-only member owes this Mac nothing. */
function boardFacts(contextRoot: string, target: AutomationManifest, readOnly: boolean, home?: string): { boardLimited: boolean; boardQuestion: boolean } {
  const view = agentBoardView(contextRoot, target.slug, target, home);
  return { boardLimited: view.limited, boardQuestion: !readOnly && view.question };
}

/** GET /api/agents/:slug/amendments — what the Super Agent changed in this member, newest first,
 *  with the text before and after. Machine-local, so a teammate's copy shows nothing here. */
export async function handleAgentsAmendments(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!isSafeAutomationSlug(params.slug)) {
    sendError(res, 404, 'not_found', `Agent not found: ${params.slug}`);
    return;
  }
  sendJson(res, 200, { amendments: listAmendments(dirname(contextRoot), params.slug) });
}

/** POST /api/agents/:slug/amendments/:id/revert — the owner takes a change back. */
export async function handleAgentsAmendmentRevert(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (refuseUnlessOwnerPage(req, res, 'takes back a change')) return;
  if (!isSafeAutomationSlug(params.slug)) {
    sendError(res, 404, 'not_found', `Agent not found: ${params.slug}`);
    return;
  }
  try {
    const amendment = revertAmendment(contextRoot, params.slug, params.id);
    settleApprovalQuestions(contextRoot, params.slug);
    sendJson(res, 200, { amendment });
  } catch (err) {
    if (err instanceof AmendmentRefused) {
      sendError(res, err.status, err.code, err.message);
      return;
    }
    sendWriteError(res, err, 'revert_failed', 'Failed to take the change back.');
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
    telegramHub()?.refreshIdentity(slug);
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

  // The stage's latest session from the history index, falling back to the older single record.
  const home = latestStageSession(dirname(contextRoot), slug) ?? readStageHomeSession(dirname(contextRoot), slug);
  return {
    slug,
    title: target.agentTitle || target.title,
    face: faceOf(slug, agent?.face ?? null),
    autonomy: agentLevelInForce(contextRoot, target),
    homeSessionId: home,
    // Held = a live child with a socket bound to it right now. A detached one (its pane closed a
    // moment ago) is not held: the stage adopts it.
    homeLive: !!home && !!findLiveChat(home)?.holder?.(),
    owner: null,
    liveJobs,
    reports,
    files,
    routines: routines.map((m) => ({
      slug: m.slug,
      title: m.title,
      enabled: m.enabled,
      nextFireAt: nextFireIso(m, now, { projectRoot: dirname(contextRoot) }),
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

/**
 * GET /api/agents/:slug/history?before=<lastAt>|<key>&exclude=<claudeId>&kind=run — one page of the agent's
 * history for its stage pane: every routine run and every talk with the owner, newest activity
 * first (lib/agents/history.ts). Desktop only, like the stage. A talk a live socket holds (a Chat
 * tab in use) waits until it ends; `exclude` is the stage's own live session. `kind=run`: routine
 * runs only, the member Super page's feed (`ListHistoryOptions.runsOnly`).
 */
export async function handleAgentsHistory(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!isAgentRequest(req)) {
    sendError(res, 403, 'forbidden', 'An agent\'s history is available in the desktop app only.');
    return;
  }
  if (!agentTarget(contextRoot, params.slug)) {
    sendError(res, 404, 'not_found', `Agent not found: ${params.slug}`);
    return;
  }
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const before = url.searchParams.get('before');
    const exclude = sanitizeUuid(url.searchParams.get('exclude')) || null;
    // One look per source: a page asks about several of its runs.
    const activity = new Map<string, AgentActivity | null>();
    const activityOf = (source: string): AgentActivity | null => {
      if (!activity.has(source)) activity.set(source, agentActivity(contextRoot, source));
      return activity.get(source) ?? null;
    };
    const page = listAgentHistory(contextRoot, params.slug, {
      audience: 'owner',
      before: before && before.length <= 512 ? before : null,
      exclude,
      markTurns: true,
      runsOnly: url.searchParams.get('kind') === 'run',
      isLive: (id) => findLiveChat(id) !== null,
      isHeld: (id) => !!findLiveChat(id)?.holder?.(),
      isRunActive: (source, runId) => runIsActive(activityOf(source), runId) || runChildAlive(contextRoot, source, runId),
      isRunHeld: (source, runId) => !!activityOf(source)?.runs?.some((r) => r.runId === runId),
    });
    sendJson(res, 200, page);
  } catch (err) {
    console.error('[agents] history failed', err);
    sendError(res, 500, 'history_failed', 'Failed to read the agent\'s history.');
  }
}
