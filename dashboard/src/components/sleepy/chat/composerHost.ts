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
  /** The live model, re-read on every render — never a snapshot (see Composer's header). */
  getModel(): ComposerHostModel;
  /** Mirror every keystroke back to the host, so an EXTERNAL append (a dropped file's path,
   *  a page-level insert) composes against an accurate draft rather than clobbering it. */
  syncDraft(text: string): void;
  /** Register the textarea so the host can focus it (click-to-focus on the transcript). */
  setFocusTarget(el: HTMLElement | null): void;
  /** Send now. The only delivery a host MUST implement. */
  send(text: string): void;
  /**
   * The three BUSY-ONLY deliveries: steer into the running turn, hold for the next one, stop.
   * Every control that reaches them is drawn only while the `busy` prop is true, so a host
   * that has no turn to steer (the meeting room reports `busy: false` — its agents' progress
   * is a presence strip, not a turn) can implement them as no-ops that are never called.
   */
  steer(text: string): boolean;
  enqueue(text: string, opts?: { steerWhenPossible?: boolean }): void;
  interrupt(): void;
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
