import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import chalk from 'chalk';
import { error, success, header, info } from '../../../lib/format.js';
import { createAdSet } from '../../../lib/marketing/meta-client.js';
import { TokenExpiredError, MetaApiError } from '../../../lib/marketing/meta-fetch.js';
import { withLock, beginRun } from '../../../lib/marketing/store.js';
import { loadEntity, saveEntity, listEntities, newEntityId, type CampaignEntity, type AdSetEntity } from '../../../lib/marketing/entity-store.js';
import { parseDailyBudget, BudgetInvalidError, BudgetMissingError } from '../../../lib/marketing/budget.js';
import { buildCtx } from './_ctx.js';

export function registerMarketingAdSet(parent: Command): void {
  const cmd = parent
    .command('adset')
    .description('Manage adsets.');

  cmd
    .command('create')
    .description('Create an adset (PAUSED). --daily-budget required (no fallback).')
    .requiredOption('--campaign <id>', 'parent campaign local id')
    .requiredOption('--name <name>', 'adset name')
    .requiredOption('--daily-budget <amount>', 'daily budget (major-currency units)')
    .requiredOption('--targeting <file>', 'JSON file with Meta targeting spec')
    .option('--currency <code>', 'currency code', 'TRY')
    .option('--optimization-goal <goal>', 'OFFSITE_CONVERSIONS|LINK_CLICKS|...', 'OFFSITE_CONVERSIONS')
    .option('--billing-event <event>', 'IMPRESSIONS|LINK_CLICKS|THRUPLAY', 'IMPRESSIONS')
    .option('--custom-event-type <evt>', 'e.g. PURCHASE, COMPLETE_REGISTRATION (for OFFSITE_CONVERSIONS)')
    .option('--no-dry-run', 'Actually create on Meta')
    .action(async (opts: {
      campaign: string; name: string; dailyBudget: string; targeting: string;
      currency?: string; optimizationGoal?: string; billingEvent?: string; customEventType?: string;
      dryRun?: boolean;
    }) => {
      console.log(header(`Adset create — ${opts.name}`));

      const campaign = loadEntity<CampaignEntity>('campaign', opts.campaign);
      if (!campaign) {
        error(`Campaign "${opts.campaign}" not found. Run \`dreamcontext marketing campaign list\`.`);
        process.exit(1);
      }

      // Budget — required, no fallback (BudgetMissingError if blank)
      let dailyBudgetMinor: number;
      try {
        dailyBudgetMinor = parseDailyBudget(opts.dailyBudget, opts.currency ?? 'TRY');
      } catch (e) {
        if (e instanceof BudgetMissingError || e instanceof BudgetInvalidError) {
          error(e.message);
          process.exit(1);
        }
        throw e;
      }

      // Targeting file
      if (!existsSync(opts.targeting)) {
        error(`Targeting file not found: ${opts.targeting}`);
        process.exit(1);
      }
      let targeting: Record<string, unknown>;
      try {
        targeting = JSON.parse(readFileSync(opts.targeting, 'utf8'));
      } catch (e) {
        error(`Failed to parse targeting JSON: ${(e as Error).message}`);
        process.exit(1);
      }

      const ctx = buildCtx({ noDryRun: opts.dryRun === false });
      if (ctx.dryRun) info(chalk.yellow('[DRY-RUN] no live changes — pass --no-dry-run to create on Meta'));

      const localId = newEntityId('adset');
      const now = new Date().toISOString();

      try {
        await withLock(async () => {
          const run = beginRun('adset-create', {
            local_id: localId, campaign: opts.campaign, name: opts.name,
            daily_budget: dailyBudgetMinor, dry_run: ctx.dryRun,
          });
          try {
            const promotedObject = ctx.pixelId && opts.customEventType
              ? { pixel_id: ctx.pixelId, custom_event_type: opts.customEventType }
              : undefined;

            const result = await createAdSet(ctx, {
              name: opts.name,
              campaign_id: ctx.dryRun ? campaign.fb_id || campaign.id : campaign.fb_id,
              daily_budget: dailyBudgetMinor,
              optimization_goal: (opts.optimizationGoal ?? 'OFFSITE_CONVERSIONS') as 'OFFSITE_CONVERSIONS',
              billing_event: (opts.billingEvent ?? 'IMPRESSIONS') as 'IMPRESSIONS',
              ...(promotedObject ? { promoted_object: promotedObject } : {}),
              targeting: targeting as never,
              status: 'PAUSED',
            });

            const entity: AdSetEntity = {
              id: localId,
              kind: 'adset',
              fb_id: ctx.dryRun ? '' : String(result.id),
              status: 'PAUSED',
              cohort_id: campaign.cohort_id,
              name: opts.name,
              campaign_id: opts.campaign,
              daily_budget: dailyBudgetMinor,
              optimization_goal: opts.optimizationGoal ?? 'OFFSITE_CONVERSIONS',
              billing_event: opts.billingEvent ?? 'IMPRESSIONS',
              ...(promotedObject ? { promoted_object: promotedObject } : {}),
              targeting,
              created_at: now,
              updated_at: now,
            };
            saveEntity(entity);

            run.succeed({ local_id: localId, fb_id: entity.fb_id });
            success(`adset ${chalk.cyan(localId)}${entity.fb_id ? ` → ${chalk.dim(entity.fb_id)}` : ''}${ctx.dryRun ? ' (dry-run)' : ''}`);
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
        error(`adset create failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command('list')
    .description('List adsets (optionally filtered by campaign).')
    .option('--campaign <id>', 'filter by campaign local id')
    .action((opts: { campaign?: string }) => {
      const all = listEntities<AdSetEntity>('adset');
      const filtered = opts.campaign ? all.filter((a) => a.campaign_id === opts.campaign) : all;
      console.log(header('Adsets'));
      if (filtered.length === 0) {
        info('No adsets yet.');
        return;
      }
      for (const a of filtered) {
        const fb = a.fb_id ? chalk.dim(`fb:${a.fb_id}`) : chalk.yellow('dry-run');
        console.log(`  ${chalk.cyan(a.id)}  ${a.status.padEnd(8)}  ${chalk.dim(`budget=${(a.daily_budget / 100).toFixed(2)}`).padEnd(20)}  ${fb}  ${a.name}`);
      }
    });
}
