import { Command } from 'commander';
import { ensureContextRoot } from '../../lib/context-path.js';
import { dueAgentTasks, agentTaskById } from '../../migrations/index.js';
import { appendLedger } from '../../lib/migration-ledger.js';
import { migrateDiagramsToFolders } from '../../lib/diagrams-migration.js';
import { dreamcontextVersion } from '../../lib/manifest.js';
import { success, error, info, warn } from '../../lib/format.js';
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
    .description('Print the agent migration tasks that have work waiting, with their instructions')
    .option('--json', 'Print the due tasks as JSON (version, id, title only), for the app server')
    .action((opts: { json?: boolean }) => {
      const root = ensureContextRoot();

      // LEDGER-judged, deliberately NOT setupVersion-ranged: `update` advances
      // setupVersion as soon as the code steps land, which used to make this
      // command compute the empty range (cliVersion, cliVersion] and go blind
      // to the agentTask it exists to print. See dueAgentTasks for the rule.
      const due = dueAgentTasks(root, dreamcontextVersion());

      if (opts.json) {
        // Ids, versions and titles only: registry constants, never instruction or vault text.
        console.log(JSON.stringify(due.map((d) => ({ version: d.version, id: d.id, title: d.title }))));
        return;
      }

      if (due.length === 0) {
        info('No pending agent migration tasks.');
        return;
      }

      for (const d of due) {
        const found = agentTaskById(d.id);
        if (!found) continue;
        console.log(`\n## Migration ${d.version} — ${d.id}: ${d.title}\n`);
        console.log(found.task.instruction);
        console.log();
        console.log(
          `Record completion with: dreamcontext migrations record --version ${d.version} --step ${d.id} --executor agent --summary "<what you did>"`,
        );
        console.log(
          `If the owner says no, record it: dreamcontext migrations record --version ${d.version} --step ${d.id} --executor agent --summary "owner declined: <his words>"`,
        );
      }
    });

  // --- apply-diagrams ---
  migrations
    .command('apply-diagrams')
    .description(
      'Organize flat knowledge/diagrams/*.excalidraw.md boards into per-title folders. ' +
      'Moves board + same-basename generator/spec files, rewrites inbound [[wikilinks]] atomically. ' +
      'Opt-in: only organize boards you confirm are canonical knowledge.',
    )
    .action(() => {
      const root = ensureContextRoot();

      const result = migrateDiagramsToFolders(root);

      const totalMoved = result.moved.length;
      const totalSkipped = result.skipped.length;
      const totalAmbiguous = result.ambiguous.length;

      if (totalMoved === 0 && totalSkipped === 0 && totalAmbiguous === 0) {
        info('nothing to organize — no flat boards found in knowledge/diagrams/');
        return;
      }

      if (result.moved.length > 0) {
        console.log('\nMoved into per-title folders:');
        for (const slug of result.moved) {
          console.log(`  diagrams/${slug}.excalidraw.md  →  diagrams/${slug}/${slug}.excalidraw.md`);
        }
      }

      if (result.skipped.length > 0) {
        console.log('\nAlready in per-title folder (skipped):');
        for (const slug of result.skipped) {
          console.log(`  diagrams/${slug}/${slug}.excalidraw.md`);
        }
      }

      if (result.ambiguous.length > 0) {
        console.log('\nLeft in place (ambiguous — check manually):');
        for (const item of result.ambiguous) {
          console.log(`  ${item}`);
        }
      }

      if (totalMoved === 0) {
        info(`nothing moved (${totalSkipped} already foldered, ${totalAmbiguous} ambiguous)`);
        return;
      }

      // Record a ledger entry for the work done.
      const movedPaths = result.moved.map(
        (slug) => `knowledge/diagrams/${slug}/${slug}.excalidraw.md`,
      );
      const entry: LedgerEntry = {
        version: '0.7.2',
        step: 'diagrams-folder-convention',
        executor: 'agent',
        timestamp: new Date().toISOString(),
        filesTouched: movedPaths,
        summary: `Organized ${totalMoved} flat board(s) into per-title folders: ${result.moved.join(', ')}`,
      };
      appendLedger(root, entry);

      success(
        `Moved ${totalMoved} board(s) into per-title folders. Inbound [[wikilinks]] rewritten atomically. Ledger entry recorded (0.7.2/diagrams-folder-convention).`,
      );
      if (totalAmbiguous > 0) {
        warn(`${totalAmbiguous} board(s) left in place due to ambiguous siblings — review manually.`);
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
