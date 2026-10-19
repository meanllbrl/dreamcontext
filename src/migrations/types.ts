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
   *
   * ONLY FOR RETRYABLE FAILURES — a read-only mount, a torn file, a lost race.
   * Never for content the step cannot deterministically interpret.
   *
   * The distinction is load-bearing, not stylistic. `runMigrations` re-runs every
   * step on every `update` and sums `failedCount` BEFORE the ledger gate, and
   * `migrateThenStampSetupVersion` pins `setupVersion` whenever that sum is > 0.
   * So a step that reports `failedCount` for input it will never be able to parse
   * pins the vault PERMANENTLY: the same content re-fails on every future run,
   * `setupVersion` never advances, the drift check reports stale assets forever,
   * and there is no supported recovery short of hand-editing
   * `state/.config.json`. Two real vaults sat on 0.21.0 this way (0.23.0's
   * `split-user-file`, on a `## People` block written as prose).
   *
   * Content the step cannot interpret is `agentTask` work by definition (D5:
   * deterministic detection in the code step, judgment in the agentTask). Route
   * it — to the residue, to a `detected` entry, to whatever the migration's
   * agent path is — and return CLEAN. The agent finishing the job later is a
   * completed migration; a pinned vault is not.
   */
  failedCount?: number;
}

/**
 * A single migration step: receives the _dream_context root and returns its result.
 *
 * A step may only do what is DETERMINISTIC. The two questions that look
 * mechanical and are not, both learned the hard way on 0.23.0:
 *
 *   - "which fragment of this line is a person's NAME?" — a `## People` bullet
 *     written as description has no parseable answer.
 *   - "WHOSE prose is this?" — when `resolveActivePerson` cannot name the person
 *     at the keyboard, neither can a step. Ranking the roster and taking the
 *     first entry is not a fallback, it is a coin flip: it wrote one teammate's
 *     Identity / Preferences / Communication Style into another's constitution
 *     while the real owner's file stayed an empty scaffold.
 *
 * Route both to the `agentTask` and return CLEAN. Judgment reaching a person's
 * constitution is worse than judgment left undone, because the step deletes its
 * own source: after `split-user-file` unlinks `core/1.user.md`, a wrong
 * destination is indistinguishable from a right one.
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
  /**
   * true for tasks that are an OFFER, not an obligation (e.g. 0.7.2's
   * organize-your-diagram-boards): they are never "unfinished", so
   * `migrations pending` does not list them — they run only through their own
   * explicit command and record their ledger entry there. Without this flag a
   * ledger-judged pending would nag about them forever on every old vault.
   */
  optIn?: boolean;
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
