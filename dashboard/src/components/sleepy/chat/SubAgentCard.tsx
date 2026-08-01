import { useEffect, useRef, useState } from 'react';
import {
  summarizeSubAgents, formatClock, runMetaChips, isAgentRun, isHeadlessAgentShell,
  useGroupCollapse, groupOutcomeNote,
  type SubAgentRun,
} from './chatEntities';
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
 *
 * The card sits WHERE IT WAS SPAWNED in the transcript, so a fan-out that runs for minutes
 * scrolls away under the output that follows it. {@link SubAgentRail} is the same group
 * pinned to the top of the transcript once that happens — ChatPane decides when to show it
 * and scrolls back to the row a chip names.
 *
 * The rows are open while the group is LIVE and collapse to the header the moment the last
 * run lands (`useGroupCollapse`) — a finished fan-out is a record, and a record that keeps N
 * rows of the transcript forever is just cost. The header still reports the whole outcome,
 * and a click brings the rows back for good.
 */

function statusMark(status: SubAgentRun['status']): string {
  if (status === 'completed') return '✓';
  if (status === 'error') return '⚠';
  if (status === 'stopped') return '■';
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
    // A headless `claude` run reports no progress frames of its own (it is a shell task to
    // the CLI), so its COMMAND is the most honest thing to show while it works — the prompt
    // it was launched with is right there in it. Collapsed to one line; the row truncates.
    if (run.command) return run.command.replace(/\s+/g, ' ').trim();
    return 'Working…';
  }
  if (run.summary) return run.summary;
  if (run.status === 'error') return 'Ended with an error';
  return 'Done';
}

/**
 * What the group card may honestly call itself. Every row here is an agent by
 * `isAgentRun` — a dispatched sub-agent or a headless `claude` run — so the count and the
 * noun normally agree. "task" survives for the case they don't: a row this card was handed
 * that `summarizeSubAgents` does not count as an agent should not be summed into a number
 * calling itself agents.
 */
function groupNoun(agents: number, total: number): string {
  return agents === total ? 'agent' : 'task';
}

