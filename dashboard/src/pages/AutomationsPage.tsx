import { useEffect, useMemo, useState } from 'react';
import { AgentsMembers } from '../components/agents/AgentsMembers';
import { AgentAvatar } from '../components/agents/AgentAvatar';
import { AgentDialog, type AgentDialogInitial } from '../components/agents/AgentDialog';
import { useFloaterClearance } from '../components/agents/useFloaterClearance';
import { AgentsFeed } from '../components/agents/AgentsFeed';
import { SlideOver } from '../components/sleepy/chat/SlideOver';
import { Lightbox } from '../components/sleepy/chat/Lightbox';
import { PdfViewer } from '../components/sleepy/chat/PdfViewer';
import { BoardFullscreen } from '../components/sleepy/chat/BoardEmbed';
import { agentFileKind } from '../components/agents/AgentMessage';
import { agentFileUrl, graphContentUrl } from '../api/client';
import { useVault } from '../context/VaultContext';
import { dropScratch } from '../components/sleepy/chat/composerScratch';
import { dropThreadScratch } from '../components/agents/agentsChannelHost';
import { classifyReference } from '../components/sleepy/chat/chatEntities';
import '../components/sleepy/chat/overlays.css';
import { useAgentFeed, useAutomations } from '../hooks/useAutomations';
import { AutomationsEmptyState } from '../components/automations/AutomationsEmptyState';
import { AutomationsDispatcherBar } from '../components/automations/AutomationsDispatcherBar';
import { useI18n } from '../context/I18nContext';
import { useAgentCapabilities } from '../hooks/useAgentCapabilities';
import './AutomationsPage.css';

/** The page's three views. `messages` is the channel — the feed of what the
 *  agents did — and it is where the page OPENS. `agents` is the roster behind
 *  it: who these agents are, not what they said. `files` is every document the
 *  agents have attached, newest first — the same paths the messages carry,
 *  gathered for the times you remember a file but not which run posted it. */
type AgentsView = 'messages' | 'agents' | 'files';

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
/**
 * EVERY FILE THE AGENTS HAVE POSTED, newest first.
 *
 * Derived from the feed the channel already reads rather than from a route of
 * its own: the paths are on the messages, so a second endpoint would be a
 * second answer to "what has been attached" that could disagree with the first.
 * De-duplicated by path — the published document rides on its run's message AND
 * can be attached by a post, and one document is one row.
 *
 * ONE VIEWER. A row opens the same `SlideOver` a file card in a message opens,
 * so a document does not change behaviour depending on which list you found it in.
 */
