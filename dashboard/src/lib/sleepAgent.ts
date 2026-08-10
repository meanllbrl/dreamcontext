import { emitInstance } from '../context/VaultContext';
import { readScopedRaw, removeScoped, writeScopedRaw } from './scopedStorage';

/**
 * The "Run sleep agent" bridge. The header's Sleep-debt tracker lives in the page
 * tree; the Agent surface (which actually spawns Claude Code sessions) is mounted
 * once, ABOVE the page router, so it never remounts on navigation. They can't hold a
 * shared ref, so the tracker asks for a sleep agent by firing an event and the
 * always-mounted `AgentSurface` listens for it — the same decoupled pattern the
 * surface already uses for `dreamcontext-navigate`.
 *
 * ON THE INSTANCE BUS, NOT `window`. A consolidation is the single most project-specific
 * thing this app can start: it rewrites one vault's tasks, knowledge and changelog. On
 * `window`, one click would spawn a `sleep` session in EVERY project the window is holding
 * — several agents consolidating several brains nobody asked about. So the caller passes
 * the bus of the instance it belongs to (`useVault().bus`) and exactly one surface hears it.
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
 *
 * The fan-out sentence is load-bearing, not emphasis. Claude Code appends "Do not
 * call the AgentTool unless the user requested it" to every Opus 5 system prompt,
 * which outranks SKILL.md and silently collapsed sleep into inline specialist
 * passes. This text IS the user's turn, so spelling out the dispatch here is what
 * makes the condition true at the one entry point that can't rely on a hook. Keep
 * it in lockstep with `buildSleepPrompt` (server) — pinned by
 * `tests/unit/sleep-subagent-dispatch.test.ts`.
 */
export const SLEEP_AGENT_PROMPT =
  'Think hard. Run a full dreamcontext memory consolidation ("sleep") for THIS project ' +
  'now, fully autonomously — do NOT ask any questions. Follow the project\'s dreamcontext ' +
  'sleep flow: pin the epoch with `dreamcontext sleep start`, reconcile the task / changelog ' +
  '/ knowledge / feature files to current truth (prefer updating existing entities over ' +
  'creating new ones), then close the cycle with `dreamcontext sleep done "<one-paragraph ' +
  'summary>"` to reset the debt. I am explicitly requesting the sub-agent fan-out: dispatch ' +
  'the sleep specialists as PARALLEL sub-agents via the Agent tool (sleep-tasks + sleep-state ' +
  'always; sleep-product when knowledge/feature signals warrant; sleep-migration only if ' +
  '`dreamcontext migrations pending` has output) — do NOT run those passes inline in your own ' +
  'context. When finished, reply with a SHORT Markdown summary of what was consolidated.';

/** Ask THIS project's Agent surface to open + run a "Sleep" consolidation session. */
export function runSleepAgent(bus: EventTarget): void {
  emitInstance(bus, RUN_SLEEP_AGENT_EVENT);
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
// unmounting on navigation; announced so a live tracker reflects it immediately.
//
// PER VAULT, and the marker's own meaning is why: "a consolidation was just requested" is a
// fact about ONE project. Held at a single global key, clicking Run sleep agent in project A
// would put project B's tracker into "Waiting to sleep…" and disable its menu item, for a
// sleep B never asked for and will never see start. It rides `scopedStorage`, and its
// notification rides the instance bus, for the same reason.
//
// The pre-scoping key was the bare `dreamcontext:sleep-pending-at` and is deliberately NOT
// migrated: this marker is ephemeral (see the TTL below) and every app launch starts on a
// fresh origin with empty localStorage, so there is never a legacy value worth adopting —
// and adopting one would hand project A's "waiting" state to whichever project read first,
// which is the exact bug the scoping removes.
const SLEEP_PENDING_KEY = 'sleep-pending-at';
export const SLEEP_PENDING_EVENT = 'dreamcontext-sleep-pending';
/** How long "Waiting to sleep" holds before self-clearing if no real sleep ever starts.
 *  Comfortably longer than a normal boot → `sleep start` (a few tens of seconds, plus the
 *  ~15s sleep-state poll), short enough that a stalled spawn re-enables the button — and the
 *  idle-session re-issue path in AgentSurface — within a few minutes. */
export const SLEEP_PENDING_TTL_MS = 3 * 60_000;

/** Mark a sleep as requested for `vault` — its tracker shows "Waiting to sleep…" until it
 *  truly starts. */
export function markSleepPending(bus: EventTarget, vault: string | null): void {
  writeScopedRaw(vault, SLEEP_PENDING_KEY, String(Date.now()));
  emitInstance(bus, SLEEP_PENDING_EVENT);
}

/** Drop `vault`'s "Waiting to sleep" marker (real sleep began, or we're giving up on it). */
export function clearSleepPending(bus: EventTarget, vault: string | null): void {
  removeScoped(vault, SLEEP_PENDING_KEY);
  emitInstance(bus, SLEEP_PENDING_EVENT);
}

/** The epoch (ms) a sleep was requested at for `vault`, or null if none pending / it expired
 *  past the TTL. */
export function sleepPendingSince(vault: string | null): number | null {
  const raw = readScopedRaw(vault, SLEEP_PENDING_KEY);
  if (!raw) return null;
  const at = Number(raw);
  if (!Number.isFinite(at) || Date.now() - at > SLEEP_PENDING_TTL_MS) return null;
  return at;
}
