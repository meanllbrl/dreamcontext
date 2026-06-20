import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import { dreamcontextVersion } from '../../lib/manifest.js';
import { readVersionCache, writeVersionCache } from '../../lib/version-check.js';
import { resolveContextRoot } from '../../lib/context-path.js';
import { listVaults, type Vault } from '../../lib/vaults.js';
import { readAppManifest } from './app.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Injectable installer for testing — receives the same args as execFileSync npm. */
export type Installer = (args: string[]) => void;

/** Result of refreshing one project. */
export interface ProjectUpdateResult {
  vault: Vault;
  ok: boolean;
  error?: string;
}

export interface UpgradeOpts {
  /** Injected installer; defaults to execFileSync('npm', ['install', '-g', 'dreamcontext@latest']) */
  installer?: Installer;
  /** Injected latest-version source for --check; defaults to a live `npm view` */
  latestVersion?: () => string | null;
  /** Injected live latest-version source for --check; takes precedence over latestVersion */
  liveLatest?: () => string | null;
  /** Non-interactive: refresh every registered project without prompting. */
  yes?: boolean;
  /** Injected vault lister (testing); defaults to listVaults(). */
  vaultLister?: () => Vault[];
  /** Injected per-project updater (testing); defaults to spawning the upgraded CLI's `update --yes`. */
  projectUpdater?: (vault: Vault) => ProjectUpdateResult;
  /** Injected confirm prompt (testing); defaults to an interactive y/N. */
  confirmAll?: (count: number) => Promise<boolean>;
  /** Injected desktop-app install check (testing); defaults to readAppManifest() !== null. */
  appInstalledCheck?: () => boolean;
  /** Injected desktop-app updater (testing); defaults to spawning the upgraded CLI's `app update`. */
  appUpdater?: () => { ok: boolean; error?: string };
}

// ─── Default implementations ─────────────────────────────────────────────────

function defaultInstaller(args: string[]): void {
  execFileSync('npm', args, { stdio: 'inherit' });
}

/**
 * Refresh one project's installed files using the NEWLY upgraded global CLI.
 *
 * We cannot call the update logic in-process — this process is still the OLD
 * version. Spawning `npx dreamcontext update --yes` in the vault directory runs
 * the freshly-installed binary's update flow (skill + agents + hooks + packs +
 * references). `--yes` skips the stale-file delete prompts so it is unattended.
 * Never throws — failures are captured per-vault so one bad project does not
 * abort the rest.
 */
function defaultProjectUpdater(vault: Vault): ProjectUpdateResult {
  if (!existsSync(vault.path)) {
    return { vault, ok: false, error: 'project folder no longer exists' };
  }
  try {
    execFileSync('npx', ['dreamcontext', 'update', '--yes'], {
      cwd: vault.path,
      stdio: 'inherit',
    });
    return { vault, ok: true };
  } catch (e) {
    return { vault, ok: false, error: (e as Error).message };
  }
}

async function defaultConfirmAll(count: number): Promise<boolean> {
  return confirm({
    message: `Also refresh ${count} registered dreamcontext project(s) to the new version?`,
    default: true,
  });
}

/**
 * Update the installed desktop app using the NEWLY upgraded global CLI (spawns
 * `npx dreamcontext app update`). Never throws — a failed app update never
 * aborts the rest of the upgrade.
 */
