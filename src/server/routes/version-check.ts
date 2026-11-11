import { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { sendJson } from '../middleware.js';
import { readVersionCache, isCacheFresh, buildNudge, readAutoUpgradeMarker, shouldSuppressCliNudge, compareVersions } from '../../lib/version-check.js';
import { dreamcontextVersion, readDreamcontextVersionFromDisk } from '../../lib/manifest.js';

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
    // momentarily unavailable — the '0.0.0' sentinel. A built CLI now falls back
    // to its own build-time stamp first (so the .app bundle, which has no
    // package.json to read, reports its real version), which leaves this guard
    // for the unstamped case only. Kept: '0.0.0' still means "no signal".
    const freshCli = readDreamcontextVersionFromDisk();
    const installedCli = freshCli === '0.0.0' ? dreamcontextVersion() : freshCli;
    // App-context guard: inside the desktop app (DREAMCONTEXT_DESKTOP=1) the app
    // owns updates (self-update), so the manual CLI line is always wrong noise.
    // Otherwise suppress only while a background auto-upgrade for this version is
    // freshly in flight (returns if it failed).
    const marker = readAutoUpgradeMarker(projectRoot);
    const suppressCliNudge =
      process.env.DREAMCONTEXT_DESKTOP === '1' ||
      shouldSuppressCliNudge(fresh ? cache?.latestCli ?? null : null, marker, process.env);
    const nudge = buildNudge(installedCli, fresh ? cache : null, {
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
    sendJson(res, 200, {
      cache, fresh, nudge, currentCli: installedCli, latestCli, cliOutdated,
    });
  } catch {
    sendJson(res, 200, { cache: null, fresh: false, nudge: null });
  }
}
