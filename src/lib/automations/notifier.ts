import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findPackageDir } from '../catalog.js';

/**
 * Branded macOS notifications for automations.
 *
 * WHY THIS EXISTS, and why it is not just `osascript`. macOS binds a
 * notification's icon and name to the BUNDLE THAT POSTS IT. `osascript` always
 * posts as `com.apple.ScriptEditor2`, so every automation notification arrived
 * titled correctly but wearing Script Editor's icon, with no way to override it
 * — AppleScript's `display notification` has no icon parameter, by design.
 *
 * Three separate layers were each silently swallowing the branding, all of them
 * confirmed against the unified log rather than guessed at:
 *
 *  1. ATTRIBUTION. `osascript` is `com.apple.ScriptEditor2`. Nothing about the
 *     message can change that. The notification must come from a bundle we own.
 *  2. PERMISSION. A brand-new bundle has no notification authorisation, and an
 *     unauthorised notification is NOT an error: `usernoted` accepts it and
 *     files it away with `visibility: []`, so it lands in Notification Centre
 *     and never appears on screen. `osascript` still exits 0. This is why the
 *     feature looked broken rather than unpermitted, and it is why `install`
 *     primes the permission prompt instead of leaving it to chance.
 *  3. ICON PRECEDENCE. `osacompile` emits a bundle carrying BOTH
 *     `CFBundleIconFile` and `CFBundleIconName`, plus an `Assets.car`. The
 *     asset catalogue wins, so replacing `applet.icns` alone changes nothing —
 *     the default applet icon keeps rendering. `CFBundleIconName` has to be
 *     deleted and `Assets.car` removed for the icns to be consulted at all.
 *
 * The payload does NOT travel in argv. An applet launched through
 * LaunchServices receives a `run` Apple Event, not command-line arguments, so
 * `open -a app --args …` leaves `argv` empty; the script then fails on a
 * missing item and sits on an invisible error dialog forever. That is the whole
 * explanation for a notifier that both hung and delivered nothing. Messages go
 * through a queue directory instead, which also means two automations finishing
 * in the same instant both get announced rather than one overwriting the other.
 */

export const NOTIFIER_BUNDLE_ID = 'com.dreamcontext.notify';
const MAX_QUEUE_DRAIN = 20;

export function notifierAppPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'bin', 'dc-notify.app');
}

export function notifyQueueDir(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'bin', 'notify-queue');
}

/** The packaged icon, or null when running from a checkout that lacks it. */
export function notifierIconPath(): string | null {
  const dir = findPackageDir('assets');
  if (!dir) return null;
  const icns = join(dir, 'notify-icon.icns');
  return existsSync(icns) ? icns : null;
}

/**
 * The applet source. Reads the queue with `do shell script` rather than
 * AppleScript file APIs (far less to get wrong), caps the drain so a stuck
 * queue can never turn into an unbounded notification storm, and deletes each
 * payload BEFORE posting it: a crash mid-run then loses one notification
 * instead of replaying it on every subsequent launch.
 *
 * Payload format is deliberately not JSON — AppleScript has no JSON parser, and
 * shelling out to one would add a dependency for no gain. First line is the
 * title, every remaining line is the body.
 */
