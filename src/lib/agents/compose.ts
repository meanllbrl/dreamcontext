import { createHash } from 'node:crypto';
import {
  DEFAULT_AGENT_AUTONOMY,
  DEFAULT_CATCHUP_HOURS,
  type ApprovalBinding,
  type AutomationJob,
  type AutomationManifest,
} from '../automations/types.js';
import { agentKeyOf } from './slot.js';
import { DEFAULT_CALL_SETTINGS, type AgentManifest } from './types.js';

/**
 * Composing a RUN TARGET from an agent and (optionally) an automation job.
 *
 * Pure, no I/O. `composeRun` is called by the two stores only (and by these
 * modules' own tests): a target built anywhere else would carry
 * `legacyKey: false` and `bindings: []`, silently dropping approvals that
 * depend on them, so every surface gets its targets from the store helpers.
 *
 * The load-bearing property is HASH INVARIANCE: for every legacy manifest `m`,
 * `manifestHash(composeRun(legacyPair(m)...)) === manifestHash(m)`, so splitting
 * a manifest into agent + automation keeps every approval on every machine with
 * no registry write.
 */

const LEGACY_ID_RE = /^auto_(.+)$/;

/**
 * The agent id a legacy automation's agent gets — deterministic, so two
 * machines splitting the same file write the same bytes.
 *  - `auto_<x>` → `agt_<x>`
 *  - any other non-empty id → `agt_<id>`
 *  - no id → `agt_` + the first 8 hex of sha256(slug)
 */
export function deriveAgentId(legacyId: string, slug: string): string {
  const id = legacyId.trim();
  if (!id) return `agt_${createHash('sha256').update(slug, 'utf8').digest('hex').slice(0, 8)}`;
  const m = LEGACY_ID_RE.exec(id);
  return `agt_${m ? m[1] : id}`;
}

/** True when a manifest's frontmatter has no `agent:` key at all — a legacy,
 *  unsplit manifest. Uses the one predicate every reader shares. */
export function isLegacyAutomation(data: Record<string, unknown>): boolean {
  return agentKeyOf(data).kind === 'none';
}

/**
 * A legacy manifest read as the agent and job it would split into.
 *
 * `sched` → an agent with default call settings + a job carrying everything
 * else. `call` → an agent only: the old run settings become its call settings
 * (owner decision O1), so the composed call target hashes exactly like the
 * legacy file did.
 */
export function legacyPair(m: AutomationManifest): { agent: AgentManifest; job: AutomationJob | null } {
  const isCall = m.mode === 'call';
  const agent: AgentManifest = {
    slug: m.slug,
    id: deriveAgentId(m.id, m.slug),
    title: m.title,
    photo: m.photo,
    prompt: m.prompt,
    // Total for a hand-built manifest without the field: it reads as no soul.
    soul: m.soul ?? '',
    model: m.model,
    effort: m.effort,
    learning: m.learning,
    pattern: m.pattern,
    whiteboard: m.whiteboard ?? null,
    shared: m.shared,
    // A legacy file holds no team placement: it stays a root until it is split.
    reportsTo: null,
    team: null,
    // A legacy file holds no autonomy (the default) and no stamped face.
    autonomy: m.autonomy ?? DEFAULT_AGENT_AUTONOMY,
    face: null,
    call: isCall
      ? {
          timeoutMinutes: m.timeoutMinutes,
          outputDir: m.outputDir,
          review: m.review,
          outputInstructions: m.outputInstructions,
          flow: m.flow ?? null,
          enabled: m.enabled,
          notify: m.notify,
        }
      : { ...DEFAULT_CALL_SETTINGS },
    migratedFrom: m.id,
    implicit: true,
    path: m.path,
    body: m.body,
  };
  if (isCall) return { agent, job: null };
  const job: AutomationJob = {
    slug: m.slug,
    id: m.id,
    title: m.title,
    agent: m.slug,
    mode: m.mode,
    enabled: m.enabled,
    schedule: m.schedule,
    scheduleError: m.scheduleError ?? null,
    timeoutMinutes: m.timeoutMinutes,
    catchupHours: m.catchupHours,
    outputDir: m.outputDir,
    shared: m.shared,
    notify: m.notify,
    review: m.review,
    outputInstructions: m.outputInstructions,
    job: '',
    flow: m.flow ?? null,
    path: m.path,
    body: m.body,
  };
  return { agent, job };
}

