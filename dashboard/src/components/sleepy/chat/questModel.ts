import {
  isDispatchedAgent, isHeadlessAgentShell, runReportText, toolResultText, type SubAgentRun,
} from './chatEntities';
import { parseChatActions } from './chatActions';
import { dreamOutcome, parseDreamActions } from './dreamCommand';
import { actionText, isQuestOnlyCommand, toolAction } from './toolAction';
import {
  AGENT_ROLES, LEAD_NAME, QUEST_STAGE_LABELS, STAGE_ACTS, isJudgeRole, resolveAgentIdentity,
  type AgentIdentity, type AgentRoleId, type PartyStageId, type QuestStageId,
} from '../../../lib/agentRoles';
import {
  JARGON_RE, QUEST_TEMPLATES, lineageNote,
  type Carries, type QuestLineage, type QuestLineageNode, type QuestMember, type QuestOutcomeKind,
  type QuestStage, type QuestView, type Verdict, verdictOf,
} from '../../../lib/quest';

/**
 * A Plan or Develop chat's agent work, read as a QUEST: who was sent (parties), how far the
 * run got (the quest view), and who was built from whom (the lineage).
 *
 * Everything is inferred from the stream the chat already has: the dispatch tool calls, the
 * sub-agent runs they started, and the brain calls the agent made (`tasks create`, `tasks
 * status`, the `develop` hand-off). There is no live file for a chat run; the goal-skill's
 * live file is `lib/quest.ts`'s `goalQuest`. Both produce the same `QuestView`.
 *
 * Every sentence here is user-facing copy under the plain-language rule (`JARGON_RE`): the
 * lead is `LEAD_NAME`, and nothing names the plumbing.
 */

/** The subset of a transcript item this module reads. Structural, so `ChatItem` satisfies it. */
export interface QuestEntry {
  kind: string; id: string; toolUseId?: string; name?: string; input?: unknown; status?: string;
  text?: string; done?: boolean; ts?: number; startedAt?: number;
  /** A tool call's own result: how a ghost run's verdict, and a status call's success, are read. */
  result?: unknown;
}

/** One dispatch batch: the agents sent together, rendered as one party card. */
export interface Party {
  id: string;
  runs: SubAgentRun[];
  stage: PartyStageId;
  lead: AgentRoleId;
  /** 1-based among parties of the same stage (the wave, for a build). 0 for scouting and teamwork. */
  round: number;
  anchorEntryId: string | null;
  /** `replace`: the card takes the first Agent call's place. `after`: it follows the headless
   *  Bash row that started it. `trailing`: no call of this chat started it; it trails. */
  anchorKind: 'replace' | 'after' | 'trailing';
  /** A later party of the same judging stage exists: this round was answered. */
  superseded: boolean;
  /** Every member was rebuilt from a transcript call with no live run (a resumed chat). A
   *  ghost party feeds the quest and the lineage, and never renders a card. */
  ghost: boolean;
}

export type PartyOutcome = 'running' | 'cleared' | 'sent-back' | 'ended';

const GHOST_PREFIX = 'ghost:';

/** How long a beat reads as news. Mirrors `lib/quest.ts`'s goal-run beat. */
const BEAT_FRESH_MS = 8000;

const JUDGED_STAGES: ReadonlySet<PartyStageId> = new Set(['review', 'boss', 'trial']);

