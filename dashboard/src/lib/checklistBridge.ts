/**
 * The window→window transport for the pinned checklist window's Submit button (plan
 * §1.11/§1.12, `chat-interactive-views-plan-v2.md`). A checklist lives in a SEPARATE OS
 * window with no WebSocket of its own, and its submit can arrive long after the turn that
 * asked for it ended — unlike `SurveyCard`, which answers a request the agent is actively
 * blocking on (and has a `requestId`). The server holds no session registry beyond a bare
 * `liveConversations: Set<string>` (ids only, no socket handles), so routing a submit
 * through it would mean new server state for a message that never leaves the machine.
 * A targeted Tauri event does the job with zero new server surface.
 *
 * TARGETED, NOT BROADCAST — the one invariant this file must never regress. `emitTo` is
 * used in BOTH directions; plain `emit()` broadcasts to every open window, which would hand
 * a checklist's plaintext markdown (which may hold a pasted API key) to every open vault's
 * Chat surface, including an unrelated project's — filtering at the receiver is not
 * isolation. `vaultWindowLabel`/`checklistWindowLabel` are single-sourced (`desktop.ts` /
 * `checklistStore.ts`) so this file never re-derives a label of its own.
 */
import { isDesktop, vaultWindowLabel } from './desktop';
import { checklistWindowLabel } from './checklistStore';

export const CHECKLIST_SUBMIT_EVENT = 'dream://checklist-submit';
export const CHECKLIST_ACK_EVENT = 'dream://checklist-ack';
export const CHECKLIST_ACK_TIMEOUT_MS = 2000;

export interface ChecklistSubmitPayload {
  vault: string;
  conversationId: string;
  checklistId: string;
  markdown: string;
}

interface ChecklistAckPayload {
  checklistId: string;
  ok: true;
}

/**
 * Cached `@tauri-apps/api/event` module — mirrors `desktop.ts`'s `windowApi()` cache so a
 * failed load doesn't poison every future call. Worth caching here specifically because
 * `submitChecklist` races a hard `CHECKLIST_ACK_TIMEOUT_MS` budget; a cold dynamic import
 * on top of that would eat into it for no reason after the first call.
 */
let eventApiPromise: Promise<typeof import('@tauri-apps/api/event')> | null = null;
function eventApi(): Promise<typeof import('@tauri-apps/api/event')> {
  if (!eventApiPromise) {
    eventApiPromise = import('@tauri-apps/api/event');
    eventApiPromise.catch(() => { eventApiPromise = null; });
  }
  return eventApiPromise;
}

/**
 * Fired from the checklist window's Submit button. Resolves `true` ONLY on a real ack from
 * the target vault window. A thrown `emitTo`/`listen` (ACL denial, non-desktop) and a
 * silent non-delivery (the vault window was closed, or the label derivation is wrong) are
 * indistinguishable to the caller and both mean "couldn't reach the chat" — so both resolve
 * `false`, and the caller (`ChecklistWindow`) renders the same failure strip either way.
 * The ack listener is registered BEFORE `emitTo` fires (so a fast ack can never race ahead
 * of our own subscription) and is torn down on every exit path — ack, timeout, or thrown.
 */
export async function submitChecklist(p: ChecklistSubmitPayload): Promise<boolean> {
  if (!isDesktop()) return false;
  let unlisten: (() => void) | null = null;
  try {
    const { emitTo, listen } = await eventApi();
    let resolveAck: (ok: boolean) => void = () => {};
    const ackPromise = new Promise<boolean>((resolve) => { resolveAck = resolve; });
    unlisten = await listen<ChecklistAckPayload>(CHECKLIST_ACK_EVENT, (event) => {
      if (event.payload?.checklistId === p.checklistId) resolveAck(true);
    });
    await emitTo(vaultWindowLabel(p.vault), CHECKLIST_SUBMIT_EVENT, p);
    const timeoutPromise = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), CHECKLIST_ACK_TIMEOUT_MS);
    });
    return await Promise.race([ackPromise, timeoutPromise]);
  } catch {
    return false;
  } finally {
    unlisten?.();
  }
}

/**
 * Registered once by `AgentSurface` — the durable session registry, mounted for the whole
 * app's lifetime (a `ChatPane` is per-visible-pane and can be garaged, so it cannot be the
 * listener's home). `vault` scopes the incoming submit: a plain `listen()` here only ever
 * sees events `emitTo` addressed to THIS window, but `vaultWindowLabel`'s sanitizer is
 * DELIBERATELY lossy (`vault-a.b` and `vault-a-b` collide — an accepted pre-existing quirk,
 * §1.12), so this equality check is the belt-and-braces catch for that collision rather
 * than a redundant no-op. `handler` returns whether it CLAIMED the submit (resolved a live
 * chat session in this vault and posted the message to it); the ack fires only on `true`,
 * so an unmatched or vault-mismatched submit leaves the checklist window's timeout path to
 * render its own failure strip — never a silent success.
 */
export function listenForChecklistSubmits(
  vault: string,
  handler: (p: ChecklistSubmitPayload) => boolean,
): () => void {
  if (!isDesktop()) return () => {};
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  void (async () => {
    try {
      const { emitTo, listen } = await eventApi();
      const fn = await listen<ChecklistSubmitPayload>(CHECKLIST_SUBMIT_EVENT, (event) => {
        const payload = event.payload;
        if (!payload || payload.vault !== vault) return;
        if (!handler(payload)) return;
        void emitTo(checklistWindowLabel(payload.vault, payload.checklistId), CHECKLIST_ACK_EVENT, {
          checklistId: payload.checklistId,
          ok: true,
        } satisfies ChecklistAckPayload).catch(() => { /* best-effort — a lost ack just surfaces as the sender's own timeout */ });
      });
      // The effect that registered us unmounted (or resubscribed) while the listen() IPC
      // round-trip was still in flight — unlisten immediately instead of leaking it into
      // `unlisten`, which nothing will ever call again.
      if (cancelled) { fn(); return; }
      unlisten = fn;
    } catch { /* ACL / non-desktop — no submits will ever be claimed */ }
  })();
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
