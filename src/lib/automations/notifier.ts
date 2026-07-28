import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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

/**
 * Sounds for the two outcomes. Names come from `/System/Library/Sounds`, which
 * every macOS install has — no audio asset to ship, nothing to go missing.
 * `Basso` is what macOS itself uses for errors, so a failed unattended run is
 * audibly different from a successful one without anyone reading a word.
 */
export const NOTIFY_SOUND_OK = 'Glass';
export const NOTIFY_SOUND_FAILED = 'Basso';

export function notifierAppPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'bin', 'dc-notify.app');
}

export function notifyQueueDir(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'bin', 'notify-queue');
}

/**
 * Where the applet reads the path to open when its banner is CLICKED.
 *
 * A `display notification` banner has no click handler — AppleScript cannot
 * attach one, and macOS's own behaviour when a banner is clicked is simply to
 * activate the posting app. That behaviour is the mechanism: the applet exits
 * as soon as it has drained the queue, so a click always LAUNCHES it fresh and
 * re-enters `on run` with an empty queue. An empty queue is therefore the
 * primary signal for "a human clicked a banner" — but NOT a sufficient one on
 * its own; see {@link notifyArmedPath} for the race it misreads and the second
 * condition that closes it.
 *
 * Only the most recent target is kept. Clicking yesterday's banner opens
 * today's document, which is a real (if minor) wrong answer, and the honest
 * trade for not maintaining a notification-id registry macOS gives us no way
 * to query.
 */
export function notifyClickTargetPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'bin', '.dc-notify-target');
}

/**
 * Epoch seconds of the most recent ENQUEUE, written by the poster just before
 * it launches the applet.
 *
 * This exists because "empty queue ⇒ a human clicked" is not quite true. Two
 * notifications close together race: poster A queues and launches, poster B
 * queues and launches, and if instance A's directory listing happens after B's
 * write, A drains BOTH — leaving instance B to start, find nothing, and
 * conclude it was clicked. It would then open a document nobody asked for,
 * which is a genuinely alarming thing for a background job to do.
 *
 * So the click branch additionally requires that no payload was enqueued in the
 * last {@link CLICK_ARM_DELAY_SECONDS}. The trade is explicit: clicking a
 * banner within that window does nothing (click again). Losing a click is a
 * shrug; opening a file unbidden is not.
 */
export function notifyArmedPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'bin', '.dc-notify-armed');
}

/** How long after an enqueue a launch is assumed to be the drain, not a click.
 *  Applet start-up is well under a second; a human reading a banner and
 *  deciding to press it is not. */
export const CLICK_ARM_DELAY_SECONDS = 3;

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
 * shelling out to one would add a dependency for no gain. Line 1 is the title,
 * line 2 is the sound name (empty ⇒ silent), LINE 3 is the click target (empty
 * ⇒ none), everything after is the body.
 *
 * The click branch at the end is what makes a banner worth pressing — see
 * {@link notifyClickTargetPath} for why an empty queue is a reliable proxy for
 * "a human clicked this".
 */
