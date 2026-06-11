import { Command } from 'commander';
import { ensureContextRoot } from '../../lib/context-path.js';
import { pendingMigrations } from '../../migrations/index.js';
import { readSetupConfig } from '../../lib/setup-config.js';
import { appendLedger } from '../../lib/migration-ledger.js';
import { dreamcontextVersion } from '../../lib/manifest.js';
import { dirname } from 'node:path';
import { success, error, info } from '../../lib/format.js';
import type { LedgerEntry } from '../../lib/migration-ledger.js';

/**
 * Register the `dreamcontext migrations` command.
 * Subcommands: pending, record.
 * No 'status' subcommand (YAGNI — see task doc constraints).
 */
export function registerMigrationsCommand(program: Command): void {
  const migrations = program
    .command('migrations')
    .description('Inspect and record brain structure migrations');

  // --- pending ---
  migrations
    .command('pending')
    .description('Print pending agent task instructions for any unfinished migrations')
    .action(() => {
      const root = ensureContextRoot();
      const projectRoot = dirname(root);
      const config = readSetupConfig(projectRoot);
      const fromVersion = config?.setupVersion ?? '0.0.0';
      const toVersion = dreamcontextVersion();

      const pending = pendingMigrations(fromVersion, toVersion);
      const tasks = pending.filter((m) => m.agentTask);

      if (tasks.length === 0) {
        info('No pending agent migration tasks.');
        return;
      }

      for (const m of tasks) {
        console.log(`\n## Migration ${m.version} — ${m.agentTask!.id}\n`);
        console.log(m.agentTask!.instruction);
        console.log();
        console.log(
          `Record completion with: dreamcontext migrations record --version ${m.version} --step ${m.agentTask!.id} --executor agent --summary "<what you did>"`,
        );
      }
    });

  // --- record ---
  migrations
    .command('record')
    .description('Append a ledger entry (used by agent after completing an agentTask)')
    .requiredOption('--version <ver>', 'Migration version (e.g. 0.7.0)')
    .requiredOption('--step <id>', 'Step identifier (e.g. fence-data-structures)')
    .requiredOption(
      '--executor <type>',
      "Executor type: 'code' | 'agent' | 'detected'",
    )
    .option('--files <paths...>', 'Files touched (space-separated)', [])
    .option('--summary <text>', 'Human-readable summary', '')
    .action(
      (opts: {
        version: string;
        step: string;
        executor: string;
        files: string[];
        summary: string;
      }) => {
        const validExecutors = ['code', 'agent', 'detected'];
        if (!validExecutors.includes(opts.executor)) {
          error(
            `Invalid executor '${opts.executor}'. Must be one of: ${validExecutors.join(', ')}`,
          );
          return;
        }

        const root = ensureContextRoot();
        const entry: LedgerEntry = {
          version: opts.version,
          step: opts.step,
          executor: opts.executor as LedgerEntry['executor'],
          timestamp: new Date().toISOString(),
          filesTouched: Array.isArray(opts.files) ? opts.files : [],
          summary: opts.summary || `Recorded by agent: ${opts.step}`,
        };

        appendLedger(root, entry);
        success(
          `Ledger entry recorded: ${opts.version}/${opts.step} (${opts.executor})`,
        );
      },
    );
}
