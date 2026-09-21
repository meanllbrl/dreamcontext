import { useMemo, useRef, useState } from 'react';
import type { ComposerHost, ComposerHostModel } from '../sleepy/chat/composerHost';
import type { PeerMention } from '../../lib/agentComposer';
import { automationPhotoUrl } from '../../api/client';
import { mentionedIn, withoutMention, type ComposerAgent } from '../../lib/agentChannelMention';

/**
 * `#agents` AS A COMPOSER HOST — the whole adapter between this channel and the chat's own
 * composer. One pure mapping and one ref-backed host; the point of the file is that there is
 * nothing else.
 *
 * ── Why the channel stopped having a composer of its own ────────────────────────────
 * It shipped with one: a bespoke textarea, a bespoke `@` picker and a Send button, with its
 * own `.agent-say*`/`.agent-mention*` styling. The owner's note was "text gönderme kısmında
 * bizim composer componentlerini ve stilini kullansana" — and the project already said so
 * (`pattern-component-reuse-over`, and `composerHost.ts`'s own header: a hand-rolled box means
 * every one of the composer's behaviours rebuilt worse and drifting the moment the real one
 * moves). The meeting room answered this exact question first and this follows it.
 *
 * ── What this surface HAS, and what it deliberately does not ────────────────────────
 * Attach, Send and the field are the owner's explicit list and are all live. The model/effort
 * trigger is off (`showModel={false}`): an automation runs on the model IT is configured with,
 * so a picker here would change nothing. Mode/permission is off by having no `onModeChange`,
 * for the same reason it is off in the room — these are headless runs under a fixed `auto`.
 */

/** An agent as a mention the composer's `@` picker can offer. `vault` IS the token written
 *  into the draft (the slug, not the title — see `agentChannelMention.ts`), `whatItIs` is the
 *  human name under it, and `logoUrl` is the agent's own photo: the channel's premise is that
 *  agents have faces, so the picker you choose them from must show them. */
export function agentMention(a: ComposerAgent, vault: string | null): PeerMention {
  return {
    vault: a.slug,
    agent: a.slug,
    whatItIs: a.title,
    logo: a.hasPhoto,
    ...(a.hasPhoto ? { logoUrl: automationPhotoUrl(vault, a.slug) } : {}),
  };
}

/** What the channel wants back from a send it accepted — so `AgentsFeed` can drive the
 *  mutation and keep the pending/error state React already owns. */
export interface ChannelSend {
  (target: ComposerAgent, body: string): void;
}

/** The one sentence under the field (K5), or null. */
export interface ChannelNote {
  kind: 'error' | 'hint';
  text: string;
}

export interface AgentsChannelComposer {
  host: ComposerHost;
  /**
   * What the field says about ITSELF right now — who is being asked, why nobody is, or why
   * the last send did not happen.
   *
   * DERIVED FROM THE LIVE DRAFT, not latched at send time, and that is the whole rule: a red
   * "name an agent" sitting under a sentence that now names one is the field arguing with
   * what is on screen. Every keystroke re-derives it; the refusals below are the only entries
   * that outlive the keystroke that caused them, and only until the next one.
   */
  note: ChannelNote | null;
  /** Set it from the outside — the server refusing a send it already accepted from here. */
  setNote: (n: ChannelNote | null) => void;
  /** Focus the field (the composer registers it). */
  focusComposer: () => void;
}

/** Two notes that say the same thing, so `setNote` can hand back the previous object and let
 *  React bail out of the render. Typing the body after `@digest` re-derives the same hint on
 *  every keystroke; without this, each one would re-render the whole channel. */
function sameNote(a: ChannelNote | null, b: ChannelNote | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.text === b.text;
}

/**
 * A {@link ComposerHost} over `#agents`.
 *
 * STABLE FOR THE PAGE'S LIFE (`useMemo` with no deps) and reading everything live through a
 * ref — not an optimisation but a requirement in two directions, exactly as in
 * `meetingHost.ts`: the composer registers its focus target in `useEffect(…, [session])`, so a
 * host rebuilt per render would tear that registration down and back up every 15s poll tick;
 * and `getModel()` runs on EVERY composer render, so it cannot close over a snapshot.
 */
