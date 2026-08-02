import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import {
  NOTIFIER_BUNDLE_ID,
  buildNotifierApp,
  inspectNotifier,
  notifierAppPath,
  notifierIconPath,
  notifyQueueDir,
  notifyViaBundle,
  removeNotifierApp,
  renderNotifierScript,
  CLICK_ARM_DELAY_SECONDS,
  notifyArmedPath,
} from '../../src/lib/automations/notifier.js';

/**
 * Branded-notifier tests. Every one of these takes an explicit `home`, so no
 * test in this file can reach the developer's real ~/.dreamcontext — the same
 * rule the rest of the automations suite follows, and the reason it matters
 * more here than usual: this module's whole job is writing an app bundle and
 * registering it with LaunchServices.
 *
 * The bundle BUILD is exercised on darwin only. `osacompile` does not exist
 * elsewhere, and skipping is honest where faking would not be.
 */

let home: string;

/**
 * EVERY call here injects this. An earlier version of these tests let the real
 * `open(1)` run, which asked LaunchServices to launch a bundle inside a temp
 * directory the test then deleted — filling the system log with genuine launch
 * failures. A unit test must not reach the window server to prove a file was
 * written. Also records what it was asked to open, so the "no side effect on
 * the absent path" case can be asserted rather than assumed.
 */
const opened: string[] = [];
const noOpen = (appPath: string): void => { opened.push(appPath); };

