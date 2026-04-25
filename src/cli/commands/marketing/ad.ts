import { Command } from 'commander';
import chalk from 'chalk';
import { error, success, header, info } from '../../../lib/format.js';
import { createAd } from '../../../lib/marketing/meta-client.js';
import { TokenExpiredError, MetaApiError } from '../../../lib/marketing/meta-fetch.js';
import { withLock, beginRun } from '../../../lib/marketing/store.js';
import {
  loadEntity, saveEntity, listEntities, newEntityId,
  type AdSetEntity, type CreativeEntity, type AdEntity,
} from '../../../lib/marketing/entity-store.js';
import { buildCtx } from './_ctx.js';

export function registerMarketingAd(parent: Command): void {
  const cmd = parent
    .command('ad')
    .description('Manage individual ads (the leaf entity).');

  cmd
    .command('create')
    .description('Create an ad (PAUSED) by linking an adset + creative.')
    .requiredOption('--name <name>', 'ad name')
    .requiredOption('--adset <id>', 'parent adset local id')
    .requiredOption('--creative <id>', 'creative local id')
    .option('--no-dry-run', 'Actually create on Meta')
    .action(async (opts: { name: string; adset: string; creative: string; dryRun?: boolean }) => {
      console.log(header(`Ad create — ${opts.name}`));

      const adset = loadEntity<AdSetEntity>('adset', opts.adset);
      if (!adset) {
        error(`Adset "${opts.adset}" not found.`);
        process.exit(1);
      }
      const creative = loadEntity<CreativeEntity>('creative', opts.creative);
      if (!creative) {
        error(`Creative "${opts.creative}" not found.`);
        process.exit(1);
      }

      const ctx = buildCtx({ noDryRun: opts.dryRun === false });
      if (ctx.dryRun) info(chalk.yellow('[DRY-RUN] no live changes'));

      const localId = newEntityId('ad');
      const now = new Date().toISOString();

      try {
        await withLock(async () => {
          const run = beginRun('ad-create', {
            local_id: localId, name: opts.name, adset: opts.adset, creative: opts.creative, dry_run: ctx.dryRun,
          });
          try {
            const result = await createAd(ctx, {
              name: opts.name,
              adset_id: ctx.dryRun ? adset.fb_id || adset.id : adset.fb_id,
              creative_id: ctx.dryRun ? creative.fb_id || creative.id : creative.fb_id,
              status: 'PAUSED',
            });
            const entity: AdEntity = {
              id: localId,
              kind: 'ad',
              fb_id: ctx.dryRun ? '' : String(result.id),
              status: 'PAUSED',
              cohort_id: adset.cohort_id,
              name: opts.name,
              adset_id: opts.adset,
              creative_id: opts.creative,
              created_at: now,
              updated_at: now,
            };
            saveEntity(entity);
            run.succeed({ local_id: localId, fb_id: entity.fb_id });
            success(`ad ${chalk.cyan(localId)}${entity.fb_id ? ` → ${chalk.dim(entity.fb_id)}` : ''}${ctx.dryRun ? ' (dry-run)' : ''}`);
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
        error(`ad create failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command('list')
    .description('List ads (optionally filtered by adset).')
    .option('--adset <id>', 'filter by adset local id')
    .action((opts: { adset?: string }) => {
      const all = listEntities<AdEntity>('ad');
      const filtered = opts.adset ? all.filter((a) => a.adset_id === opts.adset) : all;
      console.log(header('Ads'));
      if (filtered.length === 0) {
        info('No ads yet.');
        return;
      }
      for (const a of filtered) {
        const fb = a.fb_id ? chalk.dim(`fb:${a.fb_id}`) : chalk.yellow('dry-run');
        console.log(`  ${chalk.cyan(a.id)}  ${a.status.padEnd(8)}  adset=${chalk.dim(a.adset_id.padEnd(15))}  ${fb}  ${a.name}`);
      }
    });
}
