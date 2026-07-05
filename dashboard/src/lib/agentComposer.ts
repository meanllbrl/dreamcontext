/**
 * Agent composer bar — model / thinking-effort selection, the built-in skill triggers,
 * and the small persisted preference blob behind the strip at the bottom of the Agent
 * overlay ({@link AgentComposerBar}).
 *
 * ── Provider abstraction (Codex-ready) ───────────────────────────────────────────
 * Today the only agent backend is Claude Code, but the whole model/effort layer is
 * keyed on a `provider` so adding Codex later is a data change, not a refactor. A model
 * carries the exact `--model` token to pass at spawn; an effort carries BOTH a Claude
 * thinking keyword (realized by prefixing the prompt) AND a generic reasoning level a
 * future Codex path can map to its own `-c model_reasoning_effort` flag. The UI groups
 * options by provider and greys out any provider that isn't wired yet.
 */

/** Which agent backend a session runs. Only 'claude' is wired today. */
export type AgentProvider = 'claude' | 'codex';

export interface ModelOption {
  provider: AgentProvider;
  /** The token passed to the backend's model flag (`claude --model <id>`). Empty = let
   *  the backend use its own configured default (no flag added). */
  id: string;
  label: string;
  /** Short tag shown after the label (e.g. "fast", "soon"). */
  tag?: string;
  /** False → shown but disabled (backend not wired yet, e.g. every Codex model today). */
  available: boolean;
}

/**
 * The model menu. Claude aliases (`opus`/`sonnet`/`haiku`) always resolve to the current
 * generation, so we don't pin dated ids here. Codex rows are placeholders — visible so
 * the product direction is clear, disabled until the backend lands.
 */
export const MODEL_OPTIONS: ModelOption[] = [
  { provider: 'claude', id: '',       label: 'Default',    tag: 'auto', available: true },
  { provider: 'claude', id: 'opus',   label: 'Opus 4.8',   available: true },
  { provider: 'claude', id: 'sonnet', label: 'Sonnet 5',   available: true },
  { provider: 'claude', id: 'haiku',  label: 'Haiku 4.5',  tag: 'fast', available: true },
  { provider: 'codex',  id: 'gpt-5-codex', label: 'GPT-5 Codex', tag: 'soon', available: false },
  { provider: 'codex',  id: 'codex-mini',  label: 'Codex mini',  tag: 'soon', available: false },
];

export type ThinkingEffortId = 'off' | 'think' | 'think-hard' | 'ultra';

export interface ThinkingEffort {
  id: ThinkingEffortId;
  label: string;
  /** Claude realizes reasoning depth from prompt keywords — prefixed to the sent prompt.
   *  Empty = no keyword (the model's default effort). */
  claudeKeyword: string;
  /** Generic level a future Codex path maps to `model_reasoning_effort`. */
  codexReasoning: 'minimal' | 'low' | 'medium' | 'high';
}

export const THINKING_EFFORTS: ThinkingEffort[] = [
  { id: 'off',        label: 'Effort: off', claudeKeyword: '',            codexReasoning: 'minimal' },
  { id: 'think',      label: 'Think',       claudeKeyword: 'Think.',      codexReasoning: 'low' },
  { id: 'think-hard', label: 'Think hard',  claudeKeyword: 'Think hard.', codexReasoning: 'medium' },
  { id: 'ultra',      label: 'Ultrathink',  claudeKeyword: 'Ultrathink.', codexReasoning: 'high' },
];

// ── Built-in skill triggers (our three signature capabilities) ─────────────────────
// Clicking one appends its trigger to the composer text field (never fires it directly)
// — the user reviews/edits, then sends. A skill is a slash command Claude Code runs; the
// "Goal" capability offers TWO side-by-side inserts (a plain goal statement, and the
// orchestrated `/goal-skill`) per the product spec.

export interface SkillTrigger {
  /** Text appended to the composer. Slash commands run the skill; a bare scaffold ("Goal:")
   *  just seeds a prompt the user finishes typing. */
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
    id: 'goal',
    label: 'Goal',
    triggers: [
      { insert: 'Goal: ', label: 'goal', hint: 'Seed a plain goal statement for the agent to pursue.' },
      { insert: '/goal-skill ', label: 'goal-skill', hint: 'Drive the goal end-to-end: plan → review → implement → validate.' },
    ],
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

// ── Persisted preferences (model + effort) ─────────────────────────────────────────
// Kept in localStorage only: the desktop app gets a fresh loopback origin each launch, so
// these reset to sane defaults per launch (a model picker doesn't need cross-launch
// durability the way the roster does). Versioned key so a shape change invalidates clean.

export interface ComposerPrefs {
  provider: AgentProvider;
  modelId: string;
  effort: ThinkingEffortId;
}

const PREFS_KEY = 'agent:composer:v1';

export const DEFAULT_COMPOSER_PREFS: ComposerPrefs = {
  provider: 'claude',
  modelId: '',
  effort: 'off',
};

/** Resolve a stored blob to a valid prefs object, dropping anything that no longer maps
 *  to an available option (e.g. a removed model id → back to Default). */
export function coerceComposerPrefs(raw: Partial<ComposerPrefs> | null | undefined): ComposerPrefs {
  const r = raw ?? {};
  const model = MODEL_OPTIONS.find((m) => m.id === r.modelId && m.available);
  const effort = THINKING_EFFORTS.find((e) => e.id === r.effort);
  return {
    provider: model?.provider ?? DEFAULT_COMPOSER_PREFS.provider,
    modelId: model?.id ?? DEFAULT_COMPOSER_PREFS.modelId,
    effort: effort?.id ?? DEFAULT_COMPOSER_PREFS.effort,
  };
}

export function readComposerPrefs(): ComposerPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return coerceComposerPrefs(JSON.parse(raw) as Partial<ComposerPrefs>);
  } catch { /* fall through to defaults */ }
  return { ...DEFAULT_COMPOSER_PREFS };
}

export function writeComposerPrefs(prefs: ComposerPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* best-effort */ }
}

/** The effort's Claude thinking keyword, or '' when off / unknown. */
export function effortKeyword(id: ThinkingEffortId): string {
  return THINKING_EFFORTS.find((e) => e.id === id)?.claudeKeyword ?? '';
}

/** Look up a model option by id (falls back to Default). */
export function modelById(id: string): ModelOption {
  return MODEL_OPTIONS.find((m) => m.id === id) ?? MODEL_OPTIONS[0];
}

/**
 * POSIX-safe rendering of a file path for injection into a prompt / PTY: strip control
 * chars (a newline would submit early), leave a simple path bare, single-quote-escape one
 * with spaces/special chars. Mirrors the drag-drop path quoting in AgentSurface.
 */
export function quotePath(p: string): string {
  const clean = [...p].filter((ch) => { const c = ch.codePointAt(0) ?? 0; return c >= 0x20 && c !== 0x7f; }).join('');
  if (/^[\w@%+=:,./-]+$/.test(clean)) return clean;
  return `'${clean.replace(/'/g, "'\\''")}'`;
}

/**
 * Compose the final prompt sent to a session: prefix the effort keyword UNLESS the text is
 * a slash command (a skill must lead its line). Single line — callers guarantee no newline.
 */
export function composePrompt(text: string, effort: ThinkingEffortId): string {
  const body = text.trim();
  if (!body) return '';
  const kw = effortKeyword(effort);
  if (!kw || body.startsWith('/')) return body;
  return `${kw} ${body}`;
}
