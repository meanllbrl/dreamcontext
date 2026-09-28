import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `look` — the Assistant sees the owner's screen, ONLY when the owner asks it to.
 *
 * macOS `screencapture` writes one file per display it is handed a path for, so the capture
 * is given {@link MAX_DISPLAYS} paths and whatever exists afterwards is the set of screens.
 * Each shot is then shrunk with `sips` to {@link MAX_EDGE_PX} on its long edge: a 5K display
 * is ~15 MB of PNG, and the model downsamples far below that anyway.
 *
 * PERMISSION. The capture runs inside the desktop app's process tree, so macOS asks for
 * Screen Recording on behalf of the app. Without it `screencapture` exits non-zero with
 * "could not create image from display" and writes nothing — that is reported as
 * `screen_permission`, never as an empty success, and the Privacy pane is opened for the
 * owner so the fix is one click away.
 *
 * Shots live in the hidden vault's `tmp/screens/` and are pruned after {@link KEEP_MS}: a
 * screenshot of the owner's desktop is the most sensitive file this feature writes, so it
 * does not outlive the conversation that asked for it.
 */

export const MAX_DISPLAYS = 4;
export const MAX_EDGE_PX = 1920;
export const KEEP_MS = 30 * 60_000;

export const SCREEN_PRIVACY_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

export interface ScreenShot {
  /** 1 = the main display, then the others in the order macOS lists them. */
  display: number;
  path: string;
}

export type CaptureResult =
  | { ok: true; shots: ScreenShot[] }
  | { ok: false; error: 'screen_permission' | 'unsupported' | 'capture_failed'; message: string };

/** One external command. Injectable so the tests never touch the real screen. */
export type Run = (file: string, args: string[]) => Promise<{ code: number; stderr: string }>;

const realRun: Run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { timeout: 20_000 }, (err, _stdout, stderr) => {
    const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
    resolve({ code, stderr: String(stderr ?? '') });
  });
});

/** Drop shots older than {@link KEEP_MS}. Best effort: a file that cannot be read is left. */
export function pruneScreens(dir: string, now = Date.now()): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      if (now - statSync(p).mtimeMs > KEEP_MS) unlinkSync(p);
    } catch { /* raced with another prune */ }
  }
}

export async function captureScreens(opts: {
  dir: string;
  /** Only this display (1 = main). Omitted: every display. */
  display?: number;
  now?: number;
  run?: Run;
  platform?: NodeJS.Platform;
}): Promise<CaptureResult> {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin') return { ok: false, error: 'unsupported', message: 'Looking at the screen works on macOS only.' };
  const run = opts.run ?? realRun;
  const now = opts.now ?? Date.now();
  mkdirSync(opts.dir, { recursive: true });
  pruneScreens(opts.dir, now);

  const one = typeof opts.display === 'number' && Number.isInteger(opts.display) && opts.display >= 1 && opts.display <= 16
    ? opts.display : null;
  const count = one ? 1 : MAX_DISPLAYS;
  const paths = Array.from({ length: count }, (_, i) => join(opts.dir, `screen-${now}-${one ?? i + 1}.jpg`));
  const args = ['-x', '-t', 'jpg', ...(one ? ['-D', String(one)] : []), ...paths];
  const cap = await run('/usr/sbin/screencapture', args);
  const made = paths.filter((p) => existsSync(p));
  if (cap.code !== 0 || made.length === 0) {
    if (/could not create image/i.test(cap.stderr)) {
      await run('/usr/bin/open', [SCREEN_PRIVACY_PANE]);
      return {
        ok: false,
        error: 'screen_permission',
        message: 'macOS has not allowed dreamcontext to see the screen. Turn dreamcontext on in System Settings, Privacy & Security, Screen & System Audio Recording (opened for you), then quit and reopen the app.',
      };
    }
    return { ok: false, error: 'capture_failed', message: cap.stderr.trim().slice(0, 200) || `screencapture exited ${cap.code}` };
  }
  for (const p of made) await run('/usr/bin/sips', ['-Z', String(MAX_EDGE_PX), p]);
  return {
    ok: true,
    shots: made.map((path) => ({ display: Number(/-(\d+)\.jpg$/.exec(path)?.[1] ?? 1), path })),
  };
}
