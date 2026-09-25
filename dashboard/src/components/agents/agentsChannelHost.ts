import { useMemo, useReducer, useRef, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import type { ComposerHost, ComposerHostModel } from '../sleepy/chat/composerHost';
import type { PeerMention } from '../../lib/agentComposer';
import { automationPhotoUrl } from '../../api/client';
import { dropScratch } from '../sleepy/chat/composerScratch';
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
    // The picker matches the agent's NAME as well as its slug: "@deep" is how a person reaches
    // "Deep researcher", whose slug may be anything.
    aliases: [a.title],
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
  /** Set when the note says this agent is still running, so the page can retire it the
   *  moment that agent's run slot frees rather than waiting for the next keystroke. */
  busySlug?: string;
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
  /**
   * Put the last message this host accepted back into the field.
   *
   * The host answers `send` before the server does, so the composer has already cleared the
   * field by the time a refusal (a 409) lands. Called from the mutation's `onError`, this is
   * what keeps a refused sentence from simply vanishing: it bumps `draftEpoch`, which is the
   * composer's own signal to adopt the host's draft wholesale.
   */
  restoreLastSent: () => void;
}

/** Two notes that say the same thing, so `setNote` can hand back the previous object and let
 *  React bail out of the render. Typing the body after `@digest` re-derives the same hint on
 *  every keystroke; without this, each one would re-render the whole channel. */
function sameNote(a: ChannelNote | null, b: ChannelNote | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.text === b.text && a.busySlug === b.busySlug;
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
  /** This project's skills and commands, for the `/` menu — see `useProjectSlashCommands`. */
  slashCommands: string[] = [],
  /** Whether this agent holds its run slot right now. Agents run in parallel, one slot each,
   *  so the channel refuses only a message to the agent that is already running. */
  isBusy: (slug: string) => boolean = () => false,
): AgentsChannelComposer {
  const live = useRef({ agents, send, slashCommands, isBusy });
  live.current.agents = agents;
  live.current.send = send;
  live.current.slashCommands = slashCommands;
  live.current.isBusy = isBusy;

  // The draft lives in a ref rather than state because nothing here RENDERS it — the composer
  // owns the textarea and mirrors every keystroke down via `syncDraft`. Its only readers are
  // the composer's own mount and the refusal path below.
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;

  const draft = useRef('');
  /** The last full text `send` accepted, for {@link AgentsChannelComposer.restoreLastSent}. */
  const lastSent = useRef('');
  /** Bumped when the draft is replaced wholesale; read by the composer through `getModel`. */
  const epoch = useRef(0);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const focusTarget = useRef<HTMLElement | null>(null);
  const [note, setNote] = useState<ChannelNote | null>(null);
  const busyNote = (target: ComposerAgent): ChannelNote => ({
    kind: 'error',
    text: tRef.current('agents.busy').replace('{name}', target.title),
    busySlug: target.slug,
  });

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
      // Moves only when `restoreLastSent` puts a refused message back. A refusal the HOST makes
      // needs no epoch — `send` returning false means the field was never cleared — but a
      // refusal the SERVER makes arrives after the clear, and adopting is how the text returns.
      draftEpoch: epoch.current,
      history: [],
      // The transcript is the CHANNEL, rendered by `AgentsFeed` above this composer as agent
      // messages with photos, status words and thread rows — not as `ItemView` chat items. So
      // the composer is handed none: `items` feeds ↑/↓ prompt history, and a history walk
      // through other agents' posts would recall text the user never wrote.
      items: [],
      // No CLI process reports commands here, so the list is the project's CACHED one — the
      // same list a new chat is handed at connect. A `/name` picked from it rides into the ask,
      // and the run's brief tells it to load that skill (`buildAskBlock`).
      slashCommands: live.current.slashCommands,
      context: null,
    }),
    syncDraft: (text) => {
      draft.current = text;
      // Re-derive the note from what is actually in the box. This is what retires a refusal
      // the moment the user acts on it, and what answers "and then what happens?" while they
      // are still typing — the question the old hand-rolled field answered and the chat's
      // composer, which knows nothing about agents, cannot.
      const target = mentionedIn(text, live.current.agents);
      const next: ChannelNote | null = !target
        ? null
        : live.current.isBusy(target.slug)
          ? busyNote(target)
          : { kind: 'hint', text: `${target.title} runs once, with what you wrote. Enter sends, Shift+Enter is a new line.` };
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
        return refuse(tRef.current('agents.composer.noAgent'));
      }
      const body = withoutMention(text, target);
      if (!body) {
        // A bare `@agent` with nothing after it is someone mid-sentence, not a request. Refuse
        // rather than starting a run with an empty prompt.
        return refuse(tRef.current('agents.composer.noBody').replace('{name}', target.title));
      }
      if (live.current.isBusy(target.slug)) {
        // The agent named is mid-run, and a second run of one agent would write into the same
        // thread. Refused HERE, with the draft and chips kept, rather than sent to a 409.
        setNote(busyNote(target));
        return false as const;
      }
      lastSent.current = text;
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

  const restoreLastSent = () => {
    if (!lastSent.current) return;
    draft.current = lastSent.current;
    epoch.current += 1;
    rerender();
  };

  return { host, note, setNote, focusComposer: () => focusTarget.current?.focus(), restoreLastSent };
}

