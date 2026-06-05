import type { FlowSpec } from './FlowDiagram';
import { vCurve } from './flow-specs';

/**
 * The feature showcase catalogue. One entry per dreamcontext capability, grounded
 * in `_dream_context/core/features/*.md` and the CLI surface. Flagship features
 * open by default and carry a small `flow` mini-diagram; minor features stay
 * collapsed and (mostly) render a glyph block instead of a contrived diagram.
 *
 * Positioning note: dreamcontext gives agents a brain to *use*; it never claims to
 * be self-directed or fully autonomous. Copy here stays in "learning to act" /
 * roadmap framing where the line is close.
 */

export interface FeatureItem {
  id: string;
  title: string;
  tagline: string;
  body: string;
  defaultOpen: boolean;
  tag?: string;
  glyph?: string;
  flow?: FlowSpec;
}

// ── Mini flow helpers ───────────────────────────────────────────────────────
// Mini specs use a compact 360×170 viewBox, 2–4 nodes, 1–3 short edges.

const MINI_VB = '0 0 360 170';

/** A simple two-node A → B mini flow with one connecting edge. */
function pairFlow(
  ariaLabel: string,
  a: { title: string; sub?: string; variant?: FlowSpec['nodes'][number]['variant'] },
  b: { title: string; sub?: string; variant?: FlowSpec['nodes'][number]['variant'] },
): FlowSpec {
  return {
    viewBox: MINI_VB,
    ariaLabel,
    nodes: [
      { id: 'a', x: 20, y: 50, w: 140, h: 70, title: a.title, sub: a.sub, variant: a.variant ?? 'hook' },
      { id: 'b', x: 200, y: 50, w: 140, h: 70, title: b.title, sub: b.sub, variant: b.variant ?? 'rem' },
    ],
    edges: [{ id: 'a-b', d: 'M 160 85 L 200 85', travel: 40, dur: 2 }],
  };
}

// ── Per-feature mini diagrams ───────────────────────────────────────────────

const SNAPSHOT_FLOW: FlowSpec = {
  viewBox: MINI_VB,
  ariaLabel:
    'Context snapshot: a SessionStart hook injects the soul, memory, active tasks and knowledge index straight into the agent with zero tool calls.',
  nodes: [
    { id: 'hook', x: 110, y: 12, w: 140, h: 50, title: 'SessionStart', sub: '0 tool calls', variant: 'hook' },
    { id: 'brain', x: 16, y: 100, w: 150, h: 56, title: 'project brain', sub: 'soul · memory · tasks', variant: 'region', breathe: true },
    { id: 'agent', x: 194, y: 100, w: 150, h: 56, title: 'your agent', sub: 'oriented', variant: 'agent' },
  ],
  edges: [
    { id: 'h-b', d: vCurve(180, 62, 91, 100), travel: 80, dur: 2.2 },
    { id: 'b-a', d: 'M 166 128 L 194 128', travel: 28, dur: 1.6, delay: 0.5 },
  ],
};

const RECALL_MINI_FLOW: FlowSpec = {
  viewBox: MINI_VB,
  ariaLabel:
    'Memory recall: a question is scored by BM25 keyword match, optionally refined by a small Haiku agent, returning the most relevant docs in under 100 milliseconds.',
  nodes: [
    { id: 'q', x: 14, y: 52, w: 96, h: 66, title: 'question', sub: 'any language', variant: 'hook' },
    { id: 'bm25', x: 132, y: 52, w: 96, h: 66, title: 'BM25', sub: '+ Haiku', variant: 'region', breathe: true },
    { id: 'docs', x: 250, y: 52, w: 96, h: 66, title: 'top docs', sub: '<100ms', variant: 'rem' },
  ],
  edges: [
    { id: 'q-b', d: 'M 110 85 L 132 85', travel: 22, dur: 1.6 },
    { id: 'b-d', d: 'M 228 85 L 250 85', travel: 22, dur: 1.6, delay: 0.4 },
  ],
};

