import { Command } from 'commander';
import { existsSync } from 'node:fs';
import chalk from 'chalk';
import { input, checkbox, confirm } from '@inquirer/prompts';
import { error, info, miniBox } from '../../lib/format.js';
import { getInitPath } from '../../lib/context-path.js';
import {
  DEFAULT_PLATFORMS,
  PLATFORM_CATALOG,
  ensurePlatformSelection,
  formatSupportedPlatforms,
  parsePlatformList,
  type PlatformId,
} from '../../lib/platforms.js';
import {
  installCoreForPlatform,
  directPackInstall,
  loadCatalog,
  getOrCreateManifest,
  SETUP_INTERNAL_ENV,
} from './install-skill.js';
import { installInstructions } from './install-claude-md.js';
import {
  writeManifest,
  recordPlatform,
  dreamcontextVersion,
} from '../../lib/manifest.js';
import { updateSetupConfig } from '../../lib/setup-config.js';
import { ensureRemoteBackendGitignore } from '../../lib/task-backend/paths.js';
import { writeClickUpToken } from '../../lib/task-backend/secrets.js';
import { installTaskSyncHooks } from '../../lib/task-backend/git-hooks.js';
import { writeProjectPlatformDefaults } from '../../lib/platform-defaults.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function parsePlatformsOption(raw?: string): PlatformId[] {
  if (!raw) return [];
  const parsed = parsePlatformList(raw);
  if (parsed.invalid.length > 0) {
    throw new Error(
      `Unknown platform(s): ${parsed.invalid.join(', ')}. Supported: ${formatSupportedPlatforms()}`,
    );
  }
  return ensurePlatformSelection(parsed.platforms);
}

function parsePacksOption(raw?: string): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseMultiProductOption(raw?: string): string[] | false {
  if (!raw) return false;
  const tokens = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const valid = tokens.filter((t) => SLUG_RE.test(t));
  return valid.length > 0 ? valid : false;
}

export interface InstallIntegrationOptions {
  platforms: PlatformId[];
  packs?: string[];
  multiProduct?: string[] | false;
  /** Default: true (dreamcontext owns memory). Persisted before install so the per-platform installer reads it. */
  disableNativeMemory?: boolean;
}

export interface InstallIntegrationResult {
  installed: string[];
  notes: string[];
  fileCount: number;
}

/**
 * Install the platform integration into an EXISTING `_dream_context/` project:
 * skills, agents, hooks, optional packs, and root instruction files — all
 * threaded through a single manifest. This is the part of `setup` that turns a
 * bare context directory into a working agent integration (`.claude/` etc.).
 *
 * Shared by `runSetup` and `dreamcontext init`'s "finish setup now" path so the
 * two never drift. Caller is responsible for ensuring `_dream_context/` exists.
 */
export async function installPlatformIntegration(
  projectRoot: string,
  opts: InstallIntegrationOptions,
): Promise<InstallIntegrationResult> {
  const { platforms } = opts;
  const packs = opts.packs ?? [];
  const disableNativeMemory = opts.disableNativeMemory ?? true;

  writeProjectPlatformDefaults(projectRoot, platforms);

  // Persist the native-memory choice BEFORE installing, so the per-platform
  // installer (installCoreForPlatform) reads it when writing .claude/settings.json.
  updateSetupConfig(projectRoot, { disableNativeMemory });

  // Install core skill/agents/hooks for each platform.
  info('Installing platform integration...');
  const manifest = getOrCreateManifest(projectRoot);
  for (const p of platforms) recordPlatform(manifest, p);

  const installed: string[] = [];
  const notes: string[] = [];
  for (const platform of platforms) {
    const result = await installCoreForPlatform(platform, projectRoot, manifest);
    installed.push(...result.installed);
    notes.push(...result.notes);
  }

  // Install packs.
  if (packs.length > 0) {
    info(`Installing ${packs.length} pack(s): ${chalk.dim(packs.join(', '))}`);
    directPackInstall(packs, projectRoot, platforms, manifest);
  }

  // Install root instructions (CLAUDE.md / AGENTS.md).
  info('Installing root instruction file(s)...');
  for (const platform of platforms) {
    try {
      await installInstructions(projectRoot, platform, 'append');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      info(`${platform} root instructions skipped: ${msg}`);
    }
  }

  // Persist manifest + config.
  writeManifest(projectRoot, manifest);
  updateSetupConfig(projectRoot, {
    platforms,
    packs,
    multiProduct: opts.multiProduct ?? false,
    setupVersion: dreamcontextVersion(),
  });

  return { installed, notes, fileCount: Object.keys(manifest.files).length };
}