/**
 * The run target of `agent`, through `job` when there is one.
 *
 * With a job: an automation (`runKind: 'automation'`), keyed by the job's slug,
 * identity from the agent and everything else from the job. `bindings` and
 * `legacyKey` do not apply to an automation and are always `[]` / `false`.
 *
 * Without a job: the agent's CALL TARGET (`runKind: 'agent'`), keyed by the
 * agent's slug, `mode: 'call'`, no schedule, `job: ''` always, and the agent's
 * call settings. `bindings` and `legacyKey` are what the store computed.
 */
export function composeRun(
  agent: AgentManifest,
  job: AutomationJob | null,
  bindings: readonly ApprovalBinding[] = [],
  legacyKey = false,
): AutomationManifest {
  const identity = {
    photo: agent.photo,
    prompt: agent.prompt,
    soul: agent.soul,
    model: agent.model,
    effort: agent.effort,
    learning: agent.learning,
    pattern: agent.pattern,
    whiteboard: agent.whiteboard,
    agent: agent.slug,
    agentTitle: agent.title,
    // Only a level other than the default rides the target, so a composed target stays field for
    // field what a legacy read gives (the hash omits the default either way).
    ...(agent.autonomy !== DEFAULT_AGENT_AUTONOMY ? { autonomy: agent.autonomy } : {}),
  };
  if (job) {
    return {
      slug: job.slug,
      id: job.id,
      title: job.title,
      mode: job.mode,
      enabled: job.enabled,
      schedule: job.schedule,
      scheduleError: job.scheduleError ?? null,
      timeoutMinutes: job.timeoutMinutes,
      catchupHours: job.catchupHours,
      outputDir: job.outputDir,
      shared: job.shared,
      notify: job.notify,
      review: job.review,
      outputInstructions: job.outputInstructions,
      flow: job.flow ?? null,
      job: job.job,
      ...identity,
      runKind: 'automation',
      bindings: [],
      legacyKey: false,
      path: job.path,
      body: job.body,
    };
  }
  const call = agent.call;
  return {
    slug: agent.slug,
    // A split agent keeps the legacy id on its call target, so nothing that
    // keyed off the old manifest's id sees it change.
    id: agent.migratedFrom ?? agent.id,
    title: agent.title,
    mode: 'call',
    enabled: call.enabled,
    schedule: null,
    scheduleError: null,
    timeoutMinutes: call.timeoutMinutes,
    catchupHours: DEFAULT_CATCHUP_HOURS,
    outputDir: call.outputDir,
    shared: agent.shared,
    notify: call.notify,
    review: call.review,
    outputInstructions: call.outputInstructions,
    flow: call.flow ?? null,
    job: '',
    ...identity,
    runKind: 'agent',
    bindings: [...bindings],
    legacyKey,
    path: agent.path,
    body: agent.body,
  };
}

/**
 * The target a CONVERSATION is built from: every call setting forced back to
 * the defaults. Chat, card chat and chat sub-agents never read call settings, so
 * a synced edit to them (an output folder, a flow, a review mode) can neither
 * widen a conversation's scope nor gate it. Identity fields are untouched.
 */
export function identityOnly(m: AutomationManifest): AutomationManifest {
  return {
    ...m,
    timeoutMinutes: DEFAULT_CALL_SETTINGS.timeoutMinutes,
    outputDir: DEFAULT_CALL_SETTINGS.outputDir,
    review: DEFAULT_CALL_SETTINGS.review,
    outputInstructions: DEFAULT_CALL_SETTINGS.outputInstructions,
    flow: DEFAULT_CALL_SETTINGS.flow,
    job: '',
  };
}
