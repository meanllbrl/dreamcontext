/**
 * The agent ROLE REGISTRY: who each dispatched agent is, as a character the chat can draw.
 *
 * One pure module, imported by every surface that shows an agent (the party card, the rail,
 * the drill-in, the goal-skill quest map), so a reviewer is the same character everywhere and
 * nothing re-derives identity from a name hash.
 *
 * Identity is STATIC chrome, never a status (the ★★★ rule: colour = mood, movement = mode). A
 * role's hue family is spent as a tint on its disc; status keeps its own colour and running keeps
 * its own motion. The family encodes the one idea the UI exists to show: `maker` roles carry
 * memory (the planner and the builders it seeds), `judge` roles always arrive with fresh eyes.
 *
 * Total by construction: an unknown agent type resolves to `agent` (the plain teammate face),
 * so a new sub-agent renders as a teammate rather than as a crash or a mislabelled character.
 */

/** The lead's name in ALL copy. The Sleepy face is its picture; the name is the product's. */
export const LEAD_NAME = 'Claude';

export type AgentRoleId =
  | 'lead' | 'planner' | 'critic' | 'pragmatist' | 'edge-cases' | 'security' | 'plan-reviewer'
  | 'implementer' | 'reviewer' | 'validator' | 'explorer' | 'peer' | 'headless' | 'agent';

export type RoleGlyphId =
  | 'face' | 'pencil' | 'lens' | 'scissors' | 'split' | 'shield' | 'hammer' | 'crown'
  | 'scales' | 'compass' | 'diamond' | 'prompt';

export type RoleHue = 'maker' | 'judge' | 'neutral';

export type QuestStageId = 'ask' | 'draft' | 'review' | 'task' | 'build' | 'boss' | 'trial';

/** The stage a PARTY advances. `scout` and `none` move no quest stage forward. */
export type PartyStageId = QuestStageId | 'scout' | 'none';

export interface AgentRole {
  id: AgentRoleId;
  /** Character name, sentence case, no emoji. */
  label: string;
  /** One plain line for a tooltip: what this character does. */
  blurb: string;
  /** How a headline counts them: "Critic" alone, "3 reviewers" together. */
  noun: { one: string; many: string };
  glyph: RoleGlyphId;
  hue: RoleHue;
}

/** The single source for every role's look. `hue: 'judge'` is also what defines a judge. */
export const AGENT_ROLES: Readonly<Record<AgentRoleId, AgentRole>> = {
  lead: { id: 'lead', label: LEAD_NAME, blurb: 'Leads the team and briefs everyone else', noun: { one: LEAD_NAME, many: LEAD_NAME }, glyph: 'face', hue: 'neutral' },
  planner: { id: 'planner', label: 'Planner', blurb: 'Drafts the plan against the real code', noun: { one: 'Planner', many: 'planners' }, glyph: 'pencil', hue: 'maker' },
  critic: { id: 'critic', label: 'Critic', blurb: 'Attacks the premise and the assumptions', noun: { one: 'Critic', many: 'reviewers' }, glyph: 'lens', hue: 'judge' },
  pragmatist: { id: 'pragmatist', label: 'Pragmatist', blurb: 'Cuts scope nobody needs', noun: { one: 'Pragmatist', many: 'reviewers' }, glyph: 'scissors', hue: 'judge' },
  'edge-cases': { id: 'edge-cases', label: 'Edge hunter', blurb: 'Hunts empty inputs, races and partial failures', noun: { one: 'Edge hunter', many: 'reviewers' }, glyph: 'split', hue: 'judge' },
  security: { id: 'security', label: 'Security', blurb: 'Looks for ways the work could be abused', noun: { one: 'Security', many: 'reviewers' }, glyph: 'shield', hue: 'judge' },
  'plan-reviewer': { id: 'plan-reviewer', label: 'Reviewer', blurb: 'Reads the plan and says whether it holds', noun: { one: 'Reviewer', many: 'reviewers' }, glyph: 'lens', hue: 'judge' },
  implementer: { id: 'implementer', label: 'Builder', blurb: 'Builds its part of the plan', noun: { one: 'Builder', many: 'builders' }, glyph: 'hammer', hue: 'maker' },
  reviewer: { id: 'reviewer', label: 'Reviewer', blurb: 'Reviews the changes before they count', noun: { one: 'Reviewer', many: 'reviewers' }, glyph: 'crown', hue: 'judge' },
  validator: { id: 'validator', label: 'Validator', blurb: 'Runs the final checks and reports what it saw', noun: { one: 'Validator', many: 'validators' }, glyph: 'scales', hue: 'judge' },
  explorer: { id: 'explorer', label: 'Scout', blurb: 'Maps the code before anyone builds', noun: { one: 'Scout', many: 'scouts' }, glyph: 'compass', hue: 'neutral' },
  peer: { id: 'peer', label: 'Other project', blurb: 'A teammate from a connected project', noun: { one: 'Other project', many: 'other projects' }, glyph: 'diamond', hue: 'neutral' },
  headless: { id: 'headless', label: 'Helper', blurb: 'A helper started from the command line', noun: { one: 'Helper', many: 'helpers' }, glyph: 'prompt', hue: 'neutral' },
  agent: { id: 'agent', label: 'Teammate', blurb: 'A teammate working on part of the task', noun: { one: 'Teammate', many: 'teammates' }, glyph: 'face', hue: 'neutral' },
};

