import { useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useAgent } from '../../../hooks/useAgents';
import { requestOpenAgents } from '../../../lib/openAgents';
import { AgentAvatar } from '../../agents/AgentAvatar';
import type { MemberHelper } from '../../../lib/superTypes';
import type { SessionStatusKind } from '../agentStatus';
import { StatusRing } from './AgentCard';
import { elapsedLabel, toneOfStatus } from './superHandover';
import './TeamHelpers.css';

/** A helper's state in the ONE status language every card speaks: its pool wait reads as
 *  starting, a question (to the member) as asking, done as idle, stuck or gone as ended. Pure. */
export function helperStatusKind(row: MemberHelper['row']): SessionStatusKind {
  if (row === 'working') return 'working';
  if (row === 'asking' || row === 'waiting') return 'asking';
  if (row === 'pooled') return 'starting';
  if (row === 'done') return 'ready';
  return 'ended';
}

/**
 * What a helper's chip says beside its brief, read from its ROW, never from its tone: a pool wait
 * is "waiting", a question to the member "asks <member>", a turn that ended on something only the
 * owner can do "waits for you" (both asking-toned, but only one is the member's to answer). Else
 * its model and how long it ran (still running: until now; stopped with no end time: none). Pure.
 */
export function helperMeta(t: (key: string) => string, h: MemberHelper, member: string): string {
  if (h.row === 'pooled') return t('superStage.team.helperWaiting');
  if (h.row === 'asking') return t('superStage.team.helperAsks').replace('{name}', member);
  if (h.row === 'waiting') return t('superStage.team.helperWaitsOwner');
  const end = h.finishedAt ?? (h.live ? Date.now() : undefined);
  return [shortModel(h.model), end !== undefined ? elapsedLabel(end - h.startedAt) : ''].filter(Boolean).join(' · ');
}

/** A model id as its short family word ("claude-fable-5-2" -> "fable"), for a one-line chip. */
export function shortModel(model: string | undefined): string {
  if (!model) return '';
  const m = /(fable|opus|sonnet|haiku)/i.exec(model);
  return m ? m[1].toLowerCase() : model.slice(0, 12);
}

/**
 * The helpers a member's Super started for the Super Agent's job, under the member card's head
 * (owner 2026-11-15, option A): live ones as chips (status ring, brief, model, time), the finished
 * ones folded into "+N done". A click on a started helper opens its conversation in the card
 * (`onPick`); a job its pool still keeps has none yet. Nothing is drawn when there are none.
 */
export function TeamHelpers({ helpers, picked, onPick, member }: {
  helpers: readonly MemberHelper[];
  picked: string | null;
  onPick: (id: string | null) => void;
  member: string;
}) {
  const { t } = useI18n();
  const [showDone, setShowDone] = useState(false);
  if (!helpers.length) return null;
  const live = helpers.filter((h) => h.live);
  const done = helpers.filter((h) => !h.live);
  const unfolded = showDone || done.some((h) => h.id === picked);
  const shown = unfolded ? helpers : live;
  return (
    <div className="super-team-helpers" role="group" aria-label={t('superStage.team.helpers')} data-testid="team-helpers">
      <span className="super-team-helpers-label">{t('superStage.team.helpers')}</span>
      {shown.map((h) => {
        const kind = helperStatusKind(h.row);
        const pooled = h.row === 'pooled';
        const meta = helperMeta(t, h, member);
        return (
          <button
            key={h.id}
            type="button"
            className="super-team-helper"
            data-kind={kind}
            data-super-tone={toneOfStatus(kind)}
            data-testid="team-helper"
            data-helper={h.id}
            aria-pressed={picked === h.id}
            disabled={pooled}
            title={h.brief}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onPick(picked === h.id ? null : h.id); }}
          >
            <StatusRing kind={kind} size={14} />
            <span className="super-team-helper-brief">{h.brief}</span>
            {meta && <span className="super-team-helper-meta">{meta}</span>}
          </button>
        );
      })}
      {done.length > 0 && (
        <button type="button" className="super-team-helper super-team-helper--more" data-testid="team-helpers-done" aria-expanded={unfolded}
          onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setShowDone((v) => !v); }}>
          {unfolded ? t('superStage.team.helpersFold') : t('superStage.team.helpersDone').replace('{n}', String(done.length))}
        </button>
      )}
    </div>
  );
}

/** A member card's title in its large head: the member's face and name, the way its tile shows
 *  them (the record's title was its slug). */
export function TeamHeadTitle({ member }: { member: string }) {
  const agent = useAgent(member).data?.agent;
  const name = agent?.title || member;
  return (
    <span className="super-team-head-title" data-testid="team-head-title">
      <AgentAvatar of="agent" slug={member} title={name} hasPhoto={!!agent?.hasPhoto} size={20} />
      <span className="super-card-title" title={name}>{name}</span>
    </span>
  );
}

/**
 * "Open stage" (owner 2026-11-15): the member's own stage, its one conversation with every card and
 * its own work, from the member card's head. It replaced the "Open chat" bar at the card's foot,
 * which named a chat and opened the stage.
 */
export function OpenStageButton({ member }: { member: string }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="super-open-stage"
      data-testid="team-job-open-member"
      title={t('superStage.team.openStageHint')}
      aria-label={t('superStage.team.openStage')}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); requestOpenAgents({ slug: member }); }}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4.5 2H2v8h8V7.5M7 2h3v3M10 2 5.5 6.5" />
      </svg>
      {/* On a narrow screen only the icon stays: the member's name needs the head's room. */}
      <span className="super-open-stage-label">{t('superStage.team.openStage')}</span>
    </button>
  );
}