function inputStr(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

// ─── One run ───────────────────────────────────────────────────────────────────────

function isGhost(run: SubAgentRun): boolean {
  return run.taskId.startsWith(GHOST_PREFIX);
}

export function runIdentity(run: SubAgentRun): AgentIdentity {
  return resolveAgentIdentity({
    subagentType: run.subagentType,
    name: run.name,
    prompt: run.prompt,
    // A headless run whose spawning call was never seen is named after its own command.
    command: run.command ?? (run.taskType === 'local_bash' ? run.name : undefined),
    taskType: run.taskType,
  });
}

/** A judge's verdict, from its own summary or report. Best effort; never guessed. */
export function runVerdict(run: SubAgentRun): Verdict | null {
  if (!isJudgeRole(runIdentity(run).role)) return null;
  return verdictOf(run.summary) ?? verdictOf(runReportText(run));
}

/**
 * What the character brings into the room. A judge always arrives with fresh eyes. A headless
 * builder started from someone's copied memory, or brought back to its own, carries memory.
 * Everyone else started from only a brief, which is not worth a badge.
 */
export function runCarries(run: SubAgentRun): Carries | null {
  const { role } = runIdentity(run);
  if (isJudgeRole(role)) return 'fresh';
  if (isHeadlessAgentShell(run)) {
    const command = run.command ?? run.name;
    if (/(?:^|\s)(?:--fork-session|--resume|-r)(?:[\s=]|$)/.test(command)) return 'memory';
  }
  return null;
}

/** The row's "doing" line: what it is on right now, or how it ended. */
export function runDoing(run: SubAgentRun): string {
  const { stage } = runIdentity(run);
  if (run.status === 'completed') return capitalize(STAGE_ACTS[stage].past);
  if (run.status === 'error') return 'Ran into a problem';
  if (run.status === 'stopped') return 'Stopped';
  const activity = run.activity?.trim();
  if (activity) return /(?:…|\.\.\.)$/.test(activity) ? activity : `${activity}…`;
  if (run.lastToolName) return actionText(toolAction(run.lastToolName, undefined, 'running'));
  if (stage !== 'none') return `${capitalize(STAGE_ACTS[stage].present)}…`;
  return 'Getting started…';
}

// ─── Parties ───────────────────────────────────────────────────────────────────────

/** A transcript Agent call with no live run (a resumed chat), rebuilt from its own input. */
function ghostRun(e: QuestEntry): SubAgentRun {
  const started = e.startedAt ?? e.ts ?? 0;
  return {
    taskId: `${GHOST_PREFIX}${e.toolUseId ?? e.id}`,
    toolUseId: e.toolUseId,
    name: inputStr(e.input, 'description') ?? '',
    subagentType: inputStr(e.input, 'subagent_type'),
    prompt: inputStr(e.input, 'prompt'),
    status: e.status === 'running' ? 'running' : e.status === 'error' ? 'error' : 'completed',
    startedAt: started,
    resultContent: e.result,
  };
}

function isAgentCall(e: QuestEntry): boolean {
  return e.kind === 'tool' && (e.name === 'Agent' || e.name === 'Task');
}

function isQuestOnlyEntry(e: QuestEntry): boolean {
  return e.kind === 'tool' && e.name === 'Bash' && isQuestOnlyCommand(inputStr(e.input, 'command'));
}

/** Draws nothing and says nothing: it neither joins a batch nor closes one. */
function isTransparent(e: QuestEntry): boolean {
  if (e.kind === 'thinking') return true;
  if (e.kind === 'text') return !e.text?.trim();
  return isQuestOnlyEntry(e);
}

/** The value the most members share; a tie goes to the earliest member. */
function majority<V>(values: readonly V[]): V {
  const counts = new Map<V, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0];
  for (const v of values) if ((counts.get(v) ?? 0) > (counts.get(best) ?? 0)) best = v;
  return best;
}

interface Batch { runs: SubAgentRun[]; anchor: QuestEntry | null; kind: Party['anchorKind'] }

/**
 * The chat's parties, in transcript order. A party is a maximal stretch of dispatch calls:
 * Agent calls and headless `claude` Bash calls, with only thinking, empty text and quest-map
 * bookkeeping between them. Anything the reader can see closes it, so one message's parallel
 * dispatches are ONE party and a round sent after "Revising" is the next.
 *
 * Runs that no call in `entries` started trail the transcript as one last party.
 */