const SLEEP_MINI_FLOW: FlowSpec = {
  viewBox: MINI_VB,
  ariaLabel:
    'RemSleep: accumulated sleep debt triggers a fan-out to three parallel specialists that consolidate the session and reset the meter.',
  nodes: [
    { id: 'debt', x: 108, y: 10, w: 144, h: 46, title: 'sleep debt', sub: 'crosses threshold', variant: 'accent' },
    { id: 's1', x: 14, y: 92, w: 100, h: 50, title: 'sleep-tasks', variant: 'region', breathe: true },
    { id: 's2', x: 130, y: 92, w: 100, h: 50, title: 'sleep-state', variant: 'region', breathe: true, breatheDelay: 0.2 },
    { id: 's3', x: 246, y: 92, w: 100, h: 50, title: 'sleep-product', variant: 'region', breathe: true, breatheDelay: 0.4 },
  ],
  edges: [
    { id: 'd-1', d: vCurve(180, 56, 64, 92), travel: 90, dur: 2.2 },
    { id: 'd-2', d: 'M 180 56 L 180 92', travel: 36, dur: 1.8, delay: 0.2 },
    { id: 'd-3', d: vCurve(180, 56, 296, 92), travel: 90, dur: 2.2, delay: 0.4 },
  ],
};

const REGIONS_FLOW: FlowSpec = {
  viewBox: MINI_VB,
  ariaLabel:
    'Brain-region core files: soul, user, memory and the knowledge index sit in a numbered band the snapshot always loads.',
  nodes: [
    { id: 'soul', x: 14, y: 24, w: 158, h: 54, title: '0.soul', sub: 'identity · rules', variant: 'region', breathe: true },
    { id: 'mem', x: 188, y: 24, w: 158, h: 54, title: '2.memory', sub: 'decisions · issues', variant: 'region', breathe: true, breatheDelay: 0.2 },
    { id: 'user', x: 14, y: 96, w: 158, h: 54, title: '1.user', sub: 'preferences', variant: 'region', breathe: true, breatheDelay: 0.4 },
    { id: 'know', x: 188, y: 96, w: 158, h: 54, title: 'knowledge', sub: 'index · pinned', variant: 'region', breathe: true, breatheDelay: 0.6 },
  ],
  edges: [],
};

const BRAIN_FLOW: FlowSpec = {
  viewBox: MINI_VB,
  ariaLabel:
    'Tag-based relation graph: knowledge, features and tasks link through shared tags into a navigable brain view.',
  nodes: [
    { id: 'tag', x: 110, y: 58, w: 140, h: 54, title: 'shared tag', sub: 'the edge', variant: 'accent', breathe: true },
    { id: 'k', x: 14, y: 10, w: 110, h: 44, title: 'knowledge', variant: 'region' },
    { id: 'f', x: 236, y: 10, w: 110, h: 44, title: 'features', variant: 'region' },
    { id: 't', x: 125, y: 122, w: 110, h: 40, title: 'tasks', variant: 'region' },
  ],
  edges: [
    { id: 'k-tag', d: vCurve(69, 54, 150, 58), travel: 90, dur: 2.4 },
    { id: 'f-tag', d: vCurve(291, 54, 210, 58), travel: 90, dur: 2.4, delay: 0.4 },
    { id: 't-tag', d: 'M 180 122 L 180 112', travel: 12, dur: 1.6, delay: 0.8 },
  ],
};

const TASKS_FLOW: FlowSpec = {
  viewBox: MINI_VB,
  ariaLabel:
    'Task management: each task carries a LIFO changelog viewable as a Kanban board, an Eisenhower matrix, or RICE-scored.',
  nodes: [
    { id: 'task', x: 16, y: 50, w: 130, h: 70, title: 'task .md', sub: 'LIFO changelog', variant: 'hook' },
    { id: 'views', x: 200, y: 24, w: 144, h: 44, title: 'Kanban', variant: 'region', breathe: true },
    { id: 'eis', x: 200, y: 74, w: 144, h: 40, title: 'Eisenhower', variant: 'region', breathe: true, breatheDelay: 0.2 },
    { id: 'rice', x: 200, y: 120, w: 144, h: 40, title: 'RICE score', variant: 'region', breathe: true, breatheDelay: 0.4 },
  ],
  edges: [
    { id: 't-k', d: vCurve(146, 85, 272, 46), travel: 90, dur: 2.2 },
    { id: 't-e', d: 'M 146 85 L 200 94', travel: 56, dur: 2, delay: 0.3 },
    { id: 't-r', d: vCurve(146, 85, 272, 140), travel: 90, dur: 2.2, delay: 0.6 },
  ],
};

