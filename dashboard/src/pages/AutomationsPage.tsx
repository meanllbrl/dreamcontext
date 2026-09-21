import { useEffect, useMemo, useState } from 'react';
import { AgentsMembers } from '../components/agents/AgentsMembers';
import { AgentAvatar } from '../components/agents/AgentAvatar';
import { AgentDialog } from '../components/agents/AgentDialog';
import { AgentsFeed } from '../components/agents/AgentsFeed';
import { SlideOver } from '../components/sleepy/chat/SlideOver';
import { dropScratch } from '../components/sleepy/chat/composerScratch';
import { classifyReference } from '../components/sleepy/chat/chatEntities';
import '../components/sleepy/chat/overlays.css';
import { useAutomations } from '../hooks/useAutomations';
import { AutomationsEmptyState } from '../components/automations/AutomationsEmptyState';
import { AutomationsDispatcherBar } from '../components/automations/AutomationsDispatcherBar';
import './AutomationsPage.css';

/** The page's two views. `messages` is the channel — the feed of what the
 *  agents did — and it is where the page OPENS. `agents` is the roster behind
 *  it: who these agents are, not what they said. */
type AgentsView = 'messages' | 'agents';

/**
 * The Agents page — no `<h1>`, the sidebar already labels the active page
 * (project rule).
 *
 * SHAPE. This is a CHANNEL, and it opens on the channel: `#agents`, the
 * messages the agents post. The roster is the secondary view, reached from the
 * member avatars in the header — the same shape as the approved prototype, and
 * the owner's own correction after the first pass opened straight onto a grid
 * of cards ("Slack mesaj alanı gibi açılacak… önce thread'i göreceğiz").
 *
 * The feed is the channel's body: one message per RUN, across every agent,
 * newest at the bottom. What a message says — and what it withholds to the
 * thread panel — is `AgentsFeed`/`AgentMessage`'s business, not this page's.
 *
 * The `Page` union value stays `'automations'`: renaming the route key would
 * break persisted nav state for no user-visible gain.
 */
