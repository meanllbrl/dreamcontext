import { useEffect, useId, useRef, useState } from 'react';
import { formatClock, isAgentRun, type SubAgentRun } from './chatEntities';
import { AGENT_ROLES } from '../../../lib/agentRoles';
import { AgentAvatar } from './atoms';
import { ExpandIcon } from '../GoalLivePanel';
import { partyClockMs } from './SubAgentCard';
import {
  partyLine, partyOutcome, partyTitle, runDoing, runIdentity, runName, runVerdict,
  type Party, type PartyOutcome,
} from './questModel';
import './teamBoard.css';

/**
 * ORGANISM — the whole chat's agent work in ONE place: a line of phases in the order they were
 * sent, and under it the team of one phase. The party cards say what each batch did where it
 * happened; they scatter down the transcript, so a run of seven phases and a dozen agents has
 * no place where it reads as one run. This is that place, on the live rail.
 *
 * The line names each phase once, and a stage once per stretch: "Build  wave 1 3/3 · wave 3
 * 3/5 — Boss gate  round 3 1/1". Open, the board shows ONE phase's team (the one at work, or
 * the one you clicked on the line), each agent by the words that say which one it is
 * (`runName`), since the face already says the role. The team wraps across the width, so it
 * is usually one row tall. Owner 2026-10-04: a column per phase repeated every phase name under
 * the line that had just said it, stacked five "Builder"s in one column beside empty ones, and
 * named nobody.
 *
 * It opens on its own while the team works and the live party's card is NOT on screen: with
 * that card in view the card is the detail, so the board folds to its line. A click holds until
 * the reason changes (the card comes or goes, a run starts or ends), then the board follows the
 * run again. Shown only once a chat has sent two parties or more: one party is already one card.
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

/** Room kept clear past the phase on show when the line scrolls it into view: the edge fade. */
const RAIL_FADE = 24;

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

export function TeamBoard({ parties, runsOf, onDrillIn, onExpand, teamInView = false }: {
  parties: Party[];
  /** A party's live runs: the board, like the cards, cannot drill into a rebuilt one. */
  runsOf: (p: Party) => SubAgentRun[];
  onDrillIn: (run: SubAgentRun) => void;
  /** Opens the goal-skill run's full quest map; absent when no such run is live. */
  onExpand?: () => void;
  /** The live party's card is on screen in the transcript: it already shows the team. */
  teamInView?: boolean;
}) {
  const phases = teamPhases(parties, runsOf);
  const all = phases.flatMap((ph) => ph.runs);
  const running = all.filter((r) => r.status === 'running').length;

  // What the run alone would show: the newest phase at work (else the newest), open while the
  // team works out of sight. A click overrides either one only while that stays what it was.
  // Once nobody works, where the card is no longer matters: scrolling a finished chat must not
  // fold a board you opened to read.
  const working = [...phases].reverse().find((ph) => ph.runs.some((r) => r.status === 'running'));
  const autoPick = (working ?? phases[phases.length - 1])?.party.id ?? null;
  const reason = running === 0 ? 'idle' : teamInView ? 'card-in-view' : 'card-away';
  const autoOpen = reason === 'card-away';
  const [userOpen, setUserOpen] = useState<{ open: boolean; over: string } | null>(null);
  const [userPick, setUserPick] = useState<{ id: string; over: string | null } | null>(null);
  const open = userOpen && userOpen.over === reason ? userOpen.open : autoOpen;
  const pickedId = userPick && userPick.over === autoPick && phases.some((ph) => ph.party.id === userPick.id)
    ? userPick.id : autoPick;

  const [now, setNow] = useState(() => Date.now());
  const panelId = useId();
  const railRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (running === 0) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  // A line longer than the pane scrolls sideways; the phase on show is kept in view.
  useEffect(() => {
    const rail = railRef.current;
    const current = rail?.querySelector<HTMLElement>('[data-current]');
    if (!rail || !current) return;
    const right = current.offsetLeft + current.offsetWidth + RAIL_FADE;
    if (right > rail.scrollLeft + rail.clientWidth) rail.scrollLeft = right - rail.clientWidth;
    else if (current.offsetLeft < rail.scrollLeft) rail.scrollLeft = current.offsetLeft;
  }, [pickedId, phases.length]);

  if (phases.length < 2) return null;
  const clock = partyClockMs(all, now);
  const shown = phases.find((ph) => ph.party.id === pickedId) ?? phases[phases.length - 1];

  // A phase's click shows its team; on the phase already showing, it folds the board.
  const choose = (id: string) => {
    setUserOpen({ open: !(open && id === shown.party.id), over: reason });
    setUserPick({ id, over: autoPick });
  };

  return (
    <div className="chat-team-board" data-open={open || undefined} data-running={running > 0 || undefined}>
      <div className="chat-team-board-top">
        <div className="chat-team-board-rail" ref={railRef} role="group" aria-label="Phases of this run">
          {partyLine(phases, (ph) => ph.party).map((group, gi) => (
            <span className="chat-team-board-group" key={group.phases[0].phase.party.id}>
              {gi > 0 && <span className="chat-team-board-link" aria-hidden />}
              {group.phases[0].step && <span className="chat-team-board-stage">{group.stage}</span>}
              {group.phases.map(({ phase: { party, runs }, step }) => {
                const landed = runs.filter((r) => r.status !== 'running').length;
                const current = party.id === shown.party.id;
                return (
                  <button
                    type="button"
                    key={party.id}
                    className="chat-team-board-phase"
                    data-tone={phaseTone(partyOutcome(party))}
                    data-current={current || undefined}
                    data-solo={step ? undefined : true}
                    aria-pressed={open && current}
                    aria-controls={open && current ? panelId : undefined}
                    title={`${partyTitle(party)} · ${landed} of ${runs.length} back`}
                    onClick={() => choose(party.id)}
                  >
                    <span className="chat-team-board-dot" aria-hidden />
                    <span className="chat-team-board-phase-name">{step ?? group.stage}</span>
                    <span className="chat-team-board-phase-count">{landed}/{runs.length}</span>
                  </button>
                );
              })}
            </span>
          ))}
        </div>
        <button
          type="button"
          className="chat-team-board-toggle"
          aria-expanded={open}
          onClick={() => setUserOpen({ open: !open, over: reason })}
          title={open ? 'Hide the team' : 'Show the team of this phase'}
        >
          {running > 0
            ? <span className="chat-team-board-live">{running} working</span>
            : <span className="chat-team-board-tally">{all.length} agents</span>}
          {clock != null && <span className="chat-team-board-clock">{formatClock(clock)}</span>}
          <span className="chat-team-board-caret" aria-hidden>{open ? '▴' : '▾'}</span>
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
        <div className="chat-team-board-team" id={panelId} role="region" aria-label={partyTitle(shown.party)}>
          {shown.runs.map((run) => {
            const { role } = runIdentity(run);
            const tone = chipTone(run);
            const name = runName(run);
            return (
              <button
                type="button"
                key={run.taskId}
                className="chat-team-board-chip"
                data-role={role}
                data-tone={tone}
                title={[AGENT_ROLES[role].label, name, runDoing(run)].filter(Boolean).join(' · ')}
                onClick={() => onDrillIn(run)}
              >
                <AgentAvatar name={run.subagentType ?? run.name} size={20} role={role} running={tone === 'running'} />
                <span className="chat-team-board-chip-label">{name ?? AGENT_ROLES[role].label}</span>
                <span className="chat-team-board-chip-mark" data-tone={tone} aria-hidden>{MARKS[tone]}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
