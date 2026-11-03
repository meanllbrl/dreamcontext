import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TeamConversation } from '../components/aiteam/TeamConversation';
import { OpenInMainApp, sayFromApp, useEmbed } from '../components/embed/embedMode';
import { buildRoster, messagesOf, type TeamAgent } from '../components/aiteam/teamModel';
import { listedRows } from '../components/aiteam/teamTree';
import { AgentAvatar } from '../components/agents/AgentAvatar';
import { BrainFileViewer } from '../components/agents/BrainFileViewer';
import { dropThreadScratch } from '../components/agents/agentsChannelHost';
import { useI18n } from '../context/I18nContext';
import { useIsNewShell } from '../lib/uxMode';
import { PageBar } from '../components/layout/PageBar';
import { useAgents } from '../hooks/useAgents';
import { useAgentFeed, useAutomations } from '../hooks/useAutomations';
import { automationLinkRoute, requestManageMembers, requestOpenAgents, type AgentsFocus } from '../lib/openAgents';
import '../components/sleepy/chat/overlays.css';
import './AiTeamPage.css';
import '../components/aiteam/TeamEmbed.css';

/** "Open this agent's thread": a landed `dreamcontext://…/automation/<slug>` link. */
export interface AutomationsFocus {
  slug: string;
  nonce: number;
}

const TOAST_MS = 4200;

/**
 * THE AI TEAM PAGE IS GONE (plan-r10 1d, `uv773y`): a member is opened from its project's Ekip
 * row, talked to on its stage, and created or edited in "Üyeleri yönet". The `agents` (and old
 * `automations`) page ids stay only as DEEP-LINK ALIASES: `page/agents/<slug>`, an automation
 * link, the command palette's agent hit all land here, and this opens "Üyeleri yönet" on that
 * member (`requestManageMembers`). Nothing of the old page (roster, stage, Activity feed,
 * conversation) is drawn.
 *
 * One exception, unchanged: an app's embedded team screen (`?embed=`, view `team`) still reads
 * a member's conversation through `TeamConversation` and speaks as its app (AC23).
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
  const embed = useEmbed();
  // The composer drafts and staged chips die with the PAGE, not with one conversation.
  useEffect(() => () => dropThreadScratch(), []);
  if (embed) return <EmbeddedTeam automationFocus={automationFocus} onAutomationFocusDone={onAutomationFocusDone} />;
  return (
    <ManageAlias
      automationFocus={automationFocus}
      onAutomationFocusDone={onAutomationFocusDone}
      agentsFocus={agentsFocus}
      onAgentsFocusDone={onAgentsFocusDone}
    />
  );
}

/** The alias: every arrival opens "Üyeleri yönet" on what it asked for, except a member's
 *  routine link, which opens that member's stage. */
function ManageAlias({ automationFocus, onAutomationFocusDone, agentsFocus, onAgentsFocusDone }: {
  automationFocus: AutomationsFocus | null;
  onAutomationFocusDone?: () => void;
  agentsFocus: AgentsFocus | null;
  onAgentsFocusDone?: () => void;
}) {
  const { t } = useI18n();
  const newShell = useIsNewShell();
  const automationsQ = useAutomations();
  const agentsQ = useAgents();

  // A bare arrival (the page id itself, an old bookmark) opens the modal on the list.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || agentsFocus || automationFocus) return;
    opened.current = true;
    requestManageMembers();
  }, [agentsFocus, automationFocus]);
  useEffect(() => {
    if (!agentsFocus) return;
    opened.current = true;
    requestManageMembers({
      ...(agentsFocus.slug ? { slug: agentsFocus.slug } : {}),
      ...(agentsFocus.create ? { create: true } : {}),
      ...(agentsFocus.create && agentsFocus.whiteboard ? { whiteboard: agentsFocus.whiteboard } : {}),
    });
    onAgentsFocusDone?.();
  }, [agentsFocus, onAgentsFocusDone]);
  // An automation link (the "needs your answer" banner, `automation/<slug>`): a member's routine
  // opens THAT member's stage, where its open routine questions are answered; a routine of no
  // member keeps "Üyeleri yönet".
  useEffect(() => {
    if (!automationFocus || !automationsQ.data || !agentsQ.data) return;
    opened.current = true;
    const route = automationLinkRoute(automationFocus.slug, automationsQ.data, agentsQ.data);
    if (route.to === 'member') requestOpenAgents({ slug: route.slug });
    else requestManageMembers({ slug: route.slug });
    onAutomationFocusDone?.();
  }, [automationFocus, automationsQ.data, agentsQ.data, onAutomationFocusDone]);

  const page = (
    <div className="aiteam aiteam--alias">
      <section className="aiteam-convo">
        <div className="aiteam-zero">
          <button type="button" className="auto-intro-new-btn" data-testid="aiteam-open-manage" onClick={() => requestManageMembers()}>
            {t('drawer.team.manage')}
          </button>
        </div>
      </section>
    </div>
  );
  if (!newShell) return page;
  return (
    <div className="aiteam-ns">
      <PageBar title={t('drawer.team.manage')} />
      {page}
    </div>
  );
}

