import { Command } from 'commander';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import { error, info, warn, miniBox } from '../../lib/format.js';
import { readSleepState, writeSleepState } from './sleep.js';
import { SUPPORTED_PLATFORMS, type PlatformId } from '../../lib/platforms.js';
import {
  installCoreForPlatform,
  directPackInstall,
  loadCatalog,
  platformSkillRoot,
  getOrCreateManifest,
} from './install-skill.js';
import { knownArtifactNames } from '../../lib/catalog.js';
import {
  readManifest,
  writeManifest,
  diffManifests,
  isSafeDeletePath,
  bootstrapManifestFromScan,
  recordPlatform,
  dreamcontextVersion,
  PRE_MANIFEST_VERSION,
  type Manifest,
} from '../../lib/manifest.js';
import { updateSetupConfig, readSetupConfig } from '../../lib/setup-config.js';
import { runMigrations } from '../../lib/migration-runner.js';

// ─── Update Summary ──────────────────────────────────────────────────────────

export interface UpdateSummaryInput {
  platforms: PlatformId[];
  installedCount: number;
  packs: string[];
  removed: string[];
  setupVersion: string | null;
}

/**
 * Build a relay-able plain-text summary of what the update command did.
 * Exported for use by tests and relay agents.
 */
export function buildUpdateSummary(input: UpdateSummaryInput): string {
  const { platforms, installedCount, packs, removed, setupVersion } = input;
  const lines: string[] = ['## Update Summary\n'];
  lines.push(`Platforms: ${platforms.length > 0 ? platforms.join(', ') : 'none'}`);
  lines.push(`Core files refreshed: ${installedCount}`);
  if (packs.length > 0) {
    lines.push(`Packs refreshed: ${packs.join(', ')}`);
  } else {
    lines.push('Packs refreshed: none');
  }
  if (removed.length > 0) {
    lines.push(`Pruned files: ${removed.join(', ')}`);
  } else {
    lines.push('Pruned files: none');
  }
  if (setupVersion !== null) {
    lines.push(`Setup version: ${setupVersion}`);
  }
  return lines.join('\n');
}

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

/**
 * Decide which stale (removed-from-manifest) files to delete vs. keep.
 *
 * Returns `{ removed, keep }` where `keep = candidates.filter(c => !removed.includes(c))`,
 * i.e. EVERYTHING not actually deleted. The caller re-persists every `keep`
 * entry into the new manifest unconditionally so nothing is silently dropped
 * from tracking. All return paths (first-run, declined, success) use this shape.
 *
 * Partition of `candidates` (safe-to-delete stale paths) by old-manifest version:
 *  - heuristic (version === PRE_MANIFEST_VERSION): adopted by the legacy
 *    bootstrap, which cannot tell a dreamcontext file from a user-authored one.
 *    NEVER deleted — only warned. This is the data-loss safety net for users
 *    whose manifest was already polluted before the allowlist fix.
 *  - owned (concrete semver): genuinely dreamcontext-installed and later
 *    removed from the catalog. Auto-deletable (first-run flags only; otherwise
 *    confirm-or-`--yes`).
 *
 * Threat model note: a custom file can only acquire a concrete-version entry by
 * a user hand-editing the manifest. Hand-edited manifests assigning a concrete
 * version to a custom file are explicitly OUT of the threat model.
 */
