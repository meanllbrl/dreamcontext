import { useEffect, useRef, useState } from 'react';
import {
  summarizeSubAgents, formatClock, runMetaChips, isAgentRun, isHeadlessAgentShell,
  useGroupCollapse, groupOutcomeNote, reportableRuns,
  type SubAgentRun,
} from './chatEntities';
import { SubAgentReport } from './SubAgentReport';
import { peerForAgent, type PeerMention } from '../../../lib/agentComposer';
import { peerLogoUrl } from '../../../api/client';
import { useVault } from '../../../context/VaultContext';
import { AGENT_ROLES, type AgentRoleId } from '../../../lib/agentRoles';
import { JARGON_RE, VERDICT_LABELS, freshExplainer, type Verdict } from '../../../lib/quest';
import { AgentAvatar, QuestBadge, RoleGlyph, VerdictChip } from './atoms';
import { CardHeader } from './molecules';
import {
  partyBatches, partyHeadline, partyOutcome, partyTally, partyTitle,
  runCarries, runDoing, runIdentity, runVerdict,
  type Party, type PartyOutcome,
} from './questModel';

/**
 * ORGANISM — the PARTY card, state 9: the agents one dispatch sent, read as a team. Driven by
 * `conv.subAgents` (reduced from the `task-started`/`task-progress`/`task-updated`/
 * `task-notification` ChatEvents; see chatSession.ts's header note), grouped into a `Party`
 * by `questModel.partyBatches`. The header is a team sentence ("3 reviewers are reading the
 * plan · 1 back") under the stage kicker ("Plan review · round 2"); each row is a CHARACTER:
 * face and role emblem, the role's name, what it is doing, and its verdict. A click drills
 * into `SlideOver`'s `mode:'subagent'` for that run's real sidechain transcript.
 *
 * The row answers "who is this, what is it doing, and what did it decide". The plumbing
 * (`subagent_type`, the command line) rides the row's `title`, never its text: the reader
 * is watching a team, not a job queue. Meta chips (duration, model, tokens) render ONLY
 * where the CLI actually reported them (see `runMetaChips`).
 *
 * The card sits WHERE IT WAS SPAWNED in the transcript, so a fan-out that runs for minutes
 * scrolls away under the output that follows it. {@link SubAgentRail} is the same party
 * pinned to the top of the transcript once that happens — ChatPane decides when to show it
 * and scrolls back to the row a chip names.
 *
 * The rows are open while the party is LIVE and collapse to the header the moment the last
 * run lands (`useGroupCollapse`) — a finished fan-out is a record, and a record that keeps N
 * rows of the transcript forever is just cost. The header still reports the whole outcome
 * (the seal says "cleared" or "sent back"), and a click brings the rows back for good.
 */

function statusMark(status: SubAgentRun['status']): string {
  if (status === 'completed') return '✓';
  if (status === 'error') return '⚠';
  if (status === 'stopped') return '■';
  return '▸';
}

/**
 * The party this card speaks for. ChatPane hands the real one (it knows the transcript, so it
 * knows the round); a caller that only has runs gets the same grammar from a one-batch read
 * of them, with no round to claim.
 */
function resolveParty(runs: SubAgentRun[], party: Party | null | undefined): Party | null {
  return party ?? partyBatches([], runs)[0] ?? null;
}

/** Roles whose label alone does not say which one this is: the run's own words go beside it. */
const NAMED_ROLES: ReadonlySet<AgentRoleId> = new Set(['implementer', 'headless', 'agent']);

/** A run's name, only when it is words a person wrote (a dispatch description), never a command line. */
function speakableName(run: SubAgentRun): string | null {
  const name = run.name.trim();
  return name && !JARGON_RE.test(name) ? name : null;
}

/** The row's hover text: the whole identity, plumbing included, for whoever wants it. */
function rowTitle(run: SubAgentRun, role: AgentRoleId): string {
  const kind = run.subagentType ?? (isHeadlessAgentShell(run) ? 'headless' : null);
  return [AGENT_ROLES[role].label, run.name.trim() || null, kind].filter(Boolean).join(' · ');
}

/** "2 Solid · 1 Needs work": the verdicts back so far, only once there is one. */
function tallyText(verdicts: Record<Verdict, number>): string | null {
  const parts = (Object.keys(verdicts) as Verdict[])
    .filter((v) => verdicts[v] > 0)
    .map((v) => `${verdicts[v]} ${VERDICT_LABELS[v]}`);
  return parts.length ? parts.join(' · ') : null;
}

const SEAL_WORDS: Partial<Record<PartyOutcome, string>> = { cleared: 'cleared', 'sent-back': 'sent back' };