/** An app's embedded team screen: its members, and one member's conversation, as before. */
function EmbeddedTeam({ automationFocus, onAutomationFocusDone }: {
  automationFocus: AutomationsFocus | null;
  onAutomationFocusDone?: () => void;
}) {
  const { t } = useI18n();
  const embed = useEmbed()!;
  const embedChat = embed.view === 'chat';
  const agentsQ = useAgents();
  const automationsQ = useAutomations();
  const { data: feed } = useAgentFeed();
  const agents: TeamAgent[] = useMemo(() => agentsQ.data ?? [], [agentsQ.data]);
  const automations = useMemo(() => automationsQ.data ?? [], [automationsQ.data]);
  const rows = useMemo(() => buildRoster(agents, automations, feed), [agents, automations, feed]);
  const listRows = useMemo(() => listedRows(rows), [rows]);
  const [selected, setSelected] = useState<string | null>(embed.member ?? null);
  const selectedRef = useRef<string | null>(selected);
  selectedRef.current = selected;
  const [landing, setLanding] = useState<{ slug: string; nonce: number; runId?: string | null } | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // An embedded screen speaks as its app, and its chat shows that app's own runs.
  const embedSend = useCallback((text: string) => sayFromApp(embed, selectedRef.current ?? '', text), [embed]);
  const embedRuns = useCallback((m: { ask: { app?: string } | null }) => m.ask?.app === embed.slug, [embed.slug]);

  const current = rows.find((r) => r.slug === selected) ?? null;
  useEffect(() => {
    if (current || rows.length === 0) return;
    setSelected((listRows[0] ?? rows[0]).slug);
  }, [current, rows, listRows]);
  useEffect(() => {
    if (!automationFocus || !automationsQ.data) return;
    const a = automations.find((x) => x.slug === automationFocus.slug);
    setSelected(a?.agent ?? automationFocus.slug);
    setLanding({ slug: automationFocus.slug, nonce: automationFocus.nonce });
    onAutomationFocusDone?.();
  }, [automationFocus, automations, automationsQ.data, onAutomationFocusDone]);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const agent = current ? agents.find((a) => a.slug === current.slug) ?? null : null;
  const messages = useMemo(() => (current ? messagesOf(current.slug, automations, feed?.messages ?? []) : []), [current, automations, feed]);
  const loading = agentsQ.isLoading || automationsQ.isLoading;
  const zero = !loading && rows.length === 0;

  return (
    <div className="aiteam" data-aiteam-view="split">
      {!embedChat && listRows.length > 0 && (
        <aside className="aiteam-roster" aria-label={t('nav.aiTeam')}>
          <ul className="aiteam-embed-list">
            {listRows.map((r) => (
              <li key={r.slug}>
                <button type="button" className={`aiteam-embed-member${r.slug === current?.slug ? ' is-sel' : ''}`}
                  aria-current={r.slug === current?.slug ? 'true' : undefined}
                  onClick={() => { setSelected(r.slug); setLanding(null); }}>
                  <AgentAvatar of="agent" slug={r.slug} title={r.title} hasPhoto={r.hasPhoto} size={24} />
                  <span>{r.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
      )}
      {zero ? (
        <section className="aiteam-convo"><OpenInMainApp grant={embed} page="agents" /></section>
      ) : current && agent ? (
        // ONLY an app's embedded chat: a member is talked to on its stage in the main app.
        <TeamConversation
          key={current.slug}
          row={current}
          agent={agent}
          messages={messages}
          panelOpen={false}
          onTogglePanel={() => { /* no panel in an embedded screen */ }}
          onOpenRoutines={() => { /* no panel in an embedded screen */ }}
          focus={landing}
          onFocusDone={() => setLanding(null)}
          onOpenFile={setOpenFile}
          onToast={setToast}
          managers={[]}
          onSelectAgent={(slug) => setSelected(slug)}
          sendMessage={embedSend}
          runFilter={embedChat ? embedRuns : undefined}
        />
      ) : (
        <section className="aiteam-convo">
          <p className="aiteam-roster-empty">{loading ? t('agents.page.loading') : agentsQ.error ? t('agents.page.loadFailed') : ''}</p>
        </section>
      )}
      {openFile && <BrainFileViewer path={openFile} onClose={() => setOpenFile(null)} onOpenPath={setOpenFile} />}
      {toast && <div className="aiteam-toast" role="status" onClick={() => setToast(null)}>{toast}</div>}
    </div>
  );
}
