import { useCallback, useEffect, useMemo, useState } from 'react';
import { TeamRoster } from '../components/aiteam/TeamRoster';
import { TeamConversation } from '../components/aiteam/TeamConversation';
import { TeamPanel, type PanelTab } from '../components/aiteam/TeamPanel';
import { NewTeammate, TEAM_STARTERS, type TeamStarter } from '../components/aiteam/NewTeammate';
import { buildRoster, messagesOf, type TeamAgent } from '../components/aiteam/teamModel';
import { pageStorage, readRosterView, teamTreeOf, writeRosterView, type RosterView } from '../components/aiteam/teamTree';
import { chainOf } from '../../../src/lib/agents/tree.js';
import { AgentIdentityDialog } from '../components/agents/AgentIdentityDialog';
import { dropThreadScratch } from '../components/agents/agentsChannelHost';
import { agentFileKind } from '../components/agents/AgentMessage';
import { BrandMark } from '../components/brand/BrandMark';
import { SlideOver } from '../components/sleepy/chat/SlideOver';
import { Lightbox } from '../components/sleepy/chat/Lightbox';
import { PdfViewer } from '../components/sleepy/chat/PdfViewer';
import { BoardFullscreen } from '../components/sleepy/chat/BoardEmbed';
import { classifyReference } from '../components/sleepy/chat/chatEntities';
import { agentFileUrl, graphContentUrl } from '../api/client';
import { useVault } from '../context/VaultContext';
import { useI18n } from '../context/I18nContext';
import { useAgents } from '../hooks/useAgents';
import { useAgentFeed, useAutomationDispatcher, useAutomations } from '../hooks/useAutomations';
import { useAgentCapabilities } from '../hooks/useAgentCapabilities';
import { nextFireWords } from '../lib/agentDraft';
import type { AgentsFocus } from '../lib/openAgents';
import '../components/sleepy/chat/overlays.css';
import '../components/automations/AutomationsEmptyState.css';
import './AiTeamPage.css';

/** "Open this agent's thread": a landed `dreamcontext://…/automation/<slug>` link. */
export interface AutomationsFocus {
  slug: string;
  nonce: number;
}

/** Below this page width the list and the conversation take turns, and the panel overlays. */
const NARROW_BELOW = 760;
/** Below this the panel overlays the conversation instead of narrowing it. */
const PANEL_OVERLAY_BELOW = 1180;
const TOAST_MS = 4200;

/**
 * THE AI TEAM — the team on the left, one conversation per teammate in the middle, and who it
 * is and what it does on its own on the right (Profile · Routines · Files).
 *
 * It replaces the Automations and Agents pages: a teammate is an agent, its automations are
 * its routines, and the channel of runs became each teammate's own conversation. The route
 * key stays `automations` (persisted nav state); `agents` and the automation/agent deep links
 * land here with that teammate selected. No `<h1>` of the page's own beyond the list title.
 */
