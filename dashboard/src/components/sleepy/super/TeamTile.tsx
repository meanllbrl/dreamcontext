import { useI18n } from '../../../context/I18nContext';
import { useAgent } from '../../../hooks/useAgents';
import type { SuperQueueItem, SuperTeamJob, TeamJobStatus } from '../../../lib/superTypes';
import { openMemberApproval } from './superApprovals';
import { AgentAvatar } from '../../agents/AgentAvatar';
import { teamStatusKind } from '../agentStatus';
import { elapsedLabel, toneOfStatus } from './superHandover';
import { useSpinSlot } from './spinSlots';
import { useVaultId } from '../../../context/VaultContext';
import { useMemberHelpers, useMemberSuperRecord } from './useMemberRecord';

/** A team card's job and what the server read from the member's thread for it (the view's
 *  `teamLive`; null before the first read). */
export interface TeamCard {
  job: SuperTeamJob; status: TeamJobStatus | null; lastLine: string; sessionId?: string; resumable?: boolean;
  /** The member's approval waiting on the owner (identity or run power, K6): the card turns pink. */
  approval?: SuperQueueItem;
}

/** "For <job>": the job the member serves, as one short headline of its brief (its first line,
 *  up to the first colon or full stop, cut at 40), and what it is doing now when it wrote more. */
export function teamForLine(card: Pick<TeamCard, 'job' | 'lastLine'>): { job: string; doing: string } {
  const brief = (card.job.chain?.newest.brief ?? card.job.brief ?? '').replace(/\s+/g, ' ').trim();
  const head = brief.split(/[:.\n]/)[0].trim();
  const job = head.length > 40 ? `${head.slice(0, 39).trimEnd()}…` : head;
  const last = (card.lastLine || '').replace(/\s+/g, ' ').trim();
  return { job, doing: last && last !== brief ? last : '' };
}