function AgentsFiles({ onOpenFile }: { onOpenFile: (path: string) => void }) {
  const { data } = useAgentFeed();
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: { path: string; name: string; title: string; at: string }[] = [];
    // Newest message first: the feed is oldest-first (chat reading order), and a
    // file list is a search surface, where the thing you just made is at the top.
    for (const m of [...(data?.messages ?? [])].reverse()) {
      // The run's own document rides on `document`, no longer in `files`: the feed shows it
      // as the thread's report, but it is still a file this list must find.
      for (const f of m.document ? [...m.files, m.document] : m.files) {
        if (seen.has(f.path)) continue;
        seen.add(f.path);
        out.push({ path: f.path, name: f.name, title: m.title, at: m.at });
      }
    }
    return out;
  }, [data]);

  // The channel's own file-chip rules, reused rather than re-declared: a chip
  // here and a chip in a message are the same object, and this lane does not own
  // the stylesheet that draws them.
  return (
    <div className="agents-channel-body">
      {rows.length === 0 ? (
        /* K31: the empty state answers the question the tab asked. */
        <p className="agents-feed-note">No agent has attached a file yet.</p>
      ) : (
        <div className="agent-msg-files">
          {rows.map((r) => (
            <button
              key={r.path}
              type="button"
              className="agent-msg-file"
              onClick={() => onOpenFile(r.path)}
              title={r.path}
            >
              <span className="agent-msg-file-glyph" aria-hidden="true">◧</span>
              <span className="agent-msg-file-name">{r.name}</span>
              <span className="agent-msg-file-note">{r.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function AutomationsPage() {
  const { t } = useI18n();
  const { vault } = useVault();
  // The server's own desktop gate, the one `AgentFiles` reads to decide whether a board
  // draws: the route an `.svg` opens through is desktop-only, so off desktop it stays a card.
  const desktop = useAgentCapabilities().data?.desktop === true;
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
  useEffect(() => () => {
    dropScratch('agents-channel');
    // …and every THREAD bucket the panel minted while this page was open. One per agent, so
    // the page cannot name them and the host that mints them keeps the list. Same reason,
    // same moment: a thread panel closes and reopens constantly (it is `{openThread && …}`),
    // and a drop on ITS unmount would bin a file staged a second earlier.
    dropThreadScratch();
  }, []);

  const [toast, setToast] = useState<string | null>(null);
  /** The create dialog, open or not, and what it opens with: nothing (a blank agent) or one
   *  of the first run's starters, prefilled. */
  const [creating, setCreating] = useState<{ initial?: AgentDialogInitial } | null>(null);
  /** The page element, held in state so the floater clearance follows it across the switch
   *  between the zero-state and the channel (two branches, one page). */
  const [pageEl, setPageEl] = useState<HTMLDivElement | null>(null);
  useFloaterClearance(pageEl);
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

  /** "3 agents · 2 on a schedule". It LEADS the header now: the sidebar already names the
   *  page, so the row opens on what is in it rather than repeating the title (K31, C6). Two
   *  spans so a narrow header drops the schedule half whole instead of cutting it mid-word. */
  const subtitleCount = agents.length === 0
    ? t('agents.head.count.none')
    : agents.length === 1 ? t('agents.head.count.one') : t('agents.head.count.many').replace('{n}', String(agents.length));
  const subtitleSched = agents.length > 0 && scheduledCount > 0
    ? ` · ${t('agents.head.sched').replace('{n}', String(scheduledCount))}`
    : '';

  // The zero-state replaces the whole page: with nothing created, a channel
  // header over an empty channel and an empty roster is two dead ends where
  // one door belongs.
  if (!isLoading && agents.length === 0) {
    return (
      <div ref={setPageEl} className="agents-page agents-page--empty">
        <AutomationsEmptyState
          onToast={setToast}
          onNewAgent={() => setCreating({})}
          onStart={(initial) => setCreating({ initial })}
        />
        {creating && (
          <AgentDialog agent={null} initial={creating.initial} onClose={() => setCreating(null)} onToast={setToast} />
        )}
        {toast && <div className="agents-toast" role="status">{toast}</div>}
      </div>
    );
  }

  return (
    <div ref={setPageEl} className="agents-page">
      <header className="agents-head">
        {/* The page's name for assistive tech only: the sidebar label is the visible title
            (no page headlines), and painting it again cost the row ~190px (C6). */}
        <h2 className="sr-only">{t('nav.automations')}</h2>
        <div className="agents-head-row">
          <span className="agents-channel-sub">
            <span className="agents-channel-sub-count">{subtitleCount}</span>
            {subtitleSched && <span className="agents-channel-sub-sched">{subtitleSched}</span>}
          </span>
          <span className="agents-head-spacer" />

          {/* The scheduler's healthy state is one pill on this row, not a bar under it. */}
          <AutomationsDispatcherBar variant="inline" onToast={setToast} />

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
            <button
              type="button"
              role="tab"
              aria-selected={view === 'files'}
              className={`agents-switch-opt${view === 'files' ? ' agents-switch-opt--on' : ''}`}
              onClick={() => setView('files')}
            >
              Files
            </button>
          </div>

          <button type="button" className="agents-new-btn" onClick={() => setCreating({})}>
            New agent
          </button>
        </div>

        {/* ONE TRAY for the notices, inside the header: the scheduler's WARN row (a page-level
            truth, so every view shows it) and, in the channel, who is waiting on you. They used
            to be two stacked cards with their own margins, and at 1100px a third of the
            channel was header before any message (C6). Empty, the tray draws nothing. */}
        <div className="agents-tray">
          <AutomationsDispatcherBar variant="alerts" onToast={setToast} />
          {/* An agent blocked on a FIRST APPROVAL has never run, so it has no message to carry
              the fact; the question a RUN asked also reaches the feed, as a `needs you` row.
              Warning ink on the dot only (K26/K40): a question is not a fault. */}
          {view === 'messages' && needYou.length > 0 && (
            <button type="button" className="agents-needyou" onClick={() => setView('agents')}>
              <span className="agents-needyou-dot" aria-hidden="true" />
              <span className="agents-needyou-faces" aria-hidden="true">
                {needYou.slice(0, 3).map((a) => (
                  <AgentAvatar
                    key={a.slug}
                    slug={a.slug}
                    title={a.title}
                    hasPhoto={a.hasPhoto}
                    size={20}
                    version={a.cache?.lastRunAt ?? undefined}
                  />
                ))}
              </span>
              <span className="agents-needyou-text">
                <strong>
                  {needYou.length === 1
                    ? t('agents.needYou.one').replace('{name}', needYou[0].title)
                    : t('agents.needYou.many').replace('{n}', String(needYou.length))}
                </strong>
                <span>{t(needYou.length === 1 ? 'agents.needYou.openOne' : 'agents.needYou.openMany')}</span>
              </span>
              <span className="agents-needyou-go" aria-hidden="true">→</span>
            </button>
          )}
        </div>
      </header>

      {view === 'messages' ? (
        <div className="agents-channel-body">
          <AgentsFeed
            // While a file viewer is open over the page, Esc belongs to the viewer: the
            // thread panel under it must not close in the same keystroke.
            fileOpen={openFile !== null}
            onOpenFile={setOpenFile}
            onOpenAgent={() => setView('agents')}
          />
        </div>
      ) : view === 'files' ? (
        <AgentsFiles onOpenFile={setOpenFile} />
      ) : (
        <AgentsMembers onToast={setToast} />
      )}

      {creating && (
        <AgentDialog
          agent={null}
          onClose={() => setCreating(null)}
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
      {openFile && (() => {
        // ROUTED BY TYPE, exactly as the chat routes a file it opens (`ChatPane`'s
        // `handleOpenFile`): a board is drawn fullscreen, a picture opens in the lightbox,
        // a PDF gets the full-window viewer, and everything else (markdown, text, a clip)
        // opens in the slide-over. The slide-over alone was wrong for three of those — it
        // asks the text endpoint for a PDF's bytes and shows a board as raw JSON.
        // Paths arrive brain-relative; the chat's viewers read project-relative ones, and
        // the vault route (`graphContentUrl`) reads brain-relative bytes off-desktop too.
        const projectPath = `_dream_context/${openFile}`;
        const close = () => setOpenFile(null);
        const kind = agentFileKind(openFile);
        if (kind === 'board') return <BoardFullscreen path={projectPath} onClose={close} />;
        // An `.svg` is a PICTURE, and it opens as one, exactly as Chat opens it: in the
        // lightbox, as an `<img>`, from the desktop file route (which serves it as an image
        // under a sandbox CSP, so a script inside it never runs). Never from the vault route,
        // which is generic and refuses script-bearing types. Off desktop it stays a card and
        // opens in the slide-over below, as any other document does.
        if (openFile.toLowerCase().endsWith('.svg') && desktop) {
          return (
            <Lightbox
              src={agentFileUrl(vault, projectPath, { raw: true })}
              caption={openFile.split('/').pop()}
              path={projectPath}
              onClose={close}
            />
          );
        }
        if (kind === 'image') {
          return (
            <Lightbox
              src={graphContentUrl(vault, openFile, { raw: true })}
              caption={openFile.split('/').pop()}
              path={projectPath}
              onClose={close}
            />
          );
        }
        if (kind === 'pdf') {
          return (
            <PdfViewer
              path={projectPath}
              src={graphContentUrl(vault, openFile, { raw: true })}
              label={openFile.split('/').pop()}
              onClose={close}
            />
          );
        }
        return (
          <SlideOver
            mode="file"
            path={projectPath}
            // Classified on the PROJECT path: the task/knowledge/board matchers all key off
            // the `_dream_context/` prefix, so the bare brain path matched none of them.
            reference={classifyReference(projectPath)}
            onClose={close}
            onNavApp={close}
            onOpenPath={(p) => setOpenFile(p.replace(/^_dream_context\//, ''))}
          />
        );
      })()}
      {toast && <div className="agents-toast" role="status">{toast}</div>}
    </div>
  );
}
