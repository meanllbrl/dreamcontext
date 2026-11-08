import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { findAgent, useAgents, type AgentSummary } from '../../../hooks/useAgents';
import { useStatusModel, useTasks, type AgentJobDelivery } from '../../../hooks/useTasks';
import { jobChip, reviewRounds } from '../../../lib/taskAgentJob';
import { requestManageMembers } from '../../../lib/openAgents';
import { AgentAvatar } from '../../agents/AgentAvatar';
import { TeamApproval } from '../../aiteam/TeamApproval';
import { pendingApprovals } from '../../aiteam/teamModel';
import { JobChipView } from '../../tasks/JobChipView';
import type { MemberCardRef } from '../../../lib/superTypes';
import { memberTasks, stripRound, type MemberRefusal } from './memberStageModel';
import type { SuperRequestTurn } from './superHandover';
// TeamApproval's own styles (the AI Team page's sheet, as "Üyeleri yönet" loads it), then the band's.
import '../../../pages/AiTeamPage.css';
import './TaskStrip.css';

/** Everything the stage shows of the member whose Super it is (plan-r10 1, mockup r8-08). */
export interface MemberStageInfo {
  slug: string;
  /** The vault the stage is in (a global member's chip names it). */
  vault: string;
  /** The task strip on top (a task face's click, or a pick in "Görevleri"); null = none. */
  task: string | null;
  onTask: (slug: string | null) => void;
  onOpenTask: (slug: string) => void;
  /** Other open projects a GLOBAL member can be opened in (its chip); empty for a project member. */
  projects: readonly string[];
  onSwitchProject?: (vault: string) => void;
  /** The summary says it waits for its one approval card (plan-r10 1e). */
  approval: boolean;
  /** The summary says it is a global member (its project chip, plan-r10 1f). */
  global?: boolean;
  /** Why the open was refused (the stage says so instead of a chat), or null. */
  refusal: MemberRefusal | null;
  onRetry?: () => void;
  /** The strip itself, drawn by the stage (TaskStrip). */
  strip?: ReactNode;
  /** Its own cards' bodies (plan r4 K2), handed in by the Chat surface like the routine questions. */
  card?: (ref: MemberCardRef, variant: 'tile' | 'full') => ReactNode;
  /** Its routines' open questions (MemberRoutineQuestions), handed in by the Chat surface: the
   *  answer card is chat UI, which this pure stage module must not import (super-size.test.ts). */
  routineQuestions?: ReactNode;
}

/** The member's model as its chip says it: "Opus · medium". */
export function memberModelLabel(agent: Pick<AgentSummary, 'model' | 'effort'> | null | undefined, spawn: { model: string; effort: string }): string {
  const model = agent?.model || spawn.model;
  const effort = agent?.effort || spawn.effort;
  const name = model ? model.charAt(0).toUpperCase() + model.slice(1) : '';
  return [name, effort].filter(Boolean).join(' · ');
}

/**
 * The centre's head on a member's stage (mockup r8-08): its face, its name, "<job> · tek konuşma",
 * the model chip, a non-Claude member's note, the project chip of a global member, and "Profil"
 * (Üyeleri yönet on its profile). Main's head is unchanged (`SuperCentreHead`).
 */
