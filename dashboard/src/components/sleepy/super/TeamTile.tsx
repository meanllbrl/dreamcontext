import { useI18n } from '../../../context/I18nContext';
import { useAgent } from '../../../hooks/useAgents';
import type { SuperTeamJob, TeamJobStatus } from '../../../lib/superTypes';
import { AgentAvatar } from '../../agents/AgentAvatar';
import { teamStatusKind } from '../agentStatus';
import { StatusRing } from './AgentCard';
import { elapsedLabel, toneOfStatus } from './superHandover';
import { useSpinSlot } from './spinSlots';

/** A team card's job and what the server read from the member's thread for it (the view's
 *  `teamLive`; null before the first read). */
export interface TeamCard { job: SuperTeamJob; status: TeamJobStatus | null; lastLine: string; sessionId?: string; resumable?: boolean }

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
 * A member's ONE card on the stage (plan-r10 1b): every job the Super Agent gave that member
 * (`super team ask`, the same conversation continued) is on it. The member's face and name, the
 * status ring and word in the same tones as a chat tile ("sırada" while the newest job waits its
 * turn), "N iş", and the last line the member wrote (the newest job's brief until it wrote one),
 * with the model the newest job runs on. A click shows the card side by side with the member's
 * conversation in it (SuperContainer).
 */
export function TeamTile({ card }: { card: TeamCard }) {
  const { t } = useI18n();
  const agent = useAgent(card.job.member).data?.agent;
  const name = agent?.title || card.job.member;
  const status = teamStatusOf(card);
  const kind = teamRingKind(status);
  const working = status === 'running';
  const spin = useSpinSlot(card.job.id, working);
  const facts = teamTileFacts(card);
  const line = card.lastLine || facts.brief;
  const runsOn = [facts.light ? t('super.team.light') : '', facts.model, facts.effort].filter(Boolean).join(' · ');
  return (
    <div className="super-tile" data-tile="team" data-kind={kind} data-super-tone={toneOfStatus(kind)} data-team-status={status} data-testid="super-team-tile" title={name}>
      <span className="super-tile-corners" aria-hidden />
      {working && <span className="super-tile-spin" data-spin={spin ? 'on' : 'closed'} aria-hidden />}
      <div className="super-tile-top">
        <StatusRing kind={kind} />
        <span className="super-tile-kind">{t('super.tile.kind.team')}</span>
      </div>
      <div className="super-team-who">
        <AgentAvatar of="agent" slug={card.job.member} title={name} hasPhoto={!!agent?.hasPhoto} size={24} />
        <span className="super-tile-title" data-testid="super-team-took">{t('super.team.took').replace('{name}', name)}</span>
      </div>
      <div className="super-tile-line" data-testid="super-team-line">{line}</div>
      {runsOn && <div className="super-tile-runs-on" data-testid="super-team-runs-on" title={runsOn}>{runsOn}</div>}
      <div className="super-tile-foot">
        <span className="super-tile-state" data-testid="super-team-state">{status === 'queued' ? t('superStage.team.queued') : t(`super.team.state.${status}`)}</span>
        <span data-testid="super-team-jobs">· {t('superStage.team.jobs').replace('{n}', String(facts.jobs))}</span>
        <span>· {elapsedLabel(Date.now() - (card.job.chain?.newest.startedAt ?? card.job.startedAt))}</span>
      </div>
    </div>
  );
}
