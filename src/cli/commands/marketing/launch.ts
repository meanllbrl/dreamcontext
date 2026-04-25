/**
 * mk launch <cohort_id> --confirm <cohort_id> [--no-dry-run]
 * mk launch resume <run_id>
 *
 * Hard guardrails per task PR 3 contract (line 226):
 *   - --confirm <cohort_id> typed verbatim (no -y/--yes shortcut)
 *   - 6-line human summary printed BEFORE any flip
 *   - Pre-flip WAL → flip one entity at a time → mk launch resume <run_id>
 *   - No silent retries on the actual ACTIVE flip step
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { error, success, header, info, warn } from '../../../lib/format.js';
import { withLock } from '../../../lib/marketing/store.js';
import { loadCohort } from '../../../lib/marketing/cohort.js';
import {
  buildLaunchSummary, renderLaunchSummary,
  createLaunchWal, executeFlips, readWal, findWalByRunId,
  type PlannedFlip,
} from '../../../lib/marketing/launch.js';
import { TokenExpiredError, MetaApiError } from '../../../lib/marketing/meta-fetch.js';
import { buildCtx } from './_ctx.js';

export function registerMarketingLaunch(parent: Command): void {
  const cmd = parent
    .command('launch [cohortId]')
    .description('Launch a cohort: flip every campaign/adset/ad from PAUSED to ACTIVE.')
    .option('--confirm <cohortId>', 'cohort id typed verbatim — required, no shortcut')
    .option('--no-dry-run', 'Actually flip on Meta')
    .action(async (cohortId: string | undefined, opts: { confirm?: string; dryRun?: boolean }) => {
      if (!cohortId) {
        error('Usage: dreamcontext marketing launch <cohort_id> --confirm <cohort_id>');
        process.exit(1);
      }
      console.log(header(`Launch — ${cohortId}`));

      // Hard typed-confirm
      if (opts.confirm !== cohortId) {
        error(`--confirm must match the cohort_id verbatim.`);
        if (opts.confirm) console.log(chalk.dim(`  expected: ${cohortId}\n  got:      ${opts.confirm}`));
        else console.log(chalk.dim(`  pass --confirm ${cohortId} to proceed`));
        process.exit(1);
      }

      // 6-line human summary
      const summary = buildLaunchSummary(cohortId);
      if ('error' in summary) {
        error(summary.error);
        process.exit(1);
      }
      console.log(chalk.bold('\nSummary:'));
      for (const line of renderLaunchSummary(summary)) {
        console.log(`  ${line}`);
      }
      console.log();

      const ctx = buildCtx({ noDryRun: opts.dryRun === false });
      if (ctx.dryRun) info(chalk.yellow('[DRY-RUN] no live changes — pass --no-dry-run to flip on Meta'));

      // Create WAL pre-flip
      const cohort = loadCohort(cohortId);
      if (!cohort) {
        error(`Cohort ${cohortId} not found.`);
        process.exit(1);
      }
      let walPath: string;
      try {
        const created = await withLock(async () => createLaunchWal({
          cohortId,
          cohortName: cohort.name,
          dryRun: ctx.dryRun,
        }));
        walPath = created.walPath;
      } catch (e) {
        error(`Failed to create launch WAL: ${(e as Error).message}`);
        process.exit(1);
      }
      info(`WAL: ${chalk.dim(walPath)}`);

      // Execute flips one at a time (HALTS at first error per task contract)
      console.log();
      console.log(chalk.bold('Flipping:'));
      const result = await executeFlips(ctx, walPath, {
        onPlanItem: (item: PlannedFlip) => {
          process.stdout.write(`  ${chalk.dim('→')} ${item.kind.padEnd(8)} ${chalk.cyan(item.id)}  ${chalk.dim(item.name)} ... `);
        },
        onFlipped: () => {
          console.log(chalk.green('ACTIVE'));
        },
        onError: (item, err) => {
          console.log(chalk.red('FAILED'));
          console.log(chalk.dim(`     ${err.message.split('\n')[0].slice(0, 200)}`));
          if (err instanceof TokenExpiredError) {
            error('Token expired. Regenerate and retry. WAL is preserved — `mk launch resume <run_id>` after re-auth.');
          } else if (err instanceof MetaApiError) {
            error(`Meta returned status=${err.status} code=${err.metaErrorCode ?? '-'} on ${item.kind} ${item.id}.`);
          }
        },
      });

      console.log();
      const runId = walPath.split('/').pop()?.replace(/\.json$/, '') ?? '?';
      switch (result.status) {
        case 'complete':
          success(`launch complete · flipped=${result.flipped}${ctx.dryRun ? ' (dry-run)' : ''}`);
          break;
        case 'partial':
          warn(`launch partial · flipped=${result.flipped} · remaining=${result.remaining}`);
          info(`Resume after fixing the issue: ${chalk.cyan(`dreamcontext marketing launch resume ${runId}`)}`);
          process.exit(1);
          break;
        case 'aborted':
          error(`launch aborted: ${result.errors.join('; ')}`);
          process.exit(1);
          break;
      }
    });

  cmd
    .command('resume <runId>')
    .description('Resume a partial launch from its WAL.')
    .option('--no-dry-run', 'Match the WAL\'s ctx (must agree with the original launch)')
    .action(async (runId: string, opts: { dryRun?: boolean }) => {
      console.log(header(`Launch resume — ${runId}`));
      const walPath = findWalByRunId(runId);
      if (!walPath) {
        error(`No launch WAL found for ${runId}. Check ${chalk.dim('_dream_context/marketing/runs/')}.`);
        process.exit(1);
      }
      const wal = readWal(walPath);
      if (!wal) {
        error(`Failed to read WAL at ${walPath}.`);
        process.exit(1);
      }

      info(`WAL: ${chalk.dim(walPath)}`);
      info(`cohort: ${wal.cohort_name} (${wal.cohort_id})`);
      info(`status: ${wal.status} · flipped=${wal.flipped_count}/${wal.planned.length}`);

      if (wal.status === 'complete') {
        success('WAL already complete — nothing to do.');
        return;
      }

      const ctx = buildCtx({ noDryRun: opts.dryRun === false });
      if (wal.dry_run !== ctx.dryRun) {
        error(`Ctx mismatch: WAL was ${wal.dry_run ? 'dry-run' : 'live'} but current invocation is ${ctx.dryRun ? 'dry-run' : 'live'}. Re-run with matching --no-dry-run flag.`);
        process.exit(1);
      }

      console.log();
      console.log(chalk.bold('Resuming flips:'));
      const result = await executeFlips(ctx, walPath, {
        onPlanItem: (item) => {
          process.stdout.write(`  ${chalk.dim('→')} ${item.kind.padEnd(8)} ${chalk.cyan(item.id)} ... `);
        },
        onFlipped: () => console.log(chalk.green('ACTIVE')),
        onError: (item, err) => {
          console.log(chalk.red('FAILED'));
          console.log(chalk.dim(`     ${err.message.split('\n')[0].slice(0, 200)}`));
        },
      });

      console.log();
      switch (result.status) {
        case 'complete':
          success(`resume complete · total flipped=${result.flipped}${ctx.dryRun ? ' (dry-run)' : ''}`);
          break;
        case 'partial':
          warn(`still partial · flipped=${result.flipped} · remaining=${result.remaining}`);
          process.exit(1);
          break;
        case 'aborted':
          error(`resume aborted: ${result.errors.join('; ')}`);
          process.exit(1);
          break;
      }
    });
}