/**
 * A {@link ComposerHost} over ONE RUN'S THREAD.
 *
 * The same adapter as the channel above and deliberately not a fork of it — the two differ in
 * exactly two places, and everything else (the stable `useMemo` with no deps, every live value
 * through a ref, `busy: false`, the unreachable steer/enqueue/interrupt, the `send → false`
 * refusal contract that preserves the draft AND the staged chips) is shared by construction:
 *
 *  1. THE ADDRESS GATE IS GONE. A thread has one recipient — the run it belongs to — so there
 *     is nothing to resolve and no `@` to require. An empty body is still refused, for the
 *     same reason the channel refuses a bare `@agent`: it is someone mid-sentence, not a reply.
 *  2. THE NOTE IS THE DELIVERY, not the address. The panel writes the server's own refusal
 *     sentence into it; nothing is derived from the draft, because there is no "and then what
 *     happens?" left to answer once the recipient is fixed.
 *
 * ITS OWN SCRATCH BUCKET, per slug. `claudeId: ''` means "no conversation to measure", and
 * `composerScratch` keys attachments by that id — so an unnamed bucket here would pool this
 * panel's staged files with the channel's and the meeting room's, which is the collision the
 * channel already had to name its own bucket to escape. Per SLUG rather than per run: a thread
 * panel is re-opened on the newest run constantly, and a file staged a second before that
 * happens belongs to the agent you are talking to, not to the run id that was on screen.
 */
/**
 * Every thread scratch bucket this app run has minted.
 *
 * WHY A REGISTRY AND NOT AN UNMOUNT CLEANUP IN THE HOOK. `composerScratch`'s own header is
 * explicit that a chip is revoked "NOT when a pane unmounts, which is the whole point of this
 * module" — the store exists precisely so staged files OUTLIVE a remount. `AgentThreadPanel`
 * is mounted as `{openThread && <AgentThreadPanel …>}`, so it unmounts every time the panel
 * is closed and remounts on the next open, often for the same agent. Dropping from the hook's
 * own cleanup would therefore throw away a file the user had just attached because they
 * glanced at another message and came back — which is the EXACT bug the channel already hit
 * and fixed by moving its drop up to the page (see `AutomationsPage`'s own note).
 *
 * So the ids are recorded where they are minted and revoked where the channel's is: leaving
 * the PAGE. A `Set` rather than one fixed key because there is one bucket per agent, and the
 * page cannot know which threads were opened.
 */
const threadScratchIds = new Set<string>();

/**
 * Each agent's unsent thread reply, by slug.
 *
 * The panel remounts for every thread it shows (`key` on the run), so the draft cannot live in
 * the host alone: switching to another agent's thread and back would lose it, and NOT
 * remounting is how one agent's half-written reply used to sit under another agent's name.
 * Per slug for the same reason as the scratch bucket, and cleared with it when the page goes.
 */
const threadDrafts = new Map<string, string>();

/** The bucket for one agent's thread composer, recorded so the page can revoke it. */
function threadScratchId(slug: string): string {
  const id = `agents-thread-${slug}`;
  threadScratchIds.add(id);
  return id;
}

/**
 * Revoke every thread bucket — called from the Agents page's unmount, beside the channel's.
 *
 * Leaving the page is what ends these conversations for good; switching views inside it, or
 * closing and reopening a thread panel, is not. Idempotent: `dropScratch` no-ops on a bucket
 * that is already gone, and the set is cleared so a second call has nothing to do.
 */
export function dropThreadScratch(): void {
  for (const id of threadScratchIds) dropScratch(id);
  threadScratchIds.clear();
  threadDrafts.clear();
}

export function useAgentThreadHost(
  target: { slug: string; title: string; runId: string },
  send: (text: string) => void,
  slashCommands: string[] = [],
): AgentsChannelComposer {
  const live = useRef({ target, send, slashCommands });
  live.current.target = target;
  live.current.send = send;
  live.current.slashCommands = slashCommands;

  const draft = useRef(threadDrafts.get(target.slug) ?? '');
  const lastSent = useRef('');
  const epoch = useRef(0);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const focusTarget = useRef<HTMLElement | null>(null);
  const [note, setNote] = useState<ChannelNote | null>(null);

  const host = useMemo<ComposerHost>(() => ({
    claudeId: '',
    // Read through the ref, but computed ONCE: the host is stable for the panel's life and
    // the panel remounts when the slug changes, so this cannot go stale under itself. Minting
    // it through `threadScratchId` is what puts it on the page's revoke list — see that
    // function for why the drop does NOT hang off this hook's own unmount.
    scratchId: threadScratchId(live.current.target.slug),
    getModel: (): ComposerHostModel => ({
      draft: draft.current,
      draftEpoch: epoch.current,
      history: [],
      // Same reasoning as the channel: the transcript is rendered ABOVE this composer by the
      // panel itself, as thread entries. Handing them over as `items` would put other
      // people's posts into ↑/↓ prompt history.
      items: [],
      slashCommands: live.current.slashCommands,
      context: null,
    }),
    syncDraft: (text) => {
      draft.current = text;
      if (text) threadDrafts.set(live.current.target.slug, text);
      else threadDrafts.delete(live.current.target.slug);
    },
    setFocusTarget: (el) => { focusTarget.current = el; },
    send: (text) => {
      const body = text.trim();
      if (!body) {
        setNote({ kind: 'error', text: 'A reply needs something to say.' });
        // FALSE, so the composer clears nothing — the staged attachment chips survive a
        // refusal exactly as they do in the channel.
        return false as const;
      }
      lastSent.current = text;
      draft.current = '';
      threadDrafts.delete(live.current.target.slug);
      setNote(null);
      live.current.send(body);
      return undefined;
    },
    steer: () => false,
    enqueue: () => {},
    interrupt: () => {},
  }), []);

  const restoreLastSent = () => {
    if (!lastSent.current) return;
    draft.current = lastSent.current;
    threadDrafts.set(target.slug, lastSent.current);
    epoch.current += 1;
    rerender();
  };

  return { host, note, setNote, focusComposer: () => focusTarget.current?.focus(), restoreLastSent };
}
