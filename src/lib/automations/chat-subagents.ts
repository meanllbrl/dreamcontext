import { dirname } from 'node:path';
import { listAgentTargets } from '../agents/store.js';
import { identityOnly } from '../agents/compose.js';
import { checkApproval } from './registry.js';
import { buildPatternBlock, buildSoulBlock, buildTurnLearningDirective, sanitizeAutomationPrompt } from './runner.js';
import { nameOf, summaryOf } from '../agents/agent-summary.js';
import type { AutomationManifest } from './types.js';

/**
 * THE PROJECT'S AGENTS AS SUB-AGENTS OF A CHAT (owner, 2026-10-07: "the Claude I talk to should
 * be able to call these agents like sub-agents, and know that it can").
 *
 * Every Chat-tab spawn hands the CLI an `--agents` definition per APPROVED automation agent (an
 * unapproved prompt never speaks, on a run, a card or here), and its briefing names them, so the
 * owner's Claude dispatches one with the Agent tool (`subagent_type` = the slug) the way it
 * dispatches any sub-agent. The sub-agent speaks under its approved prompt, its pattern as notes
 * and its learning directive; it is not its thread, so nothing reaches the channel or a run.
 *
 * A sub-agent runs inside the calling chat, under THAT chat's permissions: a home-board agent's
 * run scope is a property of its own spawns (runs, cards, its Chat tab), not of a sub-agent. The
 * owner is in the chat whose permission mode governs it.
 *
 * The roster is every AGENT (`listAgentTargets`: the agents of same-slug pairs and on-call agents
 * included), checked for the `'identity'` use: a conversation lends the agent its identity and never
 * runs its call target, so a bound automation's approval (rule (c)) is enough here. Each entry is
 * built from `identityOnly`, so a synced edit to call settings can neither reach nor gate it.
 *
 * Pure but for the reads: the manifests and the machine-local approval registry.
 */

/** At most this many agents ride one spawn: the roster rides every turn of the system prompt. */
export const MAX_CHAT_SUBAGENTS = 24;

export interface SubagentDefinition {
  description: string;
  prompt: string;
}

export interface ChatSubagents {
  /** The `--agents` JSON object, keyed by agent slug. */
  agents: Record<string, SubagentDefinition>;
  /** The briefing section that tells the chat's Claude it can call them. */
  roster: string;
}

/** What the agent is told when the chat's Claude calls it. Same order as its other briefs. */
export function subagentPrompt(m: AutomationManifest): string {
  const soul = buildSoulBlock(m);
  const pattern = buildPatternBlock(m);
  const learning = buildTurnLearningDirective(m);
  return [
    `You are "${nameOf(m)}" (the dreamcontext agent \`${m.slug}\`), called as a sub-agent by the owner's Claude in a dreamcontext Chat tab.`,
    'Do what the request asks, as yourself, and end with your answer as your final message: the calling Claude relays it to the owner.',
    'This is NOT your automation thread: nothing here is posted to the Agents channel and your scheduled runs never see it, so never',
    'use `dreamcontext automations post` or `say`.',
    '',
    '--- WHO YOU ARE (your approved agent prompt, from the AI Team) ---',
    'It tells you who you are and what you know how to do. Do work it describes only when',
    'the request asks for it.',
    '',
    sanitizeAutomationPrompt(m.prompt).trim(),
    '--- END WHO YOU ARE ---',
    ...(soul ? ['', soul] : []),
    ...(pattern ? ['', pattern] : []),
    ...(learning ? ['', learning] : []),
  ].join('\n');
}

/**
 * How an ordinary Chat tab is told to use them (task super-agent-isi-bolerken-…, owner
 * 2026-10-29: chats SUGGEST the member, never consult it by themselves). `routing: false` keeps
 * the wording every other spawn had before, byte for byte: a Super Agent's child (the Super
 * already chose who does the job) and an agent's own Chat tab (it speaks AS a member).
 */
const ROUTING_RULE = [
  'The owner made these agents on the AI Team page: each is his specialist for its field. Before you answer or start work: if',
  'the request falls in one agent\'s field below, say in one line which agent knows it best and offer to ask it. Call it (the',
  'Agent tool, `subagent_type` = its slug) when the owner says yes or names it, with a complete, self-contained request; relay',
  'its answer and say which agent answered. Do its job yourself only when the owner asks you to.',
];
const SUBAGENT_RULE = [
  'The owner made these agents on the AI Team page. You can call any of them as a sub-agent: the Agent tool with `subagent_type` set',
  'to its slug. When the owner names one ("ask the funnel agent…") or asks for its job, dispatch it with a complete, self-contained',
  'request, relay what it returns, and say which agent answered. Do its job yourself only when the owner asks you to.',
];

/**
 * The approved agents a chat in this project can call, or null when there are none (no flag, no
 * briefing section). `exclude` is the agent the chat itself speaks as; `routing` picks the
 * ordinary Chat tab's routing rule over the plain sub-agent wording (see ROUTING_RULE).
 */
export function chatSubagents(contextRoot: string, opts: { exclude?: string; home?: string; routing?: boolean } = {}): ChatSubagents | null {
  const callable: AutomationManifest[] = [];
  let targets: AutomationManifest[] = [];
  try { targets = listAgentTargets(contextRoot, opts.home); } catch { targets = []; }
  for (const m of targets) {
    if (m.slug === opts.exclude) continue;
    let approved = false;
    try { approved = checkApproval(dirname(contextRoot), m, opts.home, 'identity').approved; } catch { approved = false; }
    if (!approved) continue;
    callable.push(identityOnly(m));
    if (callable.length >= MAX_CHAT_SUBAGENTS) break;
  }
  if (callable.length === 0) return null;
  const agents: Record<string, SubagentDefinition> = {};
  for (const m of callable) {
    agents[m.slug] = {
      description: `${nameOf(m)}, a dreamcontext agent of this project: ${summaryOf(m)} Call it when the owner names it or asks for its job.`,
      prompt: subagentPrompt(m),
    };
  }
  const roster = [
    "## This project's agents",
    ...(opts.routing ? ROUTING_RULE : SUBAGENT_RULE),
    ...callable.map((m) => `- \`${m.slug}\` ${nameOf(m)}: ${summaryOf(m)}`),
  ].join('\n');
  return { agents, roster };
}
