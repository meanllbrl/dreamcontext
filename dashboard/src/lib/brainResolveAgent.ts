/**
 * The "Resolve with AI" bridge (github-cloud-collaboration-brain-repo-sync, item 1).
 * The sidebar's teammate-conflict banner lives in the page tree; the Agent surface
 * (which actually spawns Claude Code sessions) is mounted once, ABOVE the router, so
 * they can't share a ref. The banner asks for a resolve session by dispatching a
 * window event and the always-mounted `AgentSurface` listens for it — the same
 * decoupled pattern `sleepAgent.ts` uses for "Run sleep agent".
 *
 * This is the REAL one-click resolve: in the desktop app it launches an in-app agent
 * running `/dream-sync` (which drives `brain sync --resume` → resolves the deferred
 * report → `--continue`), fully autonomously, and the sidebar refreshes to "Synced"
 * once it completes. In the plain browser dashboard (no agent surface) the sidebar
 * falls back to a copyable command instead of dispatching this.
 */
export const RUN_BRAIN_RESOLVE_EVENT = 'dreamcontext-run-brain-resolve';

/** Tab title for the spawned resolve session (also the dedup key — a second request focuses the live one). */
export const BRAIN_RESOLVE_TITLE = 'Resolve';

/**
 * The instruction handed to the spawned Claude Code session. One line (no newlines —
 * a bare `\n` would submit early in Claude's readline) that runs the `/dream-sync`
 * reconciliation fully autonomously. It triggers the dream-sync skill (which activates
 * on exactly this phrasing) and mirrors what a human would do at `brain sync --resume`.
 */
export const BRAIN_RESOLVE_PROMPT =
  'Think hard. Run the /dream-sync flow for THIS project now, fully autonomously — do NOT ' +
  'ask any questions. Reconcile the brain repo with the team: resume the deferred team merge ' +
  '(`dreamcontext brain sync --resume`), read the conflict report base/ours/theirs snapshots, ' +
  'write the correct semantic merge for every deferred prose file, then hand back with ' +
  '`dreamcontext brain sync --continue` to commit and push. When finished, reply with a SHORT ' +
  'Markdown summary of what you reconciled.';

/** Ask the always-mounted Agent surface to open + run a "/dream-sync" resolve session. */
export function requestBrainResolveAgent(): void {
  window.dispatchEvent(new CustomEvent(RUN_BRAIN_RESOLVE_EVENT));
}

/**
 * The exact command a human runs to resolve the merge WITHOUT the in-app agent — the
 * browser-dashboard fallback (item 1 AC: no agent surface ⇒ a clear copyable command).
 */
export const DREAM_SYNC_COMMAND = 'dreamcontext brain sync --resume   # then run /dream-sync in Claude Code, then: dreamcontext brain sync --continue';
