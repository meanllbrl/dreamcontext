/**
 * The hands-free phone's one-tap consent to see ONE media file outside the project (task
 * hands-free-phone-shows-every-picture…, D1c).
 *
 * Deliberately not the desktop's grant file (`state/.file-grants.json`): that file is the owner's
 * consent for the Mac's own screen, it can point anywhere, and in a team brain it can arrive from
 * a teammate. A phone grant is held in MEMORY, per device (`deviceIdHash`), one real file path at
 * a time, at most {@link MAX_PHONE_GRANTS} per device (oldest out). It never outlives the device's
 * session: every sign-in change (logout, revoke, revoke-all, a password change, an eviction)
 * prunes the devices that are no longer signed in, and Mac mode starting or stopping clears all.
 */

import { macHandsfreeAuth, onDeviceSessionsChanged } from './handsfree-auth.js';
import { macExposedEpoch } from './phone-origin.js';

export const MAX_PHONE_GRANTS = 200;

const grants = new Map<string, string[]>();
/** The Mac-mode run the grants belong to: a start or stop since then voids them all. */
let grantsEpoch = -1;

function current(): Map<string, string[]> {
  const e = macExposedEpoch();
  if (e !== grantsEpoch) { grants.clear(); grantsEpoch = e; }
  return grants;
}
let hooked = false;

function hookPrune(): void {
  if (hooked) return;
  hooked = true;
  onDeviceSessionsChanged(() => {
    try {
      const store = macHandsfreeAuth().store;
      prunePhoneFileGrants((h) => store.isValidDeviceHash(h));
    } catch {
      // Cannot tell who is still signed in: fail closed, nobody keeps a grant.
      grants.clear();
    }
  });
}

/** Record that `device` may see the media file at `realPath`. */
export function addPhoneFileGrant(device: string, realPath: string): void {
  hookPrune();
  const g = current();
  const list = (g.get(device) ?? []).filter((p) => p !== realPath);
  list.push(realPath);
  g.set(device, list.slice(-MAX_PHONE_GRANTS));
}

export function hasPhoneFileGrant(device: string | null, realPath: string): boolean {
  return !!device && (current().get(device)?.includes(realPath) ?? false);
}

/** Drop every device `valid` no longer accepts. */
export function prunePhoneFileGrants(valid: (device: string) => boolean): void {
  for (const d of [...grants.keys()]) if (!valid(d)) grants.delete(d);
}

/** Forget every phone grant (Mac mode started or stopped; tests). */
export function clearPhoneFileGrants(): void {
  grants.clear();
}
