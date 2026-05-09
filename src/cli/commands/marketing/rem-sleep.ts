import { Command } from 'commander';
import chalk from 'chalk';
import { error, header, info, success, warn } from '../../../lib/format.js';
import { runRemSleep } from '../../../lib/marketing/rem-sleep.js';
import { withLock } from '../../../lib/marketing/store.js';

export function registerMarketingRemSleep(parent: Command): void {
  parent
    .command('rem-sleep')
    .description('Marketing consolidation pass (called during sleep consolidation flow).')
    .option('--keep-runs <n>', 'Keep latest N runs/*.json files', (v) => parseInt(v, 10))
    .option('--weekly-after-days <n>', 'Drop insights to weekly resolution after N days', (v) => parseInt(v, 10))
    .option('--retain-daily-learnings-days <n>', 'Retain per-day learnings for N days', (v) => parseInt(v, 10))
    .option('--dry-run', 'Report planned changes without writing', false)
    .action(async (opts: {
      keepRuns?: number;
      weeklyAfterDays?: number;
      retainDailyLearningsDays?: number;
      dryRun?: boolean;
    }) => {
      console.log(header('Marketing rem-sleep'));
      try {
        const result = await withLock(async () => runRemSleep({
          keepRuns: opts.keepRuns,
          weeklyAfterDays: opts.weeklyAfterDays,
          retainDailyLearningsDays: opts.retainDailyLearningsDays,
          dryRun: opts.dryRun ?? false,
        }));

        if (!result.marketingPresent) {
          info('No _dream_context/marketing/ directory — nothing to consolidate.');
          return;
        }

        const tag = opts.dryRun ? chalk.yellow('[dry-run]') : chalk.green('[applied]');

        console.log(`${tag} runs/         scanned=${result.runs.scanned}  kept=${result.runs.kept}  deleted=${result.runs.deleted}`);
        console.log(`${tag} insights/     scanned=${result.insights.scanned}  kept=${result.insights.kept}  deleted=${result.insights.deleted}`);
        console.log(`${tag} learnings/    scanned=${result.learnings.scanned}  merged=${result.learnings.merged}  dropped_rejected=${result.learnings.droppedRejected}`);
        console.log(`${tag} redaction/    scanned=${result.redaction.scanned}  rewritten=${result.redaction.rewritten}`);

        if (result.learnings.archivePath) {
          info(`Archive: ${result.learnings.archivePath}`);
        }

        if (opts.dryRun) {
          warn('Dry run — no changes written. Re-run without --dry-run to apply.');
        } else {
          success('Marketing consolidation complete.');
        }
      } catch (e) {
        error(`Rem-sleep failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });
}
