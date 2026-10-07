import { dirname } from 'node:path';
import { listAutomations } from './store.js';
import { checkApproval } from './registry.js';
import { buildPatternBlock, buildTurnLearningDirective, sanitizeAutomationPrompt } from './runner.js';
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
 * Pure but for the reads: the manifests and the machine-local approval registry.
 */

/** At most this many agents ride one spawn: the roster rides every turn of the system prompt. */
export const MAX_CHAT_SUBAGENTS = 24;
/** A roster line's and a description's share of an agent's prompt. */
const SUMMARY_CHARS = 140;

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

/** The first `SUMMARY_CHARS` of the prompt, on one line. */
function summaryOf(m: AutomationManifest): string {
  const flat = sanitizeAutomationPrompt(m.prompt).replace(/\s+/g, ' ').trim();
  return flat.length > SUMMARY_CHARS ? `${flat.slice(0, SUMMARY_CHARS - 1).trimEnd()}…` : flat;
}

/** What the agent is told when the chat's Claude calls it. Same order as its other briefs. */
export function subagentPrompt(m: AutomationManifest): string {
  const pattern = buildPatternBlock(m);
  const learning = buildTurnLearningDirective(m);
  return [
    `You are "${m.title}" (the dreamcontext agent \`${m.slug}\`), called as a sub-agent by the owner's Claude in a dreamcontext Chat tab.`,
    'Do what the request asks, as yourself, and end with your answer as your final message: the calling Claude relays it to the owner.',
    'This is NOT your automation thread: nothing here is posted to the Agents channel and your scheduled runs never see it, so never',
    'use `dreamcontext automations post` or `say`.',
    '',
    '--- WHO YOU ARE (your approved automation prompt) ---',
    'This is the job you do on your schedule. Here it tells you who you are and what you know how to do; do the job itself only when',
    'the request asks for it.',
    '',
    sanitizeAutomationPrompt(m.prompt).trim(),
    '--- END WHO YOU ARE ---',
    ...(pattern ? ['', pattern] : []),
    ...(learning ? ['', learning] : []),
  ].join('\n');
}

/**
 * The approved agents a chat in this project can call, or null when there are none (no flag, no
 * briefing section). `exclude` is the agent the chat itself speaks as.
 */
export function chatSubagents(contextRoot: string, opts: { exclude?: string; home?: string } = {}): ChatSubagents | null {
  const callable: AutomationManifest[] = [];
  for (const m of listAutomations(contextRoot)) {
    if (m.slug === opts.exclude) continue;
    let approved = false;
    try { approved = checkApproval(dirname(contextRoot), m, opts.home).approved; } catch { approved = false; }
    if (!approved) continue;
    callable.push(m);
    if (callable.length >= MAX_CHAT_SUBAGENTS) break;
  }
  if (callable.length === 0) return null;
  const agents: Record<string, SubagentDefinition> = {};
  for (const m of callable) {
    agents[m.slug] = {
      description: `${m.title}, a dreamcontext agent of this project: ${summaryOf(m)} Call it when the owner names it or asks for its job.`,
      prompt: subagentPrompt(m),
    };
  }
  const roster = [
    "## This project's agents",
    'The owner made these agents in Automations. You can call any of them as a sub-agent: the Agent tool with `subagent_type` set',
    'to its slug. When the owner names one ("ask the funnel agent…") or asks for its job, dispatch it with a complete, self-contained',
    'request, relay what it returns, and say which agent answered. Do its job yourself only when the owner asks you to.',
    ...callable.map((m) => `- \`${m.slug}\` ${m.title}: ${summaryOf(m)}`),
  ].join('\n');
  return { agents, roster };
}
