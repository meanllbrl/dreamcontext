/**
 * Eco Plus (owner, 2026-11-22): for people whose worry is the usage limit, most work runs on
 * Sonnet instead of Opus while the judges stay on Opus. This module is the ONE rule for what a
 * spawn's model becomes; it is a leaf (no disk, no imports) so every spawn site, the hook and the
 * dashboard mirror (`dashboard/src/lib/agentSettings.ts`, pinned by tests/unit/eco-plus.test.ts)
 * apply the same table.
 *
 * - {@link lowerModel}: Opus and Fable (alias, `[1m]` suffix, any `claude-opus-*` /
 *   `claude-fable-*` id) and `''` (inherit the CLI, which may be Opus) become plain `sonnet`.
 *   Everything else (Sonnet, Haiku, any other id) passes through. Never raises a family.
 * - {@link resolveSpawnModel}: lowers only when Eco Plus is on, the tool is Claude, and the
 *   model came from a saved setting or no setting at all. A model picked for this one chat or
 *   job, or a resumed session's recorded model, is kept.
 *
 * The lowered value is written into the spawn argv only, never back into a settings file, a
 * manifest or an agent definition (approval hashes and consent fingerprints never move).
 */

/** Where a spawn's model came from (plan eco-plus D3). */
export type ModelSource = 'saved' | 'default' | 'pick' | 'resume';

export const MODEL_SOURCES: readonly ModelSource[] = ['saved', 'default', 'pick', 'resume'];

/** Parse a `modelSource` query value; anything unknown (or absent) is `pick`, today's behaviour. */
export function parseModelSource(v: unknown): ModelSource {
  return v === 'saved' || v === 'default' || v === 'resume' || v === 'pick' ? v : 'pick';
}

/** The model Eco Plus lowers to: the Agent tool's enum value, never a `[1m]` id. */
export const ECO_PLUS_MODEL = 'sonnet';

const HEAVY_RE = /^(?:opus|fable)(?:\[1m\])?$|^claude-(?:opus|fable)(?:-[a-z0-9.-]*)?(?:\[1m\])?$/i;

/** True for a model Eco Plus lowers: Opus, Fable (any spelling) or `''`. */
export function isHeavyModel(model: string | null | undefined): boolean {
  const m = (model ?? '').trim();
  return m === '' || HEAVY_RE.test(m);
}

/** The D2 table: Opus/Fable/'' → `sonnet`; everything else unchanged. */
export function lowerModel(model: string | null | undefined): string {
  const m = (model ?? '').trim();
  return isHeavyModel(m) ? ECO_PLUS_MODEL : m;
}

export interface SpawnModelInput {
  model: string | null | undefined;
  source: ModelSource;
  /** The spawn's tool; only `claude` (or unset) is ever lowered. */
  tool?: string | null;
  /** Eco Plus is on for this Mac. */
  on: boolean;
}

export interface SpawnModel {
  model: string;
  lowered: boolean;
}

/** The model a spawn runs with (plan eco-plus K1). Identity unless on + Claude + saved|default. */
export function resolveSpawnModel({ model, source, tool, on }: SpawnModelInput): SpawnModel {
  const m = (model ?? '').trim();
  const claude = !tool || tool === 'claude';
  if (!on || !claude || (source !== 'saved' && source !== 'default')) return { model: m, lowered: false };
  const next = lowerModel(m);
  return { model: next, lowered: next !== m };
}

/** Sub-agent types that stay on their own (Opus) model under Eco Plus: the judges (plan D6). */
export const ECO_PLUS_KEPT_AGENTS: readonly string[] = ['reviewer', 'review-security', 'goal-plan-reviewer'];
