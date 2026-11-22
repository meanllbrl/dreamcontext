import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { migrationsToRun, dueAgentTasks, agentTaskById } from '../migrations/index.js';
import {
  readLedger,
  appendLedger,
  isApplied,
  type LedgerEntry,
} from './migration-ledger.js';
import { insertToJsonArray } from './json-file.js';
import { today } from './id.js';
import { resolveAuthors } from './people-resolve.js';
import type { MigrationAgentTask } from '../migrations/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PendingAgentTask {
  version: string;
  agentTask: MigrationAgentTask;
}

export interface RunMigrationsResult {
  applied: LedgerEntry[];
  pendingAgentTasks: PendingAgentTask[];
  /**
   * Total files that failed to migrate across all steps this run (sum of each
   * step's `failedCount`). > 0 means a partial run — callers (update.ts) MUST
   * NOT advance setupVersion so the next `update` retries the pending migration.
   */
  failedSteps: number;
}

// ─── Runner ───────────────────────────────────────────────────────────────────

/**
 * Run all pending migrations in the (from, to] range against the given
 * _dream_context root.
 *
 * Ledger gating is an OPTIMIZATION — code steps must be independently
 * filesystem-idempotent (the ledger is not the safety net).
 *
 * CHANGELOG: for each version with >=1 'code' step applied this run, appends
 * one entry to core/CHANGELOG.json. Guarded with existsSync — never throws
 * when the file is absent (fresh projects, team clones).
 *
 * Does NOT write the ledger from snapshot/read paths — only called from
 * update.ts and sleep.ts.
 */
export function runMigrations(
  contextRoot: string,
  fromVersion: string,
  toVersion: string,
): RunMigrationsResult {
  // Downgrade guard: if to < from, the range is empty and only the `everyRun`
  // repairs run (they exist for exactly that case — see Migration.everyRun).
  const pending = migrationsToRun(fromVersion, toVersion);
  if (pending.length === 0) {
    return { applied: [], pendingAgentTasks: duePending(contextRoot, toVersion), failedSteps: 0 };
  }

  const ledger = readLedger(contextRoot);
  const applied: LedgerEntry[] = [];
  let failedTotal = 0;

  for (const migration of pending) {
    for (const stepFn of migration.steps) {
      // Run a dummy probe to get the step id
      // We need the step id before running for the isApplied check.
      // Steps are identified by their result.step field — we run them to get it.
      // Per spec: ledger gating is optimization; steps are idempotent by themselves.
      // But we MUST know the step id before running to implement the gate.
      // Solution: steps encode their id in a stable way (function body is stable).
      // Approach: run the step — it's idempotent — then check if already applied
      // before recording. This satisfies the spec: code steps filesystem-idempotent,
      // ledger gate is optimization.
      //
      // Actually the spec says: "if isApplied skip; else run step(root)".
      // But we don't know the step id until we run it. The task doc pattern
      // expects we CAN skip before running — meaning we need the step id up front.
      // The step functions always return a stable `step` string — we can run
      // the step and then gate the LEDGER WRITE. The filesystem op is idempotent.
      //
      // Implementation: run the step unconditionally (it's idempotent), then:
      //   - if already in ledger: skip ledger append (de-dup)
      //   - else: append based on result

      const result = stepFn(contextRoot);

      // Accumulate failures BEFORE the isApplied short-circuit: a ledger-recorded
      // step that re-fails on a retry must still report its failures upward so
      // update.ts keeps setupVersion pinned until the migration completes cleanly.
      failedTotal += result.failedCount ?? 0;

      // Agent work this step found is its OWN ledger entry (`<step>#work`), gated
      // by its own id, so an earlier "found nothing" entry of the step never
      // swallows a later sighting, and an every-run step's sighting is written
      // even when it touched no files. `dueAgentTasks` reads only these.
      if (result.agentWorkFor) {
        const workStep = `${result.step}#work`;
        if (!isApplied(ledger, migration.version, workStep)) {
          const sighting: LedgerEntry = {
            version: migration.version,
            step: workStep,
            executor: 'detected',
            timestamp: new Date().toISOString(),
            filesTouched: [],
            summary: `Agent work found for ${result.agentWorkFor}.`,
            agentWorkFor: result.agentWorkFor,
          };
          appendLedger(contextRoot, sighting);
          ledger.push(sighting);
          applied.push(sighting);
        }
      }

      // Check if this step is already recorded in the ledger we read at start.
      // NOTE (ledger staleness): a step first ledgered as a partial failure keeps
      // its original 'summary' forever — a later clean retry is gated out here and
      // never rewrites the entry. The setupVersion gate uses the live failedSteps
      // value (never the ledger text), so this is cosmetic/audit-only.
      if (isApplied(ledger, migration.version, result.step)) {
        continue;
      }
      // An every-run repair is ledgered by the pass that changed files, never by
      // one that found nothing (that would write `.migrations.json` and a
      // CHANGELOG line on every vault) or only failed (its retry would then be
      // gated out of the ledger and its notice). Failures still counted above.
      if (migration.everyRun && result.filesTouched.length === 0) {
        continue;
      }

      const executor: LedgerEntry['executor'] = result.detected
        ? 'detected'
        : 'code';

      const entry: LedgerEntry = {
        version: migration.version,
        step: result.step,
        executor,
        timestamp: new Date().toISOString(),
        filesTouched: result.filesTouched,
        summary: result.summary,
      };

      appendLedger(contextRoot, entry);
      // Also add to our in-memory copy so subsequent steps in same run see it
      ledger.push(entry);
      applied.push(entry);
    }
  }

  // CHANGELOG append: one entry per version with >=1 'code' step this run
  const changelogPath = join(contextRoot, 'core', 'CHANGELOG.json');
  if (existsSync(changelogPath)) {
    // Group applied entries by version, only those with executor='code'
    const codeByVersion = new Map<string, LedgerEntry[]>();
    for (const entry of applied) {
      if (entry.executor === 'code') {
        const list = codeByVersion.get(entry.version) ?? [];
        list.push(entry);
        codeByVersion.set(entry.version, list);
      }
    }

    // The human who ran the upgrade is the honest author of a migration entry.
    // `undefined` on a vault with no people/people.json (D18) ⇒ no `authors` key,
    // exactly as before — resolved once, since every entry shares the runner.
    const authors = resolveAuthors(contextRoot);

    for (const [version, entries] of codeByVersion) {
      const description = `Migration ${version} applied: ${entries.map((e) => e.step).join(', ')}`;
      const summary = entries.map((e) => e.summary).join('; ');
      const changelogEntry = {
        date: today(),
        type: 'change',
        scope: 'migration',
        description,
        breaking: false,
        summary,
        references: ['file:state/.migrations.json'],
        ...(authors?.length ? { authors } : {}),
      };
      try {
        insertToJsonArray(changelogPath, changelogEntry, 'top');
      } catch {
        // existsSync already passed — ignore write errors (read-only mount, etc.)
      }
    }
  }

  return { applied, pendingAgentTasks: duePending(contextRoot, toVersion), failedSteps: failedTotal };
}

/** The ledger's due agent work (one rule: `dueAgentTasks`), in the runner's result shape. */
function duePending(contextRoot: string, toVersion: string): PendingAgentTask[] {
  const out: PendingAgentTask[] = [];
  for (const due of dueAgentTasks(contextRoot, toVersion)) {
    const found = agentTaskById(due.id);
    if (found) out.push({ version: found.version, agentTask: found.task });
  }
  return out;
}