export function AutomationsPage() {
  const [view, setView] = useState<AgentsView>('messages');

  /**
   * The channel's staged chips die with the CHANNEL — which is this page, not the feed.
   *
   * `composerScratch` is keyed by conversation and revoked in exactly one place,
   * `dropScratch`, called from `closeSessionById` — "the one path that ends a conversation for
   * good". The channel has no such path: its bucket is the fixed `'agents-channel'` and
   * nothing ever closes it, so a pasted image staged and then abandoned would hold its object
   * URL for the life of the app run, once per visit.
   *
   * WHY HERE AND NOT IN `AgentsFeed`, which is where the composer actually lives: the
   * Messages/Agents toggle below unmounts the feed, and so does clicking an agent's name in
   * any message (`onOpenAgent`). Hanging the drop off the feed's unmount would throw away a
   * file the user had just attached because they glanced at the roster — the exact thing the
   * scratch store exists to prevent, since the chips are meant to outlive a remount (see
   * `composerScratch.ts`). Leaving the PAGE is what ends the channel; switching views inside
   * it is not.
   */
  useEffect(() => () => dropScratch('agents-channel'), []);

  const [toast, setToast] = useState<string | null>(null);
  /** The zero-state owns a create path of its own: with no agents there is no
   *  roster grid and so no dashed "New agent" card. */
  const [creating, setCreating] = useState(false);
  /** A document opened from a message's file card. Brain-relative as the feed
   *  reports it; prefixed for the project-root-scoped file route at the point
   *  of use, so only one spelling travels through this page's state. */
  const [openFile, setOpenFile] = useState<string | null>(null);
  const { data: automations, isLoading } = useAutomations();

  // The chat surface closes its SlideOver from its own key handler. Mounted
  // HERE it has none, so a document opened from a file card could only be
  // dismissed by clicking the scrim — a panel you cannot Escape out of is a
  // trap, and the runtime check caught it as one (the scrim went on eating
  // every click aimed at the page behind it).
  useEffect(() => {
    if (!openFile) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenFile(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openFile]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  const agents = useMemo(() => automations ?? [], [automations]);
  const scheduledCount = agents.filter((a) => a.mode === 'sched' && a.enabled).length;
  /** Agents holding an unanswered question, or blocked on a first approval —
   *  the two states where nothing moves until a human acts. */
  const needYou = useMemo(
    () => agents.filter((a) => a.pendingQuestion || (!a.approved && a.approvalReason === 'never-approved')),
    [agents],
  );

  /** "3 agents · 2 on a schedule" — the subtitle answers the question a person
   *  opens a channel with, rather than restating its name (K31). */
  const subtitle = agents.length === 0
    ? 'no agents yet'
    : `${agents.length} agent${agents.length === 1 ? '' : 's'}`
      + (scheduledCount > 0 ? ` · ${scheduledCount} on a schedule` : '');

  // The zero-state replaces the whole page: with nothing created, a channel
  // header over an empty channel and an empty roster is two dead ends where
  // one door belongs.
  if (!isLoading && agents.length === 0) {
    return (
      <div className="agents-page agents-page--empty">
        <AutomationsEmptyState onToast={setToast} onNewAgent={() => setCreating(true)} />
        {creating && <AgentDialog agent={null} onClose={() => setCreating(false)} onToast={setToast} />}
        {toast && <div className="agents-toast">{toast}</div>}
      </div>
    );
  }

  return (
    <div className="agents-page">
      <header className="agents-head">
        <div className="agents-head-row">
          <h2 className="agents-channel">#agents</h2>
          <span className="agents-channel-sub">{subtitle}</span>
          <span className="agents-head-spacer" />

          {/* A LABELLED two-option switch, not a face-stack you have to decode.
              The first version was avatars plus a bare count, which rendered as
              "AI MI SM 3" — three clipped monograms that say nothing about what
              the control does. Both destinations are named and both are always
              visible, so the choice is readable without being clicked. */}
          <div className="agents-switch" role="tablist" aria-label="Agents view">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'messages'}
              className={`agents-switch-opt${view === 'messages' ? ' agents-switch-opt--on' : ''}`}
              onClick={() => setView('messages')}
            >
              Messages
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'agents'}
              className={`agents-switch-opt${view === 'agents' ? ' agents-switch-opt--on' : ''}`}
              onClick={() => setView('agents')}
            >
              Agents
              <span className="agents-switch-count">{agents.length}</span>
            </button>
          </div>

          <button type="button" className="agents-new-btn" onClick={() => setCreating(true)}>
            New agent
          </button>
        </div>

        {/* The scheduler's state is a PAGE-level truth, not a roster one: an
            out-of-date dispatcher means nothing in the channel will ever
            arrive, so it belongs above both views. */}
        <AutomationsDispatcherBar onToast={setToast} />
      </header>

      {view === 'messages' ? (
        <div className="agents-channel-body">
          {/* Above the feed, not in it. An agent blocked on a FIRST APPROVAL has
              never run, so it has no message to carry the fact — it would be
              invisible in a feed of runs. The question a RUN asked does reach
              the feed, as a `needs you` message; this notice is for the state
              that has no run behind it. */}
          {needYou.length > 0 && (
            <button type="button" className="agents-needyou" onClick={() => setView('agents')}>
              <span className="agents-needyou-faces" aria-hidden="true">
                {needYou.slice(0, 3).map((a) => (
                  <AgentAvatar
                    key={a.slug}
                    slug={a.slug}
                    title={a.title}
                    hasPhoto={a.hasPhoto}
                    size={26}
                    version={a.cache?.lastRunAt ?? undefined}
                  />
                ))}
              </span>
              <span className="agents-needyou-text">
                <strong>
                  {needYou.length === 1
                    ? `${needYou[0].title} is waiting on you.`
                    : `${needYou.length} agents are waiting on you.`}
                </strong>
                <span>Open them to read what they are asking.</span>
              </span>
              <span className="agents-needyou-go" aria-hidden="true">→</span>
            </button>
          )}
          <AgentsFeed
            onOpenFile={setOpenFile}
            onOpenAgent={() => setView('agents')}
          />
        </div>
      ) : (
        <AgentsMembers onToast={setToast} onNewAgent={() => setCreating(true)} />
      )}

      {creating && (
        <AgentDialog
          agent={null}
          onClose={() => setCreating(false)}
          onToast={setToast}
          /* Creating from the CHANNEL and landing back on an empty channel is
             a create that looks like it did nothing — the new agent is the one
             thing the owner wants to see, so show them the roster it joined. */
          onCreated={() => setView('agents')}
        />
      )}
      {/* Opening a document REUSES the chat's file panel rather than growing a
          second viewer: it already handles text, images, PDFs, boards and the
          outside-the-project grant, and a second one would drift from it the
          first time any of those changed. `/agent/file` is PROJECT-root
          scoped, so the brain-relative path the feed reports is prefixed here
          — the one place that conversion happens. */}
      {openFile && (
        <SlideOver
          mode="file"
          path={`_dream_context/${openFile}`}
          reference={classifyReference(openFile)}
          onClose={() => setOpenFile(null)}
          onNavApp={() => setOpenFile(null)}
          onOpenPath={(p) => setOpenFile(p.replace(/^_dream_context\//, ''))}
        />
      )}
      {toast && <div className="agents-toast">{toast}</div>}
    </div>
  );
}
