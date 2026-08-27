import { useMemo, useRef } from 'react';
import type { ChatItem } from '../../components/sleepy/chatSession';
import type { ComposerHost, ComposerHostModel } from '../../components/sleepy/chat/composerHost';
import type { MeetingMessage } from '../../hooks/useMeetingRoom';
import type { PeerMention } from '../../lib/agentComposer';
import type { MeetingRosterEntry } from '../../hooks/useMeetingRoom';

/**
 * THE ROOM AS A COMPOSER HOST — the whole adapter between a polled HTTP thread and the chat's
 * own composer/transcript components. Three small pure mappings and one ref-backed host; the
 * point of the file is that there is nothing else.
 */

/**
 * One meeting message as a chat transcript item, so the room's feed can be `ItemView` — the
 * SAME renderer the chat pane and the peer panel use.
 *
 * The user's post maps to a `user` item (the tinted bubble, with Copy and Quote-reply) and an
 * agent's answer to a finished `text` item (full-width markdown, no avatar — hard rule 1 of
 * the chat design). `done: true` always: a headless run's reply arrives whole, so there is no
 * streaming state to represent and no caret to draw.
 *
 * A SYSTEM line gets no item and returns null — the room's own notices (a coalesced mention, a
 * cap hit) are not something an agent said, and rendering them as an assistant message would
 * put the room's voice in an agent's mouth. The feed draws those itself.
 */
export function meetingChatItem(message: MeetingMessage, index: number): ChatItem | null {
  const ts = Date.parse(message.createdAt) || 0;
  if (message.authorKind === 'user') {
    return { kind: 'user', id: message.id, text: message.body, ts };
  }
  if (message.authorKind === 'agent') {
    return { kind: 'text', id: message.id, index, text: message.body, done: true, ts };
  }
  return null;
}

/** A roster entry as a mention the composer's `@` picker can offer. `vault` IS the registered
 *  name — the exact token the server's roster-driven parse matches — and `agent` mirrors it
 *  because the room addresses PROJECTS, having no per-project agent name to show. */
export function rosterMention(entry: MeetingRosterEntry): PeerMention {
  return { vault: entry.name, agent: entry.name, whatItIs: entry.whatItIs };
}

/**
 * A {@link ComposerHost} over the room, plus the focus handle the composer registers.
 *
 * STABLE FOR THE WINDOW'S LIFE (`useMemo` with no deps) and reading everything live through a
 * ref, which is not an optimisation but a requirement in two directions:
 *   • the composer runs `useEffect(…, [session])` to register its focus target, so a host
 *     rebuilt per render would tear that registration down and back up every poll tick;
 *   • `getModel()` is called on EVERY composer render and must answer with the current
 *     messages, so it cannot close over a render's snapshot.
 */
export function useMeetingComposerHost(
  items: ChatItem[],
  onSend: (text: string) => void,
): { host: ComposerHost; focusComposer: () => void } {
  const live = useRef({ items, onSend });
  live.current.items = items;
  live.current.onSend = onSend;
  // The draft lives here rather than in React state because nothing in this window RENDERS
  // it — the composer owns the textarea and mirrors every keystroke down via `syncDraft`. Its
  // only reader is the composer's own mount, which is what makes the draft survive a thread
  // switch (the composer stays mounted; only the feed above it changes).
  const draft = useRef('');
  const focusTarget = useRef<HTMLElement | null>(null);

  const host = useMemo<ComposerHost>(() => ({
    // No conversation to measure: `useAgentSessionStats` is gated on a truthy id, so the
    // context ring is not drawn. The ACCOUNT's 5-hour and weekly caps still are — those come
    // from the vault-agnostic `/api/agent/usage-limits`, and they are exactly the numbers a
    // room that is about to spend N headless runs wants in front of it.
    claudeId: '',
    getModel: (): ComposerHostModel => ({
      draft: draft.current,
      // The room never replaces the draft wholesale — there is no rewind and no external
      // `sendText` into this surface — so the epoch never moves off 0 and the composer never
      // adopts over free typing.
      draftEpoch: 0,
      history: [],
      items: live.current.items,
      // No CLI reported any commands here, so `/` opens nothing. Empty rather than absent to
      // say that deliberately.
      slashCommands: [],
      context: null,
    }),
    syncDraft: (text) => { draft.current = text; },
    setFocusTarget: (el) => { focusTarget.current = el; },
    send: (text) => live.current.onSend(text),
    // The three busy-only deliveries. Every control that reaches them is drawn only while the
    // composer's `busy` prop is true, and the room passes `busy: false` on purpose: agents
    // here are headless runs whose progress is the presence strip, not a turn that could be
    // steered into or interrupted. Unreachable by construction — and no-ops rather than
    // throws, because a UI assertion that fires on an unreachable path is a crash, not a bug
    // report. `steer` answers false so the composer's fallback would queue rather than
    // silently swallow, if it ever did run.
    steer: () => false,
    enqueue: () => {},
    interrupt: () => {},
  }), []);

  return { host, focusComposer: () => focusTarget.current?.focus() };
}
