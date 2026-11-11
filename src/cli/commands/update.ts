import { Command, Option } from 'commander';
import { existsSync, lstatSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import { error, info, warn, miniBox } from '../../lib/format.js';
import { SUPPORTED_PLATFORMS, type PlatformId } from '../../lib/platforms.js';
import {
  installCoreForPlatform,
  getOrCreateManifest,
} from './install-skill.js';
import { knownArtifactNames, detectInstalledPlatforms, findPackageDir, platformSkillRoot } from '../../lib/catalog.js';
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
import { guardedFileIsUnchanged, isGuardedSkillPath, type GuardedInstallResult } from '../../lib/core-guarded-skill.js';
import { migrateThenStampSetupVersion } from '../../lib/migrate-and-stamp.js';
import { adoptLocalPending } from '../../lib/automations/adopt-local.js';
import { pruneRetiredPacks, pruneStoppedSkills, retireExcalidraw } from '../../lib/retired-packs.js';
import { ensureCodex } from '../ensure-codex.js';
import { refreshStaleDispatcher, type RefreshDispatcherResult } from '../../lib/automations/launchd.js';
import { refreshManagedInstructionsBlock, type ManagedBlockRefreshAction } from './install-claude-md.js';

// ─── Update Summary ──────────────────────────────────────────────────────────

export interface UpdateSummaryInput {
  platforms: PlatformId[];
  installedCount: number;
  removed: string[];
  setupVersion: string | null;
  /**
   * What happened to the managed CLAUDE.md block. Omitted (or null) when the
   * refresh did not run at all.
   */
  rootInstructions?: ManagedBlockRefreshAction | null;
}

const ROOT_INSTRUCTIONS_SUMMARY: Record<ManagedBlockRefreshAction, string> = {
  refreshed: 'CLAUDE.md managed block refreshed (text outside the block untouched)',
  unchanged: 'CLAUDE.md managed block already current',
  absent: 'no dreamcontext block in CLAUDE.md, left alone',
  'not-a-file': 'CLAUDE.md is not a regular file (symlink?), left alone',
};

/**
 * Build a relay-able plain-text summary of what the update command did.
 * Exported for use by tests and relay agents.
 */
export function buildUpdateSummary(input: UpdateSummaryInput): string {
  const { platforms, installedCount, removed, setupVersion } = input;
  const lines: string[] = ['## Update Summary\n'];
  lines.push(`Platforms: ${platforms.length > 0 ? platforms.join(', ') : 'none'}`);
  lines.push(`Core files refreshed: ${installedCount}`);
  if (removed.length > 0) {
    lines.push(`Pruned files: ${removed.join(', ')}`);
  } else {
    lines.push('Pruned files: none');
  }
  if (input.rootInstructions) {
    lines.push(`Root instructions: ${ROOT_INSTRUCTIONS_SUMMARY[input.rootInstructions]}`);
  }
  if (setupVersion !== null) {
    lines.push(`Setup version: ${setupVersion}`);
  }
  return lines.join('\n');
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
  // A stale path that is already gone needs no confirmation and no tracking: an
  // install step (e.g. the retired-agent prune) may have removed it this run.
  // lstat, not existsSync, so a dangling symlink still counts as present.
  const onDisk = (rel: string): boolean => {
    try {
      lstatSync(join(projectRoot, rel));
      return true;
    } catch {
      return false;
    }
  };
  const removedPresent = diff.removed.filter(onDisk);
  const candidates = removedPresent.filter((p) => isSafeDeletePath(p));
  const unsafe = removedPresent.filter((p) => !isSafeDeletePath(p));

  if (unsafe.length > 0) {
    console.log();
    warn(`Skipped ${unsafe.length} stale path(s) outside safe prefixes (.claude/):`);
    for (const p of unsafe) console.log(`  ${chalk.dim('•')} ${chalk.dim(p)}`);
  }

  if (candidates.length === 0) return { removed: [], keep: [] };

  // Partition by old-manifest version. Heuristic (pre-manifest) files are never
  // deleted — they may be user-authored files adopted by the legacy bootstrap.
  function editedDesignFile(p: string): boolean {
    return isGuardedSkillPath(p) && !guardedFileIsUnchanged(projectRoot, p, oldManifest.files[p]?.baselineSha);
  }
  const heuristic = candidates.filter(
    (p) => oldManifest.files[p]?.version === PRE_MANIFEST_VERSION,
  );
  const owned = candidates.filter(
    (p) => oldManifest.files[p]?.version !== PRE_MANIFEST_VERSION && !editedDesignFile(p),
  );
  // A guarded-skill file (design, draw) a later release dropped is deleted only if nobody edited it; an edited one is
  // someone's work, kept and tracked like the heuristic files above (and `upgrade` runs --yes).
  const editedDesign = candidates.filter(
    (p) => oldManifest.files[p]?.version !== PRE_MANIFEST_VERSION && editedDesignFile(p),
  );
  if (editedDesign.length > 0) {
    console.log();
    warn(`${editedDesign.length} design/draw skill file(s) no longer ship but were edited, not removed:`);
    for (const p of editedDesign) console.log(`  ${chalk.dim('•')} ${chalk.dim(p)}`);
  }

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

/** One line, only when there is something to say: a current or absent scheduler is silent. */
function reportDispatcherRefresh(r: RefreshDispatcherResult): void {
  if (r.action === 'refreshed') {
    info('Routine scheduler refreshed: it now runs at normal priority.');
    for (const w of r.warnings) warn(w);
    return;
  }
  if (r.reason === 'tick-running') {
    info(chalk.dim('Routine scheduler is out of date but busy right now; run `dreamcontext automations install` once it is idle.'));
  } else if (r.reason === 'mismatch') {
    warn(`Routine scheduler is out of date and runs a different dreamcontext (${r.detail ?? 'unknown'}); run \`dreamcontext automations install\` from the one you want it to use.`);
  } else if (r.reason === 'failed') {
    warn(`Routine scheduler could not be refreshed${r.detail ? `: ${r.detail}` : ''}. Run \`dreamcontext automations install\`.`);
  }
}

export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .description('Refresh installed dreamcontext files (skills, agents, hooks, and the managed CLAUDE.md block when one exists) to the latest shipped version')
    // Skill packs are gone (2026-11-11): every skill dreamcontext ships is core. Both flags stay
    // accepted so an older script or app that passes them gets an answer, not "unknown option".
    .addOption(new Option('--core-only', 'Same as a plain update: there are no packs any more').hideHelp())
    .addOption(new Option('--packs-only', 'Refreshes nothing: there are no packs any more').hideHelp())
    .option('-y, --yes', 'Skip confirmation prompts when deleting stale files')
    .action(async (opts: { packsOnly?: boolean; coreOnly?: boolean; yes?: boolean }) => {
      try {
        const projectRoot = process.cwd();
        if (opts.packsOnly && !opts.coreOnly) {
          info('Skill packs no longer exist: every skill dreamcontext ships is installed with the core. Nothing to refresh; run `dreamcontext update`.');
          return;
        }
        const platforms = detectInstalledPlatforms(projectRoot);

        if (platforms.length === 0) {
          error('No installed platforms found. Run `dreamcontext install-skill` first.');
          // Refuse LOUDLY, in the one channel a script actually reads. This
          // branch used to fall out on a bare `return`, so the process exited 0
          // and every batch caller — `upgrade`'s per-project fan-out, the
          // launcher's "Update all", a user's propagate loop — recorded a
          // refresh that never happened. A no-op reported as success is how
          // automation learns to ignore real failures.
          process.exitCode = 1;
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

        const installed: string[] = [];
        const notes: string[] = [];

        let rootInstructions: ManagedBlockRefreshAction | null = null;
        // This run's draw install per skill root: the excalidraw retirement below needs proof that
        // draw is on disk now.
        const drawInstalls = new Map<string, GuardedInstallResult>();
        {
          for (const platform of platforms) {
            const result = await installCoreForPlatform(platform, projectRoot, newManifest);
            installed.push(...result.installed);
            notes.push(...result.notes);
            if (result.draw) drawInstalls.set(result.draw.skillRootRel, result.draw.result);
          }

          // The managed CLAUDE.md block is core content too, but only when the
          // project already carries one: update never creates the file and never
          // adds a block the user removed (that is `install-instructions`' job).
          try {
            rootInstructions = refreshManagedInstructionsBlock(projectRoot, 'claude').action;
            if (rootInstructions === 'refreshed') {
              installed.push('CLAUDE.md (managed block)');
            }
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            notes.push(chalk.yellow(`CLAUDE.md managed block not refreshed: ${msg}`));
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

        // Retired packs first: they decide per file by content (ours goes, an edited file
        // stays untracked), and take their entries out of both manifests so the generic
        // prune below never offers a file the user edited.
        const retired = pruneRetiredPacks(projectRoot, oldManifest, newManifest, findPackageDir('agents'));
        for (const note of retired.notes) info(note);
        // The excalidraw pack became the core draw skill. It decides every file under its folder
        // by content, or (draw not proven on disk this run) carries every record forward
        // unchanged, so the stale prune below never reaches one of its files.
        for (const platform of platforms) {
          const skillRootRel = relative(projectRoot, platformSkillRoot(projectRoot, platform)).split(sep).join('/');
          const excalidraw = retireExcalidraw(projectRoot, skillRootRel, drawInstalls.get(skillRootRel) ?? null, oldManifest, newManifest);
          for (const note of excalidraw.notes) info(note);
          retired.removed.push(...excalidraw.removed);
        }
        // The skills dreamcontext stopped shipping (2026-11-11): a copy goes only when the manifest
        // on disk proves dreamcontext installed it AND it is unchanged; anything else stays, untracked.
        // Every platform shares one skill root today: decide each root once.
        for (const skillRootRel of new Set(platforms.map((p) => relative(projectRoot, platformSkillRoot(projectRoot, p)).split(sep).join('/')))) {
          const stopped = pruneStoppedSkills(projectRoot, skillRootRel, oldManifest, newManifest);
          for (const note of stopped.notes) info(note);
          retired.removed.push(...stopped.removed);
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

        // Migrations run BEFORE setupVersion is persisted, and a partial failure
        // pins it so the next `update` retries — the shared contract in
        // migrate-and-stamp.ts, which install-skill and setup follow too.
        let newSetupVersion: string | null = null;
        {
          newSetupVersion = migrateThenStampSetupVersion(projectRoot).stamped;
          // Once per project: members and routines this Mac made that waited under the old rule are
          // approved; anything that came by git keeps its one card (adopt-local.ts).
          const contextRoot = join(projectRoot, '_dream_context');
          if (existsSync(contextRoot)) {
            const { adopted } = adoptLocalPending(contextRoot);
            if (adopted.length > 0) info(`Approved on this Mac (made here, it waited under the old rule): ${adopted.join(', ')}.`);
          }
        }

        const summary = buildUpdateSummary({
          platforms,
          installedCount: installed.length,
          removed: [...retired.removed, ...pruneResult.removed],
          setupVersion: newSetupVersion,
          rootInstructions,
        });
        console.log();
        console.log(miniBox(summary.split('\n'), { color: 'green' }));
        console.log();
        await ensureCodex();
        // The scheduler is machine-wide and its plist only changes on a re-bootstrap: an older
        // release's plist keeps every routine under macOS background throttling until refreshed.
        reportDispatcherRefresh(await refreshStaleDispatcher());
      } catch (err: any) {
        if (err.name === 'ExitPromptError') {
          console.log();
          info('Cancelled.');
          return;
        }
        // Same contract as the no-platforms bail above: a throw means the
        // refresh did not finish, so the exit code has to say so. (A deliberate
        // Ctrl-C above stays 0 — that is a human choosing to stop, and it is
        // unreachable without a TTY, so no script can observe it.)
        error(err.message);
        process.exitCode = 1;
      }
    });
}
