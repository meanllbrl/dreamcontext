import { useEffect, useState } from 'react';
import { summarizeSubAgents, formatClock, runMetaChips, isAgentRun, type SubAgentRun } from './chatEntities';
import { AgentAvatar, TypeBadge, ProgressTrack } from './atoms';
import { CardHeader } from './molecules';

/**
 * ORGANISM — the "N agents running" group card, state 9. Driven entirely by
 * `conv.subAgents` (reduced from the `task-started`/`task-updated`/`task-notification`
 * ChatEvents; see chatSession.ts's header note). One row per run — avatar, name, type
 * badge, live line, progress — and a click drills into `SlideOver`'s `mode:'subagent'`
 * for that run's real sidechain transcript.
 */

function statusMark(status: SubAgentRun['status']): string {
  if (status === 'completed') return '✓';
  if (status === 'error') return '⚠';
  return '▸';
}

/** The live line under a run's name: its own summary while it has one, else what the
 *  status alone can honestly say. */
function runLine(run: SubAgentRun): string {
  if (run.summary) return run.summary;
  if (run.status === 'running') return 'Working…';
  if (run.status === 'error') return 'Ended with an error';
  return 'Done';
}

export function SubAgentCard({ runs, onDrillIn }: { runs: SubAgentRun[]; onDrillIn: (run: SubAgentRun) => void }) {
  const { running, total, earliestStart } = summarizeSubAgents(runs);
  // Self-ticking elapsed readout while any run is still going — cleared once none are.
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (running === 0) return;
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  if (total === 0) return null;

  const lastEnd = Math.max(0, ...runs.map((r) => r.endedAt ?? 0));
  const elapsed = earliestStart != null ? (running > 0 ? tick : lastEnd || tick) - earliestStart : null;

  return (
    <div className="chat-subagents">
      <CardHeader
        glyph="⚡"
        // The GROUP is what the header names — "3 agents running" for a fan-out where one
        // has already landed, since the group is what you are waiting on.
        title={`${total} agent${total === 1 ? '' : 's'} ${running > 0 ? 'running' : 'finished'}`}
        aside={(
          <>
            {elapsed != null && <span className="chat-subagents-elapsed">elapsed {formatClock(elapsed)}</span>}
            {running > 0 && <span className="chat-subagents-spinner" aria-hidden />}
          </>
        )}
      />
      <div className="chat-subagents-rows">
        {runs.map((run) => (
          <button
            type="button"
            key={run.taskId}
            className="chat-subagents-row"
            data-status={run.status}
            onClick={() => onDrillIn(run)}
          >
            <AgentAvatar name={run.subagentType ?? run.name} />
            <span className="chat-subagents-row-body">
              <span className="chat-subagents-row-head">
                <span className="chat-subagents-row-name">{run.name}</span>
                {run.subagentType && <TypeBadge>{run.subagentType}</TypeBadge>}
              </span>
              <span className="chat-subagents-row-line">{runLine(run)}</span>
            </span>
            <ProgressTrack status={run.status} />
            <span className="chat-subagents-row-mark" data-status={run.status} aria-hidden>{statusMark(run.status)}</span>
            <span className="chat-subagents-row-open" aria-hidden>open →</span>
          </button>
        ))}
      </div>
    </div>
  );
}