beforeEach(() => {
  opened.length = 0;
  home = mkdtempSync(join(tmpdir(), 'dc-notifier-home-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * PROOF OF ISOLATION (test-isolation-injectable-home). Green tests are not
 * evidence: a leak here writes an app bundle into the developer's real
 * ~/.dreamcontext/bin and registers it with LaunchServices, which no assertion
 * about temp directories would notice. Compares before/after rather than
 * asserting absence: the developer may legitimately have run
 * `automations install`, and a test must never fail because the feature under
 * test is in use.
 */
const realPlist = join(homedir(), '.dreamcontext', 'bin', 'dc-notify.app', 'Contents', 'Info.plist');
const realQueue = join(homedir(), '.dreamcontext', 'bin', 'notify-queue');
/** MTIME, not existence and not content. Two dead ends were tried first, and
 *  both report clean while the real bundle is being replaced: existence, because
 *  `buildNotifierApp` rebuilds IN PLACE on a machine that has already run
 *  `automations install`; and content, because the build is deterministic, so a
 *  rebuilt Info.plist is byte-identical to the one it replaced. The write time
 *  is the only thing that actually changes. `null` covers "not installed". */
const snap = (p: string): number | null => (existsSync(p) ? statSync(p).mtimeMs : null);
const realPlistBefore = snap(realPlist);
const realQueueBefore = existsSync(realQueue);

afterAll(() => {
  expect(
    snap(realPlist),
    'this suite rebuilt or removed the REAL notifier bundle — a home injection was missed',
  ).toBe(realPlistBefore);
  expect(
    existsSync(realQueue),
    'this suite touched the REAL notify queue — a home injection was missed',
  ).toBe(realQueueBefore);
});

describe('paths and packaging', () => {
  it('puts the bundle and queue under the injected home, never the real one', () => {
    expect(notifierAppPath(home)).toBe(join(home, '.dreamcontext', 'bin', 'dc-notify.app'));
    expect(notifyQueueDir(home)).toBe(join(home, '.dreamcontext', 'bin', 'notify-queue'));
  });

  it('finds the packaged icon — if this fails, published installs get no branding', () => {
    // Guards the `files` entry in package.json as much as the file itself: the
    // icon lives outside dist/, so an install that does not ship `assets/`
    // silently degrades every user to the generic system icon.
    const icns = notifierIconPath();
    expect(icns, 'assets/notify-icon.icns is missing — did package.json "files" lose "assets"?').not.toBeNull();
    expect(icns).toMatch(/notify-icon\.icns$/);
    expect(existsSync(icns as string)).toBe(true);
  });
});

describe('renderNotifierScript', () => {
  const script = renderNotifierScript('/tmp/some queue/', '/tmp/target', '/tmp/armed');

  it('reads the queue instead of argv — argv never arrives through LaunchServices', () => {
    // The bug this pins: `open -a app --args` does NOT populate an applet's
    // `on run argv`. The applet then failed on a missing item and hung forever
    // on an invisible error dialog, delivering nothing. Any reintroduction of
    // an argv-based payload has to fail here.
    expect(script).not.toMatch(/\bargv\b/);
    expect(script).toContain('on run');
    expect(script).toContain('display notification');
  });

  it('embeds the queue directory as a quoted literal, so spaces cannot split it', () => {
    expect(script).toContain('"/tmp/some queue/"');
  });

  it('normalises a directory given without a trailing slash', () => {
    expect(renderNotifierScript('/tmp/q', '/tmp/target', '/tmp/armed')).toContain('"/tmp/q/"');
  });

  it('opens the click target only when the queue was empty AND no enqueue just happened', () => {
    // Empty queue alone is NOT sufficient. Two posters racing (A drains B's
    // payload before B's own launch starts) leaves a launch with nothing to do
    // and no human involved — acting on that would open a document unbidden,
    // which is a genuinely alarming thing for a background job to do.
    expect(script).toContain('if posted is 0 then');
    expect(script).toContain('date +%s');
    expect(script).toContain('armedFile');
    expect(script).toContain(`if armedAgo > ${CLICK_ARM_DELAY_SECONDS} then`);
    // The open must sit INSIDE the armed guard, not merely after the count check.
    expect(script.indexOf(`if armedAgo > ${CLICK_ARM_DELAY_SECONDS} then`))
      .toBeLessThan(script.indexOf('do shell script "open "'));
  });

  it('arms defensively — an unreadable stamp reads as "long ago", never as "just now"', () => {
    // A missing armed file must not swallow every click forever; it must
    // degrade to treating the launch as a click.
    expect(script).toContain('set armedAgo to 9999');
  });

  it('caps the drain, so a stuck queue cannot become a notification storm', () => {
    expect(script).toMatch(/head -\d+/);
  });

  it('omits the sound clause entirely when the sound line is empty', () => {
    // `sound name ""` is an INVALID sound, not silence — passing it fails the
    // whole notification. So the script must branch, not interpolate.
    expect(script).toContain('if snd is "" then');
    expect(script).toContain('display notification b with title t sound name snd');
    expect(script).toMatch(/display notification b with title t\n/); // the soundless branch
  });

  it('names no variable after an AppleScript element term', () => {
    // A real bug, and a nasty one. `set lines to paragraphs of raw` COMPILES
    // fine and fails only at run time with "Can't set every line to …", because
    // `lines` is a text element specifier. The failure landed AFTER the payload
    // had already been deleted and INSIDE a `try`, so the observable behaviour
    // was: queue drains, applet exits 0, no notification, no error, anywhere.
    // Only running the script with the `try` removed revealed it.
    //
    // These are the element terms this script is realistically tempted by. A
    // denylist is the right shape here: the alternative is executing the script
    // in the suite, which would fire a real notification onto the developer's
    // screen on every test run.
    const RESERVED = ['lines', 'text', 'words', 'characters', 'paragraphs', 'items', 'result'];
    for (const word of RESERVED) {
      expect(script, `"${word}" is an AppleScript element term — using it as a variable fails at RUN time only`)
        .not.toMatch(new RegExp(`\\bset\\s+${word}\\s+to\\b`));
    }
  });

  it('deletes each payload BEFORE posting it', () => {
    // Order matters: delete-then-post loses at most one notification on a
    // crash, post-then-delete replays it on every launch forever.
    const rmAt = script.indexOf('rm -f');
    const postAt = script.indexOf('display notification');
    expect(rmAt).toBeGreaterThan(-1);
    expect(rmAt).toBeLessThan(postAt);
  });
});

/* macOS-only: `notifyViaBundle` short-circuits off `process.platform !== 'darwin'`
   (notifier.ts:238/319), so on the ubuntu runner these asserted the queueing contract against
   the branch that deliberately does nothing — 5 of the 14 failures that have kept CI red on
   main since 2026-07-27. Same skipIf idiom as `buildNotifierApp` below. */
describe.skipIf(process.platform !== 'darwin')('notifyViaBundle', () => {
  it('returns false and writes NOTHING when the bundle is absent', () => {
    // The fallback contract. A caller that gets `false` must be free to use
    // osascript; queueing a payload no applet will ever drain would strand it.
    expect(notifyViaBundle('t', 'b', home, { openImpl: noOpen })).toBe(false);
    expect(existsSync(notifyQueueDir(home))).toBe(false);
    // Nothing queued AND nothing launched: the absent path must be inert, not
    // merely unsuccessful.
    expect(opened).toEqual([]);
  });

  it('queues title, sound, click target, then body — in that order', () => {
    mkdirSync(notifierAppPath(home), { recursive: true }); // stand-in for a built bundle
    expect(
      notifyViaBundle('dreamcontext', 'line one\nline two', home, {
        sound: 'Glass', openImpl: noOpen, openTarget: '/tmp/out/2026-07-27.md',
      }),
    ).toBe(true);
    const files = readdirSync(notifyQueueDir(home));
    expect(files).toHaveLength(1);
    const raw = readFileSync(join(notifyQueueDir(home), files[0]), 'utf-8');
    expect(raw.split('\n')[0]).toBe('dreamcontext');
    expect(raw.split('\n')[1]).toBe('Glass');
    expect(raw.split('\n')[2]).toBe('/tmp/out/2026-07-27.md');
    expect(raw.split('\n').slice(3).join('\n')).toBe('line one\nline two');
    // The payload alone announces nothing — the applet has to be launched to
    // drain it, so the launch is part of the contract, not an afterthought.
    expect(opened).toEqual([notifierAppPath(home)]);
  });

  it('leaves the sound AND target lines EMPTY when unused, never omits them', () => {
    // Both lines have to exist even when unused: the applet addresses the body
    // as "line 4 onward", so dropping a fixed line would silently shift the
    // first body line into it and lose it.
    mkdirSync(notifierAppPath(home), { recursive: true });
    notifyViaBundle('dreamcontext', 'body text', home, { openImpl: noOpen });
    const files = readdirSync(notifyQueueDir(home));
    const raw = readFileSync(join(notifyQueueDir(home), files[0]), 'utf-8');
    expect(raw.split('\n')[1]).toBe('');
    expect(raw.split('\n')[2]).toBe('');
    expect(raw.split('\n')[3]).toBe('body text');
  });

  it('flattens newlines in the TITLE and the SOUND — both are single-line fields', () => {
    mkdirSync(notifierAppPath(home), { recursive: true });
    notifyViaBundle('two\nlines', 'body', home, { sound: 'Gl\nass', openImpl: noOpen });
    const files = readdirSync(notifyQueueDir(home));
    const raw = readFileSync(join(notifyQueueDir(home), files[0]), 'utf-8');
    expect(raw.split('\n')[0]).toBe('two lines');
    expect(raw.split('\n')[1]).toBe('Gl ass');
    expect(raw.split('\n')[2]).toBe('');
    expect(raw.split('\n')[3]).toBe('body');
  });

  it('stamps the armed file before launching, so the applet can tell a drain from a click', () => {
    mkdirSync(notifierAppPath(home), { recursive: true });
    notifyViaBundle('t', 'b', home, { openImpl: noOpen });
    const stamped = Number(readFileSync(notifyArmedPath(home), 'utf-8'));
    expect(Number.isFinite(stamped)).toBe(true);
    expect(Math.abs(stamped - Math.floor(Date.now() / 1000))).toBeLessThan(5);
  });

  it('gives concurrent notifications distinct files — one must not overwrite the other', () => {
    // Two automations finishing in the same tick is ordinary, not exotic: the
    // dispatcher runs every due slug in one pass.
    mkdirSync(notifierAppPath(home), { recursive: true });
    notifyViaBundle('a', 'first', home, { openImpl: noOpen });
    notifyViaBundle('b', 'second', home, { openImpl: noOpen });
    expect(readdirSync(notifyQueueDir(home))).toHaveLength(2);
  });
});

describe('inspectNotifier', () => {
  it('reports absence without inventing a permission verdict', () => {
    const state = inspectNotifier(home);
    expect(state.bundlePresent).toBe(false);
    expect(state.queuedPayloads).toBe(0);
    // There is deliberately no `permitted` field. macOS files an unauthorised
    // notification silently instead of erroring, and the grant lives where this
    // process cannot read it — so any boolean here would be a guess presented
    // as a fact.
    expect(state).not.toHaveProperty('permitted');
  });

  it('counts undrained payloads', () => {
    mkdirSync(notifyQueueDir(home), { recursive: true });
    writeFileSync(join(notifyQueueDir(home), 'a.txt'), 'x\ny');
    writeFileSync(join(notifyQueueDir(home), 'b.txt'), 'x\ny');
    writeFileSync(join(notifyQueueDir(home), 'ignored.log'), 'not a payload');
    expect(inspectNotifier(home).queuedPayloads).toBe(2);
  });
});

describe('removeNotifierApp', () => {
  it('removes the bundle and drains the queue, and is safe to call twice', () => {
    mkdirSync(notifierAppPath(home), { recursive: true });
    mkdirSync(notifyQueueDir(home), { recursive: true });
    writeFileSync(join(notifyQueueDir(home), 'a.txt'), 'x\ny');

    const first = removeNotifierApp(home);
    expect(first.removedBundle).toBe(true);
    expect(first.removedPayloads).toBe(1);
    expect(existsSync(notifierAppPath(home))).toBe(false);

    const second = removeNotifierApp(home);
    expect(second.removedBundle).toBe(false);
    expect(second.removedPayloads).toBe(0);
  });
});

describe.skipIf(process.platform !== 'darwin')('buildNotifierApp (real osacompile)', () => {
  it('produces a bundle whose identity and ICON SOURCE are both correct', () => {
    const result = buildNotifierApp(home, { register: false });
    expect(result.reason).toBeNull();
    expect(result.built).toBe(true);

    const app = notifierAppPath(home);
    const plist = readFileSync(join(app, 'Contents', 'Info.plist'), 'utf-8');
    expect(plist).toContain(NOTIFIER_BUNDLE_ID);
    expect(plist).toContain('dreamcontext');

    // The layer that made the icon fix look like it had not worked: osacompile
    // ships CFBundleIconName + Assets.car, and the asset catalogue WINS over
    // CFBundleIconFile. Replacing applet.icns alone changed nothing on screen.
    expect(plist).not.toContain('CFBundleIconName');
    expect(existsSync(join(app, 'Contents', 'Resources', 'Assets.car'))).toBe(false);

    const icns = join(app, 'Contents', 'Resources', 'applet.icns');
    expect(existsSync(icns)).toBe(true);
    expect(readFileSync(icns)).toEqual(readFileSync(notifierIconPath() as string));
  });

  it('is idempotent — rebuilding keeps the SAME bundle id, so the permission grant survives', () => {
    buildNotifierApp(home, { register: false });
    const before = readFileSync(join(notifierAppPath(home), 'Contents', 'Info.plist'), 'utf-8');
    const again = buildNotifierApp(home, { register: false });
    expect(again.built).toBe(true);
    const after = readFileSync(join(notifierAppPath(home), 'Contents', 'Info.plist'), 'utf-8');
    // A changed id would silently re-prompt the user for notification
    // permission on every upgrade, which is the one thing an upgrade must not do.
    expect(after).toContain(NOTIFIER_BUNDLE_ID);
    expect(before).toContain(NOTIFIER_BUNDLE_ID);
  });

  it('leaves no compiled-source scratch file behind', () => {
    buildNotifierApp(home, { register: false });
    expect(existsSync(join(home, '.dreamcontext', 'bin', '.dc-notify.applescript'))).toBe(false);
  });

  it('after a build, notifyViaBundle queues rather than falling back', () => {
    buildNotifierApp(home, { register: false });
    expect(notifyViaBundle('dreamcontext', 'queued', home, { openImpl: noOpen })).toBe(true);
    expect(inspectNotifier(home).queuedPayloads).toBe(1);
  });
});
