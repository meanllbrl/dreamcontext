import { execFile } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Full Disk Access for the desktop app: the one macOS permission that stops the
 * "dreamcontext would like to access data from other apps" dialog for good.
 *
 * WHY THIS AND NOT THE DIALOG'S ALLOW. Every process the app starts (a chat's Claude Code
 * session, its shell commands) is attributed to the app. When one of them reads another app's
 * container (`~/Library/Containers`, `~/Library/Group Containers`), sandboxd asks TCC
 * (kTCCServiceSystemPolicyAppData) on the app's behalf. macOS accepts that Allow but does not
 * reuse it for the next such request: measured on the owner's Mac 2026-11-19, Allow at 10:08
 * (authValue=2) and a new prompt at 12:54 for the identical identity (bundle com.dreamcontext.beta,
 * Developer ID team PP8PX5BB5P, same designated requirement), while Photos, Calendar and
 * Downloads in the same search were answered from their stored grants. The same is reported for
 * Claude Code, ChatGPT and Adobe apps. Full Disk Access is stored against the app's designated
 * requirement (bundle ID + team), so it survives updates and restarts and covers every child.
 *
 * The app never changes the setting: it reads whether it is on, and opens the Settings pane
 * where the owner turns it on.
 */

export const FULL_DISK_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

/**
 * Is Full Disk Access on for this process's responsible app? Read by opening the user's TCC
 * database: macOS refuses it (EPERM) without Full Disk Access and never prompts for it.
 * `null` off macOS, or when the answer cannot be told (no such file).
 */
export function hasFullDiskAccess(home: string, platform: NodeJS.Platform = process.platform): boolean | null {
  if (platform !== 'darwin') return null;
  try {
    closeSync(openSync(join(home, 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db'), 'r'));
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM' || code === 'EACCES' ? false : null;
  }
}

/** Open System Settings › Privacy & Security › Full Disk Access. */
export function openFullDiskAccessPane(): Promise<boolean> {
  return new Promise((done) => {
    execFile('/usr/bin/open', [FULL_DISK_PANE], { timeout: 10_000 }, (err) => done(!err));
  });
}