/** A finished judged party's stamp. The word carries it; the mark and tint only confirm. */
function PartySeal({ outcome }: { outcome: PartyOutcome }) {
  const word = SEAL_WORDS[outcome];
  if (!word) return null;
  const good = outcome === 'cleared';
  return (
    <span className="chat-subagents-seal" data-outcome={outcome}>
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="8" cy="8" r="6.5" />
        {good ? <path d="M5.2 8.2l1.9 1.9l3.7-3.9" /> : <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" />}
      </svg>
      {word}
    </span>
  );
}

export function SubAgentCard({
  runs: allRuns, party: partyProp, explain = false, onDrillIn, rootRef, highlightRunId, peers = [], conversationId,
}: {
  runs: SubAgentRun[];
  /** The dispatch batch these runs are, from `partyBatches`: its stage and round name the
   *  card ("Plan review · round 2"). Absent, the card reads the runs as one batch with no
   *  round. A ghost party (a resumed chat's calls with no live run) never renders a card. */
  party?: Party;
  /** Show the stage's "fresh eyes" explainer under the header. ChatPane sets it on ONE card
   *  per chat (the first judged party), so the explanation is said once, not per round. */
  explain?: boolean;
  onDrillIn: (run: SubAgentRun) => void;
  /** The parent conversation's claude id, forwarded to each landed run's {@link SubAgentReport}
   *  so it can fetch that run's own transcript for the report text. Absent for a card
   *  rendered outside a live session — the report cards then stay on whatever the run itself
   *  carried, and the drill-in is still one click away. */
  conversationId?: string;
  /** Callback ref for the card's root. ChatPane measures this element to know whether the
   *  card has scrolled off the top of the transcript (→ show the rail), and queries it for
   *  the `data-subagent-row` a rail chip jumps to. */
  rootRef?: (el: HTMLDivElement | null) => void;
  /** The run a rail chip just jumped to — its row flashes for a beat so the eye lands on the
   *  right one instead of hunting through four identically-shaped rows. */
  highlightRunId?: string | null;
  /** Connected peers, so a `peer-<vault>` envoy run wears that vault's identity — its logo
   *  as the avatar and its NAME on a chip — instead of the generic agent look. */
  peers?: PeerMention[];
}) {
  const { vault } = useVault();
  // AGENT runs only. Background shells ride the identical `task_*` frames but belong to
  // `BackgroundShellsTray`: this card's whole affordance is drilling into a sidechain
  // transcript, and a shell has none — clicking one used to open a panel that said the
  // transcript "hasn't flushed yet" about a file that was never going to exist. Filtered here
  // rather than at the call site so no caller can reintroduce that.
  const runs = allRuns.filter(isAgentRun);
  const party = resolveParty(runs, partyProp);
  const { running, total, earliestStart } = summarizeSubAgents(runs);
  // Live while it is live, a header once it lands: a fan-out of N agents held N rows of the
  // transcript forever, and a finished run's row says nothing its group summary doesn't. The
  // rows are one click away — and stay open if the user asks for them (see isGroupOpen).
  const { open, onToggle } = useGroupCollapse(runs);
  // A superseded round was answered by the next one: its reports are history, folded until asked.
  const [showReports, setShowReports] = useState(false);
  // Self-ticking elapsed readout while any run is still going — cleared once none are.
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (running === 0) return;
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  if (total === 0 || !party || party.ghost) return null;

  const reports = reportableRuns(runs);
  const lastEnd = Math.max(0, ...runs.map((r) => r.endedAt ?? 0));
  const elapsed = earliestStart != null ? (running > 0 ? tick : lastEnd || tick) - earliestStart : null;
  const failures = groupOutcomeNote(runs);
  const outcome = partyOutcome(party);
  const tally = tallyText(partyTally(party).verdicts);
  const why = explain ? freshExplainer(party.stage) : null;
  const foldReports = party.superseded && !showReports;

  return (
    <div
      className="chat-subagents"
      data-open={open || undefined}
      data-party-id={party.id}
      data-party-stage={party.stage}
      data-round={party.round}
      data-superseded={party.superseded ? 'true' : 'false'}
      data-outcome={outcome}
      ref={rootRef}
    >
      {/* The kicker needs the transcript to know the round, so only a real party has one. */}
      {partyProp && <div className="chat-subagents-stage">{partyTitle(party)}</div>}
      <CardHeader
        glyph={<RoleGlyph glyph={AGENT_ROLES[party.lead].glyph} size={16} />}
        title={partyHeadline(party)}
        open={open}
        onToggle={onToggle}
        aside={(
          <>
            {tally && <span className="chat-subagents-tally">{tally}</span>}
            {/* Collapsed, this header is the only thing left saying what happened — so a
                failed or killed run is named here, not only on the row that is now hidden. */}
            {failures && <span className="chat-subagents-outcome">{failures}</span>}
            <PartySeal outcome={outcome} />
            {elapsed != null && <span className="chat-subagents-elapsed" title="Time so far">{formatClock(elapsed)}</span>}
            {running > 0 && <span className="chat-subagents-spinner" aria-hidden />}
          </>
        )}
      />
      {why && <p className="chat-subagents-why">{why}</p>}
      {open && (
        <div className="chat-subagents-rows">
          {runs.map((run) => {
            // A peer envoy run is ANOTHER PROJECT working — it wears that project's face
            // (its vault logo, when it ships one) and its vault name on a chip, instead
            // of reading as one more local agent named `peer-<slug>`.
            const peer = peerForAgent(run.subagentType, peers);
            const { role, stage } = runIdentity(run);
            const verdict = run.status === 'running' ? null : runVerdict(run);
            const carries = runCarries(run);
            const name = NAMED_ROLES.has(role) ? speakableName(run) : null;
            return (
            <button
              type="button"
              key={run.taskId}
              className="chat-subagents-row"
              data-role={role}
              data-status={run.status}
              data-peer={peer ? '1' : undefined}
              // The rail's jump target — read by ChatPane off THIS card's subtree, so a split
              // view's two panes can never scroll each other (no document-wide ids).
              data-subagent-row={run.taskId}
              data-flash={run.taskId === highlightRunId ? '1' : undefined}
              title={rowTitle(run, role)}
              onClick={() => onDrillIn(run)}
            >
              <AgentAvatar
                name={run.subagentType ?? run.name}
                size={32}
                role={role}
                running={run.status === 'running'}
                src={peer?.logo ? peerLogoUrl(vault, peer.vault) : undefined}
              />
              <span className="chat-subagents-row-body">
                <span className="chat-subagents-row-head">
                  <span className="chat-subagents-row-role">{AGENT_ROLES[role].label}</span>
                  {peer && <span className="chat-subagents-row-vault">{peer.vault}</span>}
                  {name && <span className="chat-subagents-row-name">{name}</span>}
                  {verdict && <VerdictChip verdict={verdict} />}
                  {carries && <QuestBadge carries={carries} title={freshExplainer(stage) ?? undefined} />}
                </span>
                <span className="chat-subagents-row-sub">
                  <span className="chat-subagents-row-doing">{runDoing(run)}</span>
                  {/* Duration · model · tokens · tools — only ever the fields this run actually
                      reported (see runMetaChips). Right-anchored so the numbers stack into a
                      scannable column while the doing line takes the slack and truncates. */}
                  <span className="chat-subagents-row-meta">
                    {runMetaChips(run, tick).map((chip) => (
                      <span className="chat-subagents-row-chip" key={chip}>{chip}</span>
                    ))}
                  </span>
                </span>
              </span>
              <span className="chat-subagents-row-mark" data-status={run.status} aria-hidden>{statusMark(run.status)}</span>
              {/* Says what the click actually does. A dispatch opens its sidechain transcript;
                  a headless run has none on disk, so its drill-in is the live output panel —
                  which is also where its Stop button lives. */}
              <span className="chat-subagents-row-open" aria-hidden>
                {isHeadlessAgentShell(run) ? 'output →' : 'open →'}
              </span>
            </button>
            );
          })}
        </div>
      )}
      {/* The REPORTS of the runs that have landed — rendered OUTSIDE the `open` gate, because
          they are the point of the collapsed state, not a detail of the expanded one. A
          finished fan-out therefore rests as its header plus one named report per agent,
          which is what the main agent used to re-type into the transcript by hand.
          Deliberately not gated on having the report text in hand either: it arrives on the
          card's own lazy fetch (see SubAgentReport), and a backgrounded dispatch — every
          fan-out this project runs — never carries it on the run. A SUPERSEDED round folds
          them behind one toggle: the round after it is the one the reader is following. */}
      {reports.length > 0 && conversationId && party.superseded && (
        <button
          type="button"
          className="chat-subagents-reports-toggle"
          aria-expanded={showReports}
          onClick={() => setShowReports((v) => !v)}
        >
          {showReports
            ? 'Hide the reports'
            : `Show ${reports.length === 1 ? 'the report' : `the ${reports.length} reports`} from this round`}
          <span aria-hidden>{showReports ? ' ▴' : ' ▾'}</span>
        </button>
      )}
      {reports.length > 0 && conversationId && !foldReports && (
        <div className="chat-subagents-reports">
          {reports.map((run) => (
            <SubAgentReport
              key={`report-${run.taskId}`}
              run={run}
              conversationId={conversationId}
              peers={peers}
              onOpenFull={onDrillIn}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * ORGANISM — the same party, PINNED. Rendered by ChatPane over the top of the transcript
 * once {@link SubAgentCard} has scrolled off (an overlay sibling of the scroller, exactly
 * like the "jump to latest" pill — see ChatPane.css for why it is not a scrolled child).
 * Clicking a chip scrolls the transcript back to that run's row; clicking the summary
 * scrolls to the card itself.
 *
 * It is a summary, not a second card: the party's own headline, then one chip per run —
 * its character at 20px, its role, and a mark once it lands — plus the live clock. The chips
 * stay STILL: the rail is only on screen because something is running, so a moving face on
 * every chip would be motion that means "normal". Everything a row says (what it is doing,
 * model, tokens) stays in the card, one click away rather than crammed into a strip that
 * has to stay readable on one line.
 *
 * Renders NOTHING once every run has finished. A finished fan-out is a record, and a record
 * belongs in the transcript where it happened — pinning it forever would spend the top of
 * every conversation on something that stopped changing.
 */
export function SubAgentRail({ runs: allRuns, party: partyProp, onJump, onWheel, peers = [] }: {
  runs: SubAgentRun[];
  /** The party the pinned card belongs to; its headline is the rail's summary. */
  party?: Party | null;
  /** Scroll the transcript to a run's row — `null` for the card as a whole. */
  onJump: (taskId: string | null) => void;
  /** An overlay is not in the scroller's ancestor chain, so a wheel gesture that starts over
   *  the rail would otherwise scroll nothing. The host forwards it to the transcript. */
  onWheel?: (e: React.WheelEvent<HTMLDivElement>) => void;
  /** Same as {@link SubAgentCard}'s — a peer envoy chip wears its vault's logo and name. */
  peers?: PeerMention[];
}) {
  const { vault } = useVault();
  const runs = allRuns.filter(isAgentRun);
  const party = resolveParty(runs, partyProp);
  const { running, earliestStart } = summarizeSubAgents(runs);
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

  if (running === 0 || !party || party.ghost) return null;
  const headline = partyHeadline(party);

  return (
    // The host spans the transcript so the strip can be laid out against its edges, and
    // passes pointer events THROUGH everywhere except the rail itself.
    <div className="chat-subagents-rail-host" onWheel={onWheel}>
      <div className="chat-subagents-rail" role="group" aria-label={headline}>
        <button
          type="button"
          className="chat-subagents-rail-summary"
          onClick={() => onJump(null)}
          title="Scroll to the team"
        >
          <span className="chat-subagents-rail-glyph" aria-hidden>
            <RoleGlyph glyph={AGENT_ROLES[party.lead].glyph} size={14} />
          </span>
          {/* The card's own headline — the PARTY is what it names, so a fan-out where one has
              already landed still reads "3 reviewers are reading the plan · 1 back". */}
          <span className="chat-subagents-rail-count">{headline}</span>
          {earliestStart != null && (
            <span className="chat-subagents-elapsed">{formatClock(tick - earliestStart)}</span>
          )}
          <span className="chat-subagents-spinner" aria-hidden />
        </button>
        <div className="chat-subagents-rail-chips" ref={chipsRef} data-overflow={overflowing ? '1' : undefined}>
          {runs.map((run) => {
            const peer = peerForAgent(run.subagentType, peers);
            const { role } = runIdentity(run);
            const label = peer ? peer.vault : AGENT_ROLES[role].label;
            return (
            <button
              type="button"
              key={run.taskId}
              className="chat-subagents-rail-chip"
              data-role={role}
              data-status={run.status}
              data-peer={peer ? '1' : undefined}
              // The chip has room for the role only; who it is and what it is doing right
              // now ride the tooltip.
              title={`${rowTitle(run, role)} · ${runDoing(run)}`}
              onClick={() => onJump(run.taskId)}
            >
              <AgentAvatar
                name={run.subagentType ?? run.name}
                size={20}
                role={role}
                src={peer?.logo ? peerLogoUrl(vault, peer.vault) : undefined}
              />
              <span className="chat-subagents-rail-chip-label">{label}</span>
              {/* Only a FINISHED run is marked. Running is the rail's whole premise (it is
                  only on screen because something is running, and the group spinner says
                  so) — a `▸` on every live chip would be four glyphs that mean "normal". */}
              {run.status !== 'running' && (
                <span className="chat-subagents-rail-chip-mark" data-status={run.status} aria-hidden>
                  {statusMark(run.status)}
                </span>
              )}
            </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