function defaultAppUpdater(): { ok: boolean; error?: string } {
  try {
    execFileSync('npx', ['dreamcontext', 'app', 'update'], { stdio: 'inherit' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
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

// ─── Desktop app refresh ──────────────────────────────────────────────────────

/**
 * If the macOS desktop app is installed, bring it to the latest release too — so
 * `dreamcontext upgrade` is the single command that updates the CLI, the app,
 * and every project. Gated like the project refresh: silent skip when the app
 * isn't installed; auto with `--yes`; do-it in an interactive TTY; hint-only in
 * a non-interactive run without `--yes` (never download unattended in CI/tests).
 */
async function maybeUpdateApp(opts?: UpgradeOpts): Promise<void> {
  const installed = (opts?.appInstalledCheck ?? (() => readAppManifest() !== null))();
  if (!installed) return;

  const auto = opts?.yes === true;
  const interactive = process.stdin.isTTY === true;
  if (!auto && !interactive) {
    console.log(
      chalk.dim(
        'Tip: the desktop app is installed — run `dreamcontext upgrade --yes` (or `dreamcontext app update`) to update it too.',
      ),
    );
    return;
  }

  console.log(chalk.cyan('\n↻ Updating the desktop app…'));
  const result = (opts?.appUpdater ?? defaultAppUpdater)();
  if (result.ok) console.log(chalk.green('✓ Desktop app updated.'));
  else console.log(chalk.yellow(`  ⚠ Desktop app update skipped: ${result.error ?? 'failed'}`));
}

// ─── Cross-project refresh ────────────────────────────────────────────────────

/**
 * After the CLI itself is upgraded, offer to refresh EVERY registered project so
 * the whole machine moves to the new version in one step — the CLI does the
 * fan-out, not the agent. Gated so it is safe and unattended:
 *  - no registered vaults → nothing to do.
 *  - `--yes` → refresh all without asking.
 *  - interactive TTY → ask once ("refresh all N projects?").
 *  - non-interactive without `--yes` → print a hint and refresh nothing
 *    (never spawn updates unattended in a script/CI/test run).
 */
async function maybeUpdateAllProjects(opts?: UpgradeOpts): Promise<void> {
  const vaults = (opts?.vaultLister ?? (() => listVaults()))();
  if (vaults.length === 0) return;

  const auto = opts?.yes === true;
  // An injected confirm makes the prompt path reachable in tests; otherwise a
  // real prompt only makes sense at an interactive TTY.
  const canPrompt = process.stdin.isTTY === true || opts?.confirmAll !== undefined;

  if (!auto && !canPrompt) {
    console.log(
      chalk.dim(
        `Tip: ${vaults.length} registered project(s) were not refreshed. ` +
          'Run `dreamcontext upgrade --yes` to refresh them all, or `dreamcontext update` in each.',
      ),
    );
    return;
  }

  let proceed = auto;
  if (!proceed) {
    const confirmFn = opts?.confirmAll ?? defaultConfirmAll;
    proceed = await confirmFn(vaults.length);
  }
  if (!proceed) {
    console.log(chalk.dim('Skipped refreshing other projects. Run `dreamcontext update` in any project later.'));
    return;
  }

  const updater = opts?.projectUpdater ?? defaultProjectUpdater;
  const results: ProjectUpdateResult[] = [];
  for (const vault of vaults) {
    console.log(chalk.cyan(`\n↻ Refreshing ${chalk.bold(vault.name)} (${vault.path})...`));
    results.push(updater(vault));
  }

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(chalk.green(`✓ Refreshed ${ok.length}/${results.length} project(s).`));
  for (const f of failed) {
    console.log(chalk.yellow(`  ⚠ ${f.vault.name}: ${f.error ?? 'update failed'}`));
  }
}

// ─── Core logic (exported for testing) ───────────────────────────────────────

export async function runUpgrade(
  check: boolean,
  opts?: UpgradeOpts,
): Promise<void> {
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

  // Default: install latest. (Synchronous, before any await — existing
  // un-awaited tests assert the installer fired by this point.)
  console.log(chalk.cyan('Installing dreamcontext@latest via npm...'));
  // npm install -g dreamcontext@latest — trusted package published by the project owner
  installer(['install', '-g', 'dreamcontext@latest']);
  console.log('');
  console.log(chalk.green('CLI upgraded.'));

  // One command brings the whole machine current: the CLI (above), the desktop
  // app (if installed), then every registered project — so the user never has to
  // run `app update` / `update` by hand (or ask the agent to).
  await maybeUpdateApp(opts);
  await maybeUpdateAllProjects(opts);

  console.log(chalk.dim('\nIn each project, the new files take effect next session (hooks re-read them).'));
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerUpgradeCommand(program: Command): void {
  program
    .command('upgrade')
    .description('Upgrade the dreamcontext CLI, then offer to refresh every registered project to match')
    .option('--check', 'Print current vs latest version and exit without installing')
    .option('-y, --yes', 'Refresh every registered project without prompting (non-interactive)')
    .action(async (options: { check?: boolean; yes?: boolean }, _cmd?: Command, opts?: UpgradeOpts) => {
      await runUpgrade(Boolean(options.check), { ...opts, yes: options.yes });
    });
}
