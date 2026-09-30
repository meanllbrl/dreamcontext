/**
 * Two owner requests of 2026-09-28 for the dreamcontext Assistant:
 *  - `look`: "şu ekranıma bak" — a screenshot of the owner's screen(s) the assistant can Read
 *    (`src/lib/assistant/screen.ts`), with the missing Screen Recording permission reported by
 *    name instead of as an empty success.
 *  - the server's live-instance registry (`relay.ts`) — the authoritative answer to "which
 *    window already holds this project?", so a command lands in the open tab, not a new window.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureScreens, pruneScreens, KEEP_MS, SCREEN_PRIVACY_PANE, type Run } from '../../src/lib/assistant/screen.js';
import {
  registerWindow, releaseWindowNonce, windowLabelsForVault, bindCommandToWindow, _resetRelay,
} from '../../src/lib/assistant/relay.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dc-screens-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** A fake `screencapture` that "has" `displays` screens, plus a call log. */
function fakeRun(displays: number, fail?: { code: number; stderr: string }): { run: Run; calls: Array<[string, string[]]> } {
  const calls: Array<[string, string[]]> = [];
  const run: Run = async (file, args) => {
    calls.push([file, args]);
    if (file.endsWith('screencapture')) {
      if (fail) return fail;
      const paths = args.filter((a) => a.endsWith('.jpg'));
      paths.slice(0, displays).forEach((p) => writeFileSync(p, 'jpg'));
    }
    return { code: 0, stderr: '' };
  };
  return { run, calls };
}

describe('look — captureScreens', () => {
  it('every display: one shot per screen, each shrunk by sips, silent (-x)', async () => {
    const { run, calls } = fakeRun(2);
    const r = await captureScreens({ dir, run, now: 1000, platform: 'darwin' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.shots.map((s) => s.display)).toEqual([1, 2]);
    expect(r.shots.every((s) => existsSync(s.path))).toBe(true);
    expect(calls[0][0]).toBe('/usr/sbin/screencapture');
    expect(calls[0][1].slice(0, 3)).toEqual(['-x', '-t', 'jpg']);
    expect(calls.filter(([f]) => f === '/usr/bin/sips')).toHaveLength(2);
  });

  it('--display 2: only that screen (-D 2)', async () => {
    const { run, calls } = fakeRun(1);
    const r = await captureScreens({ dir, run, display: 2, now: 1000, platform: 'darwin' });
    expect(r.ok && r.shots.map((s) => s.display)).toEqual([2]);
    expect(calls[0][1]).toContain('-D');
    expect(calls[0][1][calls[0][1].indexOf('-D') + 1]).toBe('2');
  });

  it('no Screen Recording permission → named screen_permission, the Privacy pane is opened, nothing claimed', async () => {
    const { run, calls } = fakeRun(0, { code: 1, stderr: 'could not create image from display\n' });
    const r = await captureScreens({ dir, run, platform: 'darwin' });
    expect(r).toMatchObject({ ok: false, error: 'screen_permission' });
    expect(calls).toContainEqual(['/usr/bin/open', [SCREEN_PRIVACY_PANE]]);
  });

  it('another failure is capture_failed with the tool\'s own words', async () => {
    const { run } = fakeRun(0, { code: 2, stderr: 'something else' });
    const r = await captureScreens({ dir, run, platform: 'darwin' });
    expect(r).toEqual({ ok: false, error: 'capture_failed', message: 'something else' });
  });

  it('not macOS → unsupported, nothing runs', async () => {
    const { run, calls } = fakeRun(1);
    const r = await captureScreens({ dir, run, platform: 'linux' });
    expect(r).toMatchObject({ ok: false, error: 'unsupported' });
    expect(calls).toEqual([]);
  });

  it('a screenshot of the owner\'s desktop does not outlive KEEP_MS', () => {
    const old = join(dir, 'screen-1-1.jpg');
    const fresh = join(dir, 'screen-2-1.jpg');
    writeFileSync(old, 'x');
    writeFileSync(fresh, 'x');
    const now = Date.now();
    const past = (now - KEEP_MS - 60_000) / 1000;
    utimesSync(old, past, past);
    pruneScreens(dir, now);
    expect(readdirSync(dir)).toEqual(['screen-2-1.jpg']);
  });
});

describe('the server knows which window holds a project', () => {
  beforeEach(() => _resetRelay());

  it('every window with a live instance of the vault, newest first, each once', () => {
    registerWindow('acme', 'win-a', 'p1');
    registerWindow('other', 'win-b', 'p2');
    registerWindow('acme', 'win-c', 'p3');
    registerWindow('acme', 'win-a', 'p1');
    expect(windowLabelsForVault('acme')).toEqual(['win-a', 'win-c']);
    expect(windowLabelsForVault('nope')).toEqual([]);
  });

  it('a released instance (tab closed / went cold) is no longer named', () => {
    const n = registerWindow('acme', 'win-a', 'p1');
    expect(releaseWindowNonce(n)).toBe(true);
    expect(windowLabelsForVault('acme')).toEqual([]);
  });

  it('a reload of the same window drops the previous load\'s registrations', () => {
    registerWindow('acme', 'win-a', 'load-1');
    registerWindow('beta', 'win-a', 'load-1');
    registerWindow('beta', 'win-a', 'load-2');
    expect(windowLabelsForVault('acme')).toEqual([]);
    expect(windowLabelsForVault('beta')).toEqual(['win-a']);
  });

  it('bind still needs a registration for THAT vault in THAT window', () => {
    registerWindow('acme', 'win-a', 'p1');
    expect(bindCommandToWindow('no-such-id', 'acme', 'win-a')).toBe(false);
  });
});
