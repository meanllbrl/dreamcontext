import { Command } from 'commander';
import chalk from 'chalk';
import { error, success, header, info } from '../../../lib/format.js';
import { loadConfig, writeConfig } from '../../../lib/marketing/config.js';

export function registerMarketingAccount(parent: Command): void {
  const cmd = parent
    .command('account')
    .description('Manage marketing profiles (single-profile UX, multi-account plumbing for v1).');

  cmd
    .command('list')
    .description('List configured profiles.')
    .action(() => {
      const cfg = loadConfig();
      const slugs = Object.keys(cfg.profiles);
      console.log(header('Profiles'));
      if (slugs.length === 0) {
        info('No profiles configured. Default profile is implicit (single-profile UX).');
        info(`Edit _dream_context/marketing/config.json to add named profiles.`);
        return;
      }
      for (const slug of slugs) {
        const p = cfg.profiles[slug];
        const marker = slug === cfg.default_profile ? chalk.green(' ← default') : '';
        console.log(`  ${chalk.cyan(slug)}${marker}`);
        console.log(`    ad_account: ${chalk.dim(p.ad_account_id)} · page: ${chalk.dim(p.page_id)} · api: ${chalk.dim(p.api_version)}`);
      }
    });

  cmd
    .command('use <slug>')
    .description('Set the default profile.')
    .action((slug: string) => {
      const cfg = loadConfig();
      if (!cfg.profiles[slug]) {
        error(`Profile "${slug}" not found. Run \`dreamcontext marketing account list\` to see configured profiles.`);
        process.exit(1);
      }
      cfg.default_profile = slug;
      writeConfig(cfg);
      success(`Default profile set to ${chalk.cyan(slug)}`);
    });
}