export function MemberStageHead({ info, spawn }: { info: MemberStageInfo; spawn: { model: string; effort: string } }) {
  const { t } = useI18n();
  const { data: agents } = useAgents();
  const agent = findAgent(agents, info.slug);
  const name = agent?.title || info.slug;
  const job = agent?.roleLine || '';
  const tool = agent?.tool && agent.tool !== 'claude' ? agent.tool : null;
  // The manifest's scope, or the summary's word (a refused member's stage draws before its agent loads).
  const global = agent?.scope === 'global' || info.global === true;
  const toolName = tool === 'codex' ? 'Codex' : tool === 'antigravity' ? 'Antigravity' : '';
  return (
    <div className="super-member-head" data-testid="super-member-head" data-slug={info.slug}>
      <AgentAvatar of="agent" slug={info.slug} title={name} hasPhoto={!!agent?.hasPhoto} size={28} face={agent?.face} />
      <span className="super-member-name" data-testid="super-member-name">{name}</span>
      <span className="super-member-sub">{t('superStage.member.subtitle').replace('{job}', job || name)}</span>
      <span className="super-member-model" data-testid="super-member-model">{memberModelLabel(tool ? null : agent, spawn)}</span>
      {tool && <span className="super-member-note" data-testid="super-member-claude-only">{t('superStage.member.claudeOnly').replace('{tool}', toolName)}</span>}
      {global && (
        <label className="super-member-chip" data-testid="member-project-chip" title={t('superStage.member.projectChip')}>
          <select
            aria-label={t('superStage.member.projectChip')}
            value={info.vault}
            disabled={!info.onSwitchProject || info.projects.length === 0}
            onChange={(e) => { if (e.target.value !== info.vault) info.onSwitchProject?.(e.target.value); }}
          >
            {[info.vault, ...info.projects.filter((p) => p !== info.vault)].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      )}
      <button type="button" className="super-member-btn" data-testid="super-member-profile" onClick={() => requestManageMembers({ slug: info.slug })}>
        {t('superStage.member.profile')}
      </button>
    </div>
  );
}

/** The one approval card on the member's stage (plan-r10 1e): today's `TeamApproval`, as is. */
export function MemberApprovalBand({ slug }: { slug: string }) {
  const { data: agents } = useAgents();
  const agent = findAgent(agents, slug);
  const [toast, setToast] = useState('');
  useEffect(() => {
    if (!toast) return undefined;
    const id = window.setTimeout(() => setToast(''), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);
  const pending = useMemo(() => (agent ? pendingApprovals(agent, []) : []), [agent]);
  if (!agent || (pending.length === 0 && !toast)) return null;
  return (
    <div className="super-member-band" data-testid="member-approval-band">
      <TeamApproval agentTitle={agent.title || slug} pending={pending} onToast={setToast} />
      {toast && <p role="status" className="super-member-note">{toast}</p>}
    </div>
  );
}

/** What the stage says instead of a chat when the open was refused (an unapproved member also
 *  shows its approval band above this line). */
export function MemberRefusalLine({ slug, refusal, onRetry }: { slug: string; refusal: MemberRefusal; onRetry?: () => void }) {
  const { t } = useI18n();
  const { data: agents } = useAgents();
  const name = findAgent(agents, slug)?.title || slug;
  const key = refusal === 'not_owner' ? 'notOwner' : refusal;
  return (
    <p className="super-member-refusal" role="status" data-testid="member-refusal" data-refusal={refusal}>
      <span>{t(`superStage.member.${key}`).replace('{name}', name)}</span>
      {refusal === 'unreachable' && onRetry && (
        <button type="button" className="super-member-btn" onClick={onRetry}>{t('superStage.member.retry')}</button>
      )}
    </p>
  );
}

/**
 * The member agenda's "Görevleri" (plan-r10 1c): the tasks whose doer or reviewer it is, open
 * first, each with the job chip and its round; a click puts that task's strip on the stage.
 */
export function MemberAgendaTasks({ slug, selected, onPick }: { slug: string; selected: string | null; onPick: (task: string) => void }) {
  const { t } = useI18n();
  const { data: tasks } = useTasks();
  const statusModel = useStatusModel();
  const rows = useMemo(() => memberTasks(tasks ?? [], slug, (s) => statusModel.isTerminal(s)), [tasks, slug, statusModel]);
  return (
    <section className="member-agenda-tasks" data-testid="member-agenda-tasks" data-count={rows.length}>
      <h4 className="member-agenda-tasks-title">{t('superStage.member.tasks')}</h4>
      {rows.length === 0 && <p className="super-member-note">{t('superStage.task.none')}</p>}
      {rows.map(({ task, role, open }) => {
        const job = task.agent_job ?? null;
        const chip = open ? jobChip(job, t) : null;
        const round = stripRound(job);
        // The rounds a delivered task has had (its own changelog lines), when the list carries them.
        const deliveries = job && 'deliveries' in job && Array.isArray(job.deliveries) ? (job.deliveries as AgentJobDelivery[]) : null;
        const rounds = job && deliveries ? reviewRounds(job, deliveries, task.status_history ?? []).length : 0;
        return (
          <button
            key={task.slug}
            type="button"
            className="member-agenda-task"
            data-testid="member-agenda-task"
            data-task={task.slug}
            data-role={role}
            data-open={open ? 'true' : 'false'}
            aria-pressed={selected === task.slug}
            onClick={() => onPick(task.slug)}
          >
            <span className="member-agenda-task-name">{task.name}</span>
            <span className="member-agenda-task-sub">
              <span>{statusModel.labelOf(task.status)}</span>
              {round && <span>· {t('superStage.task.round').replace('{n}', String(round.n)).replace('{cap}', String(round.cap))}</span>}
              {!round && rounds > 0 && <span>· {t('superStage.task.round').replace('{n}', String(rounds)).replace('{cap}', String(job?.cap ?? rounds))}</span>}
              <span>· {t(`superStage.task.role.${role}`)}</span>
              {chip && <JobChipView chip={chip} />}
            </span>
          </button>
        );
      })}
    </section>
  );
}

/** Main Super's request (or its answer) on the member's stage: framed, its full text (plan-r10 1). */
export function SuperRequestBlock({ turn, itemId }: { turn: SuperRequestTurn; itemId: string }) {
  const { t } = useI18n();
  return (
    <div className="super-request-block" role="note" data-testid="super-request-block" data-item-id={itemId} data-kind={turn.kind} data-request={turn.itemId}>
      {/* A quote in the reply-strip language (plan r4 E2): accent bar, "Super Agent'tan", the text. */}
      <div className="super-request-block-head">
        <span className="super-request-block-mark" aria-hidden>◆</span>
        <span>{t('superStage.member.fromSuper')}</span>
      </div>
      <p className="super-request-block-text">{turn.text}</p>
    </div>
  );
}