/** "1st job with you", "2nd", "3rd", "4th", "11th": English ordinals for the card's foot. */
export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`;
}

/** A team job's status in the ONE status language every card speaks (superTone.css). */
export const teamRingKind = teamStatusKind;

/** The status the card shows: the server's read, else what the job was when it was given. */
export function teamStatusOf(card: TeamCard): TeamJobStatus {
  return card.status ?? (card.job.queued ? 'queued' : 'running');
}

/** What a member's one card shows (plan-r10 1b): how many jobs it holds, and the newest job's brief
 *  and model (the root's own when the card holds one job). Pure. */
export function teamTileFacts(card: TeamCard): { jobs: number; brief: string; model?: string; effort?: string; light: boolean } {
  const chain = card.job.chain;
  const newest = chain?.newest ?? card.job;
  return {
    jobs: chain?.jobs ?? 1,
    brief: newest.brief,
    ...(newest.model ? { model: newest.model } : {}),
    ...(newest.effort ? { effort: newest.effort } : {}),
    light: newest.light === true,
  };
}

/**
 * A member's ONE card on the stage (plan-r10 1b, super-v3 Ü1/Ü4, frame T1-sonra): every job the
 * Super Agent gave that member (`super team ask`, the same conversation continued) is on it, led
 * by WHO it is: the member's face (an All-projects member's carries a globe), name and field, and
 * a scope chip ("<project> team" or "All projects"). Then "For <job>" with what it does now, a
 * walking light while it works (never a percent, D4), and at the foot the state, "Nth job with
 * you" and how long. A member approval waiting on the owner turns the card pink with the request
 * in words and an Approve that OPENS the existing witnessed approval card (it approves nothing
 * itself). A click shows the card side by side with the member's conversation (SuperContainer).
 */
export function TeamTile({ card }: { card: TeamCard }) {
  const { t } = useI18n();
  const agent = useAgent(card.job.member).data?.agent;
  const name = agent?.title || card.job.member;
  const field = agent?.roleLine || '';
  const global = agent?.scope === 'global';
  const status = teamStatusOf(card);
  const kind = card.approval ? 'asking' : teamRingKind(status);
  const working = status === 'running' && !card.approval;
  const spin = useSpinSlot(card.job.id, working);
  const facts = teamTileFacts(card);
  const forLine = teamForLine(card);
  // The helpers the member's Super runs for this card's requests (owner 2026-11-15): the chip a
  // child tile shows for its background work, with how many are live.
  // Read only while the member works on it: a finished card polls nothing for a chip it never shows.
  const vault = useVaultId().vault ?? '';
  const asked = !!card.job.request || !!card.job.chain?.requests?.length;
  const rec = useMemberSuperRecord(vault, card.job.member, asked && status !== 'done' && status !== 'failed', null);
  const liveHelpers = useMemberHelpers(rec.record, card).filter((h) => h.live).length;
  const runsOn = [facts.light ? t('super.team.light') : '', facts.model, facts.effort].filter(Boolean).join(' · ');
  const project = vault.split(/[\\/]/).filter(Boolean).pop() || '';
  return (
    <div className="super-tile" data-tile="team" data-kind={kind} data-super-tone={toneOfStatus(kind)} data-team-status={status}
      data-team-approval={card.approval ? 'waiting' : undefined} data-testid="super-team-tile" title={name}>
      <span className="super-tile-corners" aria-hidden />
      {working && <span className="super-tile-spin" data-spin={spin ? 'on' : 'closed'} aria-hidden />}
      <div className="super-team-who">
        <span className="super-team-face">
          <AgentAvatar of="agent" slug={card.job.member} title={name} hasPhoto={!!agent?.hasPhoto} size={34} />
          {global && <span className="super-team-globe" data-testid="super-team-globe" aria-hidden><GlobeIcon size={10} /></span>}
        </span>
        <span className="super-team-names">
          <span className="super-tile-title" data-testid="super-team-name">{name}</span>
          {field && <span className="super-team-field" data-testid="super-team-field">{field}</span>}
        </span>
        {liveHelpers > 0 && (
          <span className="super-tile-chip super-team-helpers-count" data-testid="super-team-helpers-count"
            title={t('superStage.team.helpersLive').replace('{n}', String(liveHelpers))} aria-label={t('superStage.team.helpersLive').replace('{n}', String(liveHelpers))}>
            ⧉ {liveHelpers}
          </span>
        )}
      </div>
      <div className="super-team-meta">
        <span className="super-team-scope" data-scope={global ? 'global' : 'project'} data-testid="super-team-scope">
          {global ? <><GlobeIcon size={11} />{t('super.team.allProjects')}</> : t('super.team.projectTeam').replace('{project}', project || t('super.team.thisProject'))}
        </span>
        <span className="super-team-nth" data-testid="super-team-jobs">{t('super.team.nthJob').replace('{ord}', ordinal(facts.jobs)).replace('{n}', String(facts.jobs))}</span>
      </div>
      {card.approval
        ? (
          <div className="super-team-ask" data-testid="super-team-approval">
            <div className="super-tile-line super-tile-askline">{t('super.team.wantsApproval').replace('{name}', name)}</div>
            <button type="button" className="super-card-show" data-testid="super-team-approve"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); openMemberApproval(card.job.member); }}>
              {t('super.team.approve')}
            </button>
          </div>
        )
        : (
          <div className="super-tile-line" data-testid="super-team-line">
            {forLine.job
              ? <>{t('super.team.for')} <b>{forLine.job}</b>{forLine.doing ? `: ${forLine.doing}` : ''}</>
              : forLine.doing}
          </div>
        )}
      {working && <div className="super-card-walk" aria-hidden><i /></div>}
      {runsOn && <div className="super-tile-runs-on" data-testid="super-team-runs-on" title={runsOn}>{runsOn}</div>}
      <div className="super-tile-foot">
        <span className="super-tile-state" data-testid="super-team-state">{status === 'queued' ? t('superStage.team.queued') : t(`super.team.state.${status}`)}</span>
        <span>· {elapsedLabel(Date.now() - (card.job.chain?.newest.startedAt ?? card.job.startedAt))}</span>
      </div>
    </div>
  );
}

function GlobeIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <circle cx="8" cy="8" r="6.2" /><path d="M1.8 8h12.4M8 1.8c1.8 1.9 2.6 3.9 2.6 6.2S9.8 12.3 8 14.2C6.2 12.3 5.4 10.3 5.4 8S6.2 3.7 8 1.8Z" />
    </svg>
  );
}