const SUBAGENTS_FLOW: FlowSpec = {
  viewBox: MINI_VB,
  ariaLabel:
    'Sub-agents: the main agent fans work out to briefed specialist sub-agents that report back, keeping the main context small.',
  nodes: [
    { id: 'main', x: 110, y: 12, w: 140, h: 46, title: 'main agent', variant: 'agent' },
    { id: 'a', x: 16, y: 96, w: 96, h: 50, title: 'reviewer', variant: 'region', breathe: true },
    { id: 'b', x: 132, y: 96, w: 96, h: 50, title: 'planner', variant: 'region', breathe: true, breatheDelay: 0.2 },
    { id: 'c', x: 248, y: 96, w: 96, h: 50, title: 'researcher', variant: 'region', breathe: true, breatheDelay: 0.4 },
  ],
  edges: [
    { id: 'm-a', d: vCurve(180, 58, 64, 96), travel: 90, dur: 2.2 },
    { id: 'm-b', d: 'M 180 58 L 180 96', travel: 38, dur: 1.8, delay: 0.2 },
    { id: 'm-c', d: vCurve(180, 58, 296, 96), travel: 90, dur: 2.2, delay: 0.4 },
  ],
};

// Council gets a richer, dedicated diagram (not the mini viewBox): three personas
// arranged in a triangle that DEBATE each other — a cycle of comets passing round
// the triangle shows the cross-talk and the "× rounds" repetition — then the
// resolved debate converges into the synthesizer, which emits one decision report.
const COUNCIL_FLOW: FlowSpec = {
  viewBox: '0 0 400 232',
  ariaLabel:
    'Council: three persona sub-agents debate each other in a cycle — each sees the others’ reasoning, round after round — then the debate converges into a synthesizer that writes one decision report.',
  nodes: [
    { id: 'p1', x: 70, y: 14, w: 96, h: 46, title: 'persona', sub: 'lens A', variant: 'region', breathe: true },
    { id: 'p2', x: 18, y: 118, w: 96, h: 46, title: 'persona', sub: 'lens B', variant: 'region', breathe: true, breatheDelay: 0.25 },
    { id: 'p3', x: 130, y: 118, w: 96, h: 46, title: 'persona', sub: 'lens C', variant: 'region', breathe: true, breatheDelay: 0.5 },
    { id: 'syn', x: 286, y: 70, w: 104, h: 72, title: 'synthesizer', sub: 'decision report', variant: 'rem' },
  ],
  edges: [
    // The debate cycle — personas pass reasoning round the triangle (cross-talk),
    // and the loop itself reads as the rounds repeating until they converge.
    { id: 'p1-p2', d: 'M 96 60 L 80 118', travel: 60, dur: 1.8 },
    {
      id: 'p2-p3',
      d: 'M 114 141 L 130 141',
      travel: 16,
      dur: 1.1,
      delay: 0.3,
      label: { text: '↻ rounds', x: 118, y: 95 },
    },
    { id: 'p3-p1', d: 'M 178 118 L 152 60', travel: 60, dur: 1.8, delay: 0.6 },
    // Convergence — the resolved debate flows into the synthesizer.
    { id: 'p1-syn', d: vCurve(166, 40, 286, 96), travel: 130, dur: 2.4, delay: 0.4 },
    { id: 'p3-syn', d: vCurve(226, 136, 286, 116), travel: 76, dur: 2.2, delay: 0.9 },
  ],
};

