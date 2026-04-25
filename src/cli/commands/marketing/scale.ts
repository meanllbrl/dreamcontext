/**
 * mk scale --campaign <id> --pct +20
 *
 * Reads current daily_budget via getCampaign, applies the percent, calls
 * updateCampaign with the new value. Default dry-run; --no-dry-run for live.
 *
 * Snow-globe rule: refuses pcts outside [-50, +500] (task account-ops.md §4).
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { error, success, header, info, warn } from '../../../lib/format.js';
import { getCampaign, updateCampaign } from '../../../lib/marketing/meta-client.js';
import { TokenExpiredError, MetaApiError } from '../../../lib/marketing/meta-fetch.js';
import { parseScalePct, applyScale, BudgetInvalidError, formatBudget } from '../../../lib/marketing/budget.js';
import { withLock, beginRun } from '../../../lib/marketing/store.js';
import { buildCtx } from './_ctx.js';

export function registerMarketingScale(parent: Command): void {
  parent
    .command('scale')
    .description('Adjust a campaign\'s daily budget by percent. Default dry-run.')
    .requiredOption('--campaign <id>', 'campaign id (Meta fb_id)')
    .requiredOption('--pct <percent>', 'percent change, e.g. +20, -15')
    .option('--no-dry-run', 'Actually apply the budget change')
    .action(async (opts: { campaign: string; pct: string; dryRun?: boolean }) => {
      console.log(header(`Scale — ${opts.campaign} by ${opts.pct}%`));
      let multiplier: number;
      try {
        multiplier = parseScalePct(opts.pct);
      } catch (e) {
        error((e as BudgetInvalidError).message);
        process.exit(1);
      }
      const pct = (multiplier - 1) * 100;
      if (pct > 30) {
        warn(`+${pct.toFixed(0)}% exceeds account-ops.md §4 single-move guidance (+20-30%). Confirm with operator before running live.`);
      }

      const ctx = buildCtx({ noDryRun: opts.dryRun === false });
      if (ctx.dryRun) info(chalk.yellow('[DRY-RUN] no live changes — pass --no-dry-run to apply'));

      try {
        await withLock(async () => {
          const run = beginRun('scale-campaign', { campaign: opts.campaign, pct, dry_run: ctx.dryRun });
          try {
            const current = (await getCampaign(ctx, opts.campaign)) as { daily_budget?: string; name?: string };
            const currentMinor = Number.parseInt(current.daily_budget ?? '0', 10);
            if (!Number.isFinite(currentMinor) || currentMinor <= 0) {
              throw new Error(`campaign ${opts.campaign} has no daily_budget — scaling not applicable`);
            }
            const newMinor = applyScale(currentMinor, pct);
            const currency = 'minor';   // Currency lookup deferred to PR 2 polish.
            info(`current: ${formatBudget(currentMinor, currency)}`);
            info(`new:     ${formatBudget(newMinor, currency)}  (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`);
            const result = await updateCampaign(ctx, opts.campaign, { daily_budget: newMinor });
            run.succeed({ ...result, current_minor: currentMinor, new_minor: newMinor });
            success(`scaled${ctx.dryRun ? ' (dry-run)' : ''}`);
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
        error(`scale failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });
}
