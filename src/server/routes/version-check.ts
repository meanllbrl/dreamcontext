import { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { sendJson } from '../middleware.js';
import { readVersionCache, isCacheFresh, buildNudge, readAutoUpgradeMarker, shouldSuppressCliNudge, compareVersions } from '../../lib/version-check.js';
import { dreamcontextVersion } from '../../lib/manifest.js';
import { isSkillInstalled } from '../../lib/catalog.js';

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
    const installedCli = dreamcontextVersion();
    const catalogPackNames = cache?.availablePacks ?? [];
    // Filesystem truth (the pack's SKILL.md on disk), NOT config.packs — config
    // drifts from reality and produced false "new pack available" nudges for packs
    // that were already installed. Mirrors the /api/packs `installed` computation.
    const installedPacks = catalogPackNames.filter((name) => isSkillInstalled(projectRoot, name));
    const newPacks = fresh ? catalogPackNames.filter((name) => !installedPacks.includes(name)) : [];
    // App-context guard: inside the desktop app (DREAMCONTEXT_DESKTOP=1) the app
    // owns updates (self-update), so the manual CLI line is always wrong noise.
    // Otherwise suppress only while a background auto-upgrade for this version is
    // freshly in flight (returns if it failed). The new-skill-packs line stays.
    const marker = readAutoUpgradeMarker(projectRoot);
    const suppressCliNudge =
      process.env.DREAMCONTEXT_DESKTOP === '1' ||
      shouldSuppressCliNudge(fresh ? cache?.latestCli ?? null : null, marker, process.env);
    const nudge = buildNudge(installedCli, fresh ? cache : null, installedPacks, catalogPackNames, {
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
