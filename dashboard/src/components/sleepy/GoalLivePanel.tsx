import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAgentGoalLive } from '../../hooks/useAgentCapabilities';
import { AGENT_ROLES, QUEST_STAGE_LABELS } from '../../lib/agentRoles';
import { normalizeGoalLive } from '../../lib/goalLive';
import {
  GOAL_PHASE_TO_STAGE, formatQuestElapsed, freshExplainer, goalLineage, goalQuest, questVictoryCopy,
  type QuestLineage as QuestLineageModel, type QuestMember, type QuestView,
} from '../../lib/quest';
import { AgentAvatar, QuestBadge, VerdictChip } from './chat/atoms';
import { QuestLineage, QuestMap, QuestReceipt, QuestVictory, useJustWon } from './quest/QuestMap';
import './GoalLivePanel.css';

/**
 * The in-app live surface of a goal-skill run, drawn as a QUEST: the same map a Plan or
 * Develop chat shows, read off the run's live file (`goalQuest` / `goalLineage`, lib/quest.ts).
 *
 *  - BAR, above the composer (Terminal, `strip`) or on the chat's live rail (`rail`) while a
 *    run is active, zero footprint otherwise. The quest map while the team works; the one
 *    calm win beat once it is done, with "How this was built" behind it.
 *  - POPUP (click the bar): the full map, who is on stage now, the family tree and the
 *    timeline, portalled to document.body (the agent surface's `contain: layout paint` would
 *    otherwise clip a fixed overlay; same trap as the AgentDock).
 *
 * Session-scoped by the SERVER: this component only ever receives an active state for the
 * pane whose conversation is running the orchestrator.
 */
export function GoalLivePanel({ claudeId, enabled, variant = 'strip' }: {
  claudeId?: string;
  enabled: boolean;
  variant?: 'rail' | 'strip';
}) {
  const { data } = useAgentGoalLive(claudeId, enabled);
  const [open, setOpen] = useState(false);
  const [receipt, setReceipt] = useState(false);
  // The file is written by an agent: only its normalized shape reaches a renderer.
  const st = useMemo(() => (data?.active ? normalizeGoalLive(data.state) : null), [data]);
  const won = st?.phase === 'done';
  const now = useTicker(!!st && !won);
  const quest = useMemo(() => (st ? goalQuest(st, now) : null), [st, now]);
  const lineage = useMemo(() => (st ? goalLineage(st) : null), [st]);

  // The stamp is news only to someone who watched the run finish. A pane that opens onto a
  // run that was already done (the file lingers on purpose) shows the win at rest.
  const [sawLive, setSawLive] = useState(false);
  if (st && !won && !sawLive) setSawLive(true);
  // Held HERE, not in QuestVictory: the bar swaps map for victory at the win, and this is the
  // component that stays mounted across that swap.
  const justWon = useJustWon(sawLive && won);

  // A vanished run closes whatever it had open, so nothing ever shows stale state.
  useEffect(() => {
    if (!st) {
      setOpen(false);
      setReceipt(false);
    }
  }, [st]);

  if (!st || !quest) return null;
  const title = quest.title ?? 'This quest';
  const stageLabel = activeStageLabel(quest);

  return (
    <>
      {quest.outcome ? (
        <div className="goal-live-bar" data-variant={variant} data-won={quest.outcome.kind}>
          <QuestVictory
            quest={quest}
            justWon={justWon}
            onReceipt={lineage ? () => setReceipt(true) : undefined}
          />
          <ExpandButton onClick={() => setOpen(true)} />
        </div>
      ) : (
        <button
          type="button"
          className="goal-live-bar"
          data-variant={variant}
          title={`${title}: ${stageLabel}. Open the full quest map`}
          aria-label={`Quest map, ${stageLabel}. Open the full view`}
          onClick={() => setOpen(true)}
        >
          <QuestMap quest={quest} variant={variant} />
          <ExpandIcon />
        </button>
      )}
      {open && createPortal(
        <GoalLiveOverlay quest={quest} lineage={lineage} onClose={() => setOpen(false)} />,
        document.body,
      )}
      {receipt && lineage && <QuestReceipt lineage={lineage} title={title} onClose={() => setReceipt(false)} />}
    </>
  );
}

/** Wall-clock now, re-read every second while `live`: the elapsed time and the beat's
 *  freshness move on their own even when the file does not change. */
function useTicker(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return undefined;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [live]);
  return now;
}

/** The stage being worked, sentence case; the win headline once there is one. */
function activeStageLabel(q: QuestView): string {
  return questVictoryCopy(q)?.headline ?? q.stages[q.activeIndex]?.label ?? QUEST_STAGE_LABELS.draft;
}

function ExpandIcon() {
  return (
    <svg className="goal-live-expand" viewBox="0 0 12 12" width="12" height="12" aria-hidden>
      <path d="M7 1.5h3.5V5 M10.5 1.5 6.5 5.5 M5 10.5H1.5V7 M1.5 10.5l4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ExpandButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="goal-live-open" onClick={onClick} aria-label="Open the full quest map" title="Open the full quest map">
      <ExpandIcon />
    </button>
  );
}

// ─── Expanded popup: the whole quest ─────────────────────────────────────────────