export function useAgentsChannelHost(
  agents: ComposerAgent[],
  send: ChannelSend,
): AgentsChannelComposer {
  const live = useRef({ agents, send });
  live.current.agents = agents;
  live.current.send = send;

  // The draft lives in a ref rather than state because nothing here RENDERS it — the composer
  // owns the textarea and mirrors every keystroke down via `syncDraft`. Its only readers are
  // the composer's own mount and the refusal path below.
  const draft = useRef('');
  const focusTarget = useRef<HTMLElement | null>(null);
  const [note, setNote] = useState<ChannelNote | null>(null);

  const host = useMemo<ComposerHost>(() => ({
    // No conversation to measure: `useAgentSessionStats` is gated on a truthy id, so the
    // context ring is not drawn. The ACCOUNT's 5-hour and weekly caps still are — which is
    // exactly what a channel about to spend a headless run wants in front of it.
    claudeId: '',
    // …and therefore not a scratch key either. Named, so the attachment chips staged here
    // cannot be shown to the meeting room, the other host that reports no conversation.
    scratchId: 'agents-channel',
    getModel: (): ComposerHostModel => ({
      draft: draft.current,
      // Never moves off 0: this channel has no rewind and no external `sendText`, so it never
      // replaces the draft wholesale and the composer never adopts over free typing. A refusal
      // does not need it either — `send` returning false means the field was never cleared, so
      // there is nothing to put back.
      draftEpoch: 0,
      history: [],
      // The transcript is the CHANNEL, rendered by `AgentsFeed` above this composer as agent
      // messages with photos, status words and thread rows — not as `ItemView` chat items. So
      // the composer is handed none: `items` feeds ↑/↓ prompt history, and a history walk
      // through other agents' posts would recall text the user never wrote.
      items: [],
      // No CLI reported any commands here, so `/` opens nothing. Empty rather than absent, to
      // say that deliberately.
      slashCommands: [],
      context: null,
    }),
    syncDraft: (text) => {
      draft.current = text;
      // Re-derive the note from what is actually in the box. This is what retires a refusal
      // the moment the user acts on it, and what answers "and then what happens?" while they
      // are still typing — the question the old hand-rolled field answered and the chat's
      // composer, which knows nothing about agents, cannot.
      const target = mentionedIn(text, live.current.agents);
      const next: ChannelNote | null = target
        ? { kind: 'hint', text: `${target.title} runs once, with what you wrote. Enter sends, Shift+Enter is a new line.` }
        : null;
      setNote((prev) => (sameNote(prev, next) ? prev : next));
    },
    setFocusTarget: (el) => { focusTarget.current = el; },

    /**
     * THE ADDRESS GATE. The composer hands over the message fully assembled — quote prefix,
     * attachment paths and all — and this decides whether it can be delivered.
     *
     * A draft that names nobody is REFUSED, and `false` is the whole mechanism: the composer
     * clears nothing on a refusal, so the sentence AND any staged attachment chips are still
     * sitting there, untouched, with a note under them saying why. The alternative — letting
     * the clear run and putting the draft back afterwards — restores the text and silently
     * drops the chips, which is a worse lie than not sending at all.
     */
    send: (text) => {
      const refuse = (why: string) => {
        // The host is stable, so this `setState` is also what re-renders the composer; the
        // note itself is re-derived from the draft on the next keystroke (see `syncDraft`).
        setNote({ kind: 'error', text: why });
        return false as const;
      };
      const target = mentionedIn(text, live.current.agents);
      if (!target) {
        return refuse('Name an agent with @ — nobody is listening to the channel itself yet.');
      }
      const body = withoutMention(text, target);
      if (!body) {
        // A bare `@agent` with nothing after it is someone mid-sentence, not a request. Refuse
        // rather than starting a run with an empty prompt.
        return refuse(`Say what you need from ${target.title} — the address on its own is not a question.`);
      }
      draft.current = '';
      setNote(null);
      live.current.send(target, body);
      // Delivered — the composer may clear the field, the chips and the quote.
      return undefined;
    },

    // The three busy-only deliveries. Every control that reaches them is drawn only while the
    // composer's `busy` prop is true, and this channel passes `busy: false` on purpose: an
    // agent here is a headless run, not a turn that could be steered into or interrupted.
    // Unreachable by construction — and no-ops rather than throws, because a UI assertion that
    // fires on an unreachable path is a crash, not a bug report. `steer` answers false so the
    // composer's fallback would queue rather than silently swallow, if it ever did run.
    steer: () => false,
    enqueue: () => {},
    interrupt: () => {},
  }), []);

  return { host, note, setNote, focusComposer: () => focusTarget.current?.focus() };
}