const SKILLS_FLOW: FlowSpec = pairFlow(
  'Skill packs: curated domain packs install a base skill plus on-demand sub-skills into the agent.',
  { title: 'skill pack', sub: 'engineering · design · growth', variant: 'hook' },
  { title: 'agent gains', sub: 'base + sub-skills', variant: 'rem' },
);

const KNOWLEDGE_FLOW: FlowSpec = pairFlow(
  'Knowledge base: tagged knowledge files are indexed every session; pinned files load warm, the rest load cold on demand.',
  { title: 'knowledge/*.md', sub: 'tagged · indexed', variant: 'region' },
  { title: 'snapshot', sub: 'warm + cold', variant: 'rem' },
);

// ── The catalogue ───────────────────────────────────────────────────────────

export const FEATURES: FeatureItem[] = [
  // ─── Flagship ─────────────────────────────────────────────────────────────
  {
    id: 'context-snapshot',
    title: 'Context snapshot',
    tagline: 'Every session starts with the whole brain, zero tool calls.',
    body: 'A SessionStart hook injects your project identity, user preferences, memory, active tasks and the knowledge index straight into the agent — so it orients instantly instead of grepping around blind.',
    defaultOpen: true,
    tag: 'Memory',
    flow: SNAPSHOT_FLOW,
  },
  {
    id: 'memory-recall',
    title: 'Memory recall',
    tagline: 'Ask "where did we decide X?" and get an answer in under 100ms.',
    body: 'A deterministic BM25 search ranks every knowledge file, PRD, task, memory entry and changelog line — optionally sharpened by a small Haiku agent — so the right context surfaces without scrolling or grepping. Handles English, Turkish and mixed queries.',
    defaultOpen: true,
    tag: 'Memory',
    flow: RECALL_MINI_FLOW,
  },
  {
    id: 'rem-sleep',
    title: 'RemSleep consolidation',
    tagline: 'It sleeps to remember — multi-agent consolidation, like REM.',
    body: 'Sessions accumulate sleep debt; when it builds up, one command fans out to three parallel specialists that fold what changed back into the brain, then resets the meter. Knowledge compounds instead of decaying.',
    defaultOpen: true,
    tag: 'Sleep',
    flow: SLEEP_MINI_FLOW,
  },
  {
    id: 'brain-regions',
    title: 'Brain-region core files',
    tagline: 'A numbered band of core files — soul, user, memory, knowledge.',
    body: 'The brain is a handful of small, always-loaded files: identity and rules, user preferences, durable memory, and the knowledge index. Kept lightweight on purpose so the snapshot stays under budget every session.',
    defaultOpen: true,
    tag: 'Memory',
    flow: REGIONS_FLOW,
  },
  {
    id: 'knowledge-base',
    title: 'Knowledge base',
    tagline: 'Tagged research that loads warm when pinned, cold on demand.',
    body: 'Deep research and domain context live in tagged knowledge files the snapshot indexes every session. Pin the critical ones to load them in full; the rest stay one read away when an agent needs them.',
    defaultOpen: true,
    tag: 'Knowledge',
    flow: KNOWLEDGE_FLOW,
  },
  {
    id: 'brain-graph',
    title: 'Relation graph (Brain view)',
    tagline: 'Knowledge, features and tasks linked through shared tags.',
    body: 'A tag-based graph connects every knowledge file, feature and task into one navigable Brain view — so you can see how the parts of a project relate instead of reading them one file at a time.',
    defaultOpen: true,
    tag: 'Knowledge',
    flow: BRAIN_FLOW,
  },
  {
    id: 'task-management',
    title: 'Task management',
    tagline: 'LIFO changelogs, viewable as Kanban, Eisenhower or RICE.',
    body: 'Each task is a Markdown file with a LIFO changelog, so any session reads where the last one left off. View the backlog as a Kanban board, triage it on an Eisenhower matrix, or rank it numerically with RICE — Reach × Impact × Confidence ÷ Effort.',
    defaultOpen: true,
    tag: 'Tasks',
    flow: TASKS_FLOW,
  },
  {
    id: 'skill-packs',
    title: 'Skill packs',
    tagline: 'Curated, installable skills by domain — one command.',
    body: 'Extend an agent with domain packs — engineering, design, growth, brand-voice and more — each a base skill plus on-demand sub-skills. Install interactively or name a pack directly; prerequisites resolve automatically.',
    defaultOpen: true,
    tag: 'Skills',
    flow: SKILLS_FLOW,
  },
  {
    id: 'sub-agents',
    title: 'Sub-agents',
    tagline: 'Fan work out to briefed specialists; keep the main context lean.',
    body: 'The main agent dispatches focused sub-agents — reviewers, planners, researchers — each launched with a lightweight context briefing so it knows the project structure without any tool calls. They report back; the main thread stays small.',
    defaultOpen: true,
    tag: 'Agents',
    flow: SUBAGENTS_FLOW,
  },
  {
    id: 'council',
    title: 'Council',
    tagline: 'Persona sub-agents debate a hard call, a synthesizer decides.',
    body: 'For a non-trivial decision, Council spins up 3–10 persona sub-agents that debate across rounds, see each other\'s reasoning, then hand off to a dedicated synthesizer that writes one decision report — promotable straight into knowledge.',
    defaultOpen: true,
    tag: 'Agents',
    flow: COUNCIL_FLOW,
  },

  // ─── Minor ────────────────────────────────────────────────────────────────
  {
    id: 'bookmarking',
    title: 'Bookmarking (salience)',
    tagline: 'High-signal moments tagged so sleep can find them later.',
    body: 'Corrections, error-to-fix turns and decisions are auto-bookmarked during a session, marking the moments worth keeping — so consolidation folds the right learnings into the brain without manual flagging.',
    defaultOpen: false,
    tag: 'Memory',
    glyph: '◈',
  },
  {
    id: 'warm-cold-knowledge',
    title: 'Warm vs cold knowledge',
    tagline: 'Pinned files load in full; the rest stay one read away.',
    body: 'Pinned (warm) knowledge is inlined into every snapshot; unpinned (cold) knowledge appears only in the index and loads on demand. The split keeps the always-on context small while nothing gets lost.',
    defaultOpen: false,
    tag: 'Knowledge',
    glyph: '❄',
  },
  {
    id: 'feature-prds',
    title: 'Feature PRDs',
    tagline: 'Living docs that capture not just what was built, but why.',
    body: 'Each feature has a PRD with user stories, acceptance criteria and design decisions that update as work progresses — so an agent understands the product surface without reconstructing it from conversation history.',
    defaultOpen: false,
    tag: 'Knowledge',
    glyph: '▤',
  },
  {
    id: 'versions-releases',
    title: 'Versions & releases',
    tagline: 'Changelog and release readiness tracked in the brain.',
    body: 'A structured changelog and release notes live alongside the context, so version history and release readiness are part of the brain the agent reads — not an afterthought scattered across commits.',
    defaultOpen: false,
    tag: 'Knowledge',
    glyph: '⎇',
  },
  {
    id: 'multi-vault',
    title: 'Multi-vault registry',
    tagline: 'Switch between project brains from one global registry.',
    body: 'A global vault registry tracks every project brain on your machine. List, add and remove vaults, then point the dashboard at any one — so multiple projects each keep their own clean context.',
    defaultOpen: false,
    tag: 'Setup',
    glyph: '▦',
  },
  {
    id: 'multi-product',
    title: 'Multi-product support',
    tagline: 'Per-product knowledge auto-injected from the active task.',
    body: 'Monorepos and portfolios get a product namespace: per-product knowledge and data structures, plus automatic injection of the right product\'s knowledge at session start when the active task carries a product tag.',
    defaultOpen: false,
    tag: 'Knowledge',
    glyph: '◫',
  },
  {
    id: 'manifest-install',
    title: 'Manifest install & update',
    tagline: 'Clean upgrades — stale files tracked and removed, not layered.',
    body: 'A manifest tracks every file dreamcontext owns, so updates remove what a new version drops instead of leaving stale agents and configs behind. Includes a one-line install script and an in-session update nudge.',
    defaultOpen: false,
    tag: 'Setup',
    glyph: '⟳',
  },
  {
    id: 'project-init',
    title: 'Project initialization',
    tagline: 'Blank repo to agent-aware workspace in under a minute.',
    body: 'One init command scaffolds the whole context directory, detects your tech stack, runs token substitution on the templates, and wires up the Claude Code hooks — no manual setup.',
    defaultOpen: false,
    tag: 'Setup',
    glyph: '⊕',
  },
  {
    id: 'control-panel',
    title: 'Control panel',
    tagline: 'Configure platforms, packs and vaults in the browser.',
    body: 'The dashboard control panel closes the loop on configuration — edit platforms and skill packs, see which packs are actually installed on disk, manage vaults, and get notified in-app when a newer version ships.',
    defaultOpen: false,
    tag: 'Setup',
    glyph: '⚙',
  },
  {
    id: 'multi-review',
    title: 'Multi-review',
    tagline: 'Route a diff to niche reviewers, get one merged report.',
    body: 'A router classifies a diff by domain and dispatches specialist reviewers — security, frontend, cloud functions, edge cases — in parallel; a coordinator dedupes their findings into a single report. Each specialist reviews against your live project rules.',
    defaultOpen: false,
    tag: 'Agents',
    glyph: '⊜',
  },
  {
    id: 'goal-skill',
    title: 'Goal-skill orchestration',
    tagline: 'Drive a goal through a disciplined six-phase loop.',
    body: 'Turn the main agent into an orchestrator that runs a bounded loop — validate, plan, review the plan in parallel, persist as a task, implement, review the code. Each gate has a hard iteration cap that escalates to you instead of spinning.',
    defaultOpen: false,
    tag: 'Agents',
    glyph: '◎',
  },
  {
    id: 'continuous-capture',
    title: 'Continuous capture',
    tagline: 'Session digests and auto-bookmarks, searchable next session.',
    body: 'Transcripts are digested and indexed as you work, so a decision from one session is searchable in the next — before any sleep consolidation runs. Capture is down-weighted so it never crowds out curated knowledge.',
    defaultOpen: false,
    tag: 'Memory',
    glyph: '◌',
  },
  {
    id: 'context-gate',
    title: 'Context gate',
    tagline: 'Nudges the agent to load relevant skills before it acts.',
    body: 'A prompt-time hook detects when an installed skill is plausibly relevant and injects a directive to review the full skill list and invoke what fits — deliberately not a pre-selected top-N, so the right skill is never anchored out.',
    defaultOpen: false,
    tag: 'Skills',
    glyph: '⊳',
  },
  {
    id: 'auto-dashboard',
    title: 'Auto-open dashboard hook',
    tagline: 'The dashboard surfaces itself when it is worth a look.',
    body: 'A hook can open the dashboard at the right moment so the visual view of tasks, knowledge and the brain is one glance away — without you remembering to launch it.',
    defaultOpen: false,
    tag: 'Setup',
    glyph: '◰',
  },
  {
    id: 'post-edit-hook',
    title: 'Post-edit format & typecheck',
    tagline: 'Format and typecheck fire automatically after an edit.',
    body: 'A post-edit hook runs your formatter and type checker right after the agent changes a file, so problems surface immediately instead of piling up — keeping the working tree clean as work proceeds.',
    defaultOpen: false,
    tag: 'Setup',
    glyph: '✓',
  },
  {
    id: 'marketing-pack',
    title: 'Marketing pack',
    tagline: 'Brand-voice and growth skills for going to market.',
    body: 'A bundled set of go-to-market skills — brand voice, growth, performance marketing — so the same agent that builds a feature can help position and launch it, on-brand.',
    defaultOpen: false,
    tag: 'Skills',
    glyph: '✦',
  },
];
