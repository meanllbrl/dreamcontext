import { useEffect, useState, type CSSProperties } from 'react';
import { formatClock, isAgentRun, type SubAgentRun } from './chatEntities';
import { AGENT_ROLES } from '../../../lib/agentRoles';
import { AgentAvatar } from './atoms';
import { ExpandIcon } from '../GoalLivePanel';
import { partyClockMs } from './SubAgentCard';
import { partyOutcome, partyTitle, runDoing, runIdentity, runVerdict, type Party, type PartyOutcome } from './questModel';
import './teamBoard.css';

/**
 * ORGANISM — the whole chat's agent work on ONE board: every party a column, in the order it
 * was sent, every agent a chip in its column. The party cards say what each batch did where it
 * happened; they scatter down the transcript, so a run of four phases and a dozen agents has no
 * place where it reads as one run. This is that place, on the live rail.
 *
 * Collapsed it is one line: the phase rail (a dot per phase, joined, each with its count) and
 * "4 phases · 11 agents". Open, the columns appear under their phase. A chip's click is the
 * card row's click (the drill-in). Shown only once a chat has sent two parties or more: one
 * party is already one card.
 *
 * The columns share the pane's width: a phase's agents fold into as many chip tracks as the
 * width allows, so a wide pane reads four reviewers as a 2x2 block instead of a tall stack
 * beside an empty half (see boardTracks).
 */

type Tone = 'running' | 'good' | 'bad' | 'ended';

function phaseTone(outcome: PartyOutcome): Tone {
  if (outcome === 'running') return 'running';
  if (outcome === 'cleared') return 'good';
  if (outcome === 'sent-back') return 'bad';
  return 'ended';
}

/** A chip's mark: a sent-back verdict outranks a clean finish, since that is what happened next. */
function chipTone(run: SubAgentRun): Tone {
  if (run.status === 'running') return 'running';
  if (run.status === 'error') return 'bad';
  if (run.status === 'stopped') return 'ended';
  const verdict = runVerdict(run);
  return verdict === 'needs-work' || verdict === 'fail' ? 'bad' : 'good';
}

const MARKS: Record<Tone, string> = { running: '', good: '✓', bad: '!', ended: '■' };

/** A chip's narrowest readable width, and the gaps the stylesheet draws between chips and columns. */
const CHIP_MIN = 124;
const CHIP_GAP = 4;
const COL_GAP = 8;

/**
 * How many chip tracks each phase's column gets: the fewest rows whose columns all fit `width`,
 * so the board is as short as the pane allows and every phase keeps its own column. A pane too
 * narrow even for one track a phase scrolls sideways, as before.
 */
export function boardTracks(counts: number[], width: number): number[] {
  const tallest = Math.max(1, ...counts);
  for (let rows = 1; rows <= tallest; rows++) {
    const tracks = counts.map((n) => Math.max(1, Math.ceil(n / rows)));
    const need = tracks.reduce((w, t) => w + t * CHIP_MIN + (t - 1) * CHIP_GAP, 0) + (counts.length - 1) * COL_GAP;
    if (need <= width) return tracks;
  }
  return counts.map(() => 1);
}

function teamPhases(parties: Party[], runsOf: (p: Party) => SubAgentRun[]) {
  return parties
    .map((p) => ({ party: p, runs: runsOf(p).filter(isAgentRun) }))
    .filter((ph) => ph.runs.length > 0);
}

/** Whether the board draws at all, and whether its team is at work: the rail asks, so a quest
 *  map and the board never draw the same run twice. */
export function teamBoardState(parties: Party[], runsOf: (p: Party) => SubAgentRun[]): { shows: boolean; running: number } {
  const phases = teamPhases(parties, runsOf);
  return {
    shows: phases.length >= 2,
    running: phases.reduce((n, ph) => n + ph.runs.filter((r) => r.status === 'running').length, 0),
  };
}