export function partyBatches(entries: readonly QuestEntry[], runs: readonly SubAgentRun[]): Party[] {
  const agentRuns = runs.filter((r) => isDispatchedAgent(r) || isHeadlessAgentShell(r));
  const byToolUse = new Map<string, SubAgentRun>();
  for (const r of agentRuns) if (r.toolUseId && !byToolUse.has(r.toolUseId)) byToolUse.set(r.toolUseId, r);

  const batches: Batch[] = [];
  const placed = new Set<string>();
  // A run adopted off the roster carries no tool id; its Agent call is matched by the
  // description instead, so a resumed chat does not draw the same agent as a ghost AND a straggler.
  const adopted = (e: QuestEntry): SubAgentRun | undefined => {
    const description = inputStr(e.input, 'description');
    return description ? agentRuns.find((r) => !r.toolUseId && !placed.has(r.taskId) && r.name === description) : undefined;
  };
  let open: Batch | null = null;
  for (const e of entries) {
    const live = e.kind === 'tool' && e.toolUseId ? byToolUse.get(e.toolUseId) : undefined;
    const run = live ?? (isAgentCall(e) ? adopted(e) ?? ghostRun(e) : undefined);
    if (run) {
      if (!open) {
        open = { runs: [], anchor: e, kind: isHeadlessAgentShell(run) ? 'after' : 'replace' };
        batches.push(open);
      }
      open.runs.push(run);
      placed.add(run.taskId);
      continue;
    }
    if (!isTransparent(e)) open = null;
  }
  const orphans = agentRuns.filter((r) => !placed.has(r.taskId));
  if (orphans.length) batches.push({ runs: orphans, anchor: null, kind: 'trailing' });

  const seen = new Map<PartyStageId, number>();
  const parties = batches.map((b): Party => {
    const identities = b.runs.map(runIdentity);
    const stage = majority(identities.map((i) => i.stage));
    const round = stage === 'scout' || stage === 'none' ? 0 : (seen.get(stage) ?? 0) + 1;
    seen.set(stage, round);
    return {
      id: b.anchor ? `party-${b.anchor.id}` : `party-trailing-${b.runs[0].taskId}`,
      runs: b.runs,
      stage,
      lead: majority(identities.map((i) => i.role)),
      round,
      anchorEntryId: b.anchor?.id ?? null,
      anchorKind: b.kind,
      superseded: false,
      ghost: b.runs.every(isGhost),
    };
  });
  for (let i = 0; i < parties.length; i += 1) {
    const p = parties[i];
    p.superseded = JUDGED_STAGES.has(p.stage) && parties.slice(i + 1).some((later) => later.stage === p.stage);
  }
  return parties;
}

/** The card's kicker: "Plan review · round 2", "Build · wave 1", "Scouting". */
export function partyTitle(p: Party): string {
  switch (p.stage) {
    case 'review': case 'boss': case 'trial':
      return `${QUEST_STAGE_LABELS[p.stage]} · round ${p.round}`;
    case 'build':
      return `${QUEST_STAGE_LABELS.build} · wave ${p.round}`;
    case 'scout': return 'Scouting';
    case 'none': return 'Teamwork';
    default: return QUEST_STAGE_LABELS[p.stage];
  }
}

/** "Scout", or "3 reviewers": the party named the way a person would count it. */
function partyNoun(p: Party): string {
  const roles = p.runs.map((r) => AGENT_ROLES[runIdentity(r).role]);
  if (roles.length === 1) return roles[0].noun.one;
  const many = roles.every((r) => r.noun.many === roles[0].noun.many) ? roles[0].noun.many : 'teammates';
  return `${roles.length} ${many}`;
}

/** The card's title, a team sentence: "3 reviewers are reading the plan · 1 back". */
export function partyHeadline(p: Party): string {
  const tally = partyTally(p);
  const act = STAGE_ACTS[p.stage];
  const noun = partyNoun(p);
  if (tally.running === 0) return `${noun} ${act.past}`;
  const verb = p.runs.length === 1 ? 'is' : 'are';
  const back = tally.landed > 0 ? ` · ${tally.landed} back` : '';
  return `${noun} ${verb} ${act.present}${back}`;
}

export function partyOutcome(p: Party): PartyOutcome {
  if (p.runs.some((r) => r.status === 'running')) return 'running';
  if (JUDGED_STAGES.has(p.stage)) {
    const verdicts = p.runs.map(runVerdict);
    if (verdicts.some((v) => v === 'needs-work' || v === 'fail')) return 'sent-back';
    return verdicts.every((v) => v === 'solid' || v === 'pass') ? 'cleared' : 'ended';
  }
  return p.runs.every((r) => r.status === 'completed') ? 'cleared' : 'ended';
}

