import { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { sendJson } from '../middleware.js';
import { readVersionCache, isCacheFresh, buildNudge, readAutoUpgradeMarker, shouldSuppressCliNudge, compareVersions } from '../../lib/version-check.js';
import { dreamcontextVersion, readDreamcontextVersionFromDisk } from '../../lib/manifest.js';
import { isSkillInstalled } from '../../lib/catalog.js';
import { readSetupConfig } from '../../lib/setup-config.js';

/**
 * GET /api/version-check — Return cached update nudge data.
 *
 * Cache-only: no network calls or subprocesses in the request path.
 * The networked refreshVersionCache stays out-of-band (hook/CLI).
 *
 * On any read failure, returns a benign payload (never 500).
 */
export async function handleVersionCheckGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const projectRoot = dirname(contextRoot);
    const cache = readVersionCache(projectRoot);
    const fresh = isCacheFresh(cache);
    // Read the CLI version FRESH from disk, not the process-cached value.
    // `dreamcontextVersion()` memoizes at process start; the desktop app's
    // long-lived dashboard server therefore keeps reporting its launch-time
    // version even after an in-place `dreamcontext upgrade` rewrote package.json.
    // That made the header badge show a phantom "vOLD → vNEW" nudge for a version
    // the user had ALREADY installed — until they fully relaunched the app.
    // Reading fresh lets the badge self-clear on the next poll once the on-disk
    // package is upgraded. Fall back to the cached value if the fresh read is
    // momentarily unavailable (npm mid-swap returns the '0.0.0' sentinel).
    const freshCli = readDreamcontextVersionFromDisk();
    const installedCli = freshCli === '0.0.0' ? dreamcontextVersion() : freshCli;
    // Scope the pack universe to what THIS project opted into (config.packs),
    // intersected with the catalog. A pack the user consciously DECLINED (in the
    // catalog but never chosen for this vault) must NEVER surface as a "new pack
    // available" — otherwise every vault that skipped an optional pack shows a
    // permanent, un-actionable "Update available" nag (e.g. a personal notes vault
    // that will never want meta-marketing / business-idea-* / video-watching). The
    // universe is opted-in ∩ catalog; a pack is "new" only when it's opted-in but
    // missing on disk (a genuine `dreamcontext update` gap).
    const catalogPackNames = cache?.availablePacks ?? [];
    const optedInPacks = readSetupConfig(projectRoot)?.packs ?? [];
    const relevantPacks = catalogPackNames.filter((name) => optedInPacks.includes(name));
    // Filesystem truth (the pack's SKILL.md on disk), NOT config.packs alone —
    // config drifts and produced false "new pack" nudges for packs already installed.
    // Mirrors the /api/packs `installed` computation.
    const installedPacks = relevantPacks.filter((name) => isSkillInstalled(projectRoot, name));
    const newPacks = fresh ? relevantPacks.filter((name) => !installedPacks.includes(name)) : [];
    // App-context guard: inside the desktop app (DREAMCONTEXT_DESKTOP=1) the app
    // owns updates (self-update), so the manual CLI line is always wrong noise.
    // Otherwise suppress only while a background auto-upgrade for this version is
    // freshly in flight (returns if it failed). The new-skill-packs line stays.
    const marker = readAutoUpgradeMarker(projectRoot);
    const suppressCliNudge =
      process.env.DREAMCONTEXT_DESKTOP === '1' ||
      shouldSuppressCliNudge(fresh ? cache?.latestCli ?? null : null, marker, process.env);
    // Pass the OPTED-IN pack universe (relevantPacks), not the full catalog, so the
    // prose nudge's own "new packs" computation matches `newPacks` above and never
    // lists a declined pack.
    const nudge = buildNudge(installedCli, fresh ? cache : null, installedPacks, relevantPacks, {
      suppressCliNudge,
    });
    // Structured upgrade signal — independent of the manual-nudge suppression.
    // In the desktop app the "run dreamcontext upgrade" TEXT line is suppressed
    // (a terminal instruction is the wrong surface there), but the app itself CAN
    // perform the upgrade in-place. So we always report whether a newer CLI is
    // published; the header badge uses this to show the one-click "Upgrade
    // everything" action even when the prose nudge is empty.
    const latestCli = fresh ? cache?.latestCli ?? null : null;
    const cliOutdated = latestCli !== null && compareVersions(installedCli, latestCli) < 0;
    sendJson(res, 200, { cache, fresh, nudge, newPacks, currentCli: installedCli, latestCli, cliOutdated });
  } catch {
    sendJson(res, 200, { cache: null, fresh: false, nudge: null });
  }
}
