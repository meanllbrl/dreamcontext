import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DESKTOP_BUNDLE_ID,
  __setLaunchTokenForTest,
  currentLaunchToken,
  desktopServerFileGate,
  desktopServerFilePath,
  launchTokenMatches,
  readDesktopServerFile,
  removeDesktopServerFile,
  shellBundleId,
  writeDesktopServerFile,
} from '../../src/server/desktop-server-file.js';
import { publishDesktopServer } from '../../src/server/lifecycle.js';

/**
 * ~/.dreamcontext/desktop-server.json: how a dreamcontext App window finds the desktop
 * server (dreamcontext-apps plan r19, "Kontrat"). Only the app-owned server writes it; a
 * second server never deletes the live one's record.
 */

const homes: string[] = [];
function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'dc-dsf-'));
  homes.push(h);
  return h;
}
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  __setLaunchTokenForTest(null);
});

const DESKTOP = { DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_PARENT_PID: '4242' } as NodeJS.ProcessEnv;

describe('the write gate', () => {
  it('writes only from the app-owned desktop server on macOS', () => {
    expect(desktopServerFileGate(DESKTOP, 4242, 'darwin')).toBeNull();
    expect(desktopServerFileGate({}, 4242, 'darwin')).toMatch(/not the desktop app/);
    // A builder- or verify-launched dashboard inherits DREAMCONTEXT_DESKTOP=1, not the parent.
    expect(desktopServerFileGate(DESKTOP, 999, 'darwin')).toMatch(/ppid/);
    expect(desktopServerFileGate({ DREAMCONTEXT_DESKTOP: '1' }, 1, 'darwin')).toMatch(/ppid/);
    expect(desktopServerFileGate(DESKTOP, 4242, 'win32')).toMatch(/macOS/);
  });

  it('a gated-off server writes nothing', () => {
    const h = home();
    const r = writeDesktopServerFile({ port: 4173, home: h, env: DESKTOP, ppid: 1, platform: 'darwin' });
    expect(r.written).toBe(false);
    expect(existsSync(desktopServerFilePath(h))).toBe(false);
    expect(currentLaunchToken()).toBeNull();
  });
});

describe('the record', () => {
  it('is 0600 JSON with a fresh token per boot and the shell bundle id', () => {
    const h = home();
    const a = writeDesktopServerFile({ port: 4173, home: h, env: DESKTOP, ppid: 4242, pid: 777, platform: 'darwin' });
    expect(a.written).toBe(true);
    const path = desktopServerFilePath(h);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const rec = JSON.parse(readFileSync(path, 'utf-8'));
    expect(rec).toEqual({ schema: 1, pid: 777, port: 4173, launchToken: expect.any(String), appBundleId: DESKTOP_BUNDLE_ID });
    expect(rec.launchToken.length).toBeGreaterThanOrEqual(43);
    expect(currentLaunchToken()).toBe(rec.launchToken);

    const b = writeDesktopServerFile({ port: 5000, home: h, env: DESKTOP, ppid: 4242, pid: 777, platform: 'darwin' });
    expect(b.written && b.token).not.toBe(rec.launchToken);
    expect(readDesktopServerFile(h)?.port).toBe(5000);
  });

  it('takes the shell bundle id from the shell, else the shipped constant', () => {
    expect(shellBundleId({ DREAMCONTEXT_APP_BUNDLE_ID: 'com.dreamcontext.dev' })).toBe('com.dreamcontext.dev');
    expect(shellBundleId({ DREAMCONTEXT_APP_BUNDLE_ID: 'x; rm -rf /' })).toBe(DESKTOP_BUNDLE_ID);
    expect(shellBundleId({})).toBe(DESKTOP_BUNDLE_ID);
  });

  it('replaces a planted symlink instead of writing through it', () => {
    const h = home();
    mkdirSync(join(h, '.dreamcontext'), { recursive: true });
    const victim = join(h, 'victim.txt');
    writeFileSync(victim, 'keep');
    symlinkSync(victim, desktopServerFilePath(h));
    const r = writeDesktopServerFile({ port: 4173, home: h, env: DESKTOP, ppid: 4242, platform: 'darwin' });
    expect(r.written).toBe(true);
    expect(readFileSync(victim, 'utf-8')).toBe('keep');
    expect(readDesktopServerFile(h)?.port).toBe(4173);
  });
});

describe('the launch token', () => {
  it('matches only the exact Bearer token', () => {
    const tok = 'a'.repeat(43);
    __setLaunchTokenForTest(tok);
    expect(launchTokenMatches(`Bearer ${tok}`)).toBe(true);
    expect(launchTokenMatches(`Bearer ${'b'.repeat(43)}`)).toBe(false);
    expect(launchTokenMatches(`Bearer ${tok}x`)).toBe(false);
    expect(launchTokenMatches(tok)).toBe(false);
    expect(launchTokenMatches(undefined)).toBe(false);
    __setLaunchTokenForTest(null);
    expect(launchTokenMatches(`Bearer ${tok}`)).toBe(false);
  });
});

describe('removal', () => {
  it('removes only a record naming this process, never another server\'s', () => {
    const h = home();
    writeDesktopServerFile({ port: 4173, home: h, env: DESKTOP, ppid: 4242, pid: 111, platform: 'darwin' });
    expect(removeDesktopServerFile({ home: h, pid: 222 })).toBe(false);
    expect(existsSync(desktopServerFilePath(h))).toBe(true);
    expect(removeDesktopServerFile({ home: h, pid: 111 })).toBe(true);
    expect(existsSync(desktopServerFilePath(h))).toBe(false);
    expect(removeDesktopServerFile({ home: h, pid: 111 })).toBe(false);
  });

  it('publishDesktopServer removes once, on shutdown or exit, and is a no-op when gated', () => {
    const calls: string[] = [];
    const stop = publishDesktopServer(4173, {
      write: () => ({ written: true, path: '/x', token: 't' }),
      remove: () => { calls.push('remove'); return true; },
    });
    stop();
    stop();
    expect(calls).toEqual(['remove']);
    const gated = publishDesktopServer(4173, {
      write: () => ({ written: false, reason: 'not the desktop app' }),
      remove: () => { calls.push('nope'); return true; },
    });
    gated();
    expect(calls).toEqual(['remove']);
  });
});

describe('drift', () => {
  it('DESKTOP_BUNDLE_ID is the shell identifier in tauri.conf.json', () => {
    const conf = JSON.parse(readFileSync(join(__dirname, '../../desktop/src-tauri/tauri.conf.json'), 'utf-8'));
    expect(conf.identifier).toBe(DESKTOP_BUNDLE_ID);
  });
});
