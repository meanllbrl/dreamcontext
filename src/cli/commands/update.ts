import { Command } from 'commander';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import { error, info, warn, miniBox } from '../../lib/format.js';
import { SUPPORTED_PLATFORMS, type PlatformId } from '../../lib/platforms.js';
import {
  installCoreForPlatform,
  directPackInstall,
  loadCatalog,
  platformSkillRoot,
  getOrCreateManifest,
} from './install-skill.js';
import {
  readManifest,
  writeManifest,
  diffManifests,
  isSafeDeletePath,
  bootstrapManifestFromScan,
  recordPlatform,
  dreamcontextVersion,
  type Manifest,
} from '../../lib/manifest.js';

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

async function pruneStaleFiles(
  projectRoot: string,
  oldManifest: Manifest,
  newManifest: Manifest,
  isFirstRun: boolean,
  yes: boolean,
): Promise<{ removed: string[]; flagged: string[]; cancelled: boolean }> {
  const diff = diffManifests(oldManifest, newManifest);
  const candidates = diff.removed.filter((p) => isSafeDeletePath(p));
  const unsafe = diff.removed.filter((p) => !isSafeDeletePath(p));

  if (unsafe.length > 0) {
    console.log();
    warn(`Skipped ${unsafe.length} stale path(s) outside safe prefixes (.claude/, .agents/, .codex/):`);
    for (const p of unsafe) console.log(`  ${chalk.dim('•')} ${chalk.dim(p)}`);
  }

  if (candidates.length === 0) return { removed: [], flagged: [], cancelled: false };

  // First migration run: never delete; just flag for the user.
  if (isFirstRun) {
    console.log();
    warn(`First update after upgrade: ${candidates.length} stale file(s) detected (not removed).`);
    console.log(chalk.dim('  Re-run `dreamcontext update` to clean them up.'));
    for (const p of candidates) console.log(`  ${chalk.dim('•')} ${chalk.dim(p)}`);
    return { removed: [], flagged: candidates, cancelled: true };
  }

  console.log();
  console.log(`Stale file(s) detected (${candidates.length}):`);
  for (const p of candidates) console.log(`  ${chalk.yellow('-')} ${p}`);

  if (!yes && process.stdin.isTTY) {
    const ok = await confirm({ message: 'Delete these files?', default: true });
    if (!ok) {
      info('Skipped deletions.');
      return { removed: [], flagged: candidates, cancelled: true };
    }
  }

  const removed: string[] = [];
  for (const rel of candidates) {
    const abs = join(projectRoot, rel);
    try {
      rmSync(abs, { force: true });
      removed.push(rel);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      warn(`Could not delete ${rel}: ${msg}`);
    }
  }
  return { removed, flagged: [], cancelled: false };
}

export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .description('Refresh installed dreamcontext files (core skill, agents, hooks, packs, root instructions) to the latest shipped version')
    .option('--packs-only', 'Only refresh installed packs, skip core skill/agents/hooks')
    .option('--core-only', 'Only refresh core skill/agents/hooks, skip packs')
    .option('-y, --yes', 'Skip confirmation prompts when deleting stale files')
    .action(async (opts: { packsOnly?: boolean; coreOnly?: boolean; yes?: boolean }) => {
      try {
        const projectRoot = process.cwd();
        const platforms = detectInstalledPlatforms(projectRoot);

        if (platforms.length === 0) {
          error('No installed platforms found. Run `dreamcontext install-skill` first.');
          return;
        }

        info(`Detected platforms: ${chalk.dim(platforms.join(', '))}`);

        // Read or bootstrap old manifest BEFORE running install.
        let oldManifest = readManifest(projectRoot);
        let isFirstRun = false;
        if (!oldManifest) {
          isFirstRun = true;
          oldManifest = bootstrapManifestFromScan(projectRoot);
          info(chalk.dim(`No manifest found — bootstrapped baseline from ${Object.keys(oldManifest.files).length} existing files.`));
        }

        // Build a fresh manifest for this install run.
        const newManifest = getOrCreateManifest(projectRoot);
        // Clear files/packs: this represents what is currently installed.
        newManifest.files = {};
        newManifest.packs = {};
        newManifest.version = dreamcontextVersion();
        for (const p of platforms) recordPlatform(newManifest, p);

        // Preserve untouched partition when running with --core-only / --packs-only.
        // Without this, the diff would flag every file in the skipped partition as
        // "removed" and offer to delete them.
        if (opts.coreOnly && !opts.packsOnly) {
          for (const [path, entry] of Object.entries(oldManifest.files)) {
            if (entry.kind === 'pack-skill' || entry.kind === 'pack-agent') {
              newManifest.files[path] = entry;
            }
          }
          // Packs are fully owned by the pack partition.
          for (const [name, info] of Object.entries(oldManifest.packs)) {
            newManifest.packs[name] = info;
          }
        } else if (opts.packsOnly && !opts.coreOnly) {
          for (const [path, entry] of Object.entries(oldManifest.files)) {
            if (entry.kind === 'core' || entry.kind === 'agent' || entry.kind === 'hook') {
              newManifest.files[path] = entry;
            }
          }
        }

        const installed: string[] = [];
        const notes: string[] = [];

        if (!opts.packsOnly) {
          for (const platform of platforms) {
            const result = await installCoreForPlatform(platform, projectRoot, newManifest);
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
          directPackInstall(packs, projectRoot, platforms, newManifest);
        } else if (!opts.coreOnly) {
          info(chalk.dim('No installed packs detected.'));
        }

        // Diff vs. old to prune stale files BEFORE persisting the new manifest.
        // If the user cancels (or this is the first migration run), we must keep
        // the stale entries in the manifest so the next `update` can offer to
        // delete them again. Otherwise they'd be silently dropped from tracking
        // and survive on disk forever.
        const pruneResult = await pruneStaleFiles(
          projectRoot,
          oldManifest,
          newManifest,
          isFirstRun,
          !!opts.yes,
        );

        if (pruneResult.cancelled) {
          for (const path of pruneResult.flagged) {
            const entry = oldManifest.files[path];
            if (entry && !newManifest.files[path]) {
              newManifest.files[path] = entry;
            }
          }
        }

        writeManifest(projectRoot, newManifest);
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
