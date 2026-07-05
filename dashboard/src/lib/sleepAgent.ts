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

// ── "Waiting to sleep" shim ─────────────────────────────────────────────────────────
// There's a gap between clicking "Run sleep agent" and the spawned session actually
// running `dreamcontext sleep start` (which stamps `sleep_started_at` — the authoritative
// "sleeping" signal the tracker polls for): the agent has to boot, read the prompt, think,
// and type the command. During that gap the tracker had no way to show anything is
// happening, so the click read as a no-op and invited a confused re-click. We bridge it
// with a short-lived, persisted "pending" marker: set on click, cleared the moment a real
// sleep begins, and self-expiring after a ceiling so a failed spawn never wedges the
// tracker in "Waiting…" forever. Persisted (not React state) so it survives the tracker
// unmounting on navigation; broadcast so a live tracker reflects it immediately.
const SLEEP_PENDING_KEY = 'dreamcontext:sleep-pending-at';
export const SLEEP_PENDING_EVENT = 'dreamcontext-sleep-pending';
/** How long "Waiting to sleep" holds before self-clearing if no real sleep ever starts.
 *  Comfortably longer than a normal boot → `sleep start` (a few tens of seconds, plus the
 *  ~15s sleep-state poll), short enough that a stalled spawn re-enables the button — and the
 *  idle-session re-issue path in AgentSurface — within a few minutes. */
export const SLEEP_PENDING_TTL_MS = 3 * 60_000;

/** Mark a sleep as requested — the tracker shows "Waiting to sleep…" until it truly starts. */
export function markSleepPending(): void {
  try { localStorage.setItem(SLEEP_PENDING_KEY, String(Date.now())); } catch { /* storage blocked */ }
  window.dispatchEvent(new CustomEvent(SLEEP_PENDING_EVENT));
}

/** Drop the "Waiting to sleep" marker (real sleep began, or we're giving up on it). */
export function clearSleepPending(): void {
  try { localStorage.removeItem(SLEEP_PENDING_KEY); } catch { /* storage blocked */ }
  window.dispatchEvent(new CustomEvent(SLEEP_PENDING_EVENT));
}

/** The epoch (ms) a sleep was requested at, or null if none pending / it expired past the TTL. */
export function sleepPendingSince(): number | null {
  try {
    const raw = localStorage.getItem(SLEEP_PENDING_KEY);
    if (!raw) return null;
    const at = Number(raw);
    if (!Number.isFinite(at) || Date.now() - at > SLEEP_PENDING_TTL_MS) return null;
    return at;
  } catch { return null; }
}
