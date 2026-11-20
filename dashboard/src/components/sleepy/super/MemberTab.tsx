import { useState, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useAgent } from '../../../hooks/useAgents';
import { useVaultId } from '../../../context/VaultContext';
import { AgentAvatar } from '../../agents/AgentAvatar';
import { MemberCardBody, useMemberRoutines } from './MemberCardBody';
import { GlobeIcon, teamStatusOf, teamTileFacts, type TeamCard } from './TeamTile';
import { openMemberApproval } from './superApprovals';
import './MemberTab.css';

/**
 * A member's tab in the presentation window (plan super-v3 Ü2, frame T2-sonra): who it is (face,
 * name, field, its team or All projects, the model), a switch Chat / Routines / Approvals, and
 * under it the member's ONE conversation drawn by the same chat component as every chat (learned
 * rule h7tjatns3j). Never the AI Team page, never another window. Approvals opens the existing
 * witnessed approval card; it approves nothing itself.
 */
export function MemberTab({ card, conversation }: { card: TeamCard; conversation: ReactNode }) {
  const { t } = useI18n();
  const slug = card.job.member;
  const agent = useAgent(slug).data?.agent;
  const name = agent?.title || slug;
  const global = agent?.scope === 'global';
  const vault = useVaultId().vault ?? '';
  const project = vault.split(/[\\/]/).filter(Boolean).pop() || '';
  const routines = useMemberRoutines(slug);
  const facts = teamTileFacts(card);
  const [view, setView] = useState<'chat' | 'routines'>('chat');
  const scope = global ? t('super.team.allProjects') : t('super.team.projectTeam').replace('{project}', project || t('super.team.thisProject'));
  // The field as its head word ("Strategy: prices, plans…" reads "Strategy"), so the scope shows.
  const field = (agent?.roleLine ?? '').split(/[:.\n]/)[0].trim();
  const meta = [field, scope, facts.model].filter(Boolean).join(' · ');
  const approvals = card.approval ? 1 : 0;
  return (
    <div className="super-member-tab" data-testid="super-member-tab" data-member={slug}>
      <div className="super-member-tab-head">
        <span className="super-member-tab-face">
          <AgentAvatar of="agent" slug={slug} title={name} hasPhoto={!!agent?.hasPhoto} size={40} />
          {global && <span className="super-team-globe" aria-hidden><GlobeIcon size={11} /></span>}
        </span>
        <span className="super-member-tab-names">
          <span className="super-member-tab-name" data-testid="super-member-tab-name">{name}</span>
          {meta && <span className="super-member-tab-meta">{meta}</span>}
        </span>
        <span className="super-member-tab-switch" role="tablist">
          <button type="button" role="tab" aria-selected={view === 'chat'} data-testid="super-member-tab-chat" onClick={() => setView('chat')}>
            {t('super.memberTab.chat')}
          </button>
          <button type="button" role="tab" aria-selected={view === 'routines'} data-testid="super-member-tab-routines" onClick={() => setView('routines')}>
            {t('super.memberTab.routines')}{routines.length > 0 && <i>{routines.length}</i>}
          </button>
          <button type="button" data-testid="super-member-tab-approvals" disabled={!approvals} data-waiting={approvals ? 'true' : undefined}
            onClick={() => openMemberApproval(slug)}>
            {t('super.memberTab.approvals')}{approvals > 0 && <i>{approvals}</i>}
          </button>
        </span>
      </div>
      <div className="super-member-tab-body">
        {view === 'chat'
          ? conversation
          : <MemberCardBody slug={slug} cardRef="routines" variant="full" enabled working={teamStatusOf(card) === 'running'} onDeleted={() => {}} />}
      </div>
    </div>
  );
}