/** The quest map's beat for this party: "Claude called 3 reviewers with fresh eyes". */
export function partyBeat(p: Party): string {
  const n = p.runs.length;
  const role = AGENT_ROLES[p.lead];
  if (isJudgeRole(p.lead)) {
    return `${LEAD_NAME} called ${n === 1 ? `the ${role.label.toLowerCase()}` : partyNoun(p)} with fresh eyes`;
  }
  if (p.stage === 'scout') return `${LEAD_NAME} sent ${n === 1 ? 'the scout' : partyNoun(p)}`;
  if (n === 1) return `${LEAD_NAME} briefed ${/^[AEIOU]/.test(role.label) ? 'an' : 'a'} ${role.label}`;
  return `${LEAD_NAME} briefed ${partyNoun(p)}`;
}

export interface PartyTally { running: number; landed: number; total: number; verdicts: Record<Verdict, number> }

export function partyTally(p: Party): PartyTally {
  const verdicts: Record<Verdict, number> = { solid: 0, 'needs-work': 0, pass: 0, fail: 0 };
  let running = 0;
  for (const r of p.runs) {
    // A judge still at work has not answered yet, whatever its summary says so far.
    if (r.status === 'running') { running += 1; continue; }
    const v = runVerdict(r);
    if (v) verdicts[v] += 1;
  }
  return { running, landed: p.runs.length - running, total: p.runs.length, verdicts };
}

// ─── The chat as a quest ───────────────────────────────────────────────────────────

/** The composer shelf's task progress, as far as the quest reads it (`TaskProgress` fits). */
export interface QuestProgressProbe { slug: string; state: string; done: number; total: number }

function entryTime(e: QuestEntry): number | null {
  return e.startedAt ?? e.ts ?? null;
}

/** A Bash call that finished and whose CLI did not report a failure. */
function succeededCommand(e: QuestEntry): string | null {
  if (e.kind !== 'tool' || e.name !== 'Bash' || e.status !== 'done') return null;
  const command = inputStr(e.input, 'command');
  if (!command) return null;
  if (e.result !== undefined && dreamOutcome(toolResultText(e.result))?.tone === 'error') return null;
  return command;
}

/** The newest successful `tasks status <slug> <state>` the chat ran, as the run's own verdict on itself. */
function lastStatusCall(entries: readonly QuestEntry[]): { slug: string; state: string; at: number | null } | null {
  let found: { slug: string; state: string; at: number | null } | null = null;
  for (const e of entries) {
    const command = succeededCommand(e);
    if (!command) continue;
    for (const a of parseDreamActions(command)) {
      if (a.path === 'tasks status' && a.args.length >= 2) found = { slug: a.args[0], state: a.args[1], at: entryTime(e) };
    }
  }
  return found;
}

const DEVELOP_WINS: Readonly<Record<string, QuestOutcomeKind>> = { completed: 'cleared', in_review: 'awaiting-signoff' };

/** The outcome a task status means, read as an own property: the state word is agent-typed. */
function developWin(state: string): QuestOutcomeKind | undefined {
  return Object.prototype.hasOwnProperty.call(DEVELOP_WINS, state) ? DEVELOP_WINS[state] : undefined;
}

/** Where a party's members sit on this quest's map, or null when the map has no seat for them. */
function questStageOf(stage: PartyStageId, mode: 'plan' | 'develop'): QuestStageId | null {
  const seat = stage === 'scout' && mode === 'plan' ? 'draft' : stage;
  return (QUEST_TEMPLATES[mode] as readonly string[]).includes(seat) ? seat as QuestStageId : null;
}

function memberState(run: SubAgentRun): QuestMember['state'] {
  if (run.status === 'running') return 'run';
  return run.status === 'completed' ? 'done' : 'fail';
}

interface Reach { at: number | null; rounds: number }

/**
 * A Plan or Develop chat as a quest map, or null before the user has said anything.
 *
 * Plan: Ask → Draft (a second user turn, an answered question, a scout or draft party, or any
 * later stage) → Plan review (one round per review party) → Task (a task created, or a
 * progress view). Sealed when a finished answer offers the `develop` hand-off.
 *
 * Develop: Build (always; one wave per build party, the criteria meter from progress) → Boss
 * gate → Final trial. Won when the chat moved its task to `completed` (cleared) or
 * `in_review` (awaiting sign-off).
 */
