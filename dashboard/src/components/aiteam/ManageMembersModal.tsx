import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TeamSyncStrip } from './TeamSyncStrip';
import { TeamPanel, type PanelTab } from './TeamPanel';
import { NewTeammate, type TeamStarter } from './NewTeammate';
import { TeamApproval } from './TeamApproval';
import { TeamAmendments } from './TeamAmendments';
import { OrgView } from './OrgChart';
import { TeamIcon } from './TeamIcons';
import { buildRoster, messagesOf, pendingApprovals, type TeamAgent } from './teamModel';
import { teamTreeOf } from './teamTree';
import { AgentAvatar } from '../agents/AgentAvatar';
import { AgentIdentityDialog } from '../agents/AgentIdentityDialog';
import { BrainFileViewer } from '../agents/BrainFileViewer';
import { useVault } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { useAgents } from '../../hooks/useAgents';
import { useAgentFeed, useAutomations } from '../../hooks/useAutomations';
import { requestOpenAgents, type ManageMembersDetail } from '../../lib/openAgents';
import '../../pages/AiTeamPage.css';
import { focusablesIn, trapTab } from './focusTrap';
import './ManageMembersModal.css';

const TOAST_MS = 4200;

/**
 * "Üyeleri yönet" (plan-r10 1d, r8-09): where members are created and edited, desktop only.
 * It hosts what the AI Team page had beside its conversation: the profile, routines, files and
 * team tabs (`TeamPanel`), the org chart (`OrgView`), a new member (`NewTeammate`), the member's
 * ONE approval card (`TeamApproval`), its proposed amendments (`TeamAmendments`) and the team's
 * sync strip (`TeamSyncStrip`). Members of all projects are edited here too.
 *
 * NO chat pane: a member is talked to on its stage, and "Sohbeti aç" goes there
 * (`requestOpenAgents({ slug })`).
 */
