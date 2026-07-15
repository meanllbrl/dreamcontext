import type { Task } from '../hooks/useTasks';

/**
 * The "Delegate a task to Claude" bridge. A task card lives deep in the board's React
 * tree; the Agent surface (which actually spawns Claude Code sessions) is mounted once,
 * ABOVE the page router, so it never remounts on navigation. They can't share a ref, so
 * the board's Delegate composer asks for an agent by dispatching a window event and the
 * always-mounted `AgentSurface` listens for it — the same decoupled pattern the surface
 * already uses for `dreamcontext-navigate` / `dreamcontext-zoom` / the Sleep + brain-resolve
 * agents. No prop threading across the tree.
 */
export const DELEGATE_AGENT_EVENT = 'dreamcontext-delegate-agent';

/** What the composer hands the surface: the tab title (the task name) + the composed
 *  prompt to auto-submit + whether to arm bypass-permissions for the delegated agent. */
export interface DelegateAgentDetail {
  title: string;
  prompt: string;
  bypass: boolean;
}

/**
 * Build the default delegation prompt from a task. Written as a readable, multi-line
 * draft for the user to review/edit in the composer; the SERVER collapses newlines to
 * spaces before it reaches Claude's readline (see `sanitizePrompt` in agent-terminal.ts),
 * so the structure here is purely for the human reviewing it — Claude receives one message.
 * We point the agent at the source-of-truth task (`dreamcontext tasks show <slug>`) so it
 * gets the full spec (technical details, constraints) even after the flatten, and tell it
 * to log progress against the same slug.
 */
export function buildDelegatePrompt(task: Task): string {
  // Mirror boardModel's `taskName` (name, else the de-hyphenated slug) so the prompt's
  // "Task:" line matches the tab title the composer sends.
  const title = (task.name && task.name.trim() ? task.name : task.slug.replace(/-/g, ' ')).trim();
  const parts: string[] = [
    'Work on this dreamcontext task and drive it to completion, fully autonomously — do NOT ask me questions (I am away). Think hard.',
    `\nTask: ${title}`,
  ];
  if (task.description?.trim()) parts.push(`\nDescription:\n${task.description.trim()}`);
  if (task.why?.trim()) parts.push(`\nWhy:\n${task.why.trim()}`);
  if (task.user_stories?.trim()) parts.push(`\nUser stories:\n${task.user_stories.trim()}`);
  if (task.acceptance_criteria?.trim()) parts.push(`\nAcceptance criteria:\n${task.acceptance_criteria.trim()}`);
  parts.push(
    `\nThe full task lives at slug \`${task.slug}\` — read it with \`dreamcontext tasks show ${task.slug}\` `
    + 'for the complete spec (technical details, constraints, notes). Log progress with '
    + `\`dreamcontext tasks log ${task.slug} "<note>"\` and tick acceptance criteria as you satisfy them. `
    + 'When everything is done and verified, reply with a SHORT Markdown summary of what you changed.',
  );
  return parts.join('\n');
}

/** Ask the always-mounted Agent surface to spawn a delegated, background agent for a task. */
export function requestDelegateAgent(detail: DelegateAgentDetail): void {
  window.dispatchEvent(new CustomEvent<DelegateAgentDetail>(DELEGATE_AGENT_EVENT, { detail }));
}
