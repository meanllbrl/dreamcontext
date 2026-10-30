import { sanitizeAutomationPrompt } from '../automations/runner.js';
import type { AutomationManifest } from '../automations/types.js';

/**
 * How an AI Team member reads in one line: its name and the head of its prompt. Shared by the
 * chat roster (chat-subagents.ts) and the Super Agent's team block (team-roster.ts), so both
 * name a member the same way. Its own file, so neither imports the other for it.
 */

/** A roster line's and a description's share of an agent's prompt. */
export const SUMMARY_CHARS = 140;

/** The agent's display name: its own title, never a bound automation's. */
export function nameOf(m: AutomationManifest): string {
  return m.agentTitle || m.title;
}

/** The first `max` characters of the prompt, on one line. */
export function summaryOf(m: AutomationManifest, max = SUMMARY_CHARS): string {
  const flat = sanitizeAutomationPrompt(m.prompt).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}