export function renderNotifierScript(queueDir: string, clickTargetPath: string, armedPath: string): string {
  const q = queueDir.endsWith('/') ? queueDir : `${queueDir}/`;
  return [
    'on run',
    `\tset qDir to ${JSON.stringify(q)}`,
    `\tset targetFile to ${JSON.stringify(clickTargetPath)}`,
    `\tset armedFile to ${JSON.stringify(armedPath)}`,
    '\tset posted to 0',
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
    '\t\t\t\tif (count of payloadLines) > 2 then',
    '\t\t\t\t\tset t to item 1 of payloadLines',
    '\t\t\t\t\tset snd to item 2 of payloadLines',
    '\t\t\t\t\tset tgt to item 3 of payloadLines',
    '\t\t\t\t\tset b to ""',
    '\t\t\t\t\tif (count of payloadLines) > 3 then',
    '\t\t\t\t\t\trepeat with i from 4 to count of payloadLines',
    '\t\t\t\t\t\t\tif b is "" then',
    '\t\t\t\t\t\t\t\tset b to item i of payloadLines',
    '\t\t\t\t\t\t\telse',
    '\t\t\t\t\t\t\t\tset b to b & return & item i of payloadLines',
    '\t\t\t\t\t\t\tend if',
    '\t\t\t\t\t\tend repeat',
    '\t\t\t\t\tend if',
    // Recorded BEFORE posting, so the banner the user is about to see is the
    // one whose target is armed.
    '\t\t\t\t\tif tgt is not "" then',
    '\t\t\t\t\t\ttry',
    '\t\t\t\t\t\t\tdo shell script "printf \'%s\' " & quoted form of tgt & " > " & quoted form of targetFile',
    '\t\t\t\t\t\tend try',
    '\t\t\t\t\tend if',
    // `sound name ""` is not silence, it is an invalid sound — the clause has
    // to be absent entirely, so this branches rather than interpolating.
    '\t\t\t\t\tif snd is "" then',
    '\t\t\t\t\t\tdisplay notification b with title t',
    '\t\t\t\t\telse',
    '\t\t\t\t\t\tdisplay notification b with title t sound name snd',
    '\t\t\t\t\tend if',
    '\t\t\t\t\tset posted to posted + 1',
    '\t\t\t\tend if',
    '\t\t\tend try',
    '\t\tend if',
    '\tend repeat',
    // Nothing to post ⇒ nobody asked us to announce anything ⇒ this launch is a
    // banner click. Open whatever the last announcement was about.
    '\tif posted is 0 then',
    '\t\tset armedAgo to 9999',
    '\t\ttry',
    '\t\t\tset nowSec to (do shell script "date +%s") as integer',
    '\t\t\tset armedSec to (do shell script "cat " & quoted form of armedFile) as integer',
    '\t\t\tset armedAgo to nowSec - armedSec',
    '\t\tend try',
    // A launch this soon after an enqueue is the drain half of a two-poster
    // race, not a click — see notifyArmedPath.
    `\t\tif armedAgo > ${CLICK_ARM_DELAY_SECONDS} then`,
    '\t\t\ttry',
    '\t\t\t\tset tgt to do shell script "cat " & quoted form of targetFile',
    '\t\t\t\tif tgt is not "" then',
    '\t\t\t\t\tdo shell script "open " & quoted form of tgt',
    '\t\t\t\tend if',
    '\t\t\tend try',
    '\t\tend if',
    '\tend if',
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
    writeFileSync(
      scriptPath,
      renderNotifierScript(queueDir, notifyClickTargetPath(home), notifyArmedPath(home)),
      'utf-8',
    );

    execFileSync('osacompile', ['-o', appPath, scriptPath], { stdio: 'ignore' });

    const plist = join(appPath, 'Contents', 'Info.plist');
    // Identity first: the bundle id is what the permission grant attaches to, so
    // it must stay STABLE across rebuilds or every upgrade would silently ask
    // the user to re-allow notifications.
    plistSet(plist, 'Add', ':CFBundleIdentifier string ' + NOTIFIER_BUNDLE_ID);
    plistSet(plist, 'Set', ':CFBundleName dreamcontext');
    // Stamp WHAT was compiled, so `install --check` can answer "is this applet
    // what today's CLI would generate?" — see NotifierState.scriptCurrent.
    plistSet(plist, 'Add', `:${SCRIPT_SHA_KEY} string ${scriptSha(home)}`);
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
  opts: { sound?: string; openImpl?: OpenImpl; openTarget?: string | null } = {},
): boolean {
  if (process.platform !== 'darwin') return false;
  const appPath = notifierAppPath(home);
  if (!existsSync(appPath)) return false;
  try {
    const queueDir = notifyQueueDir(home);
    mkdirSync(queueDir, { recursive: true });
    // Newline is the record separator, so it can appear in the title, the sound
    // name, or the click target — all three are single-line fields by
    // construction, and the target is a filesystem path (a newline in one would
    // be pathological, but stripping costs nothing and keeps the grammar
    // total).
    const oneLineTitle = title.replace(/[\r\n]+/g, ' ');
    const sound = (opts.sound ?? '').replace(/[\r\n]+/g, ' ');
    const target = (opts.openTarget ?? '').replace(/[\r\n]+/g, ' ');
    const payload = `${oneLineTitle}\n${sound}\n${target}\n${body}`;
    const name = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.txt`;
    writeFileSync(join(queueDir, name), payload, 'utf-8');
    // Armed BEFORE the launch, so the applet can tell its own drain from a
    // human's click even when two posters race (see notifyArmedPath).
    try {
      writeFileSync(notifyArmedPath(home), String(Math.floor(Date.now() / 1000)), 'utf-8');
    } catch { /* the guard degrades to "treat as click"; never block the notification */ }
    (opts.openImpl ?? realOpen)(appPath);
    return true;
  } catch {
    return false;
  }
}

/** Info.plist key holding the sha256 of the applescript the bundle was compiled
 *  from — the only way to ask a COMPILED applet "are you what this CLI would
 *  generate today?". `osadecompile` round-trips through the compiler's own
 *  formatting, so comparing decompiled text would report false drift forever. */
const SCRIPT_SHA_KEY = 'DCNotifyScriptSha256';

export interface NotifierState {
  supported: boolean;
  bundlePresent: boolean;
  bundlePath: string;
  iconPackaged: boolean;
  queuedPayloads: number;
  /**
   * Would rebuilding right now produce the same applet? The same contract
   * `wrapperCurrent`/`plistCurrent` carry for the dispatcher, and it was missing
   * here — which is a silent-staleness hole, not a cosmetic gap: the bundle is
   * rebuilt ONLY by `automations install`, so a CLI upgrade that changes the
   * applet leaves every existing machine running the old one, with nothing
   * anywhere reporting it. A notifier bug then survives its own fix.
   *
   * False for a bundle built before this key existed, which is correct: it
   * predates the check, so it genuinely is stale.
   */
  scriptCurrent: boolean;
}

/** sha256 of the applescript this CLI would generate for `home` right now. */
function scriptSha(home: string): string {
  const source = renderNotifierScript(notifyQueueDir(home), notifyClickTargetPath(home), notifyArmedPath(home));
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

/** The sha recorded in an installed bundle, or null when absent/unreadable
 *  (a bundle built before this key existed, or no bundle at all). */
function installedScriptSha(home: string): string | null {
  try {
    const out = execFileSync(
      '/usr/libexec/PlistBuddy',
      ['-c', `Print :${SCRIPT_SHA_KEY}`, join(notifierAppPath(home), 'Contents', 'Info.plist')],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** What `automations install --check` reports. */
export function inspectNotifier(home: string = homedir()): NotifierState {
  const bundlePath = notifierAppPath(home);
  let queuedPayloads = 0;
  try {
    queuedPayloads = readdirSync(notifyQueueDir(home)).filter((f) => f.endsWith('.txt')).length;
  } catch { /* no queue dir yet */ }
  const bundlePresent = existsSync(bundlePath);
  return {
    supported: process.platform === 'darwin',
    bundlePresent,
    bundlePath,
    iconPackaged: notifierIconPath() !== null,
    queuedPayloads,
    scriptCurrent: bundlePresent && installedScriptSha(home) === scriptSha(home),
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
  rmSync(notifyClickTargetPath(home), { force: true });
  rmSync(notifyArmedPath(home), { force: true });
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
