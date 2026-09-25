/**
 * The QUEST view model: one shape for every run the chat shows as a quest map, whatever
 * produced it. A Plan or Develop chat builds one by reading its own stream
 * (chat/questModel.ts); a goal-skill run builds one from its live file (`goalQuest` below).
 * The quest map, the win beat and the "How this was built" receipt only ever read this.
 *
 * Every sentence here is user-facing copy, so it follows the plain-language rule: the lead is
 * `LEAD_NAME`, and nothing says how the orchestration is wired (see `JARGON_RE`). Every number
 * is either read off the run or absent; nothing is estimated.
 */

import {
  AGENT_ROLES, LEAD_NAME, QUEST_STAGE_LABELS, isJudgeRole, roleOf,
  type AgentRoleId, type PartyStageId, type QuestStageId,
} from './agentRoles';
import type { GoalForkState, GoalLiveFork, GoalLiveLineage, GoalLiveState } from './goalLive';

export type { PartyStageId, QuestStageId } from './agentRoles';

export type QuestKind = 'plan' | 'develop' | 'goal';
export type Verdict = 'solid' | 'needs-work' | 'pass' | 'fail';
/** What a character brings into the room: memory it inherited, or fresh eyes. */
export type Carries = 'memory' | 'fresh';

export interface QuestStage {
  id: QuestStageId;
  label: string;
  state: 'todo' | 'active' | 'done';
  /** How many times the stage ran. 0 = never entered, 2+ = it looped. */
  rounds: number;
  /** Build only. Omitted when there is no wave to report. */
  wave?: { at: number; of: number | null };
  /** Build only: acceptance criteria ticked on disk. */
  meter?: { done: number; total: number };
}

export interface QuestMember {
  key: string;
  role: AgentRoleId;
  name: string;
  stage: QuestStageId | null;
  state: GoalForkState;
  verdict: Verdict | null;
  carries: Carries | null;
}

/** One character's memory copied into several. `ctxEach` is per builder, `null` where unmeasured. */
export interface QuestBranch {
  fromKey: string;
  fromRole: AgentRoleId;
  toKeys: string[];
  ctxEach: (number | null)[];
  ctxTotal: number | null;
}

export type QuestOutcomeKind = 'sealed' | 'cleared' | 'awaiting-signoff';

export interface QuestOutcome {
  kind: QuestOutcomeKind;
  taskSlug: string | null;
  rounds: number;
  agents: number;
  elapsedMs: number | null;
}

export interface QuestView {
  kind: QuestKind;
  title: string | null;
  stages: QuestStage[];
  /** Index of the active stage; `stages.length` once won. */
  activeIndex: number;
  /** The characters acting right now, each placed on its stage. */
  cast: QuestMember[];
  branch: QuestBranch | null;
  beat: { text: string; stale: boolean } | null;
  outcome: QuestOutcome | null;
  startedAt: number | null;
  timeline: { stage: QuestStageId | 'done'; at: number }[];
}

export interface QuestLineageNode {
  key: string;
  role: AgentRoleId;
  label: string;
  kind: 'lead' | 'spawn' | 'fork' | 'resume' | 'fresh';
  rounds: number[];
  state: GoalForkState;
  verdict: Verdict | null;
  carries: Carries | null;
  ctx: number | null;
  note: string;
  children: QuestLineageNode[];
}

export interface QuestLineage {
  root: QuestLineageNode;
  copies: number;
  returns: number;
  fresh: number;
  /** Sum of measured context over copied memories; null unless EVERY copy was measured. */
  reusedTokens: number | null;
}

export const QUEST_TEMPLATES: Readonly<Record<QuestKind, readonly QuestStageId[]>> = {
  plan: ['ask', 'draft', 'review', 'task'],
  develop: ['build', 'boss', 'trial'],
  goal: ['draft', 'review', 'task', 'build', 'boss', 'trial'],
};

/** A goal-skill phase → the quest stage it advances. */
export const GOAL_PHASE_TO_STAGE: Readonly<Record<string, QuestStageId>> = {
  plan: 'draft',
  review: 'review',
  task: 'task',
  impl: 'build',
  codereview: 'boss',
  validate: 'trial',
};

