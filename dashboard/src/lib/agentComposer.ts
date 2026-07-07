/**
 * Support for the thin strip at the bottom of the Agent overlay ({@link AgentComposerBar}):
 * our signature skill triggers, path quoting, and the model/effort config the strip reads
 * from the Claude CLI (never a hardcoded list).
 *
 * ── Model + effort are sourced from the CLI, per agent ────────────────────────────
 * `GET /api/agent/model-config` returns the models the CLI actually offers (its cached
 * option list + aliases), the effort levels from `claude --help`, and the user's own
 * defaults from `~/.claude/settings.json`. A session's CURRENT model comes from its
 * transcript (`GET /api/agent/session-model`). Switching either fires the live `/model`
 * or `/effort` slash command into that agent. Provider-neutral so another backend can
 * later populate the same shapes.
 */

// ── Built-in skill triggers (our signature capabilities) ───────────────────────────
// Clicking one types its trigger into the terminal's OWN input line; the user finishes it.
// Each trigger carries a rich "what it is / how it works" payload so the Skills popover
// can render a live detail card on hover — far clearer than a one-line native tooltip.

export interface SkillTrigger {
  /** The slash trigger typed into the focused terminal's input line. */
  insert: string;
  /** Chip label. */
  label: string;
  /** One-line fallback (native title / aria) — a compressed form of `what`. */
  hint: string;
  /** One sentence: what this capability IS. */
  what: string;
  /** How it works, as an ordered flow (the phases / gates the orchestrator runs). */
  how: string[];
  /** The sub-agents it dispatches, if any (shown as a "Dispatches" row). */
  agents?: string[];
}

export interface SkillGroup {
  id: string;
  label: string;
  triggers: SkillTrigger[];
}

export const SKILL_GROUPS: SkillGroup[] = [
  {
    id: 'brain',
    label: 'Brain lifecycle',
    triggers: [
      {
        insert: '/initializer ',
        label: 'Initializer',
        hint: 'Bootstrap a missing or sparse brain from your real material.',
        what: 'Bootstraps a missing or sparse brain from your real material — docs, wikis, Obsidian/Notion exports, or just the codebase — into a proper knowledge / feature / task hierarchy.',
        how: [
          'Scout inventories your code + docs into a categorized ingestion manifest',
          'You confirm the proposed knowledge / feature / task hierarchy',
          'Ingestor agents fan out per batch, distilling sources into real files (never templates)',
          'Verifier gates: no placeholders, doctor clean, recall actually returns hits',
        ],
        agents: ['initializer-scout', 'initializer-ingestor', 'initializer-verifier'],
      },
      {
        insert: '/curator ',
        label: 'Curator',
        hint: 'The periodic brain refactor that sleep won\'t do.',
        what: 'The periodic brain REFACTOR that sleep won\'t do — re-orders the whole corpus into the right shape (MOVE / MERGE / SPLIT / RENAME / RE-TYPE / RETIRE) to conform to current conventions.',
        how: [
          'Auditors fan out per domain, reading conventions live from the skill + taxonomy + soul',
          'A reorg PLAN is proposed: source → action → target for every drifted file',
          'You confirm the shape before anything moves',
          'Workers execute via the CLI so frontmatter, wikilinks and indexes stay coherent',
          'Verifier gates: doctor clean, zero duplicate topics, recall not regressed',
        ],
        agents: ['curator-auditor', 'curator-worker', 'curator-verifier'],
      },
      {
        insert: '/dreamcontext-deep-research ',
        label: 'Deep Research',
        hint: 'Heavy cross-corpus synthesis across a large or multi-project brain.',
        what: 'Heavy, iterative synthesis across a large or multi-project brain and connected peer vaults — for when a single explore pass under-serves the question.',
        how: [
          'Searchers fan out over knowledge, features, tasks, memory, changelog + connected peers',
          'Load-bearing claims are adversarially verified, not trusted',
          'Returns a synthesized, CITED report — not a pile of raw hits',
        ],
      },
      {
        insert: '/dream-sync ',
        label: 'Sync',
        hint: 'Resolve the team brain-merge the CLI defers to you.',
        what: 'The agent half of the team brain-merge — resolves the prose conflicts the CLI deliberately hands off.',
        how: [
          'The CLI auto-resolves every deterministic file (JSON, task statuses, changelogs)',
          'It defers only PROSE where two people edited the same section',
          'You read base / ours / theirs and write the true semantic merge',
          'Hand back to the CLI to commit + push',
        ],
      },
    ],
  },
  {
    id: 'build',
    label: 'Build & review',
    triggers: [
      {
        insert: '/goal-skill ',
        label: 'Goal',
        hint: 'Drive a non-trivial goal to done under planned, reviewed, validated orchestration.',
        what: 'Drives a non-trivial goal to done under rigorous orchestration — the orchestrator gates each phase; sub-agents do the work; "done" means validation passes against criteria you agreed to.',
        how: [
          'Planner produces a file-by-file plan grounded in the real codebase',
          'Parallel plan-reviewers critique it from different lenses → SOLID / NEEDS_WORK',
          'The plan is persisted as a dreamcontext task with agreed acceptance criteria',
          'Implementer builds strictly to the criteria; the reviewer gates the diff',
          'Validator runs your chosen tests / checklist → PASS / FAIL, looping until reached',
        ],
        agents: ['goal-planner', 'goal-plan-reviewer', 'goal-implementer', 'reviewer', 'goal-validator'],
      },
      {
        insert: '/multi-review ',
        label: 'Multi-review',
        hint: 'Route the diff to specialist reviewers, then consolidate one report.',
        what: 'Team code review — routes a diff to niche specialists in parallel, then consolidates their findings into one greptile-style report with a verdict.',
        how: [
          'Router classifies the diff by size tier + affected domains',
          'Specialists review in parallel: security · cloud-functions · frontend · edge-cases',
          'Coordinator dedupes, re-ranks and drops false positives → one final verdict',
        ],
        agents: ['review-router', 'review-security', 'review-cloud-functions', 'review-frontend', 'review-edge-cases', 'review-coordinator'],
      },
    ],
  },
  {
    id: 'decide',
    label: 'Decide & draw',
    triggers: [
      {
        insert: '/council ',
        label: 'Council',
        hint: 'Run a structured multi-persona debate, then synthesize a decision.',
        what: 'A structured multi-persona debate for a hard decision, ending in a synthesized decision report that traces every reason back to who raised it.',
        how: [
          '3–10 persona agents debate the question over N rounds',
          'Each argues from its own assigned perspective, with optional web research',
          'A synthesizer reads every report and writes the final decision + minority views',
        ],
        agents: ['council-persona', 'council-synthesizer'],
      },
      {
        insert: '/excalidraw ',
        label: 'Excalidraw',
        hint: 'Generate or extend an Obsidian Excalidraw board from a spec.',
        what: 'Generate or extend an Obsidian Excalidraw board — images, labels, shapes, arrows, lanes, grids — from a small spec.',
        how: [
          'You describe the board (or point at screenshots to embed)',
          'A deterministic script emits valid plugin markup — ~no tokens, always renders',
        ],
      },
    ],
  },
];

