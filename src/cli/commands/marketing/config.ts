import { Command } from 'commander';
import chalk from 'chalk';
import { error, success, header, info } from '../../../lib/format.js';
import { listAdAccounts } from '../../../lib/marketing/meta-client.js';
import { TokenExpiredError, MetaApiError } from '../../../lib/marketing/meta-fetch.js';
import { buildReadCtx } from './_ctx.js';

export function registerMarketingConfig(parent: Command): void {
  const cmd = parent
    .command('config')
    .description('Manage Meta credentials and verify access.');

  cmd
    .command('check')
    .description('Hit Graph /me/adaccounts to confirm token + ad account access.')
    .action(async () => {
      console.log(header('Config check'));
      const ctx = buildReadCtx();
      info(`api version: ${chalk.dim(ctx.apiVersion)}`);
      info(`ad account: ${chalk.dim(ctx.adAccountId)}`);
      try {
        const resp = await listAdAccounts(ctx);
        const accounts = resp.data ?? [];
        const matched = accounts.find((a) => a.id === ctx.adAccountId);
        if (!matched) {
          error(
            `Token works but ${ctx.adAccountId} is NOT in /me/adaccounts (${accounts.length} accounts visible). ` +
            `Check META_AD_ACCOUNT_ID in _dream_context/marketing/.env.`,
          );
          process.exit(1);
        }
        success(`Token valid · ${matched.name} (status=${matched.account_status})`);
      } catch (e) {
        if (e instanceof TokenExpiredError) {
          error('Token expired or revoked. Regenerate at https://business.facebook.com/settings/system-users');
          process.exit(1);
        }
        if (e instanceof MetaApiError) {
          error(`Graph API error: status=${e.status} code=${e.metaErrorCode ?? '-'}`);
          console.log(chalk.dim(e.message));
          process.exit(1);
        }
        error(`Config check failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });
}
