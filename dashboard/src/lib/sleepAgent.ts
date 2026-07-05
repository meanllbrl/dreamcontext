/**
 * The "Run sleep agent" bridge. The header's Sleep-debt tracker lives in the page
 * tree; the Agent surface (which actually spawns Claude Code sessions) is mounted
 * once, ABOVE the page router, so it never remounts on navigation. They can't hold a
 * shared ref, so the tracker asks for a sleep agent by dispatching a window event and
 * the always-mounted `AgentSurface` listens for it — the same decoupled pattern the
 * surface already uses for `dreamcontext-navigate` / `dreamcontext-zoom`.
 */
export const RUN_SLEEP_AGENT_EVENT = 'dreamcontext-run-sleep-agent';

/** The tab title used for the spawned consolidation session, so it's trackable in the
 *  bottom-right dock. Also the dedup key — a second request focuses the live one. */
export const SLEEP_AGENT_TITLE = 'Sleep';

/**
 * The instruction handed to the spawned Claude Code session. A single line (no
 * newlines — a bare `\n` would submit early in Claude's readline) that runs the
 * project's documented sleep/consolidation flow fully autonomously, mirroring the
 * headless Sleep button's `buildSleepPrompt` on the server (kept concise here since
 * the interactive agent resolves depth itself via `dreamcontext sleep start`).
 */
export const SLEEP_AGENT_PROMPT =
  'Think hard. Run a full dreamcontext memory consolidation ("sleep") for THIS project ' +
  'now, fully autonomously — do NOT ask any questions. Follow the project\'s dreamcontext ' +
  'sleep flow: pin the epoch with `dreamcontext sleep start`, reconcile the task / changelog ' +
  '/ knowledge / feature files to current truth (prefer updating existing entities over ' +
  'creating new ones), then close the cycle with `dreamcontext sleep done "<one-paragraph ' +
  'summary>"` to reset the debt. When finished, reply with a SHORT Markdown summary of what ' +
  'was consolidated.';

/** Ask the always-mounted Agent surface to open + run a "Sleep" consolidation session. */
export function requestSleepAgent(): void {
  window.dispatchEvent(new CustomEvent(RUN_SLEEP_AGENT_EVENT));
}