/** Words the quest UI must never show: they describe the plumbing, not the work. */
export const JARGON_RE = /fork|session|resume|--|(?:^|\s)-p(?:\s|$)/i;

export const VERDICT_LABELS: Readonly<Record<Verdict, string>> = {
  solid: 'Solid',
  'needs-work': 'Needs work',
  pass: 'Pass',
  fail: 'Fail',
};

/** How long a beat reads as news before it settles into the quieter colour. */
const BEAT_FRESH_MS = 8000;

// ─── Verdicts ─────────────────────────────────────────────────────────────────────

/** Markdown and label noise in front of a judge's first line: `## Review: `, `**`, `> `. */
function stripLead(line: string): string {
  return line
    .replace(/^[\s#>*_`-]+/, '')
    .replace(/^(?:verdict|review)\s*:\s*/i, '')
    .replace(/^[\s*_`]+/, '');
}

/**
 * The verdict a judge wrote, read off its first three non-empty lines. The word must LEAD the
 * line (every judge contract here opens with it), so "Previously SOLID, now…" is not a verdict,
 * and a line naming both PASS and FAIL is a template, not an answer. Upper case only: "passes"
 * in prose is never read as a pass. Nothing found → null, never a guess.
 */
export function verdictOf(text: string | null | undefined): Verdict | null {
  if (!text) return null;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3);
  for (const raw of lines) {
    const line = stripLead(raw);
    if (/\bPASS(?:ED)?\b/.test(line) && /\bFAIL(?:ED)?\b/.test(line)) return null;
    if (/^NEEDS[_ ]WORK\b/.test(line)) return 'needs-work';
    if (/^SOLID\b/.test(line)) return 'solid';
    if (/^FAIL(?:ED)?\b/.test(line)) return 'fail';
    if (/^PASS(?:ED)?\b/.test(line)) return 'pass';
  }
  return null;
}

// ─── Formatting ───────────────────────────────────────────────────────────────────

export function formatQuestTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function formatQuestElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ─── Copy ─────────────────────────────────────────────────────────────────────────

/** The line a lineage node reads under its name. `parentLabel` names whose memory it copied. */
export function lineageNote(
  kind: QuestLineageNode['kind'], role: AgentRoleId, parentLabel: string, ctx: number | null,
): string {
  switch (kind) {
    case 'lead': return 'Leads the team';
    case 'spawn': return `Briefed by ${LEAD_NAME}`;
    case 'fork': return `Started with the ${parentLabel}'s full memory${ctx != null ? ` · ${formatQuestTokens(ctx)} tokens not rebuilt` : ''}`;
    case 'resume': return 'Picked up where it left off';
    case 'fresh': return isJudgeRole(role)
      ? 'Fresh eyes: sees only the work, never the reasoning'
      : 'Started fresh with only its brief';
  }
}

/** The one-line why for a judge party. Null for stages whose members are not judges. */
export function freshExplainer(stage: PartyStageId): string | null {
  switch (stage) {
    case 'review': return `Fresh eyes: they see only the plan, never ${LEAD_NAME}'s reasoning, so they can't be talked into agreeing.`;
    case 'boss': return "Fresh eyes: it reads the changes itself, never the builders' reasoning.";
    case 'trial': return 'Fresh eyes: it runs the checks itself and reports what it saw.';
    default: return null;
  }
}

/** "The Planner's memory was copied into 3 builders", plus the saving only when every copy was measured. */
export function branchCaption(b: QuestBranch, fromLabel: string): string {
  const head = `The ${fromLabel}'s memory was copied into ${plural(b.toKeys.length, 'builder')}`;
  if (b.ctxTotal == null) return head;
  const each = b.ctxEach[0];
  const same = b.ctxEach.every((c) => c === each);
  return same && each != null
    ? `${head}: ${formatQuestTokens(each)} tokens each, not rebuilt`
    : `${head}: ${formatQuestTokens(b.ctxTotal)} tokens, not rebuilt`;
}

const VICTORY_HEADLINES: Readonly<Record<QuestOutcomeKind, string>> = {
  sealed: 'Plan sealed',
  cleared: 'Quest cleared',
  'awaiting-signoff': 'Ready for your sign-off',
};

export function questVictoryCopy(q: QuestView): { headline: string; stats: string } | null {
  const o = q.outcome;
  if (!o) return null;
  const parts: string[] = [];
  if (o.taskSlug) parts.push(o.taskSlug);
  if (o.rounds > 0) parts.push(o.kind === 'sealed' ? plural(o.rounds, 'review round') : plural(o.rounds, 'round'));
  if (o.agents > 0) parts.push(plural(o.agents, 'agent'));
  if (o.elapsedMs != null) parts.push(formatQuestElapsed(o.elapsedMs));
  return { headline: VICTORY_HEADLINES[o.kind], stats: parts.join(' · ') };
}

// ─── goal-skill: the live file as a quest ─────────────────────────────────────────

/** The phase that feeds each stage's round count (`iters` is keyed by phase). */
const STAGE_TO_PHASE: Readonly<Record<QuestStageId, string>> = {
  ask: 'ask', draft: 'plan', review: 'review', task: 'task', build: 'impl', boss: 'codereview', trial: 'validate',
};

/** The role a judge seat defaults to when the file does not name one. */
const DEFAULT_JUDGE_ROLE: Partial<Record<QuestStageId, AgentRoleId>> = {
  review: 'plan-reviewer', boss: 'reviewer', trial: 'validator',
};

function parseTime(iso: string | undefined): number | null {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : null;
}

/** Memory if the actor ever inherited context; fresh eyes if it judges; otherwise nothing to claim. */
function carriesFor(role: AgentRoleId, events: readonly GoalLiveLineage[]): Carries | null {
  if (events.some((e) => e.k === 'fork' || e.k === 'resume')) return 'memory';
  return isJudgeRole(role) ? 'fresh' : null;
}

function eventsFor(lineage: readonly GoalLiveLineage[], id: string): GoalLiveLineage[] {
  return lineage.filter((e) => e.a === id);
}

function seatName(f: GoalLiveFork, label: string, i: number): string {
  if (f.id && f.name) return `${f.id} · ${f.name}`;
  return f.name ?? f.id ?? `${label} ${i + 1}`;
}

function castOf(s: GoalLiveState, stage: QuestStageId | null, lineage: readonly GoalLiveLineage[]): QuestMember[] {
  if (!stage) return [];
  const seats = stage === 'build' ? s.impl?.forks ?? [] : DEFAULT_JUDGE_ROLE[stage] ? s.judges ?? [] : [];
  if (seats.length === 0 && stage === 'draft') {
    const planner = [...lineage].reverse().find((e) => roleOf(e.role).id === 'planner');
    if (!planner) return [];
    return [{
      key: planner.a, role: 'planner', name: AGENT_ROLES.planner.label, stage, state: 'run', verdict: null,
      carries: carriesFor('planner', eventsFor(lineage, planner.a)),
    }];
  }
  return seats.map((f, i) => {
    const role = roleOf(f.role ?? (stage === 'build' ? 'implementer' : DEFAULT_JUDGE_ROLE[stage])).id;
    return {
      key: f.id ?? `${stage}-${i}`,
      role,
      name: seatName(f, AGENT_ROLES[role].label, i),
      stage,
      state: f.s,
      verdict: verdictOf(f.v),
      carries: carriesFor(role, f.id ? eventsFor(lineage, f.id) : []),
    };
  });
}

function branchOf(lineage: readonly GoalLiveLineage[]): QuestBranch | null {
  const forks = lineage.filter((e) => e.k === 'fork');
  if (forks.length === 0) return null;
  // The newest copy's source is the one worth drawing; older copies live in the receipt.
  const fromKey = forks[forks.length - 1].from ?? 'lead';
  const toKeys: string[] = [];
  const ctxEach: (number | null)[] = [];
  for (const f of forks) {
    if ((f.from ?? 'lead') !== fromKey || toKeys.includes(f.a)) continue;
    toKeys.push(f.a);
    ctxEach.push(f.ctx ?? null);
  }
  const source = lineage.find((e) => e.a === fromKey);
  const measured = ctxEach.every((c): c is number => c != null);
  return {
    fromKey,
    fromRole: source ? roleOf(source.role).id : fromKey === 'lead' ? 'lead' : 'planner',
    toKeys,
    ctxEach,
    ctxTotal: measured ? ctxEach.reduce((a: number, c) => a + (c ?? 0), 0) : null,
  };
}

/** The newest lineage event as a sentence, merging the run of same-kind events it ends. */
function beatOf(lineage: readonly GoalLiveLineage[], now: number): QuestView['beat'] {
  const last = lineage[lineage.length - 1];
  if (!last) return null;
  let run = 1;
  for (let i = lineage.length - 2; i >= 0; i -= 1) {
    const e = lineage[i];
    if (e.k !== last.k || e.r !== last.r || e.from !== last.from || e.a === last.a) break;
    run += 1;
  }
  const role = roleOf(last.role);
  const briefed = `${LEAD_NAME} briefed ${run === 1 ? `a ${role.label}` : `${run} ${role.noun.many}`}`;
  let text: string;
  switch (last.k) {
    case 'spawn':
      text = briefed;
      break;
    case 'fork': {
      const from = lineage.find((e) => e.a === last.from);
      const fromLabel = from ? roleOf(from.role).label : 'Planner';
      text = `The ${fromLabel}'s memory was copied into ${plural(run, 'builder')}`;
      break;
    }
    case 'resume':
      text = `The ${role.label} picked up where it left off${last.r != null ? ` · round ${last.r}` : ''}`;
      break;
    case 'fresh':
      text = isJudgeRole(role.id)
        ? `${LEAD_NAME} called ${run === 1 ? `the ${role.label.toLowerCase()}` : `${run} ${role.noun.many}`} with fresh eyes`
        : briefed;
      break;
  }
  const at = parseTime(last.at);
  return { text, stale: at == null || now - at > BEAT_FRESH_MS };
}

/** A goal-skill live file (already through `normalizeGoalLive`) as a quest. */
export function goalQuest(s: GoalLiveState, now: number = Date.now()): QuestView {
  const template = QUEST_TEMPLATES.goal;
  const done = s.phase === 'done';
  const current = GOAL_PHASE_TO_STAGE[s.phase];
  const activeIndex = done ? template.length : Math.max(0, current ? template.indexOf(current) : 0);
  const lineage = s.lineage ?? [];

  const stages: QuestStage[] = template.map((id, i) => {
    const reached = done || i <= activeIndex;
    const stage: QuestStage = {
      id,
      label: QUEST_STAGE_LABELS[id],
      state: done || i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'todo',
      rounds: Math.max(reached ? 1 : 0, s.iters?.[STAGE_TO_PHASE[id]] ?? 0),
    };
    if (id === 'build' && s.impl) {
      const at = s.impl.wave ?? (s.impl.waves ? 1 : 0);
      if (at > 0) stage.wave = { at, of: s.impl.waves ?? null };
    }
    return stage;
  });

  const started = parseTime(s.started);
  const updated = parseTime(s.updated);
  const actors = new Set(lineage.map((e) => e.a));
  const outcome: QuestOutcome | null = done
    ? {
      kind: 'cleared',
      taskSlug: s.goal ?? null,
      rounds: ['review', 'codereview', 'validate'].reduce((n, p) => n + (s.iters?.[p] ?? 0), 0),
      agents: actors.size || (s.impl?.forks?.length ?? 0) + (s.judges?.length ?? 0),
      elapsedMs: started != null && updated != null ? Math.max(0, updated - started) : null,
    }
    : null;

  return {
    kind: 'goal',
    title: s.goal ?? null,
    stages,
    activeIndex,
    cast: done ? [] : castOf(s, template[activeIndex] ?? null, lineage),
    branch: branchOf(lineage),
    beat: beatOf(lineage, now),
    outcome,
    startedAt: started,
    timeline: (s.history ?? []).flatMap((h) => {
      const at = parseTime(h.at);
      const stage = h.p === 'done' ? 'done' : GOAL_PHASE_TO_STAGE[h.p];
      return at != null && stage ? [{ stage, at }] : [];
    }),
  };
}

// ─── goal-skill: the receipt ("How this was built") ───────────────────────────────

function nodeLabel(role: AgentRoleId, actor: string, name: string | undefined): string {
  const parts = [AGENT_ROLES[role].label];
  if (actor !== role) parts.push(actor);
  if (name) parts.push(name);
  return parts.join(' ');
}

/** Would hanging `child` under `parent` close a loop? Walks `from` links, bounded. */
function createsCycle(child: string, parent: string, parentOf: ReadonlyMap<string, string>): boolean {
  let cur: string | undefined = parent;
  for (let i = 0; cur && i <= parentOf.size; i += 1) {
    if (cur === child) return true;
    cur = parentOf.get(cur);
  }
  return false;
}

/**
 * The run's family tree, from its lineage events. Events with the same actor id are ONE node:
 * its rounds are the union of theirs, its kind is how it FIRST joined, and a later return adds
 * "picked up where it left off". A copied memory hangs under the actor it came from; everyone
 * else hangs under the lead. Null when the file carries no lineage (an older skill wrote it).
 */
export function goalLineage(s: GoalLiveState): QuestLineage | null {
  const lineage = s.lineage ?? [];
  if (lineage.length === 0) return null;

  const order: string[] = [];
  const byActor = new Map<string, GoalLiveLineage[]>();
  for (const e of lineage) {
    const list = byActor.get(e.a);
    if (list) list.push(e);
    else { byActor.set(e.a, [e]); order.push(e.a); }
  }
  const seats = new Map<string, GoalLiveFork>();
  for (const f of [...(s.impl?.forks ?? []), ...(s.judges ?? [])]) if (f.id) seats.set(f.id, f);

  const parentOf = new Map<string, string>();
  for (const a of order) {
    const from = byActor.get(a)![0].from;
    if (from && from !== a && byActor.has(from) && !createsCycle(a, from, parentOf)) parentOf.set(a, from);
  }

  const nodes = new Map<string, QuestLineageNode>();
  for (const a of order) {
    const events = byActor.get(a)!;
    const first = events[0];
    const role = roleOf(first.role).id;
    const forkCtx = events.find((e) => e.k === 'fork')?.ctx ?? null;
    const parent = parentOf.get(a);
    const parentRole = parent ? roleOf(byActor.get(parent)![0].role).id : 'lead';
    const resumes = events.filter((e) => e.k === 'resume');
    const lastResume = Math.max(...resumes.map((e) => e.r ?? 0));
    let note = lineageNote(first.k, role, AGENT_ROLES[parentRole].label, forkCtx);
    if (resumes.length && first.k !== 'resume') note += ' · picked up where it left off';
    if (resumes.length && lastResume > 0) note += ` · round ${lastResume}`;
    const seat = seats.get(a);
    nodes.set(a, {
      key: a,
      role,
      label: nodeLabel(role, a, events.find((e) => e.name)?.name),
      kind: first.k,
      rounds: [...new Set(events.map((e) => e.r).filter((r): r is number => r != null))].sort((x, y) => x - y),
      state: seat?.s ?? 'done',
      verdict: verdictOf(seat?.v),
      carries: carriesFor(role, events),
      ctx: forkCtx,
      note,
      children: [],
    });
  }

  const root: QuestLineageNode = {
    key: 'lead', role: 'lead', label: LEAD_NAME, kind: 'lead', rounds: [], state: s.phase === 'done' ? 'done' : 'run',
    verdict: null, carries: null, ctx: null, note: lineageNote('lead', 'lead', LEAD_NAME, null), children: [],
  };
  for (const a of order) {
    const parent = parentOf.get(a);
    (parent ? nodes.get(parent)! : root).children.push(nodes.get(a)!);
  }

  const forks = lineage.filter((e) => e.k === 'fork');
  const measured = forks.length > 0 && forks.every((e) => e.ctx != null);
  return {
    root,
    copies: forks.length,
    returns: lineage.filter((e) => e.k === 'resume').length,
    fresh: lineage.filter((e) => e.k === 'fresh').length,
    reusedTokens: measured ? forks.reduce((n, e) => n + (e.ctx ?? 0), 0) : null,
  };
}
