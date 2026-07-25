import { useEffect, useState } from 'react';
import {
  formatClock, runDurationMs, summarizeBackgroundShells, useGroupCollapse, groupOutcomeNote,
  type SubAgentRun,
} from './chatEntities';

/**
 * ORGANISM — the background-shells tray: a persistent strip above the composer listing every
 * shell the CLI is running in the background, with the two actions that surface actually
 * needs (read its live output, stop it).
 *
 * Why its own surface rather than rows in `SubAgentCard`: the CLI reports a backgrounded
 * `Bash` on the SAME `system:task_*` frames as a dispatched sub-agent (discriminated only by
 * `task_type:'local_bash'`), but the two have opposite affordances. An agent run has a
 * sidechain transcript to drill into and no lifecycle the user controls; a shell has no
 * transcript at all (drilling in showed a misleading "hasn't flushed yet") but does have live
 * output on disk and can be stopped. Mixing them put a shell behind a dead drill-in and left
 * a running process with no off switch.
 *
 * Why DOCKED rather than inline in the transcript: a background shell outlives the turn that
 * started it. An inline card scrolls away while the process keeps running, which is exactly
 * the state the user needs to stay aware of. Finished shells stay listed (their output is
 * still readable) until the conversation ends — but the list COLLAPSES to its header once the
 * last one exits, so persistent furniture stays the size of what is actually live.
 */

function statusWord(status: SubAgentRun['status']): string {
  if (status === 'running') return 'running';
  if (status === 'completed') return 'done';
  if (status === 'stopped') return 'stopped';
  return 'failed';
}

export function BackgroundShellsTray({
  runs, onOpen, onStop,
}: {
  runs: SubAgentRun[];
  onOpen: (run: SubAgentRun) => void;
  onStop: (run: SubAgentRun) => void;
}) {
  const { shells, running, total } = summarizeBackgroundShells(runs);
  // Collapsed once nothing is running: a finished shell is reference material (its output is
  // still readable, one click away), a running one is live state worth having open. The
  // tray sits over the composer, so a list that never closes costs the transcript real
  // height for rows about processes that exited minutes ago.
  const { open: expanded, onToggle } = useGroupCollapse(shells);
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (running === 0) return;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  if (total === 0) return null;

  const outcome = groupOutcomeNote(shells);
  // The group's own span: first start → last end, so the collapsed header says how long the
  // batch took without the per-row clocks it is hiding.
  const earliestStart = Math.min(...shells.map((s) => s.startedAt));
  const lastEnd = Math.max(0, ...shells.map((s) => s.endedAt ?? 0));
  const elapsed = (running > 0 ? tick : lastEnd || tick) - earliestStart;

  return (
    <div className="chat-bgshells" data-running={running > 0 || undefined}>
      <button
        type="button"
        className="chat-bgshells-head"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="chat-bgshells-glyph" aria-hidden>▶</span>
        <span className="chat-bgshells-title">
          {running > 0
            ? `${running} background shell${running === 1 ? '' : 's'} running`
            : `${total} background shell${total === 1 ? '' : 's'} finished`}
        </span>
        {/* Collapsed, this row is all that is left of the batch — so what went wrong, and how
            long it all took, are named here rather than only on the hidden rows. */}
        {outcome && <span className="chat-bgshells-note">{outcome}</span>}
        <span className="chat-bgshells-clock">{formatClock(elapsed)}</span>
        {running > 0 && <span className="chat-bgshells-spinner" aria-hidden />}
        <span className="chat-bgshells-caret" aria-hidden>{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <ul className="chat-bgshells-rows">
          {shells.map((run) => (
            <li className="chat-bgshells-row" key={run.taskId} data-status={run.status}>
              <button
                type="button"
                className="chat-bgshells-open"
                onClick={() => onOpen(run)}
                title="Read this shell's live output"
              >
                <span className="chat-bgshells-row-name">{run.name}</span>
                <span className="chat-bgshells-row-meta">
                  <span className="chat-bgshells-row-status" data-status={run.status}>
                    {statusWord(run.status)}
                  </span>
                  <span className="chat-bgshells-row-clock">{formatClock(runDurationMs(run, tick))}</span>
                </span>
              </button>
              <span className="chat-bgshells-row-actions">
                <button
                  type="button"
                  className="chat-bgshells-btn"
                  onClick={() => onOpen(run)}
                >Output</button>
                {/* Only ever offered for a shell that is actually alive — a Stop on a finished
                    process would send a `stop_task` the CLI answers "success" to regardless,
                    reading as though something happened. */}
                {run.status === 'running' && (
                  <button
                    type="button"
                    className="chat-bgshells-btn danger"
                    onClick={() => onStop(run)}
                  >Stop</button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
