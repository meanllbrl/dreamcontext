import { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../middleware.js';
import { dreamcontextVersion } from '../../lib/manifest.js';
import { getUpgradeReadyVersion } from '../lifecycle.js';
import { isCloud } from '../cloud-mode.js';
import { buildFingerprint } from '../cloud-fingerprint.js';
import { carriesTransferAuth, handsfreeAuth, hasValidTransferProof } from '../handsfree-auth.js';
import { cloudServices } from './handsfree-cloud.js';

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
  if (isCloud()) {
    // Public on the forwarded port: build identity only. The trip fields need the transfer
    // proof (the cloud gate already put a fresh nonce on this response).
    const body: Record<string, unknown> = { version: dreamcontextVersion(), fingerprint: buildFingerprint() };
    if (carriesTransferAuth(req) && hasValidTransferProof(req)) {
      const rec = cloudServices().state.get();
      Object.assign(body, {
        phase: rec.phase,
        tripId: rec.tripId,
        laptopId: rec.laptopId,
        epoch: rec.epoch,
        sealedEpoch: rec.sealedEpoch,
        verifierGeneration: handsfreeAuth().store.generation,
        supersededLaptopIds: rec.supersededLaptopIds,
      });
    }
    sendJson(res, 200, body);
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
    upgradeReady: getUpgradeReadyVersion(),
    // The build identity the hands-free cloud compares against (cloud-fingerprint.ts).
    fingerprint: buildFingerprint(),
  });
}