export async function pruneStaleFiles(
  projectRoot: string,
  oldManifest: Manifest,
  newManifest: Manifest,
  isFirstRun: boolean,
  yes: boolean,
): Promise<{ removed: string[]; keep: string[] }> {
  const diff = diffManifests(oldManifest, newManifest);
  const candidates = diff.removed.filter((p) => isSafeDeletePath(p));
  const unsafe = diff.removed.filter((p) => !isSafeDeletePath(p));

  if (unsafe.length > 0) {
    console.log();
    warn(`Skipped ${unsafe.length} stale path(s) outside safe prefixes (.claude/):`);
    for (const p of unsafe) console.log(`  ${chalk.dim('•')} ${chalk.dim(p)}`);
  }

  if (candidates.length === 0) return { removed: [], keep: [] };

  // Partition by old-manifest version. Heuristic (pre-manifest) files are never
  // deleted — they may be user-authored files adopted by the legacy bootstrap.
  const heuristic = candidates.filter(
    (p) => oldManifest.files[p]?.version === PRE_MANIFEST_VERSION,
  );
  const owned = candidates.filter(
    (p) => oldManifest.files[p]?.version !== PRE_MANIFEST_VERSION,
  );

  if (heuristic.length > 0) {
    console.log();
    warn(`${heuristic.length} legacy file(s) detected, not removed (review manually):`);
    for (const p of heuristic) console.log(`  ${chalk.dim('•')} ${chalk.dim(p)}`);
  }

  // First migration run: never delete anything; keep everything so the caller
  // re-persists and the next run can re-offer the owned set.
  if (isFirstRun) {
    if (owned.length > 0) {
      console.log();
      warn(`First update after upgrade: ${owned.length} stale file(s) detected (not removed).`);
      console.log(chalk.dim('  Re-run `dreamcontext update` to clean them up.'));
      for (const p of owned) console.log(`  ${chalk.dim('•')} ${chalk.dim(p)}`);
    }
    return { removed: [], keep: candidates };
  }

  if (owned.length === 0) {
    // Only heuristic files — nothing deletable, keep them all (tracked + protected).
    return { removed: [], keep: candidates };
  }

  console.log();
  console.log(`Stale file(s) detected (${owned.length}):`);
  for (const p of owned) console.log(`  ${chalk.yellow('-')} ${p}`);

  if (!yes && process.stdin.isTTY) {
    const ok = await confirm({ message: 'Delete these files?', default: true });
    if (!ok) {
      info('Skipped deletions.');
      // Declined: keep everything (owned re-offered next run + heuristic protected).
      return { removed: [], keep: candidates };
    }
  }

  const removed: string[] = [];
  for (const rel of owned) {
    const abs = join(projectRoot, rel);
    try {
      rmSync(abs, { force: true });
      removed.push(rel);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      warn(`Could not delete ${rel}: ${msg}`);
    }
  }
  // keep = everything NOT actually deleted (all heuristic + any owned that failed to delete).
  return { removed, keep: candidates.filter((c) => !removed.includes(c)) };
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
          oldManifest = bootstrapManifestFromScan(projectRoot, knownArtifactNames());
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
            if (
              entry.kind === 'pack-skill' ||
              entry.kind === 'pack-agent' ||
              entry.kind === 'pack-asset'
            ) {
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
        const pruneResult = await pruneStaleFiles(
          projectRoot,
          oldManifest,
          newManifest,
          isFirstRun,
          !!opts.yes,
        );

        // Re-persist EVERY kept stale entry (heuristic/custom files + owned files
        // that were first-run / declined / failed-to-delete) into the new manifest.
        // This is UNCONDITIONAL (no cancel guard): without it, a run that deletes
        // some owned files would silently drop the kept entries from tracking —
        // re-introducing the data-loss / lost-flag regression. The next `update`
        // can then re-offer owned files and keeps protecting heuristic ones.
        for (const path of pruneResult.keep) {
          const entry = oldManifest.files[path];
          if (entry && !newManifest.files[path]) {
            newManifest.files[path] = entry;
          }
        }

        writeManifest(projectRoot, newManifest);

        // Capture fromVersion BEFORE bumping setupVersion so migrations run
        // over the correct (from, to] range.
        const fromVersion =
          readSetupConfig(projectRoot)?.setupVersion ?? '0.0.0';

        // Bump setupVersion only when core was refreshed (not packs-only).
        // packs-only does NOT refresh skill/agents/hooks, so drift must remain.
        let newSetupVersion: string | null = null;
        if (!opts.packsOnly) {
          const ver = dreamcontextVersion();

          // Run pending structural migrations for the (fromVersion, ver] range
          // BEFORE persisting setupVersion. setupVersion gates which migrations
          // are considered "pending" (migration-runner.ts pendingMigrations) —
          // bumping it first would make a mid-run failure invisible to the next
          // `update`, silently orphaning un-migrated source files.
          const ctxRoot = join(projectRoot, '_dream_context');
          const migResult = runMigrations(ctxRoot, fromVersion, ver);
          if (migResult.applied.length > 0) {
            const codeApplied = migResult.applied.filter(
              (e) => e.executor === 'code',
            );
            if (codeApplied.length > 0) {
              info(
                `Applied ${codeApplied.length} migration step(s): ${codeApplied.map((e) => `${e.version}/${e.step}`).join(', ')}`,
              );
              // Queue notices into .sleep.json so the next SessionStart snapshot
              // surfaces "Migrations applied since last session" (AC-7).
              const codeNotices = codeApplied.map(
                (e) => `${e.version} ${e.step}: ${e.summary}`,
              );
              const sleepState = readSleepState(ctxRoot);
              sleepState.pendingMigrationNotices = [
                ...sleepState.pendingMigrationNotices,
                ...codeNotices,
              ];
              writeSleepState(ctxRoot, sleepState);
            }
          }

          // Persist setupVersion ONLY on a fully-clean migration run. A partial
          // failure pins setupVersion at fromVersion so the next `update` retries
          // the pending migration (idempotent) instead of silently skipping it.
          // Dual-purpose caveat: setupVersion also drives setup-drift.ts's
          // asset-freshness check — a persistently-failing migration keeps the
          // brain flagged "stale" (a perpetual update nag). Accepted tradeoff: a
          // nag is strictly safer than silently orphaning migrated-away sources.
          if (migResult.failedSteps === 0) {
            updateSetupConfig(projectRoot, { setupVersion: ver });
            newSetupVersion = ver;
          } else {
            warn(
              `Migration partially failed (${migResult.failedSteps} file(s)) — setupVersion left at ${fromVersion}. The next \`dreamcontext update\` will retry.`,
            );
          }
        }

        // Print relay-able summary always (covers packs-only too).
        const summary = buildUpdateSummary({
          platforms,
          installedCount: installed.length,
          packs,
          removed: pruneResult.removed,
          setupVersion: newSetupVersion,
        });
        console.log();
        console.log(miniBox(summary.split('\n'), { color: 'green' }));
        console.log();
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