export function AiTeamPage({
  automationFocus = null,
  onAutomationFocusDone,
  agentsFocus = null,
  onAgentsFocusDone,
}: {
  automationFocus?: AutomationsFocus | null;
  onAutomationFocusDone?: () => void;
  agentsFocus?: AgentsFocus | null;
  onAgentsFocusDone?: () => void;
} = {}) {
  const { t } = useI18n();
  const { vault } = useVault();
  const desktop = useAgentCapabilities().data?.desktop === true;
  const agentsQ = useAgents();
  const automationsQ = useAutomations();
  const { data: feed } = useAgentFeed();
  const { data: dispatcher } = useAutomationDispatcher();

  const agents: TeamAgent[] = useMemo(() => agentsQ.data ?? [], [agentsQ.data]);
  const automations = useMemo(() => automationsQ.data ?? [], [automationsQ.data]);
  const rows = useMemo(() => buildRoster(agents, automations, feed), [agents, automations, feed]);
  const tree = useMemo(() => teamTreeOf(rows, agentsQ.data ?? []), [rows, agentsQ.data]);
  const [rosterView, setRosterView] = useState<RosterView>(() => readRosterView(pageStorage()));
  const pickRosterView = useCallback((v: RosterView) => {
    setRosterView(v);
    writeRosterView(pageStorage(), v);
  }, []);

  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelTab | null>(null);
  const [creating, setCreating] = useState<{ start: TeamStarter; whiteboard?: string; title: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  /** A notification or link landed: which routine's newest message to bring into view. */
  const [landing, setLanding] = useState<{ slug: string; nonce: number } | null>(null);
  /** Phone width: which of the two halves is on screen. */
  const [mobileShow, setMobileShow] = useState<'list' | 'convo'>('list');

  // The whole page's width decides the layout (the rail beside it already took its share).
  const [pageEl, setPageEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(1440);
  useEffect(() => {
    if (!pageEl || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(pageEl.getBoundingClientRect().width));
    ro.observe(pageEl);
    setWidth(pageEl.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, [pageEl]);
  const narrow = width < NARROW_BELOW;
  const panelOverlay = width < PANEL_OVERLAY_BELOW;

  // The first teammate is open when nothing else is asked for, so the page never opens blank.
  const current = rows.find((r) => r.slug === selected) ?? null;
  useEffect(() => {
    if (current || rows.length === 0) return;
    setSelected(rows[0].slug);
  }, [current, rows]);

  // A link or a caller asked for one teammate, the create flow, or its profile.
  useEffect(() => {
    if (!agentsFocus) return;
    if (agentsFocus.create) {
      setCreating({ start: 'blank', whiteboard: agentsFocus.whiteboard, title: '' });
      setMobileShow('convo');
    } else if (agentsFocus.slug) {
      setSelected(agentsFocus.slug);
      setCreating(null);
      setPanel('profile');
      setMobileShow('convo');
    }
    onAgentsFocusDone?.();
  }, [agentsFocus, onAgentsFocusDone]);
  useEffect(() => {
    if (!automationFocus || !automationsQ.data) return;
    const a = automations.find((x) => x.slug === automationFocus.slug);
    setSelected(a?.agent ?? automationFocus.slug);
    setLanding({ slug: automationFocus.slug, nonce: automationFocus.nonce });
    setCreating(null);
    setMobileShow('convo');
    onAutomationFocusDone?.();
  }, [automationFocus, automations, automationsQ.data, onAutomationFocusDone]);

  // The composer drafts and staged chips die with the PAGE, not with one conversation.
  useEffect(() => () => dropThreadScratch(), []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!openFile) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenFile(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openFile]);

  const select = useCallback((slug: string) => {
    setSelected(slug);
    setLanding(null);
    setCreating(null);
    setMobileShow('convo');
  }, []);
  const startNew = useCallback((start: TeamStarter = 'blank') => {
    setCreating({ start, title: '' });
    setPanel(null);
    setMobileShow('convo');
  }, []);
  const onDraftTitle = useCallback((title: string) => {
    setCreating((c) => (c && c.title !== title ? { ...c, title } : c));
  }, []);

  /** The scheduler's next fire across every routine, said under the list. */
  const nextRun = useMemo(() => {
    if (dispatcher && !dispatcher.installed) {
      return rows.some((r) => r.routines.length > 0) ? t('aiteam.next.wait') : t('aiteam.next.none');
    }
    let soonest: string | null = null;
    for (const a of automations) {
      if (a.runKind === 'agent' || a.mode !== 'sched' || !a.enabled || !a.nextFireAt) continue;
      if (!soonest || a.nextFireAt < soonest) soonest = a.nextFireAt;
    }
    const words = nextFireWords(soonest, new Date());
    return words ? t('aiteam.next.at').replace('{when}', words) : t('aiteam.next.none');
  }, [automations, dispatcher, rows, t]);

  const loading = agentsQ.isLoading || automationsQ.isLoading;
  const zero = !loading && rows.length === 0 && !creating;
  const agent = current ? agents.find((a) => a.slug === current.slug) ?? null : null;
  const messages = useMemo(
    () => (current ? messagesOf(current.slug, automations, feed?.messages ?? []) : []),
    [current, automations, feed],
  );
  /** Who the open teammate reports through, top first. */
  const managers = useMemo(() => {
    if (!current) return [];
    return chainOf(tree, current.slug).slice(0, -1).map((slug) => ({
      slug,
      title: rows.find((r) => r.slug === slug)?.title ?? slug,
    }));
  }, [current, tree, rows]);

  const showList = !narrow || mobileShow === 'list';
  const showMain = !narrow || mobileShow === 'convo';
  const panelShown = !!(panel && current && agent && !creating && showMain);

  const panelEl = panelShown && current && agent ? (
    <TeamPanel
      slug={current.slug}
      title={agent.title}
      tab={panel as PanelTab}
      onTab={setPanel}
      onClose={() => setPanel(null)}
      routines={current.routines}
      messages={messages}
      onEdit={setEditing}
      onDeleted={() => { setPanel(null); setSelected(null); }}
      onOpenFile={setOpenFile}
      onToast={setToast}
      onSelectAgent={select}
    />
  ) : null;

  return (
    <div
      ref={setPageEl}
      className={`aiteam${panelShown && !panelOverlay ? ' aiteam--panel' : ''}${narrow ? ' aiteam--narrow' : ''}`}
      data-aiteam-view={narrow ? mobileShow : 'split'}
    >
      {showList && (
        <TeamRoster
          rows={rows}
          selected={current?.slug ?? null}
          draft={creating ? { title: creating.title } : null}
          onSelect={select}
          onNew={() => startNew()}
          onToast={setToast}
          nextRun={nextRun}
          tree={tree}
          view={rosterView}
          onView={pickRosterView}
        />
      )}

      {showMain && (
        creating ? (
          <NewTeammate
            key={`${creating.start}:${creating.whiteboard ?? ''}`}
            start={creating.start}
            whiteboard={creating.whiteboard}
            onDraftTitle={onDraftTitle}
            onCancel={() => { setCreating(null); setMobileShow('list'); }}
            onCreated={(slug, message) => {
              setCreating(null);
              setSelected(slug);
              setToast(message);
            }}
          />
        ) : zero ? (
          <section className="aiteam-convo">
            <div className="aiteam-zero">
              <div className="auto-intro">
                <div className="auto-intro-mark"><BrandMark size={40} glow /></div>
                <h2 className="auto-intro-title">{t('aiteam.zero.title.a')} <span>{t('aiteam.zero.title.b')}</span>.</h2>
                <p className="auto-intro-lead">{t('aiteam.zero.lead')}</p>
                <p className="auto-intro-starters-label">{t('agents.empty.starters')}</p>
                <div className="auto-intro-starters">
                  {TEAM_STARTERS.map((s) => (
                    <button key={s} type="button" className="auto-intro-starter" onClick={() => startNew(s)}>
                      <span className="auto-intro-starter-title">{t(`agents.starter.${s}.title`)}</span>
                      <span className="auto-intro-starter-sub">{t(`agents.starter.${s}.sub`)}</span>
                    </button>
                  ))}
                </div>
                <button type="button" className="auto-intro-new-btn" onClick={() => startNew()}>{t('agents.empty.blank')}</button>
                <p className="auto-intro-safety">{t('aiteam.zero.safety')}</p>
              </div>
            </div>
          </section>
        ) : current && agent ? (
          <TeamConversation
            key={current.slug}
            row={current}
            agent={agent}
            messages={messages}
            panelOpen={panelShown}
            onTogglePanel={() => setPanel((p) => (p ? null : 'profile'))}
            onOpenRoutines={() => setPanel((p) => (p === 'routines' ? null : 'routines'))}
            focus={landing}
            onFocusDone={() => setLanding(null)}
            onOpenFile={setOpenFile}
            onToast={setToast}
            onBack={narrow ? () => setMobileShow('list') : undefined}
            managers={managers}
            onSelectAgent={select}
          />
        ) : (
          <section className="aiteam-convo">
            <p className="aiteam-roster-empty">{loading ? t('agents.page.loading') : agentsQ.error ? t('agents.page.loadFailed') : ''}</p>
          </section>
        )
      )}

      {panelEl && (panelOverlay
        ? <div className="aiteam-panel-scrim" onClick={(e) => { if (e.target === e.currentTarget) setPanel(null); }}>{panelEl}</div>
        : panelEl)}

      {editing && (
        <AgentIdentityDialog
          slug={editing}
          onClose={() => setEditing(null)}
          onSaved={(_slug, message) => { setEditing(null); setToast(message); }}
        />
      )}

      {openFile && (() => {
        // Routed by type, exactly as Chat routes a file it opens; paths arrive brain-relative.
        const projectPath = `_dream_context/${openFile}`;
        const close = () => setOpenFile(null);
        const kind = agentFileKind(openFile);
        if (kind === 'board') return <BoardFullscreen path={projectPath} onClose={close} />;
        if (openFile.toLowerCase().endsWith('.svg') && desktop) {
          return <Lightbox src={agentFileUrl(vault, projectPath, { raw: true })} caption={openFile.split('/').pop()} path={projectPath} onClose={close} />;
        }
        if (kind === 'image') {
          return <Lightbox src={graphContentUrl(vault, openFile, { raw: true })} caption={openFile.split('/').pop()} path={projectPath} onClose={close} />;
        }
        if (kind === 'pdf') {
          return <PdfViewer path={projectPath} src={graphContentUrl(vault, openFile, { raw: true })} label={openFile.split('/').pop()} onClose={close} />;
        }
        return (
          <SlideOver
            mode="file"
            path={projectPath}
            reference={classifyReference(projectPath)}
            onClose={close}
            onNavApp={close}
            onOpenPath={(p) => setOpenFile(p.replace(/^_dream_context\//, ''))}
          />
        );
      })()}

      {toast && <div className="aiteam-toast" role="status" onClick={() => setToast(null)}>{toast}</div>}
    </div>
  );
}