export function renderNotifierScript(queueDir: string): string {
  const q = queueDir.endsWith('/') ? queueDir : `${queueDir}/`;
  return [
    'on run',
    `\tset qDir to ${JSON.stringify(q)}`,
    '\tset fileList to {}',
    '\ttry',
    `\t\tset fileList to paragraphs of (do shell script "ls -1 " & quoted form of qDir & " 2>/dev/null | head -${MAX_QUEUE_DRAIN}")`,
    '\tend try',
    '\trepeat with f in fileList',
    '\t\tset fname to f as string',
    '\t\tif fname is not "" then',
    '\t\t\ttry',
    '\t\t\t\tset p to qDir & fname',
    '\t\t\t\tset raw to do shell script "cat " & quoted form of p',
    '\t\t\t\tdo shell script "rm -f " & quoted form of p',
    '\t\t\t\tset payloadLines to paragraphs of raw',
    '\t\t\t\tif (count of payloadLines) > 0 then',
    '\t\t\t\t\tset t to item 1 of payloadLines',
    '\t\t\t\t\tset b to ""',
    '\t\t\t\t\tif (count of payloadLines) > 1 then',
    '\t\t\t\t\t\trepeat with i from 2 to count of payloadLines',
    '\t\t\t\t\t\t\tif b is "" then',
    '\t\t\t\t\t\t\t\tset b to item i of payloadLines',
    '\t\t\t\t\t\t\telse',
    '\t\t\t\t\t\t\t\tset b to b & return & item i of payloadLines',
    '\t\t\t\t\t\t\tend if',
    '\t\t\t\t\t\tend repeat',
    '\t\t\t\t\tend if',
    '\t\t\t\t\tdisplay notification b with title t',
    '\t\t\t\tend if',
    '\t\t\tend try',
    '\t\tend if',
    '\tend repeat',
    'end run',
    '',
  ].join('\n');
}

export interface BuildNotifierResult {
  built: boolean;
  path: string;
  /** Why the build was skipped or failed. null on success. */
  reason: string | null;
}

/**
 * Create (or replace) the notifier bundle. Idempotent — always rebuilds from
 * source rather than patching in place, so a half-modified bundle from an
 * interrupted earlier run can never survive.
 */
/**
 * @param opts.register  Announce the bundle to LaunchServices. Defaults true.
 *   Tests MUST pass false: they build under the production bundle id in a temp
 *   directory that is then deleted, and registering that would leave
 *   LaunchServices resolving `com.dreamcontext.notify` to a path that no longer
 *   exists — corrupting the developer's own working install from a unit test.
 *   `open(1)` registers on demand anyway, so this is a warm-up, not a
 *   requirement.
 */
export function buildNotifierApp(
  home: string = homedir(),
  opts: { register?: boolean } = {},
): BuildNotifierResult {
  const appPath = notifierAppPath(home);
  if (process.platform !== 'darwin') {
    return { built: false, path: appPath, reason: 'branded notifications are macOS-only' };
  }
  const icns = notifierIconPath();
  if (!icns) {
    return { built: false, path: appPath, reason: 'assets/notify-icon.icns not found in this install' };
  }

  const queueDir = notifyQueueDir(home);
  const scriptPath = join(home, '.dreamcontext', 'bin', '.dc-notify.applescript');
  try {
    mkdirSync(join(home, '.dreamcontext', 'bin'), { recursive: true });
    mkdirSync(queueDir, { recursive: true });
    rmSync(appPath, { recursive: true, force: true });
    writeFileSync(scriptPath, renderNotifierScript(queueDir), 'utf-8');

    execFileSync('osacompile', ['-o', appPath, scriptPath], { stdio: 'ignore' });

    const plist = join(appPath, 'Contents', 'Info.plist');
    // Identity first: the bundle id is what the permission grant attaches to, so
    // it must stay STABLE across rebuilds or every upgrade would silently ask
    // the user to re-allow notifications.
    plistSet(plist, 'Add', ':CFBundleIdentifier string ' + NOTIFIER_BUNDLE_ID);
    plistSet(plist, 'Set', ':CFBundleName dreamcontext');
    // Layer 3 from the header comment. Both of these are required; doing only
    // one leaves the default applet icon in place.
    plistSet(plist, 'Delete', ':CFBundleIconName');
    rmSync(join(appPath, 'Contents', 'Resources', 'Assets.car'), { force: true });
    copyFileSync(icns, join(appPath, 'Contents', 'Resources', 'applet.icns'));

    // Editing bundle contents invalidates osacompile's signature; re-sign adhoc
    // or LaunchServices may refuse to launch it.
    try { execFileSync('codesign', ['--force', '--deep', '-s', '-', appPath], { stdio: 'ignore' }); } catch { /* adhoc signing is best-effort */ }
    try { execFileSync('/usr/bin/touch', [appPath], { stdio: 'ignore' }); } catch { /* cache hint only */ }
    if (opts.register !== false) {
      try {
        execFileSync(
          '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
          ['-f', appPath],
          { stdio: 'ignore' },
        );
      } catch { /* registration is a hint; open(1) registers on demand too */ }
    }

    try { unlinkSync(scriptPath); } catch { /* leftover source is harmless */ }
    return { built: existsSync(appPath), path: appPath, reason: existsSync(appPath) ? null : 'osacompile produced no bundle' };
  } catch (err) {
    return { built: false, path: appPath, reason: (err as Error).message };
  }
}

