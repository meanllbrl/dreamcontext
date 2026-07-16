import type { Task } from '../hooks/useTasks';
import { preparePrompt } from './agentPrompt';

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

/** What the composer hands the surface: the tab title (the task name), the composed prompt
 *  (already routed to a transport — see below), and whether to arm bypass-permissions.
 *  `accepted` is the surface's ACK — see {@link requestDelegateAgent}. */
export interface DelegateAgentDetail {
  title: string;
  /**
   * The prompt, INLINE. Empty when {@link promptToken} is set instead.
   *
   * The caller must route the prompt through `preparePrompt` (lib/agentPrompt.ts) BEFORE
   * dispatching, not after: minting a token is async, and the surface's ACK below only means
   * anything while it stays synchronous. So the async part happens in the composer, where a
   * failure can still be shown to the user with the modal open.
   */
  prompt: string;
  /** Token redeeming a prompt too large to inline. Empty when {@link prompt} is used. */
  promptToken: string;
  bypass: boolean;
  /**
   * Show the agent instead of backgrounding it: open the Agents overlay with the new session
   * as a live pane, rather than starting it minimized as a corner chip.
   *
   * The default (false) is right for the board: you right-click a card, hand it off, and carry
   * on triaging — a chip is exactly the feedback you want. It is wrong when you delegated from
   * the task's OWN full-page view, because that screen is the thing you were looking at, and
   * backgrounding the agent would leave you staring at a task that now has an invisible worker.
   * Reveal replaces the screen you left with the screen you actually wanted.
   */
  reveal?: boolean;
  /** Set to true by the AgentSurface listener once it has actually spawned the session.
   *  Left false when its guards reject (not desktop / prereqs missing / surface disabled),
   *  or when no surface is mounted to listen at all. */
  accepted?: boolean;
}

/**
 * Where a task's markdown actually lives, relative to the vault root — the path an agent can
 * open to read the complete, CURRENT spec. This is the one true pointer to a task: there is no
 * `dreamcontext tasks show`, and the CLI's own docs describe tasks as `state/<slug>.md`.
 * Shared so the delegate and curate prompts can't drift to different (or invented) answers.
 */
export function taskSourcePath(slug: string): string {
  return `_dream_context/state/${slug}.md`;
}

/**
 * Build the default delegation prompt from a task. Written as a readable, multi-line
 * draft for the user to review/edit in the composer; the SERVER collapses newlines to
 * spaces before it reaches Claude's readline (see `sanitizePrompt` in agent-terminal.ts),
 * so the structure here is purely for the human reviewing it — Claude receives one message.
 * We point the agent at the source-of-truth task FILE so it can always re-read the complete
 * spec, and tell it to log progress against the same slug.
 *
 * The pointer is a file path, not a CLI command, ON PURPOSE: there is no
 * `dreamcontext tasks show`. This prompt used to name one, which meant every delegated agent
 * was told to run a command that exits with `unknown command 'show'` — a dead recovery path,
 * and the exact instruction the old truncation design leaned on. {@link taskSourcePath} is
 * where a task actually lives; `dreamcontext tasks list --json` is the CLI-shaped alternative.
 *
 * The result is NOT truncated: an oversized prompt now rides a POSTed token rather than the
 * WebSocket upgrade URL (see lib/agentPrompt.ts), so what the composer SHOWS is exactly what
 * gets SENT, at any length.
 *
 * `title` is passed in (rather than re-derived here) so the prompt's "Task:" line and the
 * delegated tab's title come from ONE `taskName(task)` call in the composer and can't drift.
 */
export function buildDelegatePrompt(task: Task, title: string): string {
  const parts: string[] = [
    'Work on this dreamcontext task and drive it to completion, fully autonomously — do NOT ask me questions (I am away). Think hard.',
    `\nTask: ${title}`,
  ];
  if (task.description?.trim()) parts.push(`\nDescription:\n${task.description.trim()}`);
  if (task.why?.trim()) parts.push(`\nWhy:\n${task.why.trim()}`);
  if (task.user_stories?.trim()) parts.push(`\nUser stories:\n${task.user_stories.trim()}`);
  if (task.acceptance_criteria?.trim()) parts.push(`\nAcceptance criteria:\n${task.acceptance_criteria.trim()}`);
  parts.push(
    `\nThe full task lives at \`${taskSourcePath(task.slug)}\` — read that file `
    + 'for the complete spec (technical details, constraints, notes). Log progress with '
    + `\`dreamcontext tasks log ${task.slug} "<note>"\` and tick acceptance criteria as you satisfy them. `
    + 'When everything is done and verified, reply with a SHORT Markdown summary of what you changed.',
  );
  return parts.join('\n');
}

/**
 * Ask the always-mounted Agent surface to spawn a delegated, background agent for a task.
 * Returns whether a session was ACTUALLY spawned.
 *
 * The ack matters because the caller and the surface gate on DIFFERENT capability snapshots:
 * the board's menu uses the polling `useAgentCapabilities()` query, while `AgentSurface` holds
 * `caps` fetched once on mount. They can disagree (e.g. prereqs became ready after the surface
 * mounted), so the menu item can be live while the surface's guard still rejects — and the
 * surface may not be mounted at all. Without an ack the composer would optimistically report
 * "Delegated ✓" for a spawn that never happened; the user would go to bed believing work was
 * underway. `dispatchEvent` invokes listeners SYNCHRONOUSLY, so the listener's mutation of
 * `accepted` is already visible by the time it returns — no async plumbing needed. That is
 * exactly why the prompt must be transport-prepared BEFORE this call, never inside the
 * listener: an await in there would make the ack a lie again.
 */
export function requestDelegateAgent(detail: DelegateAgentDetail): boolean {
  const payload: DelegateAgentDetail = { ...detail, accepted: false };
  window.dispatchEvent(new CustomEvent<DelegateAgentDetail>(DELEGATE_AGENT_EVENT, { detail: payload }));
  return payload.accepted === true;
}

/**
 * Prepare + dispatch in one step: route the prompt to a transport that can carry it, then ask
 * the surface for a session. Throws if the prompt can't be handed over (see `preparePrompt`);
 * resolves to the surface's ACK otherwise.
 */
export async function delegateTaskToAgent(
  args: { title: string; prompt: string; bypass: boolean; reveal?: boolean },
): Promise<boolean> {
  const { inline, token } = await preparePrompt(args.prompt.trim());
  return requestDelegateAgent({
    title: args.title, prompt: inline, promptToken: token, bypass: args.bypass, reveal: args.reveal,
  });
}
