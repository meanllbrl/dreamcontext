import { useEffect, useState } from 'react';
import { summarizeSubAgents, formatClock, runMetaChips, isAgentRun, type SubAgentRun } from './chatEntities';
import { AgentAvatar, TypeBadge, ProgressTrack } from './atoms';
import { CardHeader } from './molecules';

/**
 * ORGANISM — the "N agents running" group card, state 9. Driven entirely by
 * `conv.subAgents` (reduced from the `task-started`/`task-progress`/`task-updated`/
 * `task-notification` ChatEvents; see chatSession.ts's header note). One row per run —
 * avatar, name, type badge, live line, meta readout, progress — and a click drills into
 * `SlideOver`'s `mode:'subagent'` for that run's real sidechain transcript.
 *
 * The row answers "what is it doing, and what has it cost so far": `task-progress` gives the
 * current step and the running duration/token/tool totals, and the Agent tool's own result
 * gives the model. Every one of those is rendered ONLY where the CLI actually reported it —
 * see `runMetaChips`. Reasoning effort rides on no channel and therefore never appears.
 */

function statusMark(status: SubAgentRun['status']): string {
  if (status === 'completed') return '✓';
  if (status === 'error') return '⚠';
  return '▸';
}

/**
 * The live line under a run's name. While the run is going, what it is doing RIGHT NOW wins
 * (`activity`, refreshed by every `task-progress` frame — "Running List directory contents of
 * /usr/share"), then the tool it last reached for, then its own summary. A finished run shows
 * its summary. "Working…" is the last resort, for the window before the first progress frame.
 */
function runLine(run: SubAgentRun): string {
  if (run.status === 'running') {
    if (run.activity) return run.activity;
    if (run.lastToolName) return `${run.lastToolName}…`;
    if (run.summary) return run.summary;
    return 'Working…';
  }
  if (run.summary) return run.summary;
  if (run.status === 'error') return 'Ended with an error';
  return 'Done';
}

/**
 * What the group card may honestly call itself. `local_bash` tasks ride the exact same
 * `task_*` frames as dispatched sub-agents (the CLI auto-backgrounds a long shell command),
 * so a card holding one is showing TASKS, not agents — and "task" is also the honest word for
 * a mixed set. Only an all-agent card says "agent".
 */
function groupNoun(agents: number, total: number): string {
  return agents === total ? 'agent' : 'task';
}

export function SubAgentCard({ runs, onDrillIn }: { runs: SubAgentRun[]; onDrillIn: (run: SubAgentRun) => void }) {
  const { running, total, agents, earliestStart } = summarizeSubAgents(runs);
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
        title={`${total} ${groupNoun(agents, total)}${total === 1 ? '' : 's'} ${running > 0 ? 'running' : 'finished'}`}
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
                {!isAgentRun(run) && <TypeBadge>shell</TypeBadge>}
              </span>
              <span className="chat-subagents-row-sub">
                <span className="chat-subagents-row-line">{runLine(run)}</span>
                {/* Duration · model · tokens · tools — only ever the fields this run actually
                    reported (see runMetaChips). Right-anchored so the numbers stack into a
                    scannable column while the activity text takes the slack and truncates. */}
                <span className="chat-subagents-row-meta">
                  {runMetaChips(run, tick).map((chip) => (
                    <span className="chat-subagents-row-chip" key={chip}>{chip}</span>
                  ))}
                </span>
              </span>
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
