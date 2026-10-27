import { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../middleware.js';
import { dreamcontextVersion } from '../../lib/manifest.js';
import { getUpgradeReadyVersion } from '../lifecycle.js';
import { anyChatBusy } from '../chat-activity.js';
import { getUpgradeRun } from '../upgrade-job.js';
import { selfUpdateInFlight } from '../../lib/self-update.js';
import { isPhoneSocket } from '../phone-origin.js';

/**
 * LEGACY capability list, kept only so OLDER dashboard bundles (which compare
 * against it) don't false-positive their stale-server banner against a new
 * server. Version skew is now detected by the `version` field below — an exact
 * bundle↔server version handshake — plus the server-side version-drift watch
 * that exits an upgraded-under server outright (lifecycle.ts). Do NOT extend
 * this list for new routes; it proved unmaintainable (the tasks.token routes
 * shipped in v0.10.0 without an entry, so the banner never fired and users hit
 * raw "No route" errors).
 */
const CAPABILITIES = [
  'tasks.members',
  'tasks.delete',
  'tasks.sync',
  'tasks.sync-status',
  'tasks.sync-test',
  'config.task-backend',
  'tasks.containers',
  'tasks.provision',
  'tasks.token',
  'tasks.token-status',
];

export async function handleHealthGet(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (isPhoneSocket(req)) {
    // Mac mode's phone listener: public through the tunnel, so the build version only — no
    // context root, no capabilities, no nonce (the gate stamps the reachability probe value).
    sendJson(res, 200, { version: dreamcontextVersion() });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    contextRoot,
    capabilities: CAPABILITIES,
    // The version this PROCESS is running (not what's on disk) — the bundle
    // and ensure-dashboard compare it against their own to detect skew.
    version: dreamcontextVersion(),
    // Desktop self-heal: the newer on-disk version when an upgrade landed under
    // this running server (else null). The bundle uses it to auto-relaunch the
    // app onto the new version without any manual quit/reopen.
    upgradeReady: relaunchableUpgrade(getUpgradeReadyVersion()),
  });
}

/**
 * The relaunch quits the app, which reaps the server's whole process group: every chat process,
 * and the `upgrade --yes` job itself, still refreshing projects after npm already rewrote the
 * package.json the ready watch reads. So the upgrade is reported only while no in-app chat is
 * mid-turn AND no upgrade run (the badge's or the self-update's) is still going; the next health
 * poll after both settle brings it, and the relaunch countdown, back.
 */
export function relaunchableUpgrade(
  ready: string | null,
  busy: () => boolean = anyChatBusy,
  upgrading: () => boolean = () => getUpgradeRun()?.state === 'running' || selfUpdateInFlight(),
): string | null {
  if (!ready) return null;
  if (upgrading()) return null;
  return busy() ? null : ready;
}
