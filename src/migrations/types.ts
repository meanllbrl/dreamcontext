// ─── Migration Types ──────────────────────────────────────────────────────────

/**
 * Result returned by a single migration step function.
 * filesTouched: absolute paths written/moved by this step.
 * detected: true when the step found no work to do (content already in final
 *   state) — used to distinguish a 'code' run from a 'detected' backfill.
 */
export interface MigrationStepResult {
  /** Stable identifier for this step (e.g. 'move-data-structures') */
  step: string;
  /** Absolute paths that were written/moved. Empty on idempotent re-run. */
  filesTouched: string[];
  /** Human-readable summary of what happened. */
  summary: string;
  /**
   * true when the step found the content ALREADY in the desired final state
   * (nothing written) — the step is being 'detected' on a pre-migrated clone.
   * false when work was actually done (code path ran and wrote/moved files).
   */
  detected: boolean;
  /**
   * Count of files that could NOT be migrated this run (write/verify/unlink
   * failure, or a torn/divergent pre-existing dest). 0 or absent = clean.
   * Presence signals a partial run: the caller MUST NOT advance setupVersion.
   */
  failedCount?: number;
}

/**
 * A single migration step: receives the _dream_context root and returns its result.
 */
export type MigrationStep = (root: string) => MigrationStepResult;

/**
 * An optional agent task associated with a migration version.
 * Returned when a migration has work requiring human judgment.
 */
export interface MigrationAgentTask {
  /** Stable identifier (kebab-case) */
  id: string;
  /** Instruction text for the agent: start by checking the filesystem. */
  instruction: string;
}

/**
 * A versioned migration entry in the registry.
 * version: the semver at which this migration was introduced.
 * steps: deterministic filesystem steps (idempotent on their own).
 * agentTask: optional — judgment-dependent work surfaced as a ledger entry
 *   with executor:'agent'.
 */
export interface Migration {
  version: string;
  steps: MigrationStep[];
  agentTask?: MigrationAgentTask;
}
