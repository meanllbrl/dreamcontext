import type { ChatItem, ChatResultInfo } from '../chatSession';
import type { ContextUsage } from '../../../lib/agentComposer';

/**
 * WHAT THE COMPOSER NEEDS FROM WHATEVER IT IS COMPOSING INTO.
 *
 * `Composer` used to take a `ChatSession` — a WebSocket, a child process, a turn state
 * machine. That was the only thing it ever composed into, so the narrower truth was never
 * worth spelling out: it reads a draft, a transcript and a slash-command list, and it sends.
 * The MEETING ROOM is the second caller, and it has none of the session: a post there is an
 * HTTP write and the answers arrive by polling from N headless runs in N project directories.
 *
 * So this interface is the seam, and it is deliberately STRUCTURAL — `ChatSession` satisfies
 * it as-is, with no adapter, no wrapper and no change at any existing call site. Widening the
 * prop's type was the whole edit on the chat's side.
 *
 * WHY A SEAM RATHER THAN A SECOND COMPOSER: the peer-session panel already answered this
 * question once (see PeerSessionCard's header — "a peer session is a chat; it gets the
 * chat"). A hand-rolled box means no `/` menu, no `@` picker, no prompt history, no
 * auto-grow, no drag handle, no model/effort trigger, no attachment chips — every one of them
 * rebuilt worse, and drifting the moment the real one moves. The room shipped with exactly
 * such a box (a textarea and a Post button) and this replaces it.
 *
 * WHAT IS NOT HERE is as load-bearing as what is. A host has no `rewind`, `retry`,
 * `dismissBranchNotice` or permission answering: those belong to the transcript and the
 * cards, not to the composer, and a host that cannot do them must still be able to compose.
 */
export interface ComposerHost {
  /**
   * Stable id for everything keyed by CONVERSATION rather than by component: the attachment
   * chips and reply quote in `composerScratch`, and the session-stats poll.
   *
   * A host with no live agent behind it (the meeting room) returns `''`, which is not a
   * placeholder — `useAgentSessionStats` is gated on a truthy id, so an empty one means "there
   * is no conversation to measure" and the context ring simply isn't drawn.
   */
  claudeId: string;
  /**
   * What `composerScratch` keys the attachment chips and the reply quote by, when the
   * conversation id cannot be it.
   *
   * Absent (a `ChatSession`) ⇒ {@link claudeId}, which is the honest owner of anything staged
   * against a conversation and the one id no respawn changes. Supplied ⇒ a host that reports
   * `claudeId: ''` and therefore has NO conversation to key by: `''` is not an id, it is the
   * absence of one, so every such host would otherwise share a single bucket and a file
   * staged in the meeting room would reappear in the agents channel.
   *
   * Deliberately NOT folded into `claudeId`: that field is also the session-stats poll's key,
   * and a truthy value there starts a 5-second `/agent/session-stats` request for a
   * conversation that does not exist.
   */
  scratchId?: string;
  /** The live model, re-read on every render — never a snapshot (see Composer's header). */
  getModel(): ComposerHostModel;
  /** Mirror every keystroke back to the host, so an EXTERNAL append (a dropped file's path,
   *  a page-level insert) composes against an accurate draft rather than clobbering it. */
  syncDraft(text: string): void;
  /** Register the textarea so the host can focus it (click-to-focus on the transcript). */
  setFocusTarget(el: HTMLElement | null): void;
  /**
   * Send now. The only delivery a host MUST implement.
   *
   * Return `false` to REFUSE the delivery — the agents channel does this for a message that
   * names no agent, because a channel post nobody is listening to would land, sit there and
   * never be answered. A refusal means NOTHING left the composer, so the composer clears
   * nothing: the draft, the attachment chips and the reply quote all stay exactly as the user
   * left them. Anything else is the surface taking the message away without delivering it.
   *
   * Returning nothing means "delivered", which is what `ChatSession.send` (a `void` method)
   * already says — so every existing host satisfies this unchanged.
   */
  send(text: string): void | false;
  /**
   * The three BUSY-ONLY deliveries: steer into the running turn, hold for the next one, stop.
   * Every control that reaches them is drawn only while the `busy` prop is true, so a host
   * that has no turn to steer (the meeting room reports `busy: false` — its agents' progress
   * is a presence strip, not a turn) can implement them as no-ops that are never called.
   */
  steer(text: string): boolean;
  enqueue(text: string, opts?: { steerWhenPossible?: boolean }): void;
  interrupt(): void;
  /**
   * Silence spoken audio and bank the browser's autoplay activation, both synchronously.
   *
   * OPTIONAL because only a `ChatSession` in J.A.R.V.I.S mode has anything to silence — the
   * meeting room has no speech queue, and asking it to implement a no-op would be asking it
   * to know about a feature it does not have. The composer calls it with `?.()` from the mic
   * press and from Stop; a host without it simply has nothing playing.
   */
  bargeInSpeech?(): void;
  /**
   * Subscribe to "is this turn speaking". Returns the unsubscribe.
   *
   * OPTIONAL for the same reason as {@link bargeInSpeech}: only a `ChatSession` in
   * J.A.R.V.I.S mode has a speech queue. A host without it is a host with nothing playing,
   * and the composer simply never shows the speaking controls.
   */
  onSpeaking?(fn: (speaking: boolean) => void): () => void;
}

/** The slice of `ConversationModel` the composer reads. Mirrors those fields exactly. */
export interface ComposerHostModel {
  draft: string;
  /** Bumped when the host replaced the draft WHOLESALE; the composer adopts it rather than
   *  keeping what is in the box. */
  draftEpoch: number;
  /** Replayed transcript (a resumed conversation) — feeds ↑/↓ prompt history above `items`. */
  history: ChatItem[];
  items: ChatItem[];
  /** The `/` menu's list. Absent/empty ⇒ no menu, which is correct for a host with no CLI
   *  behind it to report commands. */
  slashCommands?: string[];
  lastResult?: ChatResultInfo;
  context?: ContextUsage | null;
  model?: string;
}
