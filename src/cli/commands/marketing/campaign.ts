import { Command } from 'commander';
import chalk from 'chalk';
import { error, success, header, info, warn } from '../../../lib/format.js';
import { createCampaign } from '../../../lib/marketing/meta-client.js';
import { TokenExpiredError, MetaApiError } from '../../../lib/marketing/meta-fetch.js';
import { withLock, beginRun } from '../../../lib/marketing/store.js';
import { loadCohort, saveCohort } from '../../../lib/marketing/cohort.js';
import { newEntityId, saveEntity, listEntities, type CampaignEntity } from '../../../lib/marketing/entity-store.js';
import { parseDailyBudget, BudgetMissingError, BudgetInvalidError } from '../../../lib/marketing/budget.js';
import { buildCtx } from './_ctx.js';

const ALLOWED_OBJECTIVES = ['OUTCOME_LEADS', 'OUTCOME_SALES', 'OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT', 'OUTCOME_AWARENESS', 'OUTCOME_APP_PROMOTION'];

export function registerMarketingCampaign(parent: Command): void {
  const cmd = parent
    .command('campaign')
    .description('Manage campaigns within a cohort.');

  cmd
    .command('create')
    .description('Create a campaign (PAUSED). --daily-budget required for CBO; omit for adset-level budgeting.')
    .requiredOption('--cohort <id>', 'parent cohort id')
    .requiredOption('--name <name>', 'campaign name')
    .requiredOption('--objective <obj>', `Meta objective: ${ALLOWED_OBJECTIVES.join('|')}`)
    .option('--daily-budget <amount>', 'CBO daily budget (major-currency units, e.g. 30 for ₺30 / $30)')
    .option('--currency <code>', 'currency for budget formatting', 'TRY')
    .option('--special-ad-categories <csv>', 'comma-separated ad categories (default empty)')
    .option('--no-dry-run', 'Actually create on Meta (default dry-run)')
    .action(async (opts: {
      cohort: string; name: string; objective: string;
      dailyBudget?: string; currency?: string;
      specialAdCategories?: string; dryRun?: boolean;
    }) => {
      console.log(header(`Campaign create — ${opts.name}`));

      // 1. Cohort exists
      const cohort = loadCohort(opts.cohort);
      if (!cohort) {
        error(`Cohort "${opts.cohort}" not found. Run \`dreamcontext marketing cohort list\`.`);
        process.exit(1);
      }

      // 2. Objective allowed (hard block on revenue + traffic)
      if (!ALLOWED_OBJECTIVES.includes(opts.objective)) {
        error(`--objective "${opts.objective}" not allowed. Use one of: ${ALLOWED_OBJECTIVES.join(', ')}`);
        process.exit(1);
      }
      if (opts.objective === 'OUTCOME_TRAFFIC' || opts.objective === 'OUTCOME_ENGAGEMENT') {
        warn(`${opts.objective} is the #1 reported failure mode in mistakes.md (#1: Traffic objective for revenue campaigns). Confirm this is non-revenue intent before continuing live.`);
      }

      // 3. Budget — CBO is optional; if specified, validate
      let dailyBudgetMinor: number | null = null;
      if (opts.dailyBudget) {
        try {
          dailyBudgetMinor = parseDailyBudget(opts.dailyBudget, opts.currency ?? 'TRY');
        } catch (e) {
          if (e instanceof BudgetMissingError || e instanceof BudgetInvalidError) {
            error(e.message);
            process.exit(1);
          }
          throw e;
        }
      } else {
        info(chalk.dim('No --daily-budget — adsets will need their own --daily-budget when created.'));
      }

      const ctx = buildCtx({ noDryRun: opts.dryRun === false });
      if (ctx.dryRun) info(chalk.yellow('[DRY-RUN] no live changes — pass --no-dry-run to create on Meta'));

      const localId = newEntityId('campaign');
      const now = new Date().toISOString();

      try {
        await withLock(async () => {
          const run = beginRun('campaign-create', {
            local_id: localId, cohort: opts.cohort, name: opts.name,
            objective: opts.objective, daily_budget: dailyBudgetMinor,
            dry_run: ctx.dryRun,
          });
          try {
            const result = await createCampaign(ctx, {
              name: opts.name,
              objective: opts.objective as 'OUTCOME_LEADS',
              status: 'PAUSED',
              special_ad_categories: opts.specialAdCategories
                ? opts.specialAdCategories.split(',').map((s) => s.trim()).filter(Boolean)
                : [],
              ...(dailyBudgetMinor != null ? { daily_budget: dailyBudgetMinor } : {}),
            });

            const entity: CampaignEntity = {
              id: localId,
              kind: 'campaign',
              fb_id: ctx.dryRun ? '' : String(result.id),
              status: 'PAUSED',
              cohort_id: opts.cohort,
              name: opts.name,
              objective: opts.objective,
              daily_budget: dailyBudgetMinor,
              special_ad_categories: opts.specialAdCategories
                ? opts.specialAdCategories.split(',').map((s) => s.trim()).filter(Boolean)
                : [],
              created_at: now,
              updated_at: now,
            };
            saveEntity(entity);

            // Update cohort.campaign_ids (de-duped)
            if (!cohort.campaign_ids.includes(localId)) {
              cohort.campaign_ids.push(localId);
              cohort.updated_at = now;
              saveCohort(cohort);
            }

            run.succeed({ local_id: localId, fb_id: entity.fb_id });
            success(`campaign ${chalk.cyan(localId)}${entity.fb_id ? ` → ${chalk.dim(entity.fb_id)}` : ''}${ctx.dryRun ? ' (dry-run)' : ''}`);
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
        error(`campaign create failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command('list')
    .description('List campaigns (optionally filtered by cohort).')
    .option('--cohort <id>', 'filter by cohort')
    .action((opts: { cohort?: string }) => {
      const all = listEntities<CampaignEntity>('campaign');
      const filtered = opts.cohort ? all.filter((c) => c.cohort_id === opts.cohort) : all;
      console.log(header('Campaigns'));
      if (filtered.length === 0) {
        info('No campaigns yet.');
        return;
      }
      for (const c of filtered) {
        const fb = c.fb_id ? chalk.dim(`fb:${c.fb_id}`) : chalk.yellow('dry-run');
        const budget = c.daily_budget != null ? `budget=${(c.daily_budget / 100).toFixed(2)}` : 'budget=(adset)';
        console.log(`  ${chalk.cyan(c.id)}  ${c.status.padEnd(8)}  ${chalk.dim(c.objective.padEnd(20))}  ${budget.padEnd(18)}  ${fb}  ${c.name}`);
      }
    });
}
