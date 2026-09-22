import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentAvatar } from './AgentAvatar';
import { AgentMessage } from './AgentMessage';
import { AgentThreadPanel } from './AgentThreadPanel';
import { agentMention, useAgentsChannelHost } from './agentsChannelHost';
import { Composer } from '../sleepy/chat/Composer';
import { useAgentModelConfig } from '../../hooks/useAgentCapabilities';
import { FALLBACK_MODEL_CONFIG } from '../../lib/agentComposer';
import { readAgentSettings } from '../../lib/agentSettings';
import { useVault } from '../../context/VaultContext';
import {
  useAgentFeed, useAutomationRunJob, useMarkThreadRead, useSayInChannel, type FeedMessage,
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

type Filter = { kind: 'all' } | { kind: 'unread' } | { kind: 'needs' } | { kind: 'failed' } | { kind: 'agent'; slug: string };

function sameFilter(a: Filter, b: Filter): boolean {
  return a.kind === b.kind && (a.kind !== 'agent' || b.kind !== 'agent' || a.slug === b.slug);
}

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

function dayKey(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function AgentsFeed({
  onOpenFile,
  onOpenAgent,
}: {
  onOpenFile: (path: string) => void;
  onOpenAgent: (slug: string) => void;
}) {
  // The project's one run slot. It drives two things: the composer's busy
  // note, and how fast the channel refreshes — an agent you called by hand is
  // watched, not caught up on.
  const { data: runJob } = useAutomationRunJob();
  const live = runJob?.status === 'running';
  const { data, isLoading } = useAgentFeed(live);
  const markRead = useMarkThreadRead();
  const { vault } = useVault();
  const [filter, setFilter] = useState<Filter>({ kind: 'all' });
  const [openThread, setOpenThread] = useState<FeedMessage | null>(null);
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

  const visible = useMemo(() => messages.filter((m) => {
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
  }), [messages, filter]);

  // Land at the bottom — a channel is read from its newest end. Only on the
  // first load and on a filter change: re-anchoring on every 15s poll would
  // yank the page while someone is reading scrollback.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [filter, isLoading]);

  // …and again while a run you started is in flight. Its answer lands at the
  // bottom, and a channel that made you scroll to find the reply to your own
  // question would be missing the point.
  const newestKey = messages[messages.length - 1]?.key ?? null;
  useEffect(() => {
    if (!live) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [live, newestKey, messages]);

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

  const chips: { id: string; label: string; count: number; filter: Filter; slug?: string; title?: string; hasPhoto?: boolean }[] = [
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
      filter: { kind: 'agent', slug: a.slug } as Filter,
      slug: a.slug,
      title: a.title,
      hasPhoto: a.hasPhoto,
    })),
  ];

  // ── The composer ────────────────────────────────────────────────────────
  //
  // The agent holding the project's one run slot, when one is — its title, for the note that
  // replaces the placeholder while the field is down.
  const busyWith = live
    ? (data?.agents.find((a) => a.slug === runJob?.slug)?.title ?? runJob?.slug ?? null)
    : null;

  const say = useSayInChannel();
  const agents = useMemo(() => data?.agents ?? [], [data]);
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
  const onSend = useCallback((target: { slug: string }, body: string) => {
    say.mutate({ slug: target.slug, text: body }, {
      onSuccess: (res) => setPendingOpen({ slug: res.slug, runId: res.runId }),
      // The composer has already emptied the field by the time this lands, so what a refusal
      // can still save is the REASON, on screen. Retyping is the cost of a 409; losing both
      // the sentence AND the explanation is not a cost anyone agreed to.
      onError: (err) => noteRef.current({ kind: 'error', text: (err as Error).message }),
    });
  }, [say]);

  useEffect(() => {
    if (!pendingOpen) return;
    const m = messages.find((x) => x.slug === pendingOpen.slug && x.runId === pendingOpen.runId);
    if (!m) return;
    setOpenThread(m);
    setPendingOpen(null);
  }, [pendingOpen, messages]);

  const { host, note, setNote } = useAgentsChannelHost(agents, onSend);
  noteRef.current = setNote;

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
  const composerWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = composerWrapRef.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty('--dc-bottom-strip', `${Math.round(el.getBoundingClientRect().height)}px`);
    publish();
    // It grows with the textarea, with the attachment chips and with the note under it, so a
    // one-shot measurement would be wrong the moment anyone types a second line.
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => { ro.disconnect(); root.style.removeProperty('--dc-bottom-strip'); };
  }, []);

  // Model and effort: required by the composer's prop type, and behind a trigger this surface
  // does not draw. Read once from the app-global pick — there is nothing here that changes it.
  const modelConfig = useAgentModelConfig().data ?? FALLBACK_MODEL_CONFIG;
  const [model] = useState(() => readAgentSettings().chatDefaultModel);
  const [effort] = useState(() => readAgentSettings().chatDefaultEffort);

  let lastDay = '';

  return (
    <div className="agents-feed">
      {/* `chat-pane` is not decoration: `composerHeight.ts` finds the pane whose half-height
          is the composer's auto-grow ceiling with `closest('.chat-pane')`, so this column
          wearing the class is what makes the field grow to half the CHANNEL rather than half
          the viewport. It also carries the chat's reading tokens, which the composer's own
          rules read. One class instead of a second sizing rule. */}
      <div className={`agents-feed-main chat-pane${openThread ? ' agents-feed-main--split' : ''}`}>
        <div className="agents-chips" role="tablist" aria-label="Filter the channel">
          {chips.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={sameFilter(filter, c.filter)}
              className={`agents-chip${sameFilter(filter, c.filter) ? ' agents-chip--on' : ''}`}
              onClick={() => setFilter(c.filter)}
            >
              {c.slug && (
                <AgentAvatar slug={c.slug} title={c.title ?? c.slug} hasPhoto={c.hasPhoto ?? false} size={18} />
              )}
              <span className="agents-chip-label">{c.label}</span>
              <span className="agents-chip-count">{c.count}</span>
            </button>
          ))}
        </div>

        <div className="agents-feed-scroll" ref={scrollRef}>
          {isLoading && messages.length === 0 && <p className="agents-feed-note">Reading the channel…</p>}

          {!isLoading && messages.length === 0 && (
            <div className="agents-feed-zero">
              <p className="agents-feed-zero-lede">Nothing has been posted here yet.</p>
              <p className="agents-feed-zero-note">
                The next scheduled run opens the first thread. Each one lands here as a message
                you can read without opening its session.
              </p>
            </div>
          )}

          {/* K31: an empty FILTER answers the question the filter asked, rather
              than showing the same blank slate as an empty channel. */}
          {messages.length > 0 && visible.length === 0 && (
            <p className="agents-feed-note">
              {filter.kind === 'unread' && 'Nothing unread — you are caught up.'}
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
              <div key={m.key} data-msg-key={m.key}>
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
                  onOpenThread={setOpenThread}
                  onOpenFile={onOpenFile}
                  onOpenAgent={onOpenAgent}
                  onToast={setToast}
                />
              </div>
            );
          })}
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
            // nothing to queue into. The run slot is reported by `connected` instead.
            busy={false}
            // The transport is fine; what is missing is the RUN SLOT. One run per project at
            // a time, enforced in `startAutomationJob` — so the field goes down and says who
            // is holding it rather than failing on send. Expressed as `unavailable` and NOT as
            // `connected: false`, which is what the first pass did and which froze the
            // account's usage caps for the whole duration of every run (see the prop's docs).
            connected
            unavailable={busyWith ? { reason: `${busyWith} is still running — one at a time for now.` } : undefined}
            idlePlaceholder={'Type "@" to call an agent, then say what you need.'}
            // No `quote`: the channel has no quote-reply (replying at all is step 4).
            quote={null}
            onClearQuote={() => {}}
            // Every agent in the roster is addressable here. No `onPeerMessage`: `@slug` is
            // resolved by the HOST, against this channel's own rule (a mention anywhere
            // addresses, not just a leading one — see `agentChannelMention.ts`).
            mentions={mentions}
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

      {openThread && (
        <AgentThreadPanel
          // Re-read from the live feed so the panel's root message follows the
          // poll — a run that finishes while its thread is open must not keep
          // saying "running" in the header above its own `ok` row.
          message={messages.find((m) => m.key === openThread.key) ?? openThread}
          onClose={() => setOpenThread(null)}
          onOpenFile={onOpenFile}
          onOpenAgent={onOpenAgent}
          onToast={setToast}
        />
      )}

      {/* Click to dismiss — an answer that failed to record is something the
          reader needs to have SEEN, so it does not time itself out from under
          a glance away. */}
      {toast && (
        <div className="agents-toast" role="status" onClick={() => setToast(null)}>{toast}</div>
      )}
    </div>
  );
}
