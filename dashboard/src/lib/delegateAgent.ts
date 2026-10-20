import type { Task } from '../hooks/useTasks';
import { preparePrompt } from './agentPrompt';
import { emitInstance } from '../context/VaultContext';

/**
 * The "Delegate a task to Claude" bridge. A task card lives deep in the board's React
 * tree; the Agent surface (which actually spawns Claude Code sessions) is mounted once,
 * ABOVE the page router, so it never remounts on navigation. They can't share a ref, so
 * the board's Delegate composer asks for an agent by firing an event and the always-mounted
 * `AgentSurface` listens for it — the same decoupled pattern the surface already uses for
 * `dreamcontext-navigate` / the Sleep + brain-resolve agents. No prop threading across the
 * tree.
 *
 * THE ONE THAT MUST NOT BE BROADCAST. Of every bridge in this app, this is the one where
 * `window` does not merely duplicate an action — it misroutes it. The ACK below is written
 * back onto the payload SYNCHRONOUSLY by the listener, so with several projects mounted in
 * one window the FIRST `AgentSurface` to run its listener claims the delegate and sets
 * `accepted`. The composer then reports "Delegated ✓" while the task is being worked on in
 * a project it does not belong to, against the wrong repo, by an agent reading a
 * `_dream_context/state/<slug>.md` that is not there. Every other listener spawns its own
 * duplicate agent on top. The bus is what makes the ACK mean "the project I delegated FROM
 * took it", which is the only thing it was ever supposed to mean.
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
   * The model alias to run (`opus` / `sonnet` / `haiku` / `fable`), or '' to inherit whatever
   * the user's CLI default is. Empty is the honest default: the composer's picker shows
   * `modelConfig.defaultModel`, which is only a snapshot of `~/.claude/settings.json` — forcing
   * it back down would pin a delegated agent to a stale guess (and to the FALLBACK guess when
   * the config never loaded). Only a DELIBERATE pick travels.
   */
  model?: string;
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
  return [
    'Work on this dreamcontext task and drive it to completion, fully autonomously — do NOT ask me questions (I am away). Think hard.',
    taskContextBlock(task, title),
    `The full task lives at \`${taskSourcePath(task.slug)}\` — read that file `
    + 'for the complete spec (technical details, constraints, notes). Log progress with '
    + `\`dreamcontext tasks log ${task.slug} "<note>"\` and tick acceptance criteria as you satisfy them. `
    + 'When everything is done and verified, reply with a SHORT Markdown summary of what you changed.',
  ].join('\n\n');
}

/**
 * The task itself, as the composer hands it over: the title line plus whichever of
 * description / why / user stories / acceptance criteria the task actually fills in. Empty
 * sections are omitted rather than sent as headings with nothing under them.
 *
 * Shared by every delegate mode (see lib/delegateModes.ts) so switching from "Autonomous" to
 * "Discuss" changes the INSTRUCTION and nothing else — the task the agent is looking at is
 * byte-identical across all four. Each mode wraps it with its own lead-in and closing ask.
 */
export function taskContextBlock(task: Task, title: string): string {
  const parts: string[] = [`Task: ${title}`];
  if (task.description?.trim()) parts.push(`Description:\n${task.description.trim()}`);
  if (task.why?.trim()) parts.push(`Why:\n${task.why.trim()}`);
  if (task.user_stories?.trim()) parts.push(`User stories:\n${task.user_stories.trim()}`);
  if (task.acceptance_criteria?.trim()) parts.push(`Acceptance criteria:\n${task.acceptance_criteria.trim()}`);
  return parts.join('\n\n');
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
 *
 * `bus` names WHICH project is being asked (`useVault().bus`). It is not plumbing: it is what
 * makes the ack answer for the project the composer was opened from rather than for whichever
 * surface in the window happened to run its listener first — see this module's header.
 */
export function requestDelegateAgent(bus: EventTarget, detail: DelegateAgentDetail): boolean {
  const payload: DelegateAgentDetail = { ...detail, accepted: false };
  emitInstance<DelegateAgentDetail>(bus, DELEGATE_AGENT_EVENT, payload);
  return payload.accepted === true;
}

/** What a composer hands {@link delegateTaskToAgent}: the tab title, the prompt as the user
 *  last saw it, the bypass choice, and the optional model / reveal overrides. */
export interface DelegateAgentArgs {
  title: string;
  prompt: string;
  bypass: boolean;
  model?: string;
  reveal?: boolean;
}

/**
 * Prepare + dispatch in one step: route the prompt to a transport that can carry it, then ask
 * the surface for a session. Throws if the prompt can't be handed over (see `preparePrompt`);
 * resolves to the surface's ACK otherwise.
 *
 * `vault` names the project the task belongs to and is threaded straight into `preparePrompt`
 * — the token has to be minted against the project the composer was opened from, not against
 * whichever of the window's live projects happened to be touched last. `bus` names the same
 * project for the hand-off itself, and both must come from the SAME `useVault()`: a token
 * minted against project A and redeemed by project B's surface is the misroute this bridge
 * exists to prevent.
 */
export async function delegateTaskToAgent(
  bus: EventTarget,
  vault: string | null,
  args: DelegateAgentArgs,
): Promise<boolean> {
  const { inline, token } = await preparePrompt(vault, args.prompt.trim());
  return requestDelegateAgent(bus, {
    title: args.title, prompt: inline, promptToken: token, bypass: args.bypass,
    model: args.model, reveal: args.reveal,
  });
}