export function SubAgentCard({ runs: allRuns, onDrillIn, rootRef, highlightRunId }: {
  runs: SubAgentRun[];
  onDrillIn: (run: SubAgentRun) => void;
  /** Callback ref for the card's root. ChatPane measures this element to know whether the
   *  card has scrolled off the top of the transcript (→ show the rail), and queries it for
   *  the `data-subagent-row` a rail chip jumps to. */
  rootRef?: (el: HTMLDivElement | null) => void;
  /** The run a rail chip just jumped to — its row flashes for a beat so the eye lands on the
   *  right one instead of hunting through four identically-shaped rows. */
  highlightRunId?: string | null;
}) {
  // AGENT runs only. Background shells ride the identical `task_*` frames but belong to
  // `BackgroundShellsTray`: this card's whole affordance is drilling into a sidechain
  // transcript, and a shell has none — clicking one used to open a panel that said the
  // transcript "hasn't flushed yet" about a file that was never going to exist. Filtered here
  // rather than at the call site so no caller can reintroduce that.
  const runs = allRuns.filter(isAgentRun);
  const { running, total, agents, earliestStart } = summarizeSubAgents(runs);
  // Live while it is live, a header once it lands: a fan-out of N agents held N rows of the
  // transcript forever, and a finished run's row says nothing its group summary doesn't. The
  // rows are one click away — and stay open if the user asks for them (see isGroupOpen).
  const { open, onToggle } = useGroupCollapse(runs);
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
  const outcome = groupOutcomeNote(runs);

  return (
    <div className="chat-subagents" data-open={open || undefined} ref={rootRef}>
      <CardHeader
        glyph="⚡"
        // The GROUP is what the header names — "3 agents running" for a fan-out where one
        // has already landed, since the group is what you are waiting on.
        title={`${total} ${groupNoun(agents, total)}${total === 1 ? '' : 's'} ${running > 0 ? 'running' : 'finished'}`}
        open={open}
        onToggle={onToggle}
        aside={(
          <>
            {/* Collapsed, this header is the only thing left saying what happened — so a
                failed or killed run is named here, not only on the row that is now hidden. */}
            {outcome && <span className="chat-subagents-outcome">{outcome}</span>}
            {elapsed != null && <span className="chat-subagents-elapsed">elapsed {formatClock(elapsed)}</span>}
            {running > 0 && <span className="chat-subagents-spinner" aria-hidden />}
          </>
        )}
      />
      {open && (
        <div className="chat-subagents-rows">
          {runs.map((run) => (
            <button
              type="button"
              key={run.taskId}
              className="chat-subagents-row"
              data-status={run.status}
              // The rail's jump target — read by ChatPane off THIS card's subtree, so a split
              // view's two panes can never scroll each other (no document-wide ids).
              data-subagent-row={run.taskId}
              data-flash={run.taskId === highlightRunId ? '1' : undefined}
              onClick={() => onDrillIn(run)}
            >
              <AgentAvatar name={run.subagentType ?? run.name} />
              <span className="chat-subagents-row-body">
                <span className="chat-subagents-row-head">
                  <span className="chat-subagents-row-name">{run.name}</span>
                  {/* A headless run has no `subagent_type` — nothing dispatched it, a command
                      line did — so the badge names its NATURE instead. Without it the row is
                      indistinguishable from an Agent-tool dispatch, and the two do not open
                      the same thing when clicked. */}
                  {run.subagentType
                    ? <TypeBadge>{run.subagentType}</TypeBadge>
                    : isHeadlessAgentShell(run) && <TypeBadge>headless</TypeBadge>}
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
              {/* Says what the click actually does. A dispatch opens its sidechain transcript;
                  a headless run has none on disk, so its drill-in is the live output panel —
                  which is also where its Stop button lives. */}
              <span className="chat-subagents-row-open" aria-hidden>
                {isHeadlessAgentShell(run) ? 'output →' : 'open →'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * ORGANISM — the same group, PINNED. Rendered by ChatPane over the top of the transcript
 * once {@link SubAgentCard} has scrolled off (an overlay sibling of the scroller, exactly
 * like the "jump to latest" pill — see ChatPane.css for why it is not a scrolled child).
 * Clicking a chip scrolls the transcript back to that run's row; clicking the summary
 * scrolls to the card itself.
 *
 * It is a summary, not a second card: one chip per run — face, identity, and a mark once it
 * lands — plus the group's live clock. Everything a row says (activity, model, tokens,
 * tools) stays in the card, which is one click away rather than crammed into a strip that
 * has to stay readable on one line.
 *
 * Renders NOTHING once every run has finished. A finished fan-out is a record, and a record
 * belongs in the transcript where it happened — pinning it forever would spend the top of
 * every conversation on something that stopped changing.
 */
export function SubAgentRail({ runs: allRuns, onJump, onWheel }: {
  runs: SubAgentRun[];
  /** Scroll the transcript to a run's row — `null` for the card as a whole. */
  onJump: (taskId: string | null) => void;
  /** An overlay is not in the scroller's ancestor chain, so a wheel gesture that starts over
   *  the rail would otherwise scroll nothing. The host forwards it to the transcript. */
  onWheel?: (e: React.WheelEvent<HTMLDivElement>) => void;
}) {
  const runs = allRuns.filter(isAgentRun);
  const { running, total, agents, earliestStart } = summarizeSubAgents(runs);
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (running === 0) return;
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  // Whether the chips actually run past the strip's edge — the edge fade is worth showing
  // only then (see cards.css). Re-measured on resize: a pane dragged narrower in a split is
  // exactly when a group that used to fit stops fitting.
  const chipsRef = useRef<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const el = chipsRef.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [runs.length, running]);

  if (running === 0) return null;

  return (
    // The host spans the transcript so the strip can be laid out against its edges, and
    // passes pointer events THROUGH everywhere except the rail itself.
    <div className="chat-subagents-rail-host" onWheel={onWheel}>
      <div className="chat-subagents-rail" role="group" aria-label="Running sub-agents">
        <button
          type="button"
          className="chat-subagents-rail-summary"
          onClick={() => onJump(null)}
          title="Scroll to the sub-agents"
        >
          <span className="chat-subagents-rail-glyph" aria-hidden>⚡</span>
          {/* Same wording as the card's own header — the GROUP is what it names, so a
              fan-out where one has already landed still reads "4 agents running". */}
          <span className="chat-subagents-rail-count">
            {total} {groupNoun(agents, total)}{total === 1 ? '' : 's'} running
          </span>
          {earliestStart != null && (
            <span className="chat-subagents-elapsed">{formatClock(tick - earliestStart)}</span>
          )}
          <span className="chat-subagents-spinner" aria-hidden />
        </button>
        <div className="chat-subagents-rail-chips" ref={chipsRef} data-overflow={overflowing ? '1' : undefined}>
          {runs.map((run) => (
            <button
              type="button"
              key={run.taskId}
              className="chat-subagents-rail-chip"
              data-status={run.status}
              // The row truncates the name to a few words; the chip has less room still, so
              // the full name and what it is doing right now ride the tooltip.
              title={`${run.name} — ${runLine(run)}`}
              onClick={() => onJump(run.taskId)}
            >
              <AgentAvatar name={run.subagentType ?? run.name} size={18} />
              <span className="chat-subagents-rail-chip-label">{run.subagentType ?? run.name}</span>
              {/* Only a FINISHED run is marked. Running is the rail's whole premise (it is
                  only on screen because something is running, and the group spinner says
                  so) — a `▸` on every live chip would be four glyphs that mean "normal". */}
              {run.status !== 'running' && (
                <span className="chat-subagents-rail-chip-mark" data-status={run.status} aria-hidden>
                  {statusMark(run.status)}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
