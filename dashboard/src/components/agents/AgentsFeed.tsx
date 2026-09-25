import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type AnimationEvent,
} from 'react';
import { AgentAvatar } from './AgentAvatar';
import { AgentMessage } from './AgentMessage';
import { AgentThreadPanel } from './AgentThreadPanel';
import { AgentsFeedFilters, type FeedChip, type FeedFilter } from './AgentsFeedFilters';
import { agentMention, useAgentsChannelHost } from './agentsChannelHost';
import { Composer } from '../sleepy/chat/Composer';
import { useAgentModelConfig } from '../../hooks/useAgentCapabilities';
import { FALLBACK_MODEL_CONFIG } from '../../lib/agentComposer';
import { readAgentSettings } from '../../lib/agentSettings';
import { useVault } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import {
  useAgentFeed, useAutomationDispatcher, useMarkThreadRead, useProjectSlashCommands, useSayInChannel,
  type FeedMessage,
} from '../../hooks/useAutomations';
// The chat composer's own stylesheets, in the order `ChatPane` imports them — the channel
// mounts the real `<Composer>`, so it needs the real CSS. `ChatPane.css` is here for its
// TOKENS (`--chat-text`, `--chat-lh`, …), which are declared on `.chat-pane` and read by the
// composer's rules; `.agents-composer` below wears that class for exactly that reason.
import '../sleepy/ChatPane.css';
import '../sleepy/chat/composer.css';
import './AgentsFeed.css';

/**
 * THE CHANNEL. One feed, every agent, newest at the bottom — the reading order
 * of a chat, so catching up is scrolling down and the newest thing is where
 * the eye already is.
 *
 * Three behaviours carry this screen, and each one exists because its absence
 * was the complaint:
 *
 *  - FILTERS are chips with live counts, so "which of my agents failed
 *    overnight" is one click and the count answers it before the click.
 *  - The NEW DIVIDER is a red line before the first unread, and it does not
 *    move while you read. Where you came in is a fact about this visit; a
 *    divider that slid down as messages were marked read would erase it.
 *  - The WATERMARK advances only after a message has actually BEEN ON SCREEN
 *    (an IntersectionObserver), never on open. Marking a channel read because
 *    a route rendered is how an unread badge stops meaning anything.
 */