// ── Model / effort config (fetched from the CLI via the server) ─────────────────────

export interface ModelOption { id: string; label: string; }

export interface ModelConfig {
  /** Models the CLI offers (aliases + its own cached extras). */
  models: ModelOption[];
  /** Effort levels from `claude --help` (e.g. low, medium, high, xhigh, max). */
  efforts: string[];
  /** The user's default model alias + effort level from `~/.claude/settings.json`. */
  defaultModel: string;
  defaultEffort: string;
}

/** Used only until the real config arrives (or if the CLI can't be read) — deliberately
 *  minimal, and carries NO synthetic "default" model entry. */
export const FALLBACK_MODEL_CONFIG: ModelConfig = {
  models: [
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', label: 'Haiku' },
    { id: 'fable', label: 'Fable' },
  ],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultModel: 'opus',
  defaultEffort: 'high',
};

/** Title-case an effort level for display ("high" → "High"). */
export function effortLabel(level: string): string {
  return level ? level.charAt(0).toUpperCase() + level.slice(1) : level;
}

// ── Per-session context-window + cost readout ───────────────────────────────────────

/** The focused agent's live token footprint + API-rate cost estimate (from its transcript,
 *  `GET /api/agent/session-stats`). All null until the first turn writes usage. */
export interface SessionStats {
  /** How full the context window currently is (last turn's total token footprint). */
  contextTokens: number | null;
  /** The model's context window (200K, or 1M for `[1m]` variants). */
  contextLimit: number | null;
  /** Cumulative spend priced at public API rates — a what-if for flat-rate plans. */
  costUsd: number | null;
}

/** Compact token count: 850 · 48.2k · 1.2M. */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) { const k = n / 1000; return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`; }
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Cost in USD, kept readable at small magnitudes: <$1 shows cents-precision, else 2dp. */
export function fmtCost(usd: number): string {
  if (usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd)}`;
}

/**
 * POSIX-safe rendering of a file path for injection into the terminal input: strip control
 * chars (a newline would submit early), leave a simple path bare, single-quote-escape one
 * with spaces/special chars. Mirrors the drag-drop path quoting in AgentSurface.
 */
export function quotePath(p: string): string {
  const clean = [...p].filter((ch) => { const c = ch.codePointAt(0) ?? 0; return c >= 0x20 && c !== 0x7f; }).join('');
  if (/^[\w@%+=:,./-]+$/.test(clean)) return clean;
  return `'${clean.replace(/'/g, "'\\''")}'`;
}
