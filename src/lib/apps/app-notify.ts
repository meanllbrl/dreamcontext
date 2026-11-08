import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { notifyViaBundle, NOTIFY_SOUND_OK } from '../automations/notifier.js';
import { recordNotification } from '../notification-log.js';
import { appBundlePath } from './bundle.js';

/**
 * A notification that comes out of a dreamcontext App wears the app, not dreamcontext.
 *
 * macOS binds a banner's icon to the bundle that POSTS it, and `display notification` has no icon
 * parameter (see notifier.ts). So the post leaves from the app's own bundle: its `app-runner`
 * has a one-shot notify mode (desktop/app-runner/src/notify.rs). `contentImage` was no answer:
 * it adds a picture on the far side and leaves the poster's icon where it was.
 *
 * dreamcontext's applet stays the fallback, so a banner is never lost to a bundle built by an
 * older runner, to an app that never opened a window, or to a post macOS refused.
 */

/** Mirrors `NOTIFY_FLAG` in desktop/app-runner/src/model.rs. */
export const RUNNER_NOTIFY_FLAG = '--dc-notify-1';
const POST_TIMEOUT_MS = 6_000;

/** /System/Library/Sounds on every macOS. */
export const APP_SOUNDS = ['Glass', 'Basso', 'Ping', 'Pop', 'Purr', 'Submarine', 'Tink', 'Hero', 'Funk', 'Blow', 'Bottle', 'Frog', 'Morse', 'Sosumi'] as const;
const SOUND_NAMES: ReadonlySet<string> = new Set(APP_SOUNDS);

export const APP_SOUND_HELP = `sound must be true, false, "default", "none" or one of: ${APP_SOUNDS.join(', ')}`;

/**
 * What `sound` asks for: the name to play, undefined for silence, null for a value nobody can
 * play. `true` and `default` are a real sound: with no name the notification stays silent.
 */
export function resolveAppSound(value: unknown): string | undefined | null {
  if (value === undefined || value === false || value === 'none') return undefined;
  if (value === true || value === 'default') return NOTIFY_SOUND_OK;
  return typeof value === 'string' && SOUND_NAMES.has(value) ? value : null;
}

const capable = new Map<string, boolean>();

/**
 * Does this bundle's runner know the notify mode? Read from the binary, because the flag cannot
 * be tried: a runner from before it ignores the argument and opens a window. A bundle keeps its
 * old runner until the next open with no window up.
 */
export function runnerCanNotify(bundlePath: string): boolean {
  const exe = join(bundlePath, 'Contents', 'MacOS', 'app-runner');
  try {
    const s = statSync(exe);
    const key = `${exe}\0${s.mtimeMs}\0${s.size}`;
    let known = capable.get(key);
    if (known === undefined) {
      known = readFileSync(exe).includes(RUNNER_NOTIFY_FLAG);
      capable.set(key, known);
    }
    return known;
  } catch {
    return false;
  }
}

/**
 * The server's own environment stops here. The runner sits in a folder the app's backend can
 * write, and the backend never gets the owner's tokens (ENV_ALLOW in supervisor.ts).
 */
export function runnerEnv(home: string): NodeJS.ProcessEnv {
  return { HOME: home, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' };
}

export type RunnerPost = (exe: string, payload: string, home: string) => Promise<boolean>;

const realRunnerPost: RunnerPost = (exe, payload, home) => new Promise((resolve) => {
  const child = execFile(exe, [RUNNER_NOTIFY_FLAG], { timeout: POST_TIMEOUT_MS, env: runnerEnv(home) }, (err) => resolve(!err));
  child.stdin?.on('error', () => { /* the exit code answers */ });
  child.stdin?.end(payload);
});

export interface AppNotification {
  title: string;
  body: string;
  rec: { vault: string; slug: string; hash: string };
  sound?: string;
  /** The history row's `dreamcontext://` link. */
  historyLink?: string | null;
  home?: string;
}

export interface AppNotifyDeps {
  platform?: NodeJS.Platform;
  canNotify?: (bundlePath: string) => boolean;
  post?: RunnerPost;
  fallback?: typeof notifyViaBundle;
}

/** `app`: from the app's bundle. `dreamcontext`: the fallback. null: no banner at all. */
export async function notifyFromApp(n: AppNotification, deps: AppNotifyDeps = {}): Promise<'app' | 'dreamcontext' | null> {
  const home = n.home ?? homedir();
  const bundle = appBundlePath(home, n.rec.slug, n.rec.hash);
  const app = { vault: n.rec.vault, slug: n.rec.slug };
  if ((deps.platform ?? process.platform) === 'darwin' && (deps.canNotify ?? runnerCanNotify)(bundle)) {
    const payload = JSON.stringify({ title: n.title, body: n.body, ...(n.sound ? { sound: n.sound } : {}) });
    if (await (deps.post ?? realRunnerPost)(join(bundle, 'Contents', 'MacOS', 'app-runner'), payload, home)) {
      recordNotification({ title: n.title.replace(/[\r\n]+/g, ' '), body: n.body, link: n.historyLink ?? null, file: bundle, app }, home);
      return 'app';
    }
  }
  const ok = (deps.fallback ?? notifyViaBundle)(n.title, n.body, home, { sound: n.sound, link: null, historyLink: n.historyLink ?? null, openTarget: bundle, historyApp: app });
  return ok ? 'dreamcontext' : null;
}
