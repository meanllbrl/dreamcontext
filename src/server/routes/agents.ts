import { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { lstatSync } from 'node:fs';
import { sendJson, sendError, parseJsonBody } from '../middleware.js';
import {
  agentUsage,
  createAgent,
  getAgent,
  listAgents,
  listAgentTargets,
  removeAgent,
  updateAgent,
  withRestamp,
} from '../../lib/agents/store.js';
import { DEFAULT_CALL_SETTINGS, type AgentIdentityPatch, type AgentManifest } from '../../lib/agents/types.js';
import { isSafeAutomationSlug } from '../../lib/agents/slot.js';
import { getRunTarget, parsePattern, resolveAutomationPhoto } from '../../lib/automations/store.js';
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
  AutomationError,
  EFFORT_LEVELS,
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
  approvedForChat: boolean;
  approvedToRun: boolean;
  /** Why it may not run, when it may not (`approvedToRun` false). */
  approvalReason: string | null;
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

/** One agent's summary, from its call target as the store composed it. */
export function summarizeAgent(
  contextRoot: string,
  target: AutomationManifest,
  agent: AgentManifest | null,
  home?: string,
): AgentSummary {
  const projectRoot = dirname(contextRoot);
  const forChat = checkApproval(projectRoot, target, home, 'identity');
  const toRun = checkApproval(projectRoot, target, home, 'run');
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
    approvedForChat: forChat.approved,
    approvedToRun: toRun.approved,
    approvalReason: toRun.approved ? null : toRun.reason,
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

function sendWriteError(res: ServerResponse, err: unknown, code: string, message: string): void {
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
    createAgent(contextRoot, {
      slug,
      title,
      prompt,
      soul: readSoul(body.soul) ?? '',
      model: str(body.model) ?? null,
      effort: readEffort(body.effort) ?? null,
      whiteboard: readWhiteboard(body.whiteboard) ?? null,
      ...(typeof body.learning === 'boolean' ? { learning: body.learning } : {}),
    }, { approve: { now: new Date() } });
    sendSummary(res, contextRoot, slug);
  } catch (err) {
    sendWriteError(res, err, 'create_failed', 'Failed to create the agent.');
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
    if (Object.keys(patch).length > 0) withRestamp(contextRoot, dirname(contextRoot), params.slug, patch);
    sendSummary(res, contextRoot, params.slug);
  } catch (err) {
    sendWriteError(res, err, 'update_failed', 'Failed to save the agent.');
  }
}

/** POST /api/agents/:slug/delete — refused (409 `agent_in_use`) while an
 *  automation runs as it; otherwise removed under the registry's revoke rule. */
export async function handleAgentsDelete(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
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
  const slug = params.slug;
  if (!isSafeAutomationSlug(slug) || !getAgent(contextRoot, slug)) {
    sendError(res, 404, 'not_found', `Agent not found: ${slug}`);
    return;
  }
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
