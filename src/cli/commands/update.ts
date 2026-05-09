import { Command } from 'commander';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { error, info, miniBox } from '../../lib/format.js';
import { SUPPORTED_PLATFORMS, type PlatformId } from '../../lib/platforms.js';
import {
  installCoreForPlatform,
  directPackInstall,
  loadCatalog,
  platformSkillRoot,
} from './install-skill.js';

function detectInstalledPlatforms(projectRoot: string): PlatformId[] {
  return SUPPORTED_PLATFORMS.filter((p) =>
    existsSync(join(platformSkillRoot(projectRoot, p), 'dreamcontext', 'SKILL.md')),
  );
}

function detectInstalledPacks(projectRoot: string, platforms: PlatformId[]): string[] {
  const loaded = loadCatalog();
  if (!loaded) return [];
  const knownNames = new Set<string>([
    ...loaded.catalog.packs.map((p) => p.name),
    ...loaded.catalog.standalone.map((s) => s.name),
  ]);

  const found = new Set<string>();
  for (const platform of platforms) {
    const root = platformSkillRoot(projectRoot, platform);
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      if (name === 'dreamcontext') continue;
      if (!knownNames.has(name)) continue;
      if (existsSync(join(root, name, 'SKILL.md'))) found.add(name);
    }
  }
  return [...found].sort();
}

export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .description('Refresh installed dreamcontext files (core skill, agents, hooks, packs, root instructions) to the latest shipped version')
    .option('--packs-only', 'Only refresh installed packs, skip core skill/agents/hooks')
    .option('--core-only', 'Only refresh core skill/agents/hooks, skip packs')
    .action(async (opts: { packsOnly?: boolean; coreOnly?: boolean }) => {
      try {
        const projectRoot = process.cwd();
        const platforms = detectInstalledPlatforms(projectRoot);

        if (platforms.length === 0) {
          error('No installed platforms found. Run `dreamcontext install-skill` first.');
          return;
        }

        info(`Detected platforms: ${chalk.dim(platforms.join(', '))}`);

        const installed: string[] = [];
        const notes: string[] = [];

        if (!opts.packsOnly) {
          for (const platform of platforms) {
            const result = await installCoreForPlatform(platform, projectRoot);
            installed.push(...result.installed);
            notes.push(...result.notes);
          }

          console.log();
          console.log(miniBox([
            chalk.green.bold(`✓ Core refreshed for ${platforms.join(', ')}`),
            '',
            ...installed.map((f) => `  ${chalk.green('✓')} ${chalk.magentaBright(f)}`),
            ...(notes.length > 0 ? ['', ...notes.map((n) => `  ${n}`)] : []),
          ], { color: 'green' }));
          console.log();
        }

        const packs = opts.coreOnly ? [] : detectInstalledPacks(projectRoot, platforms);
        if (packs.length > 0) {
          info(`Refreshing ${packs.length} installed pack(s): ${chalk.dim(packs.join(', '))}`);
          directPackInstall(packs, projectRoot, platforms);
        } else if (!opts.coreOnly) {
          info(chalk.dim('No installed packs detected.'));
        }
      } catch (err: any) {
        if (err.name === 'ExitPromptError') {
          console.log();
          info('Cancelled.');
          return;
        }
        error(err.message);
      }
    });
}