/**
 * Post through the branded bundle. Returns false when the bundle is absent or
 * the launch could not even be attempted, so callers can fall back rather than
 * losing the notification. Deliberately does NOT build the bundle on demand:
 * this runs on the completion path of every automation, and silently doing a
 * multi-step bundle build there would put `osacompile` and `codesign` in the
 * way of a run finishing.
 */
export type OpenImpl = (appPath: string) => void;

const realOpen: OpenImpl = (appPath) => {
  // `-g` keeps the applet from stealing focus; without it every completed
  // automation would pull the user out of whatever they were doing.
  spawn('open', ['-g', '-a', appPath], { stdio: 'ignore', detached: true })
    .on('error', () => { /* best-effort; the payload stays queued for the next post */ });
};

export function notifyViaBundle(
  title: string,
  body: string,
  home: string = homedir(),
  openImpl: OpenImpl = realOpen,
): boolean {
  if (process.platform !== 'darwin') return false;
  const appPath = notifierAppPath(home);
  if (!existsSync(appPath)) return false;
  try {
    const queueDir = notifyQueueDir(home);
    mkdirSync(queueDir, { recursive: true });
    // Newline is the record separator, so it cannot appear in the title.
    const oneLineTitle = title.replace(/[\r\n]+/g, ' ');
    const payload = `${oneLineTitle}\n${body}`;
    const name = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.txt`;
    writeFileSync(join(queueDir, name), payload, 'utf-8');
    openImpl(appPath);
    return true;
  } catch {
    return false;
  }
}

export interface NotifierState {
  supported: boolean;
  bundlePresent: boolean;
  bundlePath: string;
  iconPackaged: boolean;
  queuedPayloads: number;
}

/** What `automations install --check` reports. */
export function inspectNotifier(home: string = homedir()): NotifierState {
  const bundlePath = notifierAppPath(home);
  let queuedPayloads = 0;
  try {
    queuedPayloads = readdirSync(notifyQueueDir(home)).filter((f) => f.endsWith('.txt')).length;
  } catch { /* no queue dir yet */ }
  return {
    supported: process.platform === 'darwin',
    bundlePresent: existsSync(bundlePath),
    bundlePath,
    iconPackaged: notifierIconPath() !== null,
    queuedPayloads,
  };
}

/**
 * Remove the bundle and any undrained payloads. Symmetric with
 * {@link buildNotifierApp}, which `install` calls — without this, `uninstall`
 * would leave an orphaned app bundle behind AND a "dreamcontext" entry in the
 * user's System Settings notification list with nothing on disk to explain it.
 *
 * The macOS permission GRANT itself is not removable from here; it lives in a
 * container only the user can edit. Reported honestly rather than pretended
 * away — see the note `uninstall` prints.
 */
export function removeNotifierApp(home: string = homedir()): { removedBundle: boolean; removedPayloads: number } {
  const appPath = notifierAppPath(home);
  const existed = existsSync(appPath);
  let removedPayloads = 0;
  try {
    const queueDir = notifyQueueDir(home);
    for (const f of readdirSync(queueDir)) {
      if (f.endsWith('.txt')) { rmSync(join(queueDir, f), { force: true }); removedPayloads += 1; }
    }
    rmSync(queueDir, { recursive: true, force: true });
  } catch { /* no queue dir */ }
  rmSync(appPath, { recursive: true, force: true });
  return { removedBundle: existed, removedPayloads };
}

function plistSet(plist: string, verb: 'Add' | 'Set' | 'Delete', expr: string): void {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `${verb} ${expr}`, plist], { stdio: 'ignore' });
  } catch {
    // Add-on-existing and Delete-on-missing both exit non-zero and both are
    // fine: the desired end state is what matters, not which verb got there.
  }
}