function GoalLiveOverlay({ quest, lineage, onClose }: {
  quest: QuestView;
  lineage: QuestLineageModel | null;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const elapsed = quest.outcome?.elapsedMs ?? (quest.startedAt != null ? Date.now() - quest.startedAt : null);

  return (
    <div className="goal-live-backdrop" onClick={onClose}>
      <div
        className="goal-live-popup"
        role="dialog"
        aria-modal="true"
        aria-label={`Quest map: ${quest.title ?? 'this quest'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <span className="goal-live-popup-heading">
            <span className="goal-live-popup-kicker">Quest map</span>
            <h3>{quest.title ?? 'This quest'}</h3>
          </span>
          <span className="goal-live-popup-meta">
            {activeStageLabel(quest)}
            {elapsed != null ? ` · ${formatQuestElapsed(elapsed)}` : ''}
          </span>
          <button type="button" className="goal-live-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
              <path d="M3 3 9 9 M9 3 3 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="goal-live-popup-body">
          <QuestMap quest={quest} variant="full" />
          {quest.outcome && <QuestVictory quest={quest} justWon={false} />}
          <GoalLiveRoster quest={quest} />
          {lineage && (
            <section className="goal-live-section" aria-label="How this was built">
              <h4>How this was built</h4>
              <QuestLineage lineage={lineage} />
            </section>
          )}
          <GoalLiveTimeline quest={quest} />
        </div>
      </div>
    </div>
  );
}

const MEMBER_STATE_WORD: Readonly<Record<QuestMember['state'], string>> = {
  run: 'working',
  done: 'done',
  wait: 'waiting',
  fail: 'stopped',
};

/**
 * Who is on stage right now: one row per character, still (the cast never animates; status
 * is the word and its ink), with one explainer for the judges. Nothing while the stage is
 * empty or the quest is won: the family tree below tells the whole story then.
 */
function GoalLiveRoster({ quest }: { quest: QuestView }) {
  const cast = quest.cast;
  if (cast.length === 0) return null;
  const stage = cast[0].stage;
  const why = stage && cast.some((m) => m.carries === 'fresh') ? freshExplainer(stage) : null;
  return (
    <section className="goal-live-section goal-live-roster" aria-label="On stage now">
      <h4>On stage now</h4>
      {why && <p className="goal-live-why">{why}</p>}
      <ul>
        {cast.map((m) => (
          <li key={m.key} className="goal-live-member" data-role={m.role} data-s={m.state}>
            <AgentAvatar name={m.name} size={28} role={m.role} />
            <span className="goal-live-member-name">{m.name}</span>
            {m.name !== AGENT_ROLES[m.role].label && (
              <span className="goal-live-member-role">{AGENT_ROLES[m.role].label}</span>
            )}
            {m.carries && <QuestBadge carries={m.carries} />}
            {m.verdict ? <VerdictChip verdict={m.verdict} /> : (
              <span className="goal-live-member-state">{MEMBER_STATE_WORD[m.state]}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Every stage change, as time since the run started. A stage that looped appears again. */
function GoalLiveTimeline({ quest }: { quest: QuestView }) {
  if (quest.timeline.length === 0) return null;
  const t0 = quest.startedAt;
  return (
    <section className="goal-live-section goal-live-timeline" aria-label="Timeline">
      <h4>Timeline</h4>
      <ol>
        {quest.timeline.map((t, i) => (
          // eslint-disable-next-line react/no-array-index-key -- a stage can recur; order is the identity
          <li key={i} className="goal-live-tick" data-stage={t.stage}>
            <span className="goal-live-tick-label">
              {t.stage === 'done' ? 'Done' : QUEST_STAGE_LABELS[t.stage]}
            </span>
            {t0 != null && (
              <span className="goal-live-tick-time">{formatQuestElapsed(t.at - t0)}</span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

// ─── Dock badge: the minimized chip's quest line ─────────────────────────────────

/**
 * Mini live readout for a MINIMIZED session's dock chip: the stage being worked (sentence
 * case), the wave, one dot per builder. Shares the panel's query (same key, deduped poll).
 * Renders nothing when no run is active for that conversation.
 */
export function GoalDockBadge({ claudeId, enabled }: { claudeId?: string; enabled: boolean }) {
  const { data } = useAgentGoalLive(claudeId, enabled);
  const st = data?.active ? normalizeGoalLive(data.state) : null;
  if (!st) return null;
  const stage = GOAL_PHASE_TO_STAGE[st.phase];
  const label = st.phase === 'done' ? 'Quest cleared' : stage ? QUEST_STAGE_LABELS[stage] : QUEST_STAGE_LABELS.draft;
  const wave = st.impl?.waves && stage === 'build' ? ` · wave ${st.impl.wave ?? 1} of ${st.impl.waves}` : '';
  return (
    <span className="goal-live-dock-badge" title={`Quest map: ${label}${wave}`}>
      {label}
      {wave}
      <span className="goal-live-dock-forks" aria-hidden>
        {(st.impl?.forks ?? []).slice(0, 6).map((f, k) => (
          <b key={k} data-s={f.s} />
        ))}
      </span>
    </span>
  );
}
