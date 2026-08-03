/**
 * The "open this automation run as a chat" bridge.
 *
 * An automation's run history lives on the Automations page, deep in the page router. The
 * Agent surface that owns Claude sessions is mounted ONCE, above that router, so it never
 * remounts on navigation — the two cannot share a ref. Same decoupled window-event pattern
 * as `delegateAgent.ts` / the Sleep + brain-resolve agents: the panel dispatches, the
 * always-mounted `AgentSurface` listens.
 *
 * What makes this different from every other spawn-from-elsewhere bridge: nothing is being
 * STARTED here. The conversation already happened — headless, on a schedule, while nobody
 * was watching — and its transcript is on disk exactly like any past chat. This event asks
 * the surface to `--resume` it, which is the same path `resumePastSession` walks for a row
 * picked out of the history popup.
 */

/** A run's provenance, as the resumed tab needs to describe itself. Mirrors the fields
 *  `GET /api/automations/:slug/session` already returns (see `useAutomations.ts`), plus the
 *  automation's display title, which the session response has no reason to carry. */
export interface AutomationRunRef {
  slug: string;
  /** The automation's human title ("CalBuddy Funnel Watch"), for the tab and the header. */
  automationTitle: string;
  /** 1-based, newest-first — the same numbering the run history and `--run N` use. */
  runNumber: number;
  /** The claude conversation UUID this run had. `--resume` takes exactly this. */
  sessionId: string;
  firedAt: string;
  status: string;
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
  /** The run's output document — the artifact of record. Null when it never wrote one. */
  outputPath: string | null;
}

export const AUTOMATION_RUN_CHAT_EVENT = 'dreamcontext-automation-run-chat';

/** What travels on the event: the run, plus the surface's ACK. */
export interface AutomationRunChatDetail extends AutomationRunRef {
  /**
   * Set to true by the AgentSurface listener once it has actually opened (or focused) the
   * tab. Left false when its guards reject — not desktop, claude CLI missing, the Agents
   * surface switched off in Settings — or when no surface is mounted to listen at all.
   *
   * The caller reports what really happened from this rather than optimistically claiming
   * success, exactly like `requestDelegateAgent`. A button that silently does nothing is
   * the failure this ACK exists to make impossible.
   */
  accepted?: boolean;
}

/**
 * Ask the agent surface to open this run's conversation. Returns whether it did.
 *
 * Synchronous by construction: `dispatchEvent` runs every listener before it returns, so
 * the ACK is readable on the next line. Nothing async may be introduced between the
 * dispatch and the read, or the ACK stops meaning anything.
 */
export function requestAutomationRunChat(run: AutomationRunRef): boolean {
  const detail: AutomationRunChatDetail = { ...run, accepted: false };
  window.dispatchEvent(new CustomEvent<AutomationRunChatDetail>(AUTOMATION_RUN_CHAT_EVENT, { detail }));
  return detail.accepted === true;
}

/**
 * The tab's name. The conversation's own first prompt is the approved automation brief
 * ("You are scheduled dreamcontext automation …"), which is both enormous and identical
 * across every run of the same job — so titling from it, the way a past-chat resume does,
 * would produce a row of indistinguishable tabs. The automation's name plus the run number
 * is the only pair that tells two of these apart.
 *
 * Clipped to the same 34 chars `resumePastSession` clips to, and the run marker is kept
 * whole: it is the half that disambiguates.
 */
export function automationRunTabTitle(automationTitle: string, runNumber: number): string {
  const marker = ` · run #${runNumber}`;
  const name = automationTitle.trim() || 'Automation';
  const room = 34 - marker.length;
  const clipped = name.length > room ? `${name.slice(0, room - 1).trimEnd()}…` : name;
  return `${clipped}${marker}`;
}

/**
 * Can this run be opened as a conversation at all?
 *
 * Two distinct nulls, and conflating them is how a user ends up in a blank chat:
 *
 *  • `sessionId === null` — the run never reached a claude process (`blocked` on the
 *    approval tripwire, `deferred` behind the sleep lock, `orphaned` behind a previous
 *    run's live process group). There is no conversation, and there never was one.
 *  • `transcriptPath === null` — there WAS a session id, but no file on disk: claude writes
 *    a transcript only once a session has produced a turn, and nothing in this app owns
 *    that file's lifetime (it can also simply have been pruned).
 *
 * The second is the dangerous one. `--resume` against a missing transcript does not fail
 * loudly — the chat route falls back to `--session-id` and FRESH-PINS a brand-new empty
 * conversation under that same uuid (see `agent-chat.ts`'s `freshPin`). The user would be
 * looking at an empty chat that claims to be their run. So the caller must ask this first
 * and say why not, rather than opening something.
 */
export function runChatUnavailableReason(
  run: { sessionId: string | null; transcriptPath: string | null },
): string | null {
  if (!run.sessionId) return 'This run never started a claude session, so there is no conversation to open.';
  if (!run.transcriptPath) {
    return 'No transcript on disk for this run. Claude writes one only once a session has produced a turn, and nothing here owns that file’s lifetime.';
  }
  return null;
}