/** Judges always arrive fresh: they see only the work, never the reasoning behind it. */
export function isJudgeRole(id: AgentRoleId): boolean {
  return AGENT_ROLES[id].hue === 'judge';
}

/** Total: any string (including untrusted JSON from a live file) resolves to a role. */
export function roleOf(id: string | null | undefined): AgentRole {
  if (id && Object.prototype.hasOwnProperty.call(AGENT_ROLES, id)) return AGENT_ROLES[id as AgentRoleId];
  return AGENT_ROLES.agent;
}

export const QUEST_STAGE_LABELS: Readonly<Record<QuestStageId, string>> = {
  ask: 'Ask',
  draft: 'Draft',
  review: 'Plan review',
  task: 'Task',
  build: 'Build',
  boss: 'Boss gate',
  trial: 'Final trial',
};

/** What a party is doing at each stage, in both tenses: "3 reviewers are reading the plan". */
export const STAGE_ACTS: Readonly<Record<PartyStageId, { present: string; past: string }>> = {
  ask: { present: 'asking', past: 'asked' },
  draft: { present: 'drafting the plan', past: 'drafted the plan' },
  review: { present: 'reading the plan', past: 'read the plan' },
  task: { present: 'filing the task', past: 'filed the task' },
  build: { present: 'building', past: 'built their part' },
  boss: { present: 'reviewing the changes', past: 'reviewed the changes' },
  trial: { present: 'running the final checks', past: 'ran the final checks' },
  scout: { present: 'mapping the code', past: 'mapped the code' },
  none: { present: 'working', past: 'finished' },
};

export function roleHueVar(h: RoleHue): '--role-hue-maker' | '--role-hue-judge' | '--role-hue-neutral' {
  return `--role-hue-${h}`;
}

// ─── Resolving a dispatch to a character ──────────────────────────────────────────

export interface AgentIdentityProbe {
  subagentType?: string;
  /** The dispatch's description, e.g. "critic lens". */
  name?: string;
  prompt?: string;
  command?: string;
  taskType?: string;
}

export interface AgentIdentity { role: AgentRoleId; stage: PartyStageId }