export interface SetupOptions {
  defaults?: boolean;
  yes?: boolean;
  platforms?: string;
  packs?: string;
  multiProduct?: string;
  keepNativeMemory?: boolean;
}

export async function runSetup(opts: SetupOptions): Promise<void> {
  const projectRoot = process.cwd();
  const useDefaults = !!opts.defaults;

  // Mark child commands so they don't print deprecation hints.
  const previousEnv = process.env[SETUP_INTERNAL_ENV];
  process.env[SETUP_INTERNAL_ENV] = '1';

  try {
    // ─── 1. Resolve platforms ─────────────────────────────────────────────
    let platforms: PlatformId[];
    const explicit = parsePlatformsOption(opts.platforms);
    if (explicit.length > 0) {
      platforms = explicit;
    } else if (useDefaults || !process.stdin.isTTY) {
      platforms = [...DEFAULT_PLATFORMS];
    } else {
      const picked = await checkbox<PlatformId>({
        message: 'Select platform support to install',
        choices: PLATFORM_CATALOG.map((p) => ({
          value: p.id,
          name: `${chalk.bold(p.label)} ${chalk.dim('— ' + p.description)}`,
          checked: DEFAULT_PLATFORMS.includes(p.id),
        })),
        pageSize: PLATFORM_CATALOG.length,
      });
      platforms = ensurePlatformSelection(picked);
    }

    // ─── 2. Resolve packs ─────────────────────────────────────────────────
    let packs: string[] = parsePacksOption(opts.packs);
    if (packs.length === 0 && !useDefaults && process.stdin.isTTY) {
      const loaded = loadCatalog();
      if (loaded) {
        const choices = [
          ...loaded.catalog.packs.map((p) => ({
            value: p.name,
            name: `${chalk.bold(p.name)} ${chalk.dim('— ' + p.description)}`,
          })),
          ...loaded.catalog.standalone.map((s) => ({
            value: s.name,
            name: `${chalk.bold(s.name)} ${chalk.dim('— ' + s.description)}`,
          })),
        ];
        if (choices.length > 0) {
          packs = await checkbox<string>({
            message: 'Select optional skill packs (space to toggle, enter to skip)',
            choices,
            pageSize: Math.min(12, choices.length),
            required: false,
          });
        }
      }
    }

    // ─── 3. Resolve multi-product ─────────────────────────────────────────
    const explicitMP = parseMultiProductOption(opts.multiProduct);
    let multiProduct: string[] | false = explicitMP;
    if (!explicitMP && !useDefaults && process.stdin.isTTY) {
      const wantsMulti = await confirm({
        message: 'Is this a multi-product repo (separate context per product)?',
        default: false,
      });
      if (wantsMulti) {
        const raw = await input({
          message: 'Product names (comma-separated, lowercase kebab-case):',
        });
        multiProduct = parseMultiProductOption(raw);
      }
    }

    // ─── 4. Init (if needed) ───────────────────────────────────────────────
    const contextDir = getInitPath();
    if (!existsSync(contextDir)) {
      info('Running init...');
      const { registerInitCommand } = await import('./init.js');
      const tempProgram = new Command();
      registerInitCommand(tempProgram);
      const args = ['init', '--yes', '--platforms', platforms.join(',')];
      if (multiProduct !== false) {
        args.push('--multi-product', multiProduct.join(','));
      }
      await tempProgram.parseAsync(args, { from: 'user' });
    } else {
      info(chalk.dim('_dream_context/ already exists — skipping init.'));
    }

    // ─── 5. Install platform integration (skills, agents, hooks, packs, instructions)
    // Default: disable Claude's native auto-memory so dreamcontext owns memory.
    const disableNativeMemory = !opts.keepNativeMemory;
    const { notes, fileCount } = await installPlatformIntegration(projectRoot, {
      platforms,
      packs,
      multiProduct,
      disableNativeMemory,
    });

    // ─── 5.5 Cloud Task Management (issue #11) ────────────────────────────
    // Opt-in: tasks sync to a ClickUp list instead of living only on disk.
    // The API key goes through the SAME CLI-owned path as `config
    // clickup-token`: .gitignore entry first, then the 0600 secrets file.
    if (!useDefaults && process.stdin.isTTY) {
      const wantsCloud = await confirm({
        message: 'Enable Cloud Task Management (sync tasks to ClickUp)?',
        default: false,
      });
      if (wantsCloud) {
        try {
          ensureRemoteBackendGitignore(projectRoot);
          updateSetupConfig(projectRoot, { taskBackend: 'clickup', cloudTaskManagement: true });
          const key = await input({
            message: 'ClickUp API key (pk_…; stored in the gitignored secrets file — leave empty to add later):',
          });
          if (key.trim()) {
            writeClickUpToken(projectRoot, key.trim());
            info(chalk.dim('Token saved to _dream_context/state/.secrets.json (gitignored, mode 0600).'));
          } else {
            info(chalk.dim('No token saved. Add one later with `dreamcontext config clickup-token`.'));
          }
          try { installTaskSyncHooks(projectRoot); } catch { /* best-effort */ }
          info(chalk.dim('Set the target list with `dreamcontext config clickup-list <teamId> <spaceId> <listId>`.'));
        } catch (err) {
          error(`Cloud Task Management not enabled: ${(err as Error).message}`);
        }
      }
    }

    // ─── 6. Summary ───────────────────────────────────────────────────────
    const manifestPath = '_dream_context/state/.install-manifest.json';
    console.log();
    console.log(miniBox([
      chalk.green.bold('✓ dreamcontext setup complete'),
      '',
      `  Platforms: ${chalk.white(platforms.join(', '))}`,
      `  Packs:     ${chalk.white(packs.length > 0 ? packs.join(', ') : '(none)')}`,
      `  Products:  ${chalk.white(multiProduct === false ? 'single (default)' : multiProduct.join(', '))}`,
      `  Native mem: ${chalk.white(disableNativeMemory ? 'disabled (dreamcontext owns memory)' : 'kept enabled')}`,
      `  Files:     ${chalk.white(fileCount.toString())} tracked`,
      `  Manifest:  ${chalk.dim(manifestPath)}`,
    ], { color: 'green' }));
    console.log();

    if (notes.length > 0) {
      for (const n of notes) console.log(`  ${n}`);
      console.log();
    }
  } finally {
    if (previousEnv === undefined) {
      delete process.env[SETUP_INTERNAL_ENV];
    } else {
      process.env[SETUP_INTERNAL_ENV] = previousEnv;
    }
  }
}

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('One-shot setup: init + install-skill + install-instructions')
    .option('--defaults', 'Skip prompts; use claude platform, no packs, single-product')
    .option('-y, --yes', 'Accept all confirmation prompts')
    .option('--platforms <list>', `Comma-separated platforms: ${formatSupportedPlatforms()}`)
    .option('--packs <list>', 'Comma-separated pack names to install')
    .option('--multi-product <list>', 'Comma-separated product names for multi-product setup')
    .option('--keep-native-memory', "Keep Claude Code's native auto-memory (default: disabled so dreamcontext owns memory)")
    .action(async (opts: SetupOptions) => {
      try {
        await runSetup(opts);
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
