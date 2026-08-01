import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readSleepState, writeSleepState } from '../cli/commands/sleep.js';
import { info, warn } from './format.js';
import { dreamcontextVersion } from './manifest.js';
import { runMigrations } from './migration-runner.js';
import { readSetupConfig, updateSetupConfig, type SetupConfig } from './setup-config.js';

/**
 * Run pending structural migrations, THEN stamp `setupVersion` — the single
 * ordering every command that advances setupVersion must follow.
 *
 * WHY THIS IS SHARED. `setupVersion` is the lower bound of the migration
 * runner's half-open range `(setupVersion, cliVersion]`. Any command that
 * writes it WITHOUT migrating first silently destroys every pending migration:
 * the next `update` computes `(cliVersion, cliVersion]` = empty and applies
 * nothing, and `migrations pending` can't rescue it either — `unfinishedAgentTasks`
 * requires a code/detected ledger entry to exist before it will report an agent
 * task, so a vault stranded this way reads as FRESH. There is no CLI affordance
 * to recover; the user has to hand-edit `state/.config.json`.
 *
 * That is not hypothetical: `update` refuses on a vault with no installed
 * platform by telling the user to run `install-skill` first, and `install-skill`
 * used to stamp setupVersion with no migration run at all — so following the
 * CLI's own instruction was enough to permanently lose the 0.23.0 people-first
 * and soul-split migrations (reproduced on a real 0.18.0 vault, 2026-07-30).
 *
 * `init` is deliberately NOT a caller: it scaffolds a brand-new vault, where
 * there is nothing to migrate, and it stamps setupVersion so that the
 * install step that follows it computes an empty range.
 */
export interface MigrateAndStampResult {
  /** setupVersion as read BEFORE any bump — the migration range's lower bound. */
  fromVersion: string;
  /** Version actually persisted, or `null` when it was pinned by a failure. */
  stamped: string | null;
  /** Files that failed to migrate this run. `> 0` pins setupVersion. */
  failedSteps: number;
  /** `version/step` ids of the code-executor steps applied this run. */
  appliedCodeSteps: string[];
}

/**
 * @param projectRoot  Project root (the directory CONTAINING `_dream_context/`).
 * @param extraConfig  Other config keys to persist in the same write (platforms,
 *                     packs, multiProduct). These are written even when a
 *                     migration fails — the install genuinely happened, and only
 *                     `setupVersion` is gated on a clean run.
 */
export function migrateThenStampSetupVersion(
  projectRoot: string,
  extraConfig: Partial<SetupConfig> = {},
): MigrateAndStampResult {
  const toVersion = dreamcontextVersion();

  // Capture fromVersion BEFORE bumping so migrations run over the correct
  // (from, to] range.
  const fromVersion = readSetupConfig(projectRoot)?.setupVersion ?? '0.0.0';

  const ctxRoot = join(projectRoot, '_dream_context');

  // No vault yet (install-skill run ahead of init): there is nothing to migrate,
  // and running the registry against a missing root would be meaningless. Stamp
  // and return — init will scaffold at the current version anyway.
  if (!existsSync(ctxRoot)) {
    updateSetupConfig(projectRoot, { ...extraConfig, setupVersion: toVersion });
    return { fromVersion, stamped: toVersion, failedSteps: 0, appliedCodeSteps: [] };
  }

  const migResult = runMigrations(ctxRoot, fromVersion, toVersion);

  const codeApplied = migResult.applied.filter((e) => e.executor === 'code');
  if (codeApplied.length > 0) {
    info(
      `Applied ${codeApplied.length} migration step(s): ${codeApplied.map((e) => `${e.version}/${e.step}`).join(', ')}`,
    );
    // Queue notices into .sleep.json so the next SessionStart snapshot surfaces
    // "Migrations applied since last session".
    const codeNotices = codeApplied.map((e) => `${e.version} ${e.step}: ${e.summary}`);
    const sleepState = readSleepState(ctxRoot);
    sleepState.pendingMigrationNotices = [
      ...sleepState.pendingMigrationNotices,
      ...codeNotices,
    ];
    writeSleepState(ctxRoot, sleepState);
  }

  // Persist setupVersion ONLY on a fully-clean migration run. A partial failure
  // pins it at fromVersion so the next run retries the pending migration
  // (idempotent) instead of silently skipping it. Dual-purpose caveat:
  // setupVersion also drives setup-drift.ts's asset-freshness check, so a
  // persistently-failing migration keeps the brain flagged "stale". Accepted
  // tradeoff: a nag is strictly safer than silently orphaning migrated-away
  // sources.
  if (migResult.failedSteps === 0) {
    updateSetupConfig(projectRoot, { ...extraConfig, setupVersion: toVersion });
    return {
      fromVersion,
      stamped: toVersion,
      failedSteps: 0,
      appliedCodeSteps: codeApplied.map((e) => `${e.version}/${e.step}`),
    };
  }

  // Still persist the non-gated keys — the install DID happen.
  if (Object.keys(extraConfig).length > 0) {
    updateSetupConfig(projectRoot, extraConfig);
  }
  warn(
    `Migration partially failed (${migResult.failedSteps} file(s)) — setupVersion left at ${fromVersion}. The next \`dreamcontext update\` will retry.`,
  );
  return {
    fromVersion,
    stamped: null,
    failedSteps: migResult.failedSteps,
    appliedCodeSteps: codeApplied.map((e) => `${e.version}/${e.step}`),
  };
}