export function ManageMembersModal({ focus, onClose }: {
  /** What it was opened on: a member's profile, the create flow (on a board), or the list. */
  focus: ManageMembersDetail & { nonce: number };
  onClose(): void;
}) {
  const { t } = useI18n();
  const { vault } = useVault();
  const agentsQ = useAgents();
  const automationsQ = useAutomations();
  const { data: feed } = useAgentFeed();
  const agents: TeamAgent[] = useMemo(() => agentsQ.data ?? [], [agentsQ.data]);
  const automations = useMemo(() => automationsQ.data ?? [], [automationsQ.data]);
  const rows = useMemo(() => buildRoster(agents, automations, feed), [agents, automations, feed]);
  const tree = useMemo(() => teamTreeOf(rows, agentsQ.data ?? []), [rows, agentsQ.data]);
  // The chart: this project's tree, the members of all projects in their own band.
  const band = useMemo(() => rows.filter((r) => r.global).map((r) => r.slug), [rows]);
  const chartTree = useMemo(() => {
    const inBand = new Set(band);
    return teamTreeOf(rows.filter((r) => !inBand.has(r.slug)), (agentsQ.data ?? []).filter((a) => !inBand.has(a.slug)));
  }, [rows, band, agentsQ.data]);

  const [selected, setSelected] = useState<string | null>(focus.slug ?? null);
  const [tab, setTab] = useState<PanelTab>('profile');
  const [org, setOrg] = useState(false);
  const [creating, setCreating] = useState<{ start: TeamStarter; whiteboard?: string } | null>(
    focus.create ? { start: 'blank', ...(focus.whiteboard ? { whiteboard: focus.whiteboard } : {}) } : null,
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // A new request on the open modal (another member's Profile button) moves it there.
  const seen = useRef(focus.nonce);
  useEffect(() => {
    if (focus.nonce === seen.current) return;
    seen.current = focus.nonce;
    if (focus.create) setCreating({ start: 'blank', ...(focus.whiteboard ? { whiteboard: focus.whiteboard } : {}) });
    else if (focus.slug) { setSelected(focus.slug); setCreating(null); setOrg(false); setTab('profile'); }
  }, [focus]);

  // Never blank: the first member is open when nothing else is asked for.
  const current = rows.find((r) => r.slug === selected) ?? null;
  useEffect(() => {
    if (!current && rows.length > 0 && !creating) setSelected(rows[0].slug);
  }, [current, rows, creating]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  // Focus (a real modal): the first control takes focus on open, Tab stays inside, and focus goes
  // back to whatever opened it when it closes.
  const modalRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusablesIn(modalRef.current)[0]?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);

  // Esc closes the innermost thing first: a file, then the modal. Only its OWN: an Esc another
  // layer already took (an identity dialog inside, a menu) is left alone, and the one it takes
  // reaches nobody else (the chat surface below must not close too).
  useEffect(() => {
    if (editing) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') { trapTab(e, modalRef.current); return; }
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (openFile) setOpenFile(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [editing, openFile, onClose]);

  const select = useCallback((slug: string) => { setSelected(slug); setCreating(null); setOrg(false); }, []);
  /** "Sohbeti aç": the member's stage, its one conversation. The modal closes first. */
  const openChat = useCallback((slug: string) => { onClose(); requestOpenAgents({ slug }); }, [onClose]);

  const agent = current ? agents.find((a) => a.slug === current.slug) ?? null : null;
  const messages = useMemo(() => (current ? messagesOf(current.slug, automations, feed?.messages ?? []) : []), [current, automations, feed]);
  const pending = useMemo(() => (agent && current ? pendingApprovals(agent, current.routines) : []), [agent, current]);
  const readOnly = agent?.readOnly === true;

  return (
    <div className="mm-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={modalRef} className="mm-modal" role="dialog" aria-modal="true" aria-label={t('drawer.team.manage')} data-testid="manage-members-modal">
        <aside className="mm-list" aria-label={t('drawer.team.manage')}>
          <div className="mm-list-head">{`${t('drawer.team.manage')} · ${rows.length}`}</div>
          <TeamSyncStrip onToast={setToast} />
          <ul className="mm-members">
            {rows.map((r) => (
              <li key={r.slug}>
                <button type="button" className={`mm-member${r.slug === current?.slug && !creating && !org ? ' is-sel' : ''}`}
                  data-testid="manage-members-member" data-slug={r.slug} onClick={() => select(r.slug)}>
                  <AgentAvatar of="agent" slug={r.slug} title={r.title} hasPhoto={r.hasPhoto} size={24} />
                  <span className="mm-member-name">{r.title}</span>
                  {r.global && <span className="mm-tag">{t('drawer.team.globalAll')}</span>}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="mm-new" data-testid="manage-members-new" onClick={() => { setCreating({ start: 'blank' }); setOrg(false); }}>
            <TeamIcon name="plus" size={12} /> {t('aiteam.new')}
          </button>
        </aside>

        <section className="mm-main">
          <header className="mm-head">
            {current && agent && !creating && !org && (
              <>
                <AgentAvatar of="agent" slug={current.slug} title={current.title} hasPhoto={current.hasPhoto} size={40} />
                <div className="mm-head-id">
                  <span className="mm-head-name">{current.title}</span>
                  <span className="mm-head-role">{[current.role, vault].filter(Boolean).join(' · ')}</span>
                </div>
              </>
            )}
            <span className="mm-spacer" />
            {rows.length > 0 && (
              <button type="button" className="mm-btn" aria-pressed={org} data-testid="manage-members-org" onClick={() => { setOrg((o) => !o); setCreating(null); }}>
                {org ? t('aiteam.page.conversations') : t('aiteam.page.org')}
              </button>
            )}
            <button type="button" className="mm-close" aria-label={t('common.close')} onClick={onClose}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
            </button>
          </header>

          <div className="mm-body">
            {creating ? (
              <NewTeammate
                key={`${creating.start}:${creating.whiteboard ?? ''}`}
                start={creating.start}
                whiteboard={creating.whiteboard}
                onDraftTitle={() => { /* the list shows members, not drafts */ }}
                onCancel={() => setCreating(null)}
                onCreated={(slug, message) => { setCreating(null); setSelected(slug); setToast(message); }}
              />
            ) : org ? (
              <OrgView
                headless
                tree={chartTree}
                rows={rows}
                band={band}
                selected={current?.slug ?? null}
                onSelect={select}
                onTalk={openChat}
                onConversations={() => setOrg(false)}
                onNew={() => setCreating({ start: 'blank' })}
                onToast={setToast}
                nextRun=""
              />
            ) : current && agent ? (
              <>
                {!readOnly && <TeamApproval agentTitle={agent.title} pending={pending} onToast={setToast} />}
                {!readOnly && <TeamAmendments slug={agent.slug} onToast={setToast} />}
                <TeamPanel
                  slug={current.slug}
                  title={agent.title}
                  tab={tab}
                  onTab={setTab}
                  onClose={onClose}
                  routines={current.routines}
                  messages={messages}
                  onEdit={setEditing}
                  onDeleted={() => { setSelected(null); setTab('profile'); }}
                  onOpenFile={setOpenFile}
                  onToast={setToast}
                  onSelectAgent={select}
                  team={{ rows, tree, onTalk: openChat }}
                />
              </>
            ) : (
              <p className="mm-empty">{agentsQ.isLoading ? t('agents.page.loading') : agentsQ.error ? t('agents.page.loadFailed') : ''}</p>
            )}
          </div>

          {current && !creating && !org && (
            <footer className="mm-foot">
              <button type="button" className="mm-btn" data-testid="manage-members-open-chat" onClick={() => openChat(current.slug)}>
                {t('aiteam.manage.openChat')}
              </button>
            </footer>
          )}
        </section>

        {editing && (
          <AgentIdentityDialog
            slug={editing}
            onClose={() => setEditing(null)}
            onSaved={(_slug, message) => { setEditing(null); setToast(message); }}
          />
        )}
        {openFile && <BrainFileViewer path={openFile} onClose={() => setOpenFile(null)} onOpenPath={setOpenFile} />}
        {toast && <div className="aiteam-toast" role="status" onClick={() => setToast(null)}>{toast}</div>}
      </div>
    </div>
  );
}
