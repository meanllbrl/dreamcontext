import { Command } from 'commander';
import { mkdirSync } from 'node:fs';
import chalk from 'chalk';
import { ensureContextRoot } from '../../../lib/context-path.js';
import { success, error, info, header } from '../../../lib/format.js';
import { MARKETING_PATHS, marketingRoot } from '../../../lib/marketing/paths.js';
import { ensureEnvFile, ensureConfigFile } from '../../../lib/marketing/config.js';
import { bootstrapMarketing } from '../../../lib/marketing/bootstrap.js';

export function registerMarketingInit(parent: Command): void {
  parent
    .command('init')
    .description('Bootstrap _dream_context/marketing/ (folders, .env, venv, reinfluence tools, whisper cache)')
    .option('--skip-bootstrap', 'Only create folders + .env template; skip venv + pip install', false)
    .option('--whisper-model <model>', 'Whisper model to pre-pull (default: medium)', 'medium')
    .option('--no-whisper', 'Skip Whisper model pre-pull')
    .action(async (opts: { skipBootstrap?: boolean; whisperModel?: string; whisper?: boolean }) => {
      try {
        ensureContextRoot();
      } catch {
        error('_dream_context/ not found in this project. Run `dreamcontext init` first.');
        process.exit(1);
      }

      console.log(header('Marketing init'));

      // 1. Folder layout
      const root = marketingRoot();
      mkdirSync(root, { recursive: true });
      for (const dir of [
        MARKETING_PATHS.cohortsDir(),
        MARKETING_PATHS.campaignsDir(),
        MARKETING_PATHS.adsetsDir(),
        MARKETING_PATHS.creativesDir(),
        MARKETING_PATHS.briefsDir(),
        MARKETING_PATHS.insightsDir(),
        MARKETING_PATHS.competitorsDir(),
        MARKETING_PATHS.runsDir(),
        MARKETING_PATHS.byIdemDir(),
        MARKETING_PATHS.cacheDir(),
      ]) {
        mkdirSync(dir, { recursive: true });
      }
      info(`folders ready under ${chalk.dim(root)}`);

      // 2. .env template + config.json
      ensureEnvFile();
      info(`.env template at ${chalk.dim(MARKETING_PATHS.envFile())}`);
      ensureConfigFile();
      info(`config.json at ${chalk.dim(MARKETING_PATHS.configFile())}`);

      if (opts.skipBootstrap) {
        success('Marketing scaffolded (bootstrap skipped). Run without --skip-bootstrap to install Python deps.');
        return;
      }

      // 3. Python venv + reinfluence tool + whisper prime
      try {
        const result = await bootstrapMarketing({
          whisperModel: opts.whisper === false ? null : (opts.whisperModel ?? 'medium'),
        });
        success(`Bootstrapped. python=${chalk.dim(result.pythonBin)}`);
        if (result.whisperPrimed) info('Whisper model cached.');
      } catch (e) {
        error(`Bootstrap failed: ${(e as Error).message}`);
        process.exit(1);
      }

      console.log();
      console.log(chalk.bold('Next:'));
      console.log(`  1. Edit ${chalk.cyan(MARKETING_PATHS.envFile())} and fill in Meta credentials.`);
      console.log(`  2. Try: ${chalk.cyan('dreamcontext marketing competitor ingest <url-or-handle>')}`);
    });
}