export function deriveChatQuest(i: {
  mode: 'plan' | 'develop'; entries: readonly QuestEntry[]; parties: readonly Party[];
  progress: QuestProgressProbe | null; now?: number;
}): QuestView | null {
  const { mode, entries, parties, progress } = i;
  const users = entries.filter((e) => e.kind === 'user');
  if (users.length === 0) return null;
  const template = QUEST_TEMPLATES[mode];
  const startedAt = entryTime(users[0]);
  const reach = new Map<QuestStageId, Reach>();
  const mark = (stage: QuestStageId, at: number | null, rounds = 1) => {
    const cur = reach.get(stage);
    reach.set(stage, { at: cur?.at ?? at, rounds: Math.max(cur?.rounds ?? 0, rounds) });
  };
  for (const p of parties) {
    const stage = questStageOf(p.stage, mode);
    if (!stage) continue;
    const count = parties.filter((q) => questStageOf(q.stage, mode) === stage).length;
    mark(stage, p.runs[0]?.startedAt ?? null, stage === 'draft' ? 1 : count);
  }

  let won: { kind: QuestOutcomeKind; slug: string | null; at: number | null } | null = null;
  if (mode === 'plan') {
    mark('ask', startedAt);
    if (users.length >= 2) mark('draft', entryTime(users[1]));
    for (const e of entries) {
      if (e.kind === 'tool' && e.name === 'AskUserQuestion' && e.status === 'done') mark('draft', entryTime(e));
      const command = succeededCommand(e);
      if (command && parseDreamActions(command).some((a) => a.path === 'tasks create')) mark('task', entryTime(e));
      if (e.kind === 'text' && e.done && e.text) {
        const develop = parseChatActions(e.text).actions.find((a) => a.action === 'develop');
        if (develop) won = { kind: 'sealed', slug: develop.id ?? progress?.slug ?? null, at: entryTime(e) };
      }
    }
    if (progress) mark('task', null);
  } else {
    mark('build', startedAt, parties.filter((p) => p.stage === 'build').length || 1);
    const status = lastStatusCall(entries);
    const kind = status ? developWin(status.state) : undefined;
    if (status && kind) won = { kind, slug: status.slug, at: status.at };
  }

  // The furthest stage reached is the active one; everything before it counts as done, which
  // is how a skipped Ask still reads as passed once the draft exists.
  const furthest = template.reduce((acc, id, idx) => (reach.has(id) ? idx : acc), 0);
  const activeIndex = won ? template.length : furthest;
  const buildParties = parties.filter((p) => p.stage === 'build').length;
  const stages = template.map((id, idx): QuestStage => {
    const state = idx < activeIndex ? 'done' : idx === activeIndex ? 'active' : 'todo';
    const stage: QuestStage = { id, label: QUEST_STAGE_LABELS[id], state, rounds: state === 'todo' ? 0 : Math.max(1, reach.get(id)?.rounds ?? 0) };
    if (id === 'build') {
      if (buildParties > 0) stage.wave = { at: buildParties, of: null };
      if (progress && (progress.state === 'ok' || progress.state === 'all-done') && progress.total > 0) {
        stage.meter = { done: progress.done, total: progress.total };
      }
    }
    return stage;
  });

  const now = i.now ?? Date.now();
  const latest = [...parties].reverse().find((p) => p.runs.some((r) => r.status === 'running')) ?? parties[parties.length - 1];
  const seat = latest ? questStageOf(latest.stage, mode) : null;
  const cast: QuestMember[] = won || !latest || !seat ? [] : latest.runs.map((run) => {
    const role = runIdentity(run).role;
    return {
      key: run.taskId, role, name: AGENT_ROLES[role].label, stage: seat,
      state: memberState(run), verdict: runVerdict(run), carries: runCarries(run),
    };
  });
  const beatAt = latest?.runs[0]?.startedAt ?? null;

  const judged = parties.filter((p) => (mode === 'plan' ? p.stage === 'review' : p.stage === 'boss' || p.stage === 'trial'));
  const timeline = template
    .flatMap((id) => {
      const at = reach.get(id)?.at;
      return at != null ? [{ stage: id as QuestStageId | 'done', at }] : [];
    })
    .concat(won?.at != null ? [{ stage: 'done', at: won.at }] : [])
    .sort((a, b) => a.at - b.at);

  return {
    kind: mode,
    title: won?.slug ?? progress?.slug ?? null,
    stages,
    activeIndex,
    cast,
    branch: null,
    beat: latest ? { text: partyBeat(latest), stale: beatAt == null || now - beatAt > BEAT_FRESH_MS } : null,
    outcome: won
      ? {
        kind: won.kind,
        taskSlug: won.slug,
        rounds: judged.length,
        agents: parties.reduce((n, p) => n + p.runs.length, 0),
        elapsedMs: won.at != null && startedAt != null ? Math.max(0, won.at - startedAt) : null,
      }
      : null,
    startedAt,
    timeline,
  };
}

