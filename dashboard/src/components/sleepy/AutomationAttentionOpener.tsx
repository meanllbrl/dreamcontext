import { useEffect, useRef } from 'react';
import { useAckAttention, useAutomationAttention } from '../../hooks/useAutomations';
import type { AutomationRunChatDetail } from '../../lib/automationRunChat';

/**
 * D7 — a run that needs a human opens as a chat tab, by itself.
 *
 * THE GAP THIS CLOSES. An automation runs unattended. When it stops to ask a
 * question, or crashes, the only trace is a card on a board nobody is standing
 * in front of and a notification long since dismissed. Every part of the path
 * from that run to a conversation the user can answer in already existed — the
 * transcript on disk, the resume route, the run header, the inline question
 * card — and none of it was ever connected to "the app just opened". The
 * result: no automation session ever opened on its own, and a question could
 * sit unanswered for days while the automation refused to run.
 *
 * ONLY RUNS THAT WANT SOMEONE. The server decides (`attention.ts`) and it is
 * deliberately not "every completed run": twelve automations firing overnight
 * would greet the user with twelve tabs, eleven of which say "done, here is
 * your digest" and want nothing. A tab is an interruption; spending one on a
 * clean run teaches the user to close them unread, which costs exactly the one
 * that did need them.
 *
 * NO STATE OF ITS OWN. The watermark is machine-local on the server (D-I) and
 * only advances through the ack, which fires after the tabs are open — so a
 * refresh or a crash mid-open replays the same window instead of swallowing
 * it. `openedRef` is a within-session duplicate guard, not a substitute: the
 * query re-delivers its cached data on every render, and the surface's own
 * bring-forward would focus (and therefore steal focus) each time.
 *
 * A SEPARATE COMPONENT, not an effect inside `AgentSurface`, so the poll exists
 * only while the surface is mounted AND able to act on it — the same reason
 * `AutomationQuestionSlot` keeps its 5s poll down in the pane rather than
 * lifted into the surface.
 */
export function AutomationAttentionOpener({
  ready,
  onOpen,
}: {
  /** The surface's own spawn guards, already evaluated: desktop + claude CLI +
   *  Agents enabled. False ⇒ this must not even poll, since nothing it learned
   *  could be acted on. */
  ready: boolean;
  /** `AgentSurface.openAutomationRunChat` — returns whether a tab was opened
   *  (or an existing one brought forward). The ack is gated on it: a run whose
   *  tab could not open must stay in the window so the next look retries. */
  onOpen: (detail: AutomationRunChatDetail) => boolean;
}) {
  const { data } = useAutomationAttention(ready);
  const ack = useAckAttention();
  /** Session ids this component has already handed to the surface. Guards the
   *  re-render replay described above, and survives the gap between opening
   *  and the ack round-tripping — during which the query can refetch and still
   *  legitimately return the same runs. */
  const openedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!ready) return;
    const runs = data?.runs ?? [];
    if (runs.length === 0) return;

    const fresh = runs.filter((r) => !openedRef.current.has(r.sessionId));
    if (fresh.length === 0) return;

    // Oldest first (the server sorts it that way) so the NEWEST ends up the
    // focused tab — the rule a mail client applies to a batch that arrived
    // while you were away.
    let newest: string | null = null;
    for (const run of fresh) {
      const accepted = onOpen({
        slug: run.slug,
        automationTitle: run.automationTitle,
        // No honest row index exists for these: a question's asking run can be
        // off the end of the bounded history entirely. The header omits the
        // number rather than inventing one.
        runNumber: null,
        sessionId: run.sessionId,
        firedAt: run.firedAt,
        status: run.status,
        costUsd: run.costUsd,
        numTurns: run.numTurns,
        durationMs: run.durationMs,
        outputPath: run.outputPath,
      });
      // Only a run that actually reached a tab is marked shown. One that was
      // refused stays in the window for the next look — the alternative is
      // silently dropping the one run that needed a human.
      //
      // A WARNING TO WHOEVER ADDS A PER-ITEM REJECTION HERE. Today every guard
      // inside `onOpen` (desktop, claude CLI, Agents enabled) is closure-stable
      // across this whole loop, so a batch either opens entirely or not at all,
      // and `newest` is therefore always the newest run that was offered. Give
      // `onOpen` a reason to refuse ONE item and not its neighbours — a
      // concurrent-tab cap, a client-side dual-attach check — and two separate
      // bugs come back at once: this ack would advance past a refused OLDER run
      // and lose it (the server's watermark is monotonic), and the server's
      // oldest-first cap would let a permanently-unopenable head block
      // everything behind it. Either change needs the ack to become "the newest
      // run with no unopened run older than it", not "the newest opened".
      if (!accepted) continue;
      openedRef.current.add(run.sessionId);
      if (newest === null || Date.parse(run.at) > Date.parse(newest)) newest = run.at;
    }

    // One ack for the batch, at the newest mark that actually opened. Nothing
    // opened ⇒ nothing is acked, and the same window is offered again.
    if (newest !== null) ack.mutate(newest);
    // `ack` is a stable mutation object from react-query; including it would
    // re-run this effect on every mutation state transition, i.e. immediately
    // after its own success.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, ready, onOpen]);

  return null;
}
