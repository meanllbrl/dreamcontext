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
 *  prompt to auto-submit + whether to arm bypass-permissions for the delegated agent.
 *  `accepted` is the surface's ACK — see {@link requestDelegateAgent}. */
export interface DelegateAgentDetail {
  title: string;
  prompt: string;
  bypass: boolean;
  /** Set to true by the AgentSurface listener once it has actually spawned the session.
   *  Left false when its guards reject (not desktop / prereqs missing / surface disabled),
   *  or when no surface is mounted to listen at all. */
  accepted?: boolean;
}

/**
 * Hard ceiling for the URL-ENCODED prompt, in bytes.
 *
 * The initial prompt rides the WebSocket upgrade URL as `&prompt=<encodeURIComponent(...)>`
 * (see `agentSession.ts`), so it lands in the HTTP REQUEST LINE — and Node caps the whole
 * request line + headers at `--max-http-header-size`, default 16384 bytes. Overflow is
 * brutal and silent: the parser kills the socket with HPE_HEADER_OVERFLOW *before* the
 * server's `upgrade` handler ever runs, so no PTY spawns, no `claude` starts, and the user
 * just gets a dead chip with zero output and a lost prompt.
 *
 * Sleep/brain-resolve never hit this — their prompts are short fixed constants. Delegation
 * is the first caller to put UNBOUNDED content (a task's description + why + user stories +
 * acceptance criteria, plus whatever the user types) into that URL. Measured against the
 * real vault: 2 of 147 tasks already encode past 16KB and would fail outright today.
 *
 * Note the server's own `sanitizePrompt` 8000-CHAR cap sits on the WRONG SIDE of this limit
 * (it runs after the request is parsed), so it cannot save us — the guard has to be here,
 * client-side, before the URL is built. 6000 encoded bytes leaves >10KB of headroom for the
 * rest of the request line, the other headers, and WKWebView's own URL handling; it also
 * keeps us under the server's 8000-char cap, so nothing is silently truncated there either.
 */
export const MAX_PROMPT_ENCODED = 6000;

/** A slice can end mid-surrogate-pair; a LONE surrogate makes encodeURIComponent throw
 *  URIError (a task with an emoji would crash the composer). Drop the dangling half. */
function trimLoneSurrogate(s: string): string {
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
}

/** URL-encoded byte length — what actually counts against the request-line budget. */
export function encodedPromptLen(s: string): number {
  try { return encodeURIComponent(trimLoneSurrogate(s)).length; } catch { return Number.MAX_SAFE_INTEGER; }
}

/** Fixed, slug-less fallback marker — short by construction, so it always fits the budget. */
const GENERIC_MARKER = '\n\n[Prompt truncated to fit — open this task in dreamcontext for the full spec.]';

/**
 * The truncation marker. It normally names the slug, so a trimmed prompt still tells the agent
 * exactly where to read the full spec.
 *
 * But the marker embeds the slug, and a slug is NEVER length-capped anywhere in the stack:
 * `slugify()` (src/lib/id.ts) doesn't truncate, and neither the CLI's `tasks create` nor the
 * dashboard's TaskCreateModal bounds a task name. A pathological title (a pasted paragraph)
 * would make the marker ITSELF exceed the budget — reproducing the very HPE_HEADER_OVERFLOW
 * this guard exists to prevent. So if the slug-bearing marker can't fit in half the budget,
 * fall back to the fixed slug-less one.
 *
 * We DROP the slug rather than truncate it: a truncated slug produces a `tasks show` command
 * that silently names the WRONG task (or none), which is worse than admitting we can't name it.
 */
function truncationMarker(slug: string): string {
  const withSlug = `\n\n[Prompt truncated to fit — read the full task with \`dreamcontext tasks show ${slug}\`.]`;
  return encodedPromptLen(withSlug) <= MAX_PROMPT_ENCODED / 2 ? withSlug : GENERIC_MARKER;
}

/**
 * Bound a prompt to {@link MAX_PROMPT_ENCODED} so the WS upgrade can never overflow.
 *
 * The bound is UNCONDITIONAL — it holds for any `prompt` and any `slug`, including a
 * pathological one (see {@link truncationMarker}). Because the marker is always ≤ half the
 * budget, `budget` is always positive and `prefix + marker` can never exceed the ceiling.
 *
 * Truncation is safe here precisely BECAUSE the agent is told to read the task itself:
 * we re-append a marker naming the slug, so even a hard-truncated prompt (or one whose tail
 * the user edited away) still carries `dreamcontext tasks show <slug>` — the agent recovers
 * the complete, CURRENT spec from the source of truth rather than a stale inlined copy.
 * The section order (instruction → title → description → why → stories → criteria) means a
 * head-slice sheds the most recoverable content first.
 *
 * Idempotent: a prompt already within budget is returned untouched.
 */
export function fitPromptForTransport(prompt: string, slug: string): string {
  if (encodedPromptLen(prompt) <= MAX_PROMPT_ENCODED) return prompt;
  const suffix = truncationMarker(slug);
  // Clamped: belt-and-braces so no future marker change can drive this negative and return a
  // suffix-only string that blows the ceiling.
  const budget = Math.max(0, MAX_PROMPT_ENCODED - encodedPromptLen(suffix));
  // Largest prefix whose encoded form fits the remaining budget. encodeURIComponent's length
  // is monotonic in prefix length, so a binary search is exact.
  let lo = 0, hi = prompt.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encodedPromptLen(prompt.slice(0, mid)) <= budget) lo = mid; else hi = mid - 1;
  }
  return trimLoneSurrogate(prompt.slice(0, lo)).trimEnd() + suffix;
}

/**
 * Build the default delegation prompt from a task. Written as a readable, multi-line
 * draft for the user to review/edit in the composer; the SERVER collapses newlines to
 * spaces before it reaches Claude's readline (see `sanitizePrompt` in agent-terminal.ts),
 * so the structure here is purely for the human reviewing it — Claude receives one message.
 * We point the agent at the source-of-truth task (`dreamcontext tasks show <slug>`) so it
 * gets the full spec (technical details, constraints) even after the flatten, and tell it
 * to log progress against the same slug.
 *
 * The result is transport-fitted, so what the composer SHOWS is exactly what gets SENT —
 * a long task's criteria are visibly truncated (with the recovery marker) rather than
 * silently blowing up the WebSocket upgrade later.
 *
 * `title` is passed in (rather than re-deriving it here) so the prompt's "Task:" line and the
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
    `\nThe full task lives at slug \`${task.slug}\` — read it with \`dreamcontext tasks show ${task.slug}\` `
    + 'for the complete spec (technical details, constraints, notes). Log progress with '
    + `\`dreamcontext tasks log ${task.slug} "<note>"\` and tick acceptance criteria as you satisfy them. `
    + 'When everything is done and verified, reply with a SHORT Markdown summary of what you changed.',
  );
  return fitPromptForTransport(parts.join('\n'), task.slug);
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
 * `accepted` is already visible by the time it returns — no async plumbing needed.
 */
export function requestDelegateAgent(detail: DelegateAgentDetail): boolean {
  const payload: DelegateAgentDetail = { ...detail, accepted: false };
  window.dispatchEvent(new CustomEvent<DelegateAgentDetail>(DELEGATE_AGENT_EVENT, { detail: payload }));
  return payload.accepted === true;
}
