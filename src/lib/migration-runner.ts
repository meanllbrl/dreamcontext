import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions } from './version-check.js';
import { pendingMigrations } from '../migrations/index.js';
import {
  readLedger,
  appendLedger,
  isApplied,
  type LedgerEntry,
} from './migration-ledger.js';
import { insertToJsonArray } from './json-file.js';
import { today } from './id.js';
import type { MigrationAgentTask } from '../migrations/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PendingAgentTask {
  version: string;
  agentTask: MigrationAgentTask;
}

export interface RunMigrationsResult {
  applied: LedgerEntry[];
  pendingAgentTasks: PendingAgentTask[];
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
  // Downgrade guard: if to < from, nothing to run
  if (compareVersions(toVersion, fromVersion) < 0) {
    return { applied: [], pendingAgentTasks: [] };
  }

  const pending = pendingMigrations(fromVersion, toVersion);
  if (pending.length === 0) {
    return { applied: [], pendingAgentTasks: [] };
  }

  const ledger = readLedger(contextRoot);
  const applied: LedgerEntry[] = [];

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

      // Check if this step is already recorded in the ledger we read at start
      if (isApplied(ledger, migration.version, result.step)) {
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
      };
      try {
        insertToJsonArray(changelogPath, changelogEntry, 'top');
      } catch {
        // existsSync already passed — ignore write errors (read-only mount, etc.)
      }
    }
  }

  // Collect pending agent tasks: migrations with agentTask that don't yet
  // have an executor:'agent' entry in the ledger
  const finalLedger = readLedger(contextRoot);
  const pendingAgentTasks: PendingAgentTask[] = [];
  for (const migration of pending) {
    if (!migration.agentTask) continue;
    const hasAgentEntry = finalLedger.some(
      (e) => e.version === migration.version && e.executor === 'agent',
    );
    if (!hasAgentEntry) {
      pendingAgentTasks.push({
        version: migration.version,
        agentTask: migration.agentTask,
      });
    }
  }

  return { applied, pendingAgentTasks };
}
