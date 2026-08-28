import { emitInstance } from '../context/VaultContext';

/**
 * The "open this automation run as a chat" bridge.
 *
 * An automation's run history lives on the Automations page, deep in the page router. The
 * Agent surface that owns Claude sessions is mounted ONCE, above that router, so it never
 * remounts on navigation — the two cannot share a ref. Same decoupled event pattern as
 * `delegateAgent.ts` / the Sleep + brain-resolve agents: the panel fires on its project's
 * instance bus, that project's `AgentSurface` listens.
 *
 * The bus, not `window`, and the ACK is the sharp edge again (as in `delegateAgent.ts`): the
 * listener writes `accepted` back synchronously, so broadcast, the first surface to run wins
 * the flag while every other one ALSO `--resume`s the same conversation uuid. Two live CLIs
 * attached to one transcript interleave their appends and neither sees the other's turns —
 * the exact dual-attach this file's own bring-forward guard exists to prevent, arrived at
 * from the outside. A run belongs to one project's automation; one surface opens it.
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
  /** 1-based, newest-first — the same numbering the run history and `--run N` use.
   *  NULL when the conversation was reached from its open QUESTION rather than
   *  from a history row: the asking run can have been evicted from the bounded
   *  history entirely (a gate that refuses re-records on every tick), so there
   *  is no honest row index to quote. The header omits the number rather than
   *  inventing one — see `AutomationRunHeader`. */
  runNumber: number | null;
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

/** The open question, as the board hands it to this bridge — the fields of
 *  `PendingQuestionSummary` (`useAutomations.ts`) this file actually needs.
 *  Structural, not an import, so the bridge stays free of the hooks layer. */
export interface PendingQuestionRef {
  id: string;
  kind: 'approval' | 'flow-hitl';
  runFiredAt: string;
  sessionId: string | null;
}

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
 * Ask THIS project's agent surface to open this run's conversation. Returns whether it did.
 *
 * Synchronous by construction: `dispatchEvent` runs every listener before it returns, so
 * the ACK is readable on the next line. Nothing async may be introduced between the
 * dispatch and the read, or the ACK stops meaning anything.
 *
 * Returns `boolean`, not `void`: the ACK is the whole reason this is a function rather than a
 * bare emit — the panel reports what actually happened ("Couldn't open the run") instead of
 * optimistically claiming success, exactly like `requestDelegateAgent`.
 */
export function openAutomationRunChat(bus: EventTarget, run: AutomationRunChatDetail): boolean {
  const detail: AutomationRunChatDetail = { ...run, accepted: false };
  emitInstance<AutomationRunChatDetail>(bus, AUTOMATION_RUN_CHAT_EVENT, detail);
  return detail.accepted === true;
}

/**
 * Open the conversation THAT ASKED, from the open question itself.
 *
 * WHY THIS EXISTS RATHER THAN REUSING THE HISTORY PATH. "Open chat" used to
 * resolve its session from run #1 — the newest row of `cache.history`. For an
 * automation that is *waiting on a verdict* that row is guaranteed to be the
 * wrong one: the review gate refuses without spawning (`sessionId: null`) and
 * is re-hit by every tick, so the newest rows are all session-less refusals
 * stacked on top of the run holding the question — and once there are more of
 * them than `HISTORY_LIMIT`, the asking run is not in the history at all. The
 * question record is the only thing that still knows the conversation's uuid,
 * so a verdict-waiting automation must open from HERE, never from the history.
 *
 * Returns false without dispatching for an `'approval'` question: `hitl.ts`
 * forces its `sessionId` to null because that session ran read-only and is
 * discarded whether or not the manifest is approved. There is nothing to
 * resume, and the caller answers it on its own screen instead.
 */
export function openAutomationQuestionChat(
  bus: EventTarget,
  args: { slug: string; automationTitle: string; question: PendingQuestionRef },
): boolean {
  const { slug, automationTitle, question } = args;
  if (!question.sessionId) return false;
  return openAutomationRunChat(bus, {
    slug,
    automationTitle,
    runNumber: null,
    sessionId: question.sessionId,
    firedAt: question.runFiredAt,
    status: 'awaiting-review',
    // The question record carries no telemetry — it is not a run summary. Null
    // is honest here; a zero would read as "cost nothing, took no turns".
    costUsd: null,
    numTurns: null,
    durationMs: null,
    // A run that stopped to ask published nothing: the whole point of the gate
    // is that its document does not land until the verdict does.
    outputPath: null,
  });
}

/**
 * The tab's name. The conversation's own first prompt is the approved automation brief
 * ("You are scheduled dreamcontext automation …"), which is both enormous and identical
 * across every run of the same job — so titling from it, the way a past-chat resume does,
 * would produce a row of indistinguishable tabs. The automation's name plus the run's fire
 * date is the pair D7 asks for: it disambiguates the same way a run number would, but also
 * says WHEN without a click — which matters once app-open restores several runs at once
 * (D7's "every run since the last open") and the tab strip needs to be skimmable.
 *
 * Clipped to the same 34 chars `resumePastSession` clips to, and the date marker is kept
 * whole: it is the half that disambiguates. Month+day only (no year/time) — the fuller
 * `toLocaleString` timestamp used elsewhere (`AutomationCard.tsx`) doesn't fit a tab.
 */
export function automationRunTabTitle(automationTitle: string, firedAt: string): string {
  const marker = ` · ${formatRunDate(firedAt)}`;
  const name = automationTitle.trim() || 'Automation';
  const room = 34 - marker.length;
  const clipped = name.length > room ? `${name.slice(0, room - 1).trimEnd()}…` : name;
  return `${clipped}${marker}`;
}

/** `firedAt` as a short "Aug 10"-style marker. Falls back to the raw ISO string (same
 *  degrade-gracefully convention as `AutomationCard.tsx`/`AutomationDetailPanel.tsx`) when
 *  it doesn't parse — still legible, just not reformatted. */
function formatRunDate(firedAt: string): string {
  const d = new Date(firedAt);
  return Number.isNaN(d.getTime()) ? firedAt : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
 *
 * A PENDING QUESTION IS NO LONGER A REASON TO REFUSE — this function used to take a
 * `pendingQuestionId` and turn it away, on the reasoning that a chat turn could tell a
 * `bypassPermissions` session to "just go ahead" while the card sat unresolved. That was
 * right when the answer lived in a review queue on another screen. It is now exactly
 * backwards: a `flow-hitl` question is a run that stopped and asked IN THIS CONVERSATION,
 * and `ChatPane` renders the answer card inline (D2/D-G). Refusing to open the chat would
 * make the only surface that can answer the question unreachable, and the copy pointed at
 * a queue that no longer exists. The original hole is still closed, but by the pane rather
 * than by this gate: while a question is pending `ChatPane` replaces the composer, so the
 * card is the only way to continue the run. An `'approval'` question needs no special case
 * here — `hitl.ts` forces its `sessionId` to null, and the run that asked one records no
 * session either, so the first guard below already turns it away.
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
