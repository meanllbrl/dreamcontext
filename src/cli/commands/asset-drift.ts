/**
 * Used-asset drift computation.
 *
 * Answers ONE question: would `dreamcontext update` add or modify a file that
 * THIS project actually uses (its core skill/agents for the installed platforms,
 * plus its installed packs)? If not, the SessionStart "stale assets" nag is a
 * false positive and should stay silent even though the CLI version bumped.
 *
 * Method: install the current CLI's canonical assets for the project's exact
 * platform+pack set into a throwaway temp dir using the REAL installers (zero
 * duplication of the intricate pack→disk mapping), then byte-compare each
 * produced file against the project's on-disk copy. Hooks (`settings.json`) are
 * excluded — they're additively merged, never byte-identical.
 *
 * Comparison is temp→disk only (additions/modifications), deliberately ignoring
 * files that exist on disk but not in the canonical set. That is the point: an
 * unused/extra skill the user happens to have must NOT trigger the nag.
 *
 * The installers are async and log to stdout, so this never runs inside the sync,
 * stdout-sensitive SessionStart snapshot — only from the detached refresher below.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { SetupConfig } from '../../lib/setup-config.js';
import { readSetupConfig } from '../../lib/setup-config.js';
import { dreamcontextVersion, emptyManifest } from '../../lib/manifest.js';
import { resolveDriftState } from '../../lib/setup-drift.js';
import { writeAssetDriftCache } from '../../lib/asset-drift-cache.js';
import { installCoreForPlatform, directPackInstall } from './install-skill.js';

/** Collect every file under `dir` as a path relative to `base`. */
function walkFiles(dir: string, base: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(abs, base, out);
    else if (entry.isFile()) out.push(abs.slice(base.length + 1));
  }
}

/**
 * True iff updating this project would add or change a file it uses. Throws on
 * failure (catalog missing, install error) — the caller decides the fail
 * direction (callers fail open: show the nag when this can't be proven clean).
 */
export async function computeUsedAssetsChanged(
  projectRoot: string,
  config: SetupConfig,
): Promise<boolean> {
  const tmp = mkdtempSync(join(tmpdir(), 'dc-assetdrift-'));
  try {
    for (const platform of config.platforms) {
      await installCoreForPlatform(platform, tmp);
    }
    if (config.packs.length > 0) {
      // Pass a throwaway manifest so the installer never persists
      // `_dream_context/state/.install-manifest.json` into the temp tree.
      directPackInstall(config.packs, tmp, config.platforms, emptyManifest());
    }

    const produced: string[] = [];
    walkFiles(tmp, tmp, produced);
    for (const rel of produced) {
      // Compare only installed ASSETS. Skip merged hooks (never byte-identical)
      // and any machine-state under `_dream_context/` (e.g. the install manifest).
      if (rel.endsWith('settings.json')) continue;
      if (rel.startsWith('_dream_context/')) continue;
      const onDisk = join(projectRoot, rel);
      if (!existsSync(onDisk)) return true; // a used asset is missing on disk
      if (!readFileSync(join(tmp, rel)).equals(readFileSync(onDisk))) return true; // differs
    }
    return false;
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup — a leaked temp dir must never fail the refresh.
    }
  }
}

/**
 * Detached-process entry: recompute the used-asset drift verdict for the project
 * at `contextRoot` (= `_dream_context`) and persist it to the cache. No-ops fast
 * when version drift doesn't even flag staleness (nothing to scope). Never
 * throws to the caller's expectations beyond what the command wrapper catches.
 */
export async function runAssetDriftRefresh(contextRoot: string): Promise<void> {
  const projectRoot = dirname(contextRoot);
  const config = readSetupConfig(projectRoot);
  if (!config) return;

  const cliVersion = dreamcontextVersion();
  const state = resolveDriftState({
    cliVersion,
    setupVersion: config.setupVersion,
    driftCheckEnv: process.env.DREAMCONTEXT_DRIFT_CHECK,
  });
  // Only 'stale'/'bootstrap' produce a nag worth scoping. 'current'/'downgrade'/
  // 'disabled' need no content check.
  if (state !== 'stale' && state !== 'bootstrap') return;

  const usedAssetsChanged = await computeUsedAssetsChanged(projectRoot, config);
  writeAssetDriftCache(contextRoot, {
    cliVersion,
    setupVersion: config.setupVersion,
    usedAssetsChanged,
    checkedAt: Date.now(),
  });
}
