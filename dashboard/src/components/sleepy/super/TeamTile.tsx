import { useI18n } from '../../../context/I18nContext';
import { useAgent } from '../../../hooks/useAgents';
import type { SuperTeamJob, TeamJobStatus } from '../../../lib/superTypes';
import { AgentAvatar } from '../../agents/AgentAvatar';
import type { SessionStatusKind } from '../agentStatus';
import { StatusRing } from './AgentCard';
import { elapsedLabel, toneOfStatus } from './superHandover';
import { useSpinSlot } from './spinSlots';

/** A team card's job and what the server read from the member's thread for it (the view's
 *  `teamLive`; null before the first read). */
export interface TeamCard { job: SuperTeamJob; status: TeamJobStatus | null; lastLine: string }

/** A team job's status in the ONE status language every card speaks (superTone.css): waiting in
 *  the member's queue reads as starting, running as working, a question to the owner as asking,
 *  done as idle, failed as ended. */
export function teamRingKind(status: TeamJobStatus): SessionStatusKind {
  if (status === 'running') return 'working';
  if (status === 'asking') return 'asking';
  if (status === 'queued') return 'starting';
  if (status === 'failed') return 'ended';
  return 'ready';
}

/** The status the card shows: the server's read, else what the job was when it was given. */
export function teamStatusOf(card: TeamCard): TeamJobStatus {
  return card.status ?? (card.job.queued ? 'queued' : 'running');
}

/**
 * A job the Super Agent gave an AI Team member (`super team ask`), as a stage tile: the member's
 * face and name ("Doctor took the job"), the status ring and word in the same tones as a chat
 * tile, and the last line the member wrote for this job (its brief until it wrote one). The card
 * frame opens the member in AI Team on a click (SuperContainer).
 */
export function TeamTile({ card }: { card: TeamCard }) {
  const { t } = useI18n();
  const agent = useAgent(card.job.member).data?.agent;
  const name = agent?.title || card.job.member;
  const status = teamStatusOf(card);
  const kind = teamRingKind(status);
  const working = status === 'running';
  const spin = useSpinSlot(card.job.id, working);
  const line = card.lastLine || card.job.brief;
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
      <div className="super-tile-foot">
        <span className="super-tile-state" data-testid="super-team-state">{t(`super.team.state.${status}`)}</span>
        <span>· {elapsedLabel(Date.now() - card.job.startedAt)}</span>
      </div>
    </div>
  );
}
