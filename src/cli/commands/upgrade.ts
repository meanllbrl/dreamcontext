import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import chalk from 'chalk';
import { dreamcontextVersion } from '../../lib/manifest.js';
import { readVersionCache, writeVersionCache } from '../../lib/version-check.js';
import { resolveContextRoot } from '../../lib/context-path.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Injectable installer for testing — receives the same args as execFileSync npm. */
export type Installer = (args: string[]) => void;

export interface UpgradeOpts {
  /** Injected installer; defaults to execFileSync('npm', ['install', '-g', 'dreamcontext@latest']) */
  installer?: Installer;
  /** Injected latest-version source for --check; defaults to a live `npm view` */
  latestVersion?: () => string | null;
  /** Injected live latest-version source for --check; takes precedence over latestVersion */
  liveLatest?: () => string | null;
}

// ─── Default implementations ─────────────────────────────────────────────────

function defaultInstaller(args: string[]): void {
  execFileSync('npm', args, { stdio: 'inherit' });
}

function projectRootForCache(): string {
  // resolveContextRoot() returns _dream_context/ path; the version cache lives
  // under the project root (parent of _dream_context/).
  const contextDir = resolveContextRoot();
  return contextDir ? dirname(contextDir) : process.cwd();
}

/**
 * Fetch the latest dreamcontext version live from npm for `--check`.
 * Runs `npm view dreamcontext version` (5s timeout), validates the output looks
 * like a semver, and returns null on ANY failure (offline, npm missing, timeout,
 * malformed output). Never throws.
 *
 * On success, best-effort writes the version cache so the in-session update
 * nudge benefits from the fresh value. A cache-write failure never breaks
 * `--check` (writeVersionCache already swallows its own errors).
 */
function defaultLiveLatest(): string | null {
  let latest: string | null = null;
  try {
    const raw = execFileSync('npm', ['view', 'dreamcontext', 'version'], {
      timeout: 5_000,
      encoding: 'utf-8',
    });
    const trimmed = (typeof raw === 'string' ? raw : '').trim();
    if (/^\d+\.\d+/.test(trimmed)) latest = trimmed;
  } catch {
    return null;
  }

  if (latest !== null) {
    // Best-effort cache warm — must never break --check.
    try {
      const root = projectRootForCache();
      const existing = readVersionCache(root);
      writeVersionCache(root, {
        checkedAt: Date.now(),
        latestCli: latest,
        availablePacks: existing?.availablePacks ?? [],
        ttlHours: existing?.ttlHours ?? 24,
      });
    } catch {
      // cache warm is best-effort; ignore
    }
  }

  return latest;
}

// ─── Core logic (exported for testing) ───────────────────────────────────────

export function runUpgrade(
  check: boolean,
  opts?: UpgradeOpts,
): void {
  const installer = opts?.installer ?? defaultInstaller;

  if (check) {
    const current = dreamcontextVersion();
    // Pick the first DEFINED source FUNCTION, then call it ONCE. Do NOT chain
    // source VALUES with `??` — an injected `latestVersion: () => null` must be
    // used as-is (its null result → "unknown"), not fall through to a live npm
    // call. This preserves the existing offline-injection --check tests.
    const source = opts?.liveLatest ?? opts?.latestVersion ?? defaultLiveLatest;
    const latest = source();
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
