import { Command } from 'commander';
import { existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import chalk from 'chalk';
import { error, success, header, info } from '../../../lib/format.js';
import { uploadVideo, uploadImage } from '../../../lib/marketing/meta-client.js';
import { TokenExpiredError, MetaApiError } from '../../../lib/marketing/meta-fetch.js';
import { withLock, beginRun } from '../../../lib/marketing/store.js';
import { buildCtx } from './_ctx.js';

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export function registerMarketingAsset(parent: Command): void {
  const cmd = parent
    .command('asset')
    .description('Upload creative assets to Meta.');

  cmd
    .command('upload <path>')
    .description('Upload a video (>50MB → chunked) or image to Meta. Returns id/hash.')
    .option('--type <type>', 'override auto-detection (video|image)')
    .option('--name <name>', 'asset name (videos)')
    .option('--no-dry-run', 'Actually upload to Meta')
    .action(async (path: string, opts: { type?: string; name?: string; dryRun?: boolean }) => {
      if (!existsSync(path)) {
        error(`File not found: ${path}`);
        process.exit(1);
      }
      const ext = extname(path).toLowerCase();
      let kind: 'video' | 'image';
      if (opts.type === 'video' || opts.type === 'image') {
        kind = opts.type;
      } else if (VIDEO_EXTS.has(ext)) {
        kind = 'video';
      } else if (IMAGE_EXTS.has(ext)) {
        kind = 'image';
      } else {
        error(`Could not auto-detect asset type for "${ext}". Pass --type video|image.`);
        process.exit(1);
      }
      const sizeMb = (statSync(path).size / (1024 * 1024)).toFixed(1);
      console.log(header(`Asset upload — ${kind} (${sizeMb} MB)`));

      const ctx = buildCtx({ noDryRun: opts.dryRun === false });
      if (ctx.dryRun) info(chalk.yellow('[DRY-RUN] no live changes'));

      try {
        await withLock(async () => {
          const run = beginRun('asset-upload', { path, type: kind, size_mb: sizeMb, dry_run: ctx.dryRun });
          try {
            if (kind === 'video') {
              const result = await uploadVideo(ctx, path, opts.name ? { name: opts.name } : {});
              run.succeed({ video_id: result.video_id });
              success(`video_id: ${chalk.cyan(result.video_id)}${ctx.dryRun ? ' (dry-run)' : ''}`);
              if (result.upload_session_id) {
                info(`session: ${chalk.dim(result.upload_session_id)} (chunked upload)`);
              }
            } else {
              const result = await uploadImage(ctx, path);
              run.succeed({ image_hash: result.hash });
              success(`image_hash: ${chalk.cyan(result.hash)}${ctx.dryRun ? ' (dry-run)' : ''}`);
            }
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
        error(`asset upload failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });
}
