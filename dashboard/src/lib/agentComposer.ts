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
 * or `/effort` slash command into that agent. Provider-neutral so a Codex backend can
 * later populate the same shapes.
 */

// ── Built-in skill triggers (our signature capabilities) ───────────────────────────
// Clicking one types its trigger into the terminal's OWN input line; the user finishes it.
// The "Goal" capability offers two side-by-side inserts per the product spec.

export interface SkillTrigger {
  insert: string;
  label: string;
  hint: string;
}

export interface SkillGroup {
  id: string;
  label: string;
  triggers: SkillTrigger[];
}

export const SKILL_GROUPS: SkillGroup[] = [
  {
    id: 'multi-review',
    label: 'Multi-review',
    triggers: [{
      insert: '/multi-review ',
      label: 'Multi-review',
      hint: 'Route the diff to specialist reviewers (security · functions · frontend · edge-cases).',
    }],
  },
  {
    id: 'excalidraw',
    label: 'Excalidraw',
    triggers: [{
      insert: '/excalidraw ',
      label: 'Excalidraw',
      hint: 'Generate or extend an Obsidian Excalidraw board from a spec.',
    }],
  },
  {
    id: 'council',
    label: 'Council',
    triggers: [{
      insert: '/council ',
      label: 'Council',
      hint: 'Run a structured multi-persona debate, then synthesize a decision.',
    }],
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