export function TeamBoard({ parties, runsOf, onDrillIn, onExpand }: {
  parties: Party[];
  /** A party's live runs: the board, like the cards, cannot drill into a rebuilt one. */
  runsOf: (p: Party) => SubAgentRun[];
  onDrillIn: (run: SubAgentRun) => void;
  /** Opens the goal-skill run's full quest map; absent when no such run is live. */
  onExpand?: () => void;
}) {
  const phases = teamPhases(parties, runsOf);
  const all = phases.flatMap((ph) => ph.runs);
  const running = all.filter((r) => r.status === 'running').length;

  // Open while the team works, so the board is where the eye goes; a click keeps it either way.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? running > 0;
  const [now, setNow] = useState(() => Date.now());
  const [colsEl, setColsEl] = useState<HTMLDivElement | null>(null);
  const [colsWidth, setColsWidth] = useState(0);
  useEffect(() => {
    if (!colsEl) return undefined;
    const ro = new ResizeObserver(([entry]) => setColsWidth(entry.contentRect.width));
    ro.observe(colsEl);
    return () => ro.disconnect();
  }, [colsEl]);
  useEffect(() => {
    if (running === 0) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  if (phases.length < 2) return null;
  const clock = partyClockMs(all, now);
  const tracks = boardTracks(phases.map((ph) => ph.runs.length), colsWidth);

  return (
    <div className="chat-team-board" data-open={open || undefined} data-running={running > 0 || undefined}>
      <div className="chat-team-board-top">
      <button
        type="button"
        className="chat-team-board-head"
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
        title={open ? 'Hide the team board' : 'Show every agent this chat sent, by phase'}
      >
        <span className="chat-team-board-rail">
          {phases.map(({ party, runs }, i) => {
            const landed = runs.filter((r) => r.status !== 'running').length;
            return (
              <span className="chat-team-board-phase" key={party.id} data-tone={phaseTone(partyOutcome(party))}>
                {i > 0 && <span className="chat-team-board-link" aria-hidden />}
                <span className="chat-team-board-dot" aria-hidden />
                <span className="chat-team-board-phase-name">{partyTitle(party)}</span>
                <span className="chat-team-board-phase-count">{landed}/{runs.length}</span>
              </span>
            );
          })}
        </span>
        <span className="chat-team-board-sum">
          <span className="chat-team-board-tally">{phases.length} phases · {all.length} agents</span>
          {running > 0 && <span className="chat-team-board-live">{running} working</span>}
          {clock != null && <span className="chat-team-board-clock">{formatClock(clock)}</span>}
          <span className="chat-team-board-caret" aria-hidden>{open ? '▴' : '▾'}</span>
        </span>
      </button>
      {onExpand && (
        <button
          type="button"
          className="chat-team-board-expand"
          onClick={onExpand}
          aria-label="Open the full quest map"
          title="Open the full quest map"
        >
          <ExpandIcon />
        </button>
      )}
      </div>
      {open && (
        <div className="chat-team-board-cols" ref={setColsEl}>
          {phases.map(({ party, runs }, i) => (
            <div
              className="chat-team-board-col"
              key={party.id}
              data-tone={phaseTone(partyOutcome(party))}
              style={{ '--tracks': tracks[i] } as CSSProperties}
            >
              <div className="chat-team-board-col-head">{partyTitle(party)}</div>
              <div className="chat-team-board-chips">
              {runs.map((run) => {
                const { role } = runIdentity(run);
                const tone = chipTone(run);
                const label = role === 'agent' && run.name.trim() ? run.name.trim() : AGENT_ROLES[role].label;
                return (
                  <button
                    type="button"
                    key={run.taskId}
                    className="chat-team-board-chip"
                    data-role={role}
                    data-tone={tone}
                    title={`${AGENT_ROLES[role].label} · ${runDoing(run)}`}
                    onClick={() => onDrillIn(run)}
                  >
                    <AgentAvatar name={run.subagentType ?? run.name} size={18} role={role} running={tone === 'running'} />
                    <span className="chat-team-board-chip-label">{label}</span>
                    <span className="chat-team-board-chip-mark" data-tone={tone} aria-hidden>{MARKS[tone]}</span>
                  </button>
                );
              })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
