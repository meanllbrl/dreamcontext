/**
 * mk pause / mk resume — status flips on any Meta entity (campaign / adset / ad).
 *
 * Both default to dry-run; --no-dry-run is required for live writes per task
 * line 598 ("All mutations dry-run default; --no-dry-run flag wired").
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { error, success, header, info } from '../../../lib/format.js';
import { pauseEntity, resumeEntity } from '../../../lib/marketing/meta-client.js';
import { TokenExpiredError, MetaApiError } from '../../../lib/marketing/meta-fetch.js';
import { withLock, beginRun } from '../../../lib/marketing/store.js';
import { buildCtx } from './_ctx.js';

export function registerMarketingPause(parent: Command): void {
  parent
    .command('pause <id>')
    .description('Pause a campaign / adset / ad. Default dry-run; pass --no-dry-run for live.')
    .option('--no-dry-run', 'Actually flip status (required for live)')
    .action(async (id: string, opts: { dryRun?: boolean }) => {
      await flipStatus({ id, action: 'pause', noDryRun: opts.dryRun === false });
    });
}

export function registerMarketingResume(parent: Command): void {
  parent
    .command('resume <id>')
    .description('Resume a paused campaign / adset / ad. Default dry-run; pass --no-dry-run for live.')
    .option('--no-dry-run', 'Actually flip status (required for live)')
    .action(async (id: string, opts: { dryRun?: boolean }) => {
      await flipStatus({ id, action: 'resume', noDryRun: opts.dryRun === false });
    });
}

async function flipStatus(args: { id: string; action: 'pause' | 'resume'; noDryRun: boolean }): Promise<void> {
  console.log(header(`${args.action === 'pause' ? 'Pause' : 'Resume'} — ${args.id}`));
  const ctx = buildCtx({ noDryRun: args.noDryRun });
  if (ctx.dryRun) info(chalk.yellow('[DRY-RUN] no live changes — pass --no-dry-run to flip status'));

  try {
    await withLock(async () => {
      const run = beginRun(`${args.action}-entity`, { id: args.id, dry_run: ctx.dryRun });
      try {
        const result = args.action === 'pause'
          ? await pauseEntity(ctx, args.id)
          : await resumeEntity(ctx, args.id);
        run.succeed({ ...result });
        success(`${args.id} → ${args.action === 'pause' ? 'PAUSED' : 'ACTIVE'}${ctx.dryRun ? ' (dry-run)' : ''}`);
      } catch (e) {
        run.fail((e as Error).message);
        throw e;
      }
    });
  } catch (e) {
    if (e instanceof TokenExpiredError) {
      error('Token expired. Regenerate and retry.');
      process.exit(1);
    }
    if (e instanceof MetaApiError) {
      error(`Graph API error: status=${e.status} code=${e.metaErrorCode ?? '-'}`);
      console.log(chalk.dim(e.message));
      process.exit(1);
    }
    error(`${args.action} failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