// ─── Develop: how this was built ───────────────────────────────────────────────────

function lineageKind(run: SubAgentRun, role: AgentRoleId): QuestLineageNode['kind'] {
  if (isHeadlessAgentShell(run)) {
    const command = run.command ?? run.name;
    if (/(?:^|\s)--fork-session(?:[\s=]|$)/.test(command)) return 'fork';
    if (/(?:^|\s)(?:--resume|-r)(?:[\s=]|$)/.test(command)) return 'resume';
  }
  return isJudgeRole(role) ? 'fresh' : 'spawn';
}

/** A run's own name, only when it is words a person wrote, never a command line. */
function speakableName(run: SubAgentRun): string | null {
  const name = run.name.trim();
  return name && !JARGON_RE.test(name) ? name : null;
}

/**
 * The Develop chat's family tree for the "How this was built" receipt. Everyone hangs under
 * the lead: a chat does not record whose memory a builder copied, so the tree does not claim
 * one, and no token count is ever shown (nothing was measured). A judge that came back for a
 * second round is ONE node with both rounds, the way the goal-skill receipt merges an actor.
 */
export function chatLineage(parties: readonly Party[], entries: readonly QuestEntry[]): QuestLineage {
  const nodes: QuestLineageNode[] = [];
  const judges = new Map<AgentRoleId, QuestLineageNode>();
  for (const p of parties) {
    for (const run of p.runs) {
      const role = runIdentity(run).role;
      const rounds = p.round > 0 ? [p.round] : [];
      const existing = isJudgeRole(role) ? judges.get(role) : undefined;
      if (existing) {
        existing.rounds = [...new Set([...existing.rounds, ...rounds])].sort((a, b) => a - b);
        existing.state = memberState(run);
        existing.verdict = runVerdict(run) ?? existing.verdict;
        continue;
      }
      const kind = lineageKind(run, role);
      const name = isJudgeRole(role) ? null : speakableName(run);
      const node: QuestLineageNode = {
        key: run.taskId,
        role,
        label: name ? `${AGENT_ROLES[role].label} · ${name}` : AGENT_ROLES[role].label,
        kind,
        rounds,
        state: memberState(run),
        verdict: runVerdict(run),
        carries: runCarries(run),
        ctx: null,
        note: lineageNote(kind, role, AGENT_ROLES.planner.label, null),
        children: [],
      };
      if (isJudgeRole(role)) judges.set(role, node);
      nodes.push(node);
    }
  }
  const running = parties.some((p) => p.runs.some((r) => r.status === 'running'));
  const status = lastStatusCall(entries);
  const finished = !!status && developWin(status.state) != null;
  return {
    root: {
      key: 'lead', role: 'lead', label: LEAD_NAME, kind: 'lead', rounds: [],
      state: running && !finished ? 'run' : 'done', verdict: null, carries: null, ctx: null,
      note: lineageNote('lead', 'lead', LEAD_NAME, null), children: nodes,
    },
    copies: nodes.filter((n) => n.kind === 'fork').length,
    returns: nodes.filter((n) => n.kind === 'resume').length,
    fresh: nodes.filter((n) => n.kind === 'fresh').length,
    reusedTokens: null,
  };
}
