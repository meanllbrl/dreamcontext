import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import chalk from 'chalk';
import { dreamcontextVersion } from '../../lib/manifest.js';
import { readVersionCache } from '../../lib/version-check.js';
import { resolveContextRoot } from '../../lib/context-path.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Injectable installer for testing — receives the same args as execFileSync npm. */
export type Installer = (args: string[]) => void;

export interface UpgradeOpts {
  /** Injected installer; defaults to execFileSync('npm', ['install', '-g', 'dreamcontext@latest']) */
  installer?: Installer;
  /** Injected latest-version source for --check; defaults to reading the version cache */
  latestVersion?: () => string | null;
}

// ─── Default implementations ─────────────────────────────────────────────────

function defaultInstaller(args: string[]): void {
  execFileSync('npm', args, { stdio: 'inherit' });
}

function defaultLatestVersion(): string | null {
  // resolveContextRoot() returns _dream_context/ path; readVersionCache
  // expects project root (parent of _dream_context/).
  const contextDir = resolveContextRoot();
  const projectRoot = contextDir ? dirname(contextDir) : process.cwd();
  const cache = readVersionCache(projectRoot);
  return cache?.latestCli ?? null;
}

// ─── Core logic (exported for testing) ───────────────────────────────────────

export function runUpgrade(
  check: boolean,
  opts?: UpgradeOpts,
): void {
  const installer = opts?.installer ?? defaultInstaller;
  const getLatest = opts?.latestVersion ?? defaultLatestVersion;

  if (check) {
    const current = dreamcontextVersion();
    const latest = getLatest();
    if (latest === null) {
      console.log(`dreamcontext ${current} (latest unknown — run without --check to refresh)`);
    } else {
      console.log(`dreamcontext current: ${current}  latest: ${latest}`);
    }
    return;
  }

  // Default: install latest
  console.log(chalk.cyan('Installing dreamcontext@latest via npm...'));
  // npm install -g dreamcontext@latest — trusted package published by the project owner
  installer(['install', '-g', 'dreamcontext@latest']);
  console.log('');
  console.log(chalk.green('CLI upgraded. Run') + ' dreamcontext update ' + chalk.green('to refresh your project files.'));
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerUpgradeCommand(program: Command): void {
  program
    .command('upgrade')
    .description('Upgrade the dreamcontext CLI itself to the latest published version')
    .option('--check', 'Print current vs latest version and exit without installing')
    .option('-y, --yes', 'Non-interactive (no prompts; reserved for future use)')
    .action((options: { check?: boolean; yes?: boolean }, _cmd?: Command, opts?: UpgradeOpts) => {
      runUpgrade(Boolean(options.check), opts);
    });
}