/** Named agent types. Checked before any keyword, so a named type is never second-guessed. */
const EXACT_TYPES: Readonly<Record<string, AgentIdentity>> = {
  'goal-planner': { role: 'planner', stage: 'draft' },
  Plan: { role: 'planner', stage: 'draft' },
  'goal-implementer': { role: 'implementer', stage: 'build' },
  reviewer: { role: 'reviewer', stage: 'boss' },
  'review-coordinator': { role: 'reviewer', stage: 'boss' },
  'review-frontend': { role: 'reviewer', stage: 'boss' },
  'review-cloud-functions': { role: 'reviewer', stage: 'boss' },
  'review-router': { role: 'reviewer', stage: 'boss' },
  'review-security': { role: 'security', stage: 'boss' },
  'review-edge-cases': { role: 'edge-cases', stage: 'boss' },
  'goal-validator': { role: 'validator', stage: 'trial' },
  Explore: { role: 'explorer', stage: 'scout' },
  'dreamcontext-explore': { role: 'explorer', stage: 'scout' },
  'dreamcontext-deep-research': { role: 'explorer', stage: 'scout' },
};

/** L1: the plan-review lenses. Order matters: the first match names the lens. */
const LENS_PATTERNS: ReadonlyArray<[RegExp, AgentRoleId]> = [
  [/\bcritic/i, 'critic'],
  [/\bpragmat/i, 'pragmatist'],
  [/\bedge/i, 'edge-cases'],
  [/\bsecurity\b/i, 'security'],
];

/** L2: the fallback for general-purpose and unknown types, read off the NAME only. */
const NAME_PATTERNS: ReadonlyArray<[RegExp, AgentIdentity]> = [
  ...LENS_PATTERNS.map(([re, role]): [RegExp, AgentIdentity] => [re, { role, stage: 'review' }]),
  [/validat/i, { role: 'validator', stage: 'trial' }],
  [/\breview/i, { role: 'reviewer', stage: 'boss' }],
  [/implement|\bwave\b|\bbuild/i, { role: 'implementer', stage: 'build' }],
  [/explor|scout|research/i, { role: 'explorer', stage: 'scout' }],
  [/\bplan(ner|ning)?\b/i, { role: 'planner', stage: 'draft' }],
];

const AGENT_FLAG_RE = /(?:^|\s)--agent(?:=|\s+)["']?([A-Za-z0-9._-]+)/;
const FORK_FLAG_RE = /(?:^|\s)--fork-session(?:\s|$)/;

function lensOf(text: string): AgentRoleId | null {
  for (const [re, role] of LENS_PATTERNS) if (re.test(text)) return role;
  return null;
}

/**
 * Who a dispatch is, and which stage its party advances. First match wins:
 * a peer envoy; a named type (the plan reviewer picks its lens from its name and brief); a
 * command-line helper (its `--agent` names it, a copied memory makes it a builder); otherwise
 * the dispatch name's keywords; otherwise a plain teammate.
 */
export function resolveAgentIdentity(p: AgentIdentityProbe): AgentIdentity {
  const type = p.subagentType?.trim() ?? '';
  if (type.startsWith('peer-')) return { role: 'peer', stage: 'none' };

  if (type === 'goal-plan-reviewer') {
    const lens = lensOf(`${p.name ?? ''} ${(p.prompt ?? '').slice(0, 400)}`);
    return { role: lens ?? 'plan-reviewer', stage: 'review' };
  }
  if (Object.prototype.hasOwnProperty.call(EXACT_TYPES, type)) return EXACT_TYPES[type];

  if (p.taskType === 'local_bash') {
    const command = p.command ?? '';
    const named = AGENT_FLAG_RE.exec(command)?.[1];
    // Recurse once, as a typed dispatch: `--agent reviewer` is the reviewer, however it launched.
    if (named) return resolveAgentIdentity({ subagentType: named, name: p.name, prompt: p.prompt });
    if (FORK_FLAG_RE.test(command)) return { role: 'implementer', stage: 'build' };
    return { role: 'headless', stage: 'none' };
  }

  const name = p.name ?? '';
  for (const [re, identity] of NAME_PATTERNS) if (re.test(name)) return identity;
  return { role: 'agent', stage: 'none' };
}