/** "Today" / "Yesterday" / "Fri 19 Sep" — a date header only says the date
 *  when the date is not one of the two a person already has a word for. */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = new Date();
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diff = Math.round((t0.getTime() - day.getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Whether a message passes a filter. One predicate for the list and for the new-messages pill,
 *  so the pill never counts a row the reader's filter would not show them. */
function matchesFilter(m: FeedMessage, filter: FeedFilter): boolean {
  switch (filter.kind) {
    case 'all': return true;
    case 'unread': return m.unread;
    // `needsYou`, not the status word: a finished run with an unanswered
    // question is waiting on the reader too, and the chip's COUNT is the
    // server's own `needsYouTotal` — a filter keyed on something narrower
    // would show fewer rows than the number on the chip that opened it.
    case 'needs': return m.needsYou;
    case 'failed': return m.status === 'failed' || m.status === 'timeout';
    case 'agent': return m.slug === filter.slug;
  }
}

/** The arrivals of a poll that brought none. Shared so an empty poll does not re-render. */
const NO_ARRIVALS: ReadonlySet<string> = new Set();

function dayKey(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** The id the open thread panel wears, and the one its thread line points at (`aria-controls`). */
const THREAD_PANEL_ID = 'agents-thread-panel';

/** How close to the bottom (px) still counts as "at the bottom": a reader this near the newest
 *  message is following the channel, so what arrives is scrolled into view rather than counted
 *  on the new-messages pill. */
const NEAR_BOTTOM_PX = 48;
/** The channel's width (px) below which a thread OVERLAYS it, as Chat's SlideOver does,
 *  instead of splitting the row with it: under this, a 360px thread leaves the feed too
 *  narrow to read. Measured on the `.agents-feed` row, not the window. */
const THREAD_OVERLAY_BELOW = 900;

/** The open thread, and where it was opened from — focus goes back there when it closes. */
interface OpenThread {
  message: FeedMessage;
  opener: HTMLElement | null;
  /** Move focus into the panel on open. False when the panel opens by itself after an @mention,
   *  where the reader is still in the channel composer. */
  focus: boolean;
}

export function AgentsFeed({
  onOpenFile,
  onOpenAgent,
  fileOpen,
}: {
  onOpenFile: (path: string) => void;
  onOpenAgent: (slug: string) => void;
  /** A document viewer is open over the page. It owns Esc while it is, so the thread does not
   *  close underneath it. */
  fileOpen: boolean;
}) {
  const { t } = useI18n();
  // The agents running right now, one slot per agent, as the feed itself reports them
  // (`runSlots`). They drive two things: which agent a composer refuses (only the one that is
  // running; the others can be called at the same time), and how fast the channel refreshes
  // (the hook polls every 2s while any slot is held). Reading them off the feed rather than a
  // second poll is what makes a run started elsewhere (another tab, "run now") visible here.
  const { data, isLoading } = useAgentFeed();
  const runSlots = useMemo(() => data?.runSlots ?? {}, [data]);
  const markRead = useMarkThreadRead();
  const { vault } = useVault();
  const { data: dispatcher } = useAutomationDispatcher();
  const [filter, setFilter] = useState<FeedFilter>({ kind: 'all' });
  const [openThread, setOpenThread] = useState<OpenThread | null>(null);
  /** Owned HERE rather than taken as a prop: the only thing that raises one is
   *  an answer this feed's own question block could not record, and threading a
   *  callback down from the page for that would make the page responsible for a
   *  failure it has no part in. Reuses the page's `.agents-toast` style so the
   *  two read as one surface. */
  const [toast, setToast] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = useMemo(() => data?.messages ?? [], [data]);

  /**
   * The New divider is PINNED on first sight and never recomputed from the
   * live data. Once the watermark starts advancing under the reader, the
   * "first unread" moves — and a line that chases it would walk down the
   * screen as they read, which is the one thing a "you were here" marker
   * cannot do.
   */
  const [dividerKey, setDividerKey] = useState<string | null>(null);
  const pinned = useRef(false);
  useEffect(() => {
    if (pinned.current || messages.length === 0) return;
    pinned.current = true;
    setDividerKey(messages.find((m) => m.unread)?.key ?? null);
  }, [messages]);

  const visible = useMemo(() => messages.filter((m) => matchesFilter(m, filter)), [messages, filter]);

  /**
   * KEEP THE READER'S PLACE. The channel follows its newest end only while the reader is AT it:
   * a row that arrives (or grows, as "Working" turns into the answer) is scrolled into view then,
   * and counted on the "N new messages" pill otherwise. It used to scroll to the bottom on every
   * poll while any agent ran, which yanked a reader out of scrollback every two seconds.
   *
   * `atBottomRef` is a ref, not state: it is read inside layout effects and written on every
   * scroll event, and nothing renders from it directly (the pill renders from `unseen`).
   */
  const atBottomRef = useRef(true);
  const [unseen, setUnseen] = useState(0);
  const toBottom = useCallback((smooth: boolean) => {
    const el = scrollRef.current;
    atBottomRef.current = true;
    setUnseen(0);
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduce ? 'smooth' : 'auto' });
  }, []);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const at = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    atBottomRef.current = at;
    if (at) setUnseen(0);
  }, []);

  // Land at the bottom on the first load and on a filter change: a channel is read from its
  // newest end, and a new filter is a new list.
  useEffect(() => {
    toBottom(false);
  }, [filter, isLoading, toBottom]);

  // Before paint, so a row that arrives or grows while the reader is at the bottom never shows
  // for a frame below the fold.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [visible]);

  /**
   * WHICH ROWS ARRIVED. The first read is the channel as it was when the page opened, so none of
   * it animates; every key seen after that is an arrival. An arrival that the filter shows fades
   * and rises in (`--arrived`), and, when the reader is up in the scrollback, is counted on the
   * pill instead of moving them. The set is replaced on every poll, so a key never outlives the
   * poll after it (under reduced motion there is no `animationend` to clear it).
   */
  const seenKeys = useRef<Set<string> | null>(null);
  const [arrived, setArrived] = useState<ReadonlySet<string>>(NO_ARRIVALS);
  useEffect(() => {
    if (isLoading || !data) return;
    if (seenKeys.current === null) {
      seenKeys.current = new Set(messages.map((m) => m.key));
      return;
    }
    const seen = seenKeys.current;
    const fresh = messages.filter((m) => !seen.has(m.key));
    for (const m of fresh) seen.add(m.key);
    const shown = fresh.filter((m) => matchesFilter(m, filter)).map((m) => m.key);
    setArrived((prev) => (shown.length > 0 ? new Set(shown) : prev.size > 0 ? NO_ARRIVALS : prev));
    if (shown.length > 0 && !atBottomRef.current) setUnseen((n) => n + shown.length);
    // `filter` is read for the answer it gives at the moment a poll lands, not a trigger: a
    // filter change is not an arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, isLoading, data]);
  // A new filter is a new list: nothing in it has just arrived.
  useEffect(() => { setArrived(NO_ARRIVALS); }, [filter]);
  /** The arrival animation ran; the row is an ordinary row now. Bubbled events (a child's own
   *  animation) are not this row's. */
  const onArrived = useCallback((e: AnimationEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const key = e.currentTarget.dataset.msgKey;
    setArrived((prev) => {
      if (!key || !prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  /**
   * The watermark. One observer over the list: a message that has been at
   * least half visible for a moment is one the reader has had the chance to
   * see, and only then does its id go to the server.
   *
   * Per SLUG, taking the newest id seen for each — the store's own mark is
   * monotonic, so sending an older id for a slug already further along is
   * harmless, and batching per paint keeps a fast scroll from firing a request
   * per row.
   */
  const seen = useRef(new Map<string, string>());
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (rows) => {
        for (const row of rows) {
          if (!row.isIntersecting) continue;
          const key = (row.target as HTMLElement).dataset.msgKey;
          const m = messages.find((x) => x.key === key);
          if (!m || !m.unread || !m.newestId) continue;
          const best = seen.current.get(m.slug);
          if (!best || m.newestId > best) seen.current.set(m.slug, m.newestId);
        }
        for (const [slug, upToId] of seen.current) markRead.mutate({ slug, upToId });
        seen.current.clear();
      },
      { root: el, threshold: 0.5 },
    );
    for (const node of el.querySelectorAll('[data-msg-key]')) observer.observe(node);
    return () => observer.disconnect();
    // `markRead` is a stable mutation object; re-subscribing on every message
    // poll is intentional — new rows need observing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, visible.length]);

  const chips: FeedChip[] = [
    { id: 'all', label: 'All', count: messages.length, filter: { kind: 'all' } },
    { id: 'unread', label: 'Unread', count: messages.filter((m) => m.unread).length, filter: { kind: 'unread' } },
    // THE SERVER'S OWN NUMBER. Deriving it here a second way is what let the
    // chip and the rows disagree about one channel before — `buildFeed` counts
    // it once, from the same `needsYou` the filter above reads.
    { id: 'needs', label: 'Needs you', count: data?.needsYouTotal ?? 0, filter: { kind: 'needs' } },
    { id: 'failed', label: 'Failed', count: messages.filter((m) => m.status === 'failed' || m.status === 'timeout').length, filter: { kind: 'failed' } },
    ...(data?.agents ?? []).map((a) => ({
      id: `agent:${a.slug}`,
      label: a.title,
      count: messages.filter((m) => m.slug === a.slug).length,
      filter: { kind: 'agent', slug: a.slug } as FeedFilter,
      slug: a.slug,
      title: a.title,
      hasPhoto: a.hasPhoto,
    })),
  ];

  // ── The composer ────────────────────────────────────────────────────────
  //
  // A running agent's title, for the sentence that says it is busy: under the channel field when
  // a draft names it, and in its own thread's composer. Null for an agent that is free.
  const agents = useMemo(() => data?.agents ?? [], [data]);
  const busyTitle = useCallback(
    (slug: string) => (slug in runSlots ? (agents.find((a) => a.slug === slug)?.title ?? slug) : null),
    [runSlots, agents],
  );
  const isBusy = useCallback((slug: string) => slug in runSlots, [runSlots]);

  const say = useSayInChannel();
  const mentions = useMemo(() => agents.map((a) => agentMention(a, vault)), [agents, vault]);

  // One sentence under the field, one owner: the host derives it from the live draft, and a
  // server refusal is written into the same place rather than stacking a second line under it.
  const noteRef = useRef<(n: { kind: 'error' | 'hint'; text: string } | null) => void>(() => {});
  /**
   * The exchange an @mention just started, remembered until the feed carries it.
   *
   * Step-4's criterion is that a mention "posts my message and OPENS ITS THREAD" — and the
   * panel renders a `FeedMessage`, which does not exist yet at the moment the 200 lands: the
   * server has written the ask, but this client learns the message's shape from the next feed
   * read. So the pair is parked here and the effect below opens the panel the instant the
   * matching message appears, rather than the feed inventing a half-message to show now.
   */
  const [pendingOpen, setPendingOpen] = useState<{ slug: string; runId: string } | null>(null);
  const restoreRef = useRef<() => void>(() => {});
  const onSend = useCallback((target: { slug: string }, body: string) => {
    say.mutate({ slug: target.slug, text: body }, {
      // The reader's own message: follow it to the bottom, wherever they were.
      onSuccess: (res) => { setPendingOpen({ slug: res.slug, runId: res.runId }); toBottom(true); },
      // The composer has already emptied the field by the time this lands, so the refusal
      // puts it back: the server's own sentence under the field, and the words the reader
      // typed in it, ready to fix and resend.
      onError: (err) => {
        noteRef.current({ kind: 'error', text: (err as Error).message });
        restoreRef.current();
      },
    });
  }, [say, toBottom]);

  useEffect(() => {
    if (!pendingOpen) return;
    const m = messages.find((x) => x.slug === pendingOpen.slug && x.runId === pendingOpen.runId);
    if (!m) return;
    setOpenThread({ message: m, opener: null, focus: false });
    setPendingOpen(null);
  }, [pendingOpen, messages]);

  const slashCommands = useProjectSlashCommands().data?.commands;
  const { host, note, setNote, focusComposer, restoreLastSent } = useAgentsChannelHost(
    agents, onSend, slashCommands, isBusy,
  );
  noteRef.current = setNote;
  restoreRef.current = restoreLastSent;

  // A "still running" note is about a slot, not about a keystroke: when the agent it names
  // finishes, the note goes with it, rather than waiting for the reader to type again.
  const slotKey = Object.keys(runSlots).sort().join();
  const noteNow = useRef(note);
  noteNow.current = note;
  useEffect(() => {
    const busySlug = noteNow.current?.busySlug;
    if (busySlug && !(busySlug in runSlots)) setNote(null);
    // `slotKey` is the trigger; `runSlots` is read for the answer it gives at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotKey, setNote]);

  // Narrower than this, the thread slides over the channel the way Chat's SlideOver does,
  // rather than squeezing the two into a split neither can be read in.
  const [overlay, setOverlay] = useState(false);

  const openFromRow = useCallback((m: FeedMessage, opener: HTMLElement) => {
    setOpenThread({ message: m, opener, focus: true });
  }, []);
  /** Close the thread and give focus back to what opened it: the thread line, or the channel
   *  composer when that line has gone (a filter hid it, or the panel opened itself). */
  const closeThread = useCallback(() => {
    const opener = openThread?.opener ?? null;
    setOpenThread(null);
    if (opener?.isConnected) opener.focus();
    else focusComposer();
  }, [openThread, focusComposer]);

  /**
   * PUBLISH THIS STRIP'S HEIGHT, so the app's bottom-right floaters can step over it.
   *
   * The Agent FAB and the session dock are `position: fixed` in that corner on every page, and
   * this composer runs edge to edge — so Send sits exactly under them and cannot be clicked.
   * The project already met this once and already decided how it is answered:
   * `AgentTerminal.css`'s `.agent-dock--floating` LIFTS the floater clear of the pane
   * composer's strip rather than narrowing the composer ("Fixed to the corner, the dock landed
   * exactly on that button"). Same answer here, so the channel keeps the full width.
   *
   * The COMPOSER publishes and the floaters read, rather than the other way round: they are
   * global and conditional (desktop only, settings-gated, and a different element once
   * sessions exist), so a gutter reserved in CSS here would be dead space on every page that
   * has no floater. Unmounting clears it, so no other screen pays for this one.
   */
  //
  // TWO STRIPS, the taller wins. With a thread open its composer foot runs along the same
  // bottom edge, and it is the taller of the two whenever it carries a note, so the floater is
  // lifted over whichever is higher rather than straddling the thread's body/foot seam.
  //
  // The floater's OWN height (`--agents-floater-clearance`, the room the feed and the thread
  // leave under their last message) is the PAGE's to publish now (`useFloaterClearance` on
  // `.agents-page`), because the page's toast needs it in every view, not only this one.
  const composerWrapRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const [footEl, setFootEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const el = composerWrapRef.current;
    const feed = feedRef.current;
    if (!el || !feed) return;
    const root = document.documentElement;
    const publish = () => {
      const strip = Math.max(
        el.getBoundingClientRect().height,
        footEl?.isConnected ? footEl.getBoundingClientRect().height : 0,
      );
      root.style.setProperty('--dc-bottom-strip', `${Math.round(strip)}px`);
    };
    // It grows with the textarea, with the attachment chips and with the note under it, so a
    // one-shot measurement would be wrong the moment anyone types a second line.
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    if (footEl) ro.observe(footEl);
    publish();
    // The same observer decides split or overlay: it already watches this row's size.
    const decide = () => setOverlay(feed.getBoundingClientRect().width < THREAD_OVERLAY_BELOW);
    decide();
    const rowRo = new ResizeObserver(decide);
    rowRo.observe(feed);
    return () => {
      ro.disconnect();
      rowRo.disconnect();
      root.style.removeProperty('--dc-bottom-strip');
    };
  }, [footEl]);

  // Model and effort: required by the composer's prop type, and behind a trigger this surface
  // does not draw. Read once from the app-global pick — there is nothing here that changes it.
  const modelConfig = useAgentModelConfig().data ?? FALLBACK_MODEL_CONFIG;
  const [model] = useState(() => readAgentSettings().chatDefaultModel);
  const [effort] = useState(() => readAgentSettings().chatDefaultEffort);

  let lastDay = '';

  return (
    <div className="agents-feed" ref={feedRef}>
      {/* `chat-pane` is not decoration: `composerHeight.ts` finds the pane whose half-height
          is the composer's auto-grow ceiling with `closest('.chat-pane')`, so this column
          wearing the class is what makes the field grow to half the CHANNEL rather than half
          the viewport. It also carries the chat's reading tokens, which the composer's own
          rules read. One class instead of a second sizing rule. */}
      <div className={`agents-feed-main chat-pane${openThread && !overlay ? ' agents-feed-main--split' : ''}`}>
        {/* No chips on an empty channel: five filters counting zero are five controls with
            nothing behind them. */}
        {messages.length > 0 && (
          <AgentsFeedFilters chips={chips} filter={filter} onSelect={setFilter} />
        )}

        <div className="agents-feed-scroll" ref={scrollRef} onScroll={onScroll}>
          {isLoading && messages.length === 0 && <p className="agents-feed-note">Reading the channel…</p>}

          {!isLoading && messages.length === 0 && (
            <div className="agents-feed-zero">
              <p className="agents-feed-zero-lede">Nothing has been posted here yet.</p>
              {/* Lead with what the reader can do right now, and say what the scheduler will add
                  in the state it is actually in, never promising a run that is switched off. */}
              <p className="agents-feed-zero-note">
                {t(dispatcher?.installed ? 'agents.feed.empty.on' : 'agents.feed.empty.off')}
              </p>
            </div>
          )}

          {/* K31: an empty FILTER answers the question the filter asked, rather
              than showing the same blank slate as an empty channel. */}
          {messages.length > 0 && visible.length === 0 && (
            <p className="agents-feed-note">
              {filter.kind === 'unread' && t('agents.filter.empty.unread')}
              {filter.kind === 'needs' && 'No agent is waiting on you.'}
              {filter.kind === 'failed' && 'No run has failed.'}
              {filter.kind === 'agent' && 'This agent has not run yet.'}
            </p>
          )}

          {visible.map((m) => {
            const key = dayKey(m.at);
            const newDay = key !== lastDay;
            lastDay = key;
            return (
              <div
                key={m.key}
                data-msg-key={m.key}
                className={`agents-feed-item${arrived.has(m.key) ? ' agents-feed-item--arrived' : ''}`}
                onAnimationEnd={onArrived}
              >
                {newDay && (
                  <div className="agents-feed-day">
                    <span>{dayLabel(m.at)}</span>
                  </div>
                )}
                {m.key === dividerKey && (
                  <div className="agents-feed-new">
                    <span>New</span>
                  </div>
                )}
                <AgentMessage
                  message={m}
                  onOpenThread={openFromRow}
                  onOpenFile={onOpenFile}
                  onOpenAgent={onOpenAgent}
                  onToast={setToast}
                  threadOpen={openThread?.message.key === m.key}
                  panelId={THREAD_PANEL_ID}
                  // The run's own start, from the slot it holds, for the live elapsed time.
                  runStartedAt={m.status === 'running' ? (runSlots[m.slug]?.startedAt ?? null) : null}
                />
              </div>
            );
          })}

          {/* Up in the scrollback, what arrives is COUNTED here instead of moving the reader.
              Sticky to the scroller's bottom edge, so it sits just above the composer. */}
          {unseen > 0 && (
            <div className="agents-feed-newpill-wrap">
              <button type="button" className="agents-feed-newpill" onClick={() => toBottom(true)}>
                {unseen === 1
                  ? t('agents.feed.newMessages.one')
                  : t('agents.feed.newMessages.many').replace('{n}', String(unseen))}
                <span aria-hidden="true"> ↓</span>
              </button>
            </div>
          )}
        </div>

        {/* The channel's text field IS the chat's composer — see `agentsChannelHost.ts` for
            why, and for what this surface deliberately does not draw. The wrapper is what
            publishes `--dc-bottom-strip`; the composer itself knows nothing about the page's
            floating buttons. */}
        <div className="agents-composer" ref={composerWrapRef}>
          <Composer
            session={host}
            // Required by the prop type and never read: the trigger that would change them is
            // not drawn (`showModel={false}`), because an automation runs on the model IT is
            // configured with. Seeded from the app-global pick so the value behind the
            // suppressed control is at least the true one rather than a fiction.
            model={model}
            effort={effort}
            modelConfig={modelConfig}
            onModelChange={() => {}}
            onEffortChange={() => {}}
            showModel={false}
            // FALSE on purpose. `busy` means "a turn is running and ⏎ steers into it" — there
            // is no turn here, only a headless run, and the ⇡ queue button it would draw has
            // nothing to queue into. A running agent is refused by the host instead.
            busy={false}
            // Never down for the whole channel: agents run in parallel, one slot EACH, so the
            // only thing that cannot be sent is a message to an agent that is already running.
            // The host refuses that one, naming it, and keeps the draft (see `isBusy`).
            connected
            idlePlaceholder={'Type "@" to call an agent, then say what you need.'}
            // No `quote`: the channel has no quote-reply (replying at all is step 4).
            quote={null}
            onClearQuote={() => {}}
            // Every agent in the roster is addressable here. No `onPeerMessage`: `@slug` is
            // resolved by the HOST, against this channel's own rule (a mention anywhere
            // addresses, not just a leading one — see `agentChannelMention.ts`).
            mentions={mentions}
            // Agents have faces, so the picker never falls back to the connected-project glyph:
            // the agent's photo where it has one (the picker's own logo image, on the URL
            // `agentMention` already carries), and the feed's initials avatar where it does not.
            renderMentionFace={(p) => (p.logo && p.logoUrl
              ? <img className="chat-cmp-mention-logo" src={p.logoUrl} alt="" />
              : <AgentAvatar slug={p.vault} title={p.whatItIs} hasPhoto={false} size={16} />
            )}
            mentionsLabel={t('agents.composer.mentions')}
            onSignIn={() => {}}
          />
          {/* K5: one sentence, 14px, under the field — and only ever one of them. */}
          {note && (
            <p className={`agents-composer-note${note.kind === 'error' ? ' agents-composer-note--error' : ''}`}>
              {note.text}
            </p>
          )}
        </div>
      </div>

      {openThread && (() => {
        const panel = (
        <AgentThreadPanel
          // One mount per thread. Without the key the panel (and the composer inside it) was
          // REUSED across threads, so a half-written reply and a refusal note carried over to
          // the next agent, one Enter away from being sent to the wrong one.
          key={openThread.message.key}
          // Re-read from the live feed so the panel's root message follows the
          // poll — a run that finishes while its thread is open must not keep
          // saying "running" in the header above its own `ok` row.
          message={messages.find((m) => m.key === openThread.message.key) ?? openThread.message}
          onClose={closeThread}
          onOpenFile={onOpenFile}
          onOpenAgent={onOpenAgent}
          onToast={setToast}
          // Only THIS thread's agent can hold its composer down; another agent's run does not.
          busyWith={busyTitle(openThread.message.slug)}
          closeOnEscape={!fileOpen}
          autoFocus={openThread.focus}
          footRef={setFootEl}
          panelId={THREAD_PANEL_ID}
          overlay={overlay}
        />
        );
        // Narrow: Chat's own SlideOver scrim, which dims the channel and closes on a click
        // outside the panel. Wide: the split, as before.
        return overlay
          ? <div className="chat-slideover-scrim agents-thread-scrim" onClick={closeThread}>{panel}</div>
          : panel;
      })()}

      {/* Click to dismiss — an answer that failed to record is something the
          reader needs to have SEEN, so it does not time itself out from under
          a glance away. */}
      {toast && (
        <div className="agents-toast" role="status" onClick={() => setToast(null)}>{toast}</div>
      )}
    </div>
  );
}
