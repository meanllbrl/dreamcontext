/**
 * The desktop app on Windows (src/lib/app-windows.ts, `doWindowsInstall` in app.ts), with win32
 * faked: the release, the download, the registry, the process list and the installer run are
 * all injected, so nothing here touches the machine or the network.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WIN_SETUP_ASSET, WIN_SILENT_INSTALL_ARGS, WIN_UNINSTALL_KEY, appUpdateNotice, downloadStagingRoot, downloadWindowsSetup,
  exeFromDisplayIcon, isReleaseDownloadUrl,
  isWindowsAppRunning, parseRegQuery, parseSha256File, pendingAppUpdate, readWindowsInstall, recordAppUpdateAvailable,
  runWindowsSetup, type RunSync,
} from '../../src/lib/app-windows.js';
import { doWindowsInstall, maybeTriggerAppUpdate, readAppManifest } from '../../src/cli/commands/app.js';

const REPO = 'meanllbrl/dreamcontext';
const URL_BASE = `https://github.com/${REPO}/releases/download/v0.35.0/`;
const BYTES = Buffer.from('MZ fake installer bytes');
const SHA = createHash('sha256').update(BYTES).digest('hex');

function release(over: { sum?: string | null; setupUrl?: string } = {}) {
  const assets = [{ name: WIN_SETUP_ASSET, browser_download_url: over.setupUrl ?? `${URL_BASE}${WIN_SETUP_ASSET}` }];
  if (over.sum !== null) assets.push({ name: `${WIN_SETUP_ASSET}.sha256`, browser_download_url: `${URL_BASE}${WIN_SETUP_ASSET}.sha256` });
  return { tag_name: 'v0.35.0', assets, sumText: over.sum ?? `${SHA}  ${WIN_SETUP_ASSET}\n` };
}

function fakeFetch(sumText: string): typeof fetch {
  return (async (url: string) => {
    const body = String(url).endsWith('.sha256') ? Buffer.from(sumText) : BYTES;
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  }) as unknown as typeof fetch;
}

let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'dc-app-win-')); });
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); process.exitCode = undefined; });

describe('downloadWindowsSetup — never an unverified installer', () => {
  it('downloads the installer and its .sha256 and verifies them', async () => {
    const r = release();
    const dl = await downloadWindowsSetup(r, { repo: REPO, fetchImpl: fakeFetch(r.sumText), tmpRoot: scratch });
    expect(dl?.version).toBe('0.35.0');
    expect(dl?.setupPath.endsWith(WIN_SETUP_ASSET)).toBe(true);
    expect(existsSync(dl!.setupPath)).toBe(true);
  });

  it('REFUSES a checksum mismatch and leaves nothing behind', async () => {
    const r = release({ sum: `${'0'.repeat(64)}  ${WIN_SETUP_ASSET}` });
    await expect(downloadWindowsSetup(r, { repo: REPO, fetchImpl: fakeFetch(r.sumText), tmpRoot: scratch }))
      .rejects.toThrow(/Checksum mismatch.*Nothing was installed/);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('REFUSES an empty or malformed .sha256', async () => {
    const r = release({ sum: 'not-a-digest' });
    await expect(downloadWindowsSetup(r, { repo: REPO, fetchImpl: fakeFetch(r.sumText), tmpRoot: scratch })).rejects.toThrow(/Checksum mismatch/);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('REFUSES a release without the .sha256 asset, before downloading anything', async () => {
    let fetched = 0;
    const r = release({ sum: null });
    const f = (async () => { fetched += 1; throw new Error('never'); }) as unknown as typeof fetch;
    await expect(downloadWindowsSetup(r, { repo: REPO, fetchImpl: f, tmpRoot: scratch })).rejects.toThrow(/missing .*\.sha256/);
    expect(fetched).toBe(0);
  });

  it('REFUSES an asset URL outside github.com/<repo>/releases/download', async () => {
    const r = release({ setupUrl: 'https://evil.example/setup.exe' });
    await expect(downloadWindowsSetup(r, { repo: REPO, fetchImpl: fakeFetch(r.sumText), tmpRoot: scratch })).rejects.toThrow(/does not come from/);
  });

  it('judges the asset URL after parsing, so a %2e%2e climb to another repo is refused', () => {
    expect(isReleaseDownloadUrl(`${URL_BASE}${WIN_SETUP_ASSET}`, REPO)).toBe(true);
    expect(isReleaseDownloadUrl(`https://github.com/${REPO}/releases/download/%2e%2e/%2e%2e/%2e%2e/%2e%2e/evil/repo/releases/download/v1/x.exe`, REPO)).toBe(false);
    expect(isReleaseDownloadUrl(`https://github.com/${REPO}/releases/download/../../../../evil/repo/x.exe`, REPO)).toBe(false);
    expect(isReleaseDownloadUrl(`http://github.com/${REPO}/releases/download/v1/x.exe`, REPO)).toBe(false);
    expect(isReleaseDownloadUrl(`https://github.com.evil.example/${REPO}/releases/download/v1/x.exe`, REPO)).toBe(false);
    expect(isReleaseDownloadUrl(`https://user@github.com/${REPO}/releases/download/v1/x.exe`, REPO)).toBe(false);
    expect(isReleaseDownloadUrl('not a url', REPO)).toBe(false);
  });

  it('stages downloads in the user\'s own profile, never %TEMP% (a shared C:\\Temp would let another user swap the file)', () => {
    expect(downloadStagingRoot('/home/me')).toBe(join('/home/me', '.dreamcontext', 'tmp'));
  });

  it('a release without a Windows installer is null, not an error', async () => {
    expect(await downloadWindowsSetup({ tag_name: 'v1.0.0', assets: [] }, { repo: REPO, tmpRoot: scratch })).toBeNull();
  });

  it('parseSha256File reads `<hex>  <name>` and a bare digest, nothing else', () => {
    expect(parseSha256File(`${SHA.toUpperCase()}  x.exe`)).toBe(SHA);
    expect(parseSha256File(SHA)).toBe(SHA);
    expect(parseSha256File('')).toBeNull();
    expect(parseSha256File('abc x.exe')).toBeNull();
  });
});

describe('runWindowsSetup — the silent per-user install', () => {
  it('runs the installer itself with /S and nothing else', () => {
    const calls: Array<[string, readonly string[]]> = [];
    runWindowsSetup('C:\\t\\setup.exe', (f, a) => { calls.push([f, a]); return { status: 0, stdout: '' }; });
    expect(calls).toEqual([['C:\\t\\setup.exe', ['/S']]]);
    expect(WIN_SILENT_INSTALL_ARGS).toEqual(['/S']);
  });

  it('throws on a non-zero exit or a hang', () => {
    expect(() => runWindowsSetup('s.exe', () => ({ status: 2, stdout: '' }))).toThrow(/exited with code 2/);
    expect(() => runWindowsSetup('s.exe', () => ({ status: null, stdout: '' }))).toThrow(/did not finish/);
  });
});

describe('readWindowsInstall — what NSIS recorded', () => {
  const env = { SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
  const exe = 'C:\\Users\\me\\AppData\\Local\\dreamcontext-beta\\dreamcontext-desktop.exe';
  const regOut = `\r\n${WIN_UNINSTALL_KEY}\r\n    DisplayName    REG_SZ    dreamcontext-beta\r\n    DisplayVersion    REG_SZ    0.34.5\r\n    DisplayIcon    REG_SZ    "${exe}",0\r\n`;

  it('parses reg query output and the DisplayIcon exe', () => {
    expect(parseRegQuery(regOut)).toMatchObject({ DisplayVersion: '0.34.5', DisplayName: 'dreamcontext-beta' });
    expect(exeFromDisplayIcon(`"${exe}",0`)).toBe(exe);
    expect(exeFromDisplayIcon(exe)).toBe(exe);
    expect(exeFromDisplayIcon('relative.exe')).toBeNull();
  });

  it('asks System32\\reg.exe about the per-user uninstall key', () => {
    const calls: Array<[string, readonly string[]]> = [];
    const run: RunSync = (f, a) => { calls.push([f, a]); return { status: 0, stdout: regOut }; };
    expect(readWindowsInstall({ run, env, exists: (p) => p === exe })).toEqual({ version: '0.34.5', exePath: exe });
    expect(calls).toEqual([['C:\\Windows\\System32\\reg.exe', ['query', WIN_UNINSTALL_KEY]]]);
  });

  it('falls back to the default per-user folder, and is null when nothing is installed', () => {
    const none: RunSync = () => ({ status: 1, stdout: '' });
    expect(readWindowsInstall({ run: none, env, exists: (p) => p === exe })).toEqual({ version: null, exePath: exe });
    expect(readWindowsInstall({ run: none, env, exists: () => false })).toBeNull();
  });

  it('isWindowsAppRunning matches the image name in tasklist CSV', () => {
    const yes: RunSync = () => ({ status: 0, stdout: '"dreamcontext-desktop.exe","4242","Console","1","80,000 K"\r\n' });
    const no: RunSync = () => ({ status: 0, stdout: 'INFO: No tasks are running which match the specified criteria.\r\n' });
    expect(isWindowsAppRunning(exe, yes, env)).toBe(true);
    expect(isWindowsAppRunning(exe, no, env)).toBe(false);
  });
});

describe('doWindowsInstall — app install / app update on win32', () => {
  const exe = 'C:\\Users\\me\\AppData\\Local\\dreamcontext-beta\\dreamcontext-desktop.exe';
  const rel = release();
  const base = (over: Record<string, unknown> = {}) => {
    const ran: string[] = [];
    let installed: { version: string | null; exePath: string | null } | null = null;
    const deps = {
      home: scratch,
      log: () => {},
      fetchRelease: async () => rel,
      download: (async () => {
        const setupPath = join(scratch, 'dl', WIN_SETUP_ASSET);
        return { setupPath, version: '0.35.0', workDir: join(scratch, 'dl') };
      }) as never,
      runSetup: (p: string) => { ran.push(p); installed = { version: '0.35.0', exePath: exe }; },
      readInstall: () => installed,
      isRunning: () => false,
      exists: () => true,
      ...over,
    };
    return { deps, ran, setInstalled: (v: typeof installed) => { installed = v; } };
  };

  it('a fresh install runs the verified installer and writes the manifest NSIS reported', async () => {
    const { deps, ran } = base();
    expect(await doWindowsInstall(undefined, { update: false, background: false }, deps)).toBe('installed');
    expect(ran).toEqual([join(scratch, 'dl', WIN_SETUP_ASSET)]);
    expect(readAppManifest(scratch)).toMatchObject({ version: '0.35.0', path: exe, source: 'github' });
    expect(process.exitCode).toBeUndefined();
  });

  it('a failed checksum aborts before anything runs, and exits non-zero', async () => {
    const { deps, ran } = base({ download: async () => { throw new Error('Checksum mismatch for x'); } });
    expect(await doWindowsInstall(undefined, { update: false, background: false }, deps)).toBe('failed');
    expect(ran).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(readAppManifest(scratch)).toBeNull();
  });

  it('update: an installed version that is current runs nothing', async () => {
    const { deps, ran, setInstalled } = base();
    setInstalled({ version: '0.35.0', exePath: exe });
    expect(await doWindowsInstall(undefined, { update: true, background: false }, deps)).toBe('current');
    expect(ran).toEqual([]);
  });

  it('update while the app is open: refused in the foreground, OFFERED in the background', async () => {
    const fg = base({ isRunning: () => true });
    fg.setInstalled({ version: '0.34.5', exePath: exe });
    expect(await doWindowsInstall(undefined, { update: true, background: false }, fg.deps)).toBe('failed');
    expect(fg.ran).toEqual([]);
    process.exitCode = undefined;

    const bg = base({ isRunning: () => true });
    bg.setInstalled({ version: '0.34.5', exePath: exe });
    expect(await doWindowsInstall(undefined, { update: true, background: true }, bg.deps)).toBe('offered');
    expect(bg.ran).toEqual([]);
    expect(pendingAppUpdate('0.34.5', scratch)).toBe('0.35.0');
    expect(appUpdateNotice('0.34.5', scratch)).toMatch(/0\.35\.0 is available \(installed: 0\.34\.5\).*dreamcontext app update/);
  });

  it('a successful update clears the offer', async () => {
    recordAppUpdateAvailable('0.35.0', scratch);
    const { deps, setInstalled } = base();
    setInstalled({ version: '0.34.5', exePath: exe });
    expect(await doWindowsInstall(undefined, { update: true, background: true }, deps)).toBe('installed');
    expect(pendingAppUpdate('0.34.5', scratch)).toBeNull();
  });

  it('--from runs that installer (no download), and refuses a path that is not an existing .exe', async () => {
    const local = join(scratch, 'my-setup.exe');
    writeFileSync(local, BYTES);
    const ok = base({ exists: existsSync, fetchRelease: async () => { throw new Error('never fetched'); } });
    expect(await doWindowsInstall(local, { update: false, background: false }, ok.deps)).toBe('installed');
    expect(ok.ran).toEqual([local]);
    expect(readAppManifest(scratch)?.source).toBe(local);

    const bad = base({ exists: existsSync });
    expect(await doWindowsInstall(join(scratch, 'missing.exe'), { update: false, background: false }, bad.deps)).toBe('failed');
    expect(await doWindowsInstall(join(scratch, 'x.zip'), { update: false, background: false }, bad.deps)).toBe('failed');
    expect(bad.ran).toEqual([]);
  });

  it('one install at a time: a held lock refuses in the foreground and stays quiet in the background', async () => {
    const { mkdirSync: mk, writeFileSync: wf } = await import('node:fs');
    mk(join(scratch, '.dreamcontext'), { recursive: true });
    // A live holder: this test process's own pid, written fresh.
    wf(join(scratch, '.dreamcontext', 'app-install.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }));
    const fg = base();
    expect(await doWindowsInstall(undefined, { update: false, background: false }, fg.deps)).toBe('failed');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    const bg = base();
    expect(await doWindowsInstall(undefined, { update: true, background: true }, bg.deps)).toBe('none');
    expect([...fg.ran, ...bg.ran]).toEqual([]);
  });

  it('releases the lock when done, so the next install runs', async () => {
    const a = base();
    expect(await doWindowsInstall(undefined, { update: false, background: false }, a.deps)).toBe('installed');
    expect(existsSync(join(scratch, '.dreamcontext', 'app-install.lock'))).toBe(false);
  });

  it('an installer that runs but leaves no app behind is a failure, with no manifest', async () => {
    const { deps } = base({ runSetup: () => {} });
    expect(await doWindowsInstall(undefined, { update: false, background: false }, deps)).toBe('failed');
    expect(readAppManifest(scratch)).toBeNull();
  });
});

describe('maybeTriggerAppUpdate on win32', () => {
  const manifest = { version: '0.34.5', path: 'C:\\x\\dreamcontext-desktop.exe', installedAt: 0, source: 'local' };

  it('fires the background update for an installed app', () => {
    let fired = 0;
    expect(maybeTriggerAppUpdate({}, { platform: 'win32', manifest, home: scratch, exists: () => true, spawner: () => { fired += 1; } })).toBe(true);
    expect(fired).toBe(1);
  });

  it('stays quiet when the exe is gone (uninstalled) or auto-update is off', () => {
    let fired = 0;
    const spawner = () => { fired += 1; };
    expect(maybeTriggerAppUpdate({}, { platform: 'win32', manifest, home: scratch, exists: () => false, spawner })).toBe(false);
    expect(maybeTriggerAppUpdate({ DREAMCONTEXT_APP_AUTO_UPDATE: '0' }, { platform: 'win32', manifest, home: scratch, exists: () => true, spawner })).toBe(false);
    expect(fired).toBe(0);
  });

  it('still does nothing on linux', () => {
    expect(maybeTriggerAppUpdate({}, { platform: 'linux', manifest, home: scratch, spawner: () => { throw new Error('never'); } })).toBe(false);
  });
});
