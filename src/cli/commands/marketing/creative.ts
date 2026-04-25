import { Command } from 'commander';
import chalk from 'chalk';
import { error, success, header, info } from '../../../lib/format.js';
import { createImageCreative, createVideoCreative, type CTAType } from '../../../lib/marketing/meta-client.js';
import { TokenExpiredError, MetaApiError } from '../../../lib/marketing/meta-fetch.js';
import { withLock, beginRun } from '../../../lib/marketing/store.js';
import { newEntityId, saveEntity, listEntities, type CreativeEntity } from '../../../lib/marketing/entity-store.js';
import { buildCtx } from './_ctx.js';

const ALLOWED_CTAS: CTAType[] = [
  'SIGN_UP', 'LEARN_MORE', 'GET_OFFER', 'SUBSCRIBE',
  'INSTALL_APP', 'DOWNLOAD', 'BOOK_TRAVEL', 'SHOP_NOW', 'SEND_MESSAGE',
];

export function registerMarketingCreative(parent: Command): void {
  const cmd = parent
    .command('creative')
    .description('Manage ad creatives.');

  cmd
    .command('create-image')
    .description('Create an image creative (one or more image hashes).')
    .requiredOption('--name <name>', 'creative name (internal label)')
    .requiredOption('--image-hash <hash...>', 'one or more image hashes from `mk asset upload`')
    .requiredOption('--message <text>', 'ad copy body')
    .requiredOption('--link <url>', 'landing page URL')
    .requiredOption('--cta <type>', `CTA: ${ALLOWED_CTAS.join('|')}`)
    .requiredOption('--cohort <id>', 'parent cohort id (for FK)')
    .option('--no-dry-run', 'Actually create on Meta')
    .action(async (opts: {
      name: string; imageHash: string[]; message: string;
      link: string; cta: string; cohort: string; dryRun?: boolean;
    }) => {
      if (!ALLOWED_CTAS.includes(opts.cta as CTAType)) {
        error(`--cta "${opts.cta}" not allowed. Use one of: ${ALLOWED_CTAS.join(', ')}`);
        process.exit(1);
      }
      console.log(header(`Creative create-image — ${opts.name}`));
      const ctx = buildCtx({ noDryRun: opts.dryRun === false });
      if (ctx.dryRun) info(chalk.yellow('[DRY-RUN] no live changes'));

      const localId = newEntityId('creative');
      const now = new Date().toISOString();

      try {
        await withLock(async () => {
          const run = beginRun('creative-create-image', {
            local_id: localId, name: opts.name, image_hashes: opts.imageHash, dry_run: ctx.dryRun,
          });
          try {
            const result = await createImageCreative(ctx, {
              name: opts.name,
              image_hashes: opts.imageHash,
              message: opts.message,
              link: opts.link,
              cta: opts.cta as CTAType,
            });
            const entity: CreativeEntity = {
              id: localId,
              kind: 'creative',
              fb_id: ctx.dryRun ? '' : String(result.id),
              status: 'PAUSED',
              cohort_id: opts.cohort,
              name: opts.name,
              type: 'image',
              message: opts.message,
              link: opts.link,
              cta: opts.cta,
              asset_refs: opts.imageHash,
              created_at: now,
              updated_at: now,
            };
            saveEntity(entity);
            run.succeed({ local_id: localId, fb_id: entity.fb_id });
            success(`creative ${chalk.cyan(localId)}${entity.fb_id ? ` → ${chalk.dim(entity.fb_id)}` : ''}${ctx.dryRun ? ' (dry-run)' : ''}`);
          } catch (e) {
            run.fail((e as Error).message);
            throw e;
          }
        });
      } catch (e) {
        handleApiError(e as Error);
      }
    });

  cmd
    .command('create-video')
    .description('Create a video creative (one or more video_ids).')
    .requiredOption('--name <name>', 'creative name')
    .requiredOption('--video-id <id...>', 'one or more video_ids from `mk asset upload`')
    .requiredOption('--message <text>', 'ad copy body')
    .requiredOption('--link <url>', 'landing page URL')
    .requiredOption('--cta <type>', `CTA: ${ALLOWED_CTAS.join('|')}`)
    .requiredOption('--cohort <id>', 'parent cohort id (for FK)')
    .option('--no-dry-run', 'Actually create on Meta')
    .action(async (opts: {
      name: string; videoId: string[]; message: string;
      link: string; cta: string; cohort: string; dryRun?: boolean;
    }) => {
      if (!ALLOWED_CTAS.includes(opts.cta as CTAType)) {
        error(`--cta "${opts.cta}" not allowed. Use one of: ${ALLOWED_CTAS.join(', ')}`);
        process.exit(1);
      }
      console.log(header(`Creative create-video — ${opts.name}`));
      const ctx = buildCtx({ noDryRun: opts.dryRun === false });
      if (ctx.dryRun) info(chalk.yellow('[DRY-RUN] no live changes'));

      const localId = newEntityId('creative');
      const now = new Date().toISOString();

      try {
        await withLock(async () => {
          const run = beginRun('creative-create-video', {
            local_id: localId, name: opts.name, video_ids: opts.videoId, dry_run: ctx.dryRun,
          });
          try {
            const result = await createVideoCreative(ctx, {
              name: opts.name,
              video_ids: opts.videoId,
              message: opts.message,
              link: opts.link,
              cta: opts.cta as CTAType,
            });
            const entity: CreativeEntity = {
              id: localId,
              kind: 'creative',
              fb_id: ctx.dryRun ? '' : String(result.id),
              status: 'PAUSED',
              cohort_id: opts.cohort,
              name: opts.name,
              type: 'video',
              message: opts.message,
              link: opts.link,
              cta: opts.cta,
              asset_refs: opts.videoId,
              created_at: now,
              updated_at: now,
            };
            saveEntity(entity);
            run.succeed({ local_id: localId, fb_id: entity.fb_id });
            success(`creative ${chalk.cyan(localId)}${entity.fb_id ? ` → ${chalk.dim(entity.fb_id)}` : ''}${ctx.dryRun ? ' (dry-run)' : ''}`);
          } catch (e) {
            run.fail((e as Error).message);
            throw e;
          }
        });
      } catch (e) {
        handleApiError(e as Error);
      }
    });

  cmd
    .command('list')
    .description('List creatives.')
    .action(() => {
      const all = listEntities<CreativeEntity>('creative');
      console.log(header('Creatives'));
      if (all.length === 0) {
        info('No creatives yet.');
        return;
      }
      for (const c of all) {
        const fb = c.fb_id ? chalk.dim(`fb:${c.fb_id}`) : chalk.yellow('dry-run');
        console.log(`  ${chalk.cyan(c.id)}  ${c.type.padEnd(5)}  ${c.cta.padEnd(12)}  ${fb}  ${c.name}`);
      }
    });
}

function handleApiError(e: Error): never {
  if (e instanceof TokenExpiredError) {
    error('Token expired. Regenerate and retry.');
    process.exit(1);
  }
  if (e instanceof MetaApiError) {
    error(`Graph API error: status=${e.status} code=${e.metaErrorCode ?? '-'}`);
    console.log(chalk.dim(e.message));
    process.exit(1);
  }
  error(`failed: ${e.message}`);
  process.exit(1);
}
