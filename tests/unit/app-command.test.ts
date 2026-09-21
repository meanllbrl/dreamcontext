import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  detectPlatform,
  appArtifactName,
  pickAssetForArch,
  versionFromTag,
  readAppManifest,
  writeAppManifest,
  validateAppBundle,
  materializeAppBundle,
  installAppBundle,
  readBundleVersion,
  appAutoUpdateEnabled,
  installDirFor,
  defaultInstallDir,
  appRunningIn,
  maybeTriggerAppUpdate,
  downloadLatestArtifact,
  APP_BUNDLE_NAME,
  type AppManifest,
} from '../../src/cli/commands/app.js';
import { createHash } from 'node:crypto';

const isDarwin = process.platform === 'darwin';

// ─── Pure helpers (run everywhere) ─────────────────────────────────────────────

describe('detectPlatform', () => {
  it('maps arm64 → aarch64 on darwin', () => {
    expect(detectPlatform('darwin', 'arm64')).toEqual({ os: 'darwin', arch: 'aarch64' });
  });
  it('maps x64 → x86_64', () => {
    expect(detectPlatform('darwin', 'x64')).toEqual({ os: 'darwin', arch: 'x86_64' });
  });
  it('classifies windows/linux/other', () => {
    expect(detectPlatform('win32', 'x64').os).toBe('win32');
    expect(detectPlatform('linux', 'arm64').os).toBe('linux');
    expect(detectPlatform('freebsd' as NodeJS.Platform, 'mips' as string)).toEqual({ os: 'other', arch: 'other' });
  });
});

describe('appArtifactName', () => {
  it('matches the Tauri bundle naming', () => {
    expect(appArtifactName('0.8.0', 'aarch64')).toBe('dreamcontext-beta_0.8.0_aarch64.app.tar.gz');
  });
});

describe('pickAssetForArch', () => {
  const assets = [
    'dreamcontext-beta_0.8.0_aarch64.app.tar.gz',
    'dreamcontext-beta_0.8.0_x86_64.app.tar.gz',
    'dreamcontext-beta_0.8.0_aarch64.dmg',
    'source.zip',
  ];
  it('picks the arch-matching .app.tar.gz', () => {
    expect(pickAssetForArch(assets, 'aarch64')).toBe('dreamcontext-beta_0.8.0_aarch64.app.tar.gz');
    expect(pickAssetForArch(assets, 'x86_64')).toBe('dreamcontext-beta_0.8.0_x86_64.app.tar.gz');
  });
  it('returns null when no app tarball matches', () => {
    expect(pickAssetForArch(['source.zip', 'x.dmg'], 'aarch64')).toBeNull();
    expect(pickAssetForArch(assets, 'other')).toBeNull();
  });
});

describe('versionFromTag', () => {
  it('strips a leading v', () => {
    expect(versionFromTag('v0.8.0')).toBe('0.8.0');
    expect(versionFromTag('0.8.0')).toBe('0.8.0');
  });
});

describe('app manifest round-trip', () => {
  let home: string;
  beforeEach(() => {
    home = join(tmpdir(), `dc-appman-${Math.random().toString(36).slice(2)}`);
    mkdirSync(home, { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('returns null when no manifest exists', () => {
    expect(readAppManifest(home)).toBeNull();
  });
  it('round-trips a manifest', () => {
    writeAppManifest({ version: '0.8.0', path: '/x/dreamcontext-beta.app', installedAt: 123, source: 'local' }, home);
    expect(readAppManifest(home)).toEqual({
      version: '0.8.0',
      path: '/x/dreamcontext-beta.app',
      installedAt: 123,
      source: 'local',
    });
  });
  it('returns null for a malformed manifest', () => {
    const p = join(home, '.dreamcontext');
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, 'app.json'), '{ broken', 'utf-8');
    expect(readAppManifest(home)).toBeNull();
  });
});

// ─── auto-update gate (pure) ───────────────────────────────────────────────────

describe('appAutoUpdateEnabled', () => {
  it('is on by default', () => {
    expect(appAutoUpdateEnabled({})).toBe(true);
  });
  it('opts out with DREAMCONTEXT_APP_AUTO_UPDATE=0', () => {
    expect(appAutoUpdateEnabled({ DREAMCONTEXT_APP_AUTO_UPDATE: '0' })).toBe(false);
  });
  it('is disabled by the master kill-switch', () => {
    expect(appAutoUpdateEnabled({ DREAMCONTEXT_VERSION_CHECK: '0' })).toBe(false);
  });
});

describe('maybeTriggerAppUpdate', () => {
  const installed: AppManifest = { version: '0.8.0', path: '/x/dreamcontext-beta.app', installedAt: 0, source: 'local' };

  it('does NOT trigger when the app is not installed', () => {
    let fired = false;
    const out = maybeTriggerAppUpdate({}, { spawner: () => { fired = true; }, manifest: null });
    expect(out).toBe(false);
    expect(fired).toBe(false);
  });

  it('does NOT trigger when opted out', () => {
    let fired = false;
    const out = maybeTriggerAppUpdate(
      { DREAMCONTEXT_APP_AUTO_UPDATE: '0' },
      { spawner: () => { fired = true; }, manifest: installed },
    );
    expect(out).toBe(false);
    expect(fired).toBe(false);
  });

  it.skipIf(!isDarwin)('triggers when installed + enabled (macOS)', () => {
    let fired = false;
    const out = maybeTriggerAppUpdate({}, { spawner: () => { fired = true; }, manifest: installed });
    expect(out).toBe(true);
    expect(fired).toBe(true);
  });
});

// ─── downloadLatestArtifact: checksum is mandatory (supply-chain) ──────────────

describe.skipIf(process.arch !== 'arm64')('downloadLatestArtifact checksum enforcement', () => {
  const tarball = Buffer.from('fake-app-tarball-bytes');
  const assetName = 'dreamcontext-beta_0.9.0_aarch64.app.tar.gz';
  const goodSum = createHash('sha256').update(tarball).digest('hex');

  function mockFetch(assets: Array<{ name: string; body: Buffer | string }>): typeof fetch {
    return (async (url: string) => {
      const u = String(url);
      if (u.endsWith('/releases/latest')) {
        return {
          ok: true,
          json: async () => ({
            tag_name: 'v0.9.0',
            assets: assets.map((a) => ({ name: a.name, browser_download_url: `https://x/${a.name}` })),
          }),
        } as unknown as Response;
      }
      const match = assets.find((a) => u.endsWith(`/${a.name}`));
      const body = match ? match.body : '';
      return {
        ok: true,
        arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(body)),
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it('REFUSES to install when no .sha256 asset is present', async () => {
    const fetchImpl = mockFetch([{ name: assetName, body: tarball }]);
    await expect(downloadLatestArtifact('owner/repo', fetchImpl)).rejects.toThrow(/missing.*sha256|unverified/i);
  });

  it('REJECTS on checksum mismatch', async () => {
    const fetchImpl = mockFetch([
      { name: assetName, body: tarball },
      { name: `${assetName}.sha256`, body: 'deadbeef  ' + assetName },
    ]);
    await expect(downloadLatestArtifact('owner/repo', fetchImpl)).rejects.toThrow(/mismatch/i);
  });

  it('accepts a matching checksum', async () => {
    const fetchImpl = mockFetch([
      { name: assetName, body: tarball },
      { name: `${assetName}.sha256`, body: `${goodSum}  ${assetName}` },
    ]);
    const dl = await downloadLatestArtifact('owner/repo', fetchImpl);
    expect(dl?.version).toBe('0.9.0');
    expect(dl?.archivePath.endsWith(assetName)).toBe(true);
    if (dl) rmSync(join(dl.archivePath, '..'), { recursive: true, force: true });
  });
});

// ─── macOS-only: real bundle install (uses ditto/plutil/xattr/pgrep) ───────────

function makeFakeApp(dir: string, name: string, version: string): string {
  const app = join(dir, name);
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'MacOS', 'dreamcontext-beta'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
  writeFileSync(
    join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleIdentifier</key><string>com.dreamcontext.beta</string>
</dict></plist>
`,
    'utf-8',
  );
  return app;
}

describe.skipIf(!isDarwin)('validateAppBundle / readBundleVersion (macOS)', () => {
  let work: string;
  beforeEach(() => {
    work = join(tmpdir(), `dc-validate-${Math.random().toString(36).slice(2)}`);
    mkdirSync(work, { recursive: true });
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  it('accepts a well-formed .app and reads its version', () => {
    const app = makeFakeApp(work, 'x.app', '1.2.3');
    expect(() => validateAppBundle(app)).not.toThrow();
    expect(readBundleVersion(app)).toBe('1.2.3');
  });
  it('rejects a non-.app path', () => {
    expect(() => validateAppBundle(join(work, 'nope'))).toThrow();
  });
  it('rejects a malformed bundle (no Info.plist)', () => {
    const bad = join(work, 'bad.app');
    mkdirSync(join(bad, 'Contents', 'MacOS'), { recursive: true });
    expect(() => validateAppBundle(bad)).toThrow();
  });
});

describe.skipIf(!isDarwin)('materializeAppBundle (macOS)', () => {
  let work: string;
  beforeEach(() => {
    work = join(tmpdir(), `dc-mat-${Math.random().toString(36).slice(2)}`);
    mkdirSync(work, { recursive: true });
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  it('returns a .app dir as-is', () => {
    const app = makeFakeApp(work, 'x.app', '1.0.0');
    expect(materializeAppBundle(app, work)).toBe(app);
  });
  it('extracts a .tar.gz and finds the .app', () => {
    const srcDir = join(work, 'src');
    mkdirSync(srcDir, { recursive: true });
    makeFakeApp(srcDir, 'x.app', '1.0.0');
    const tar = join(work, 'bundle.tar.gz');
    execFileSync('tar', ['-czf', tar, '-C', srcDir, 'x.app']);
    const extractDir = join(work, 'extract');
    mkdirSync(extractDir, { recursive: true });
    const out = materializeAppBundle(tar, extractDir);
    expect(out.endsWith('.app')).toBe(true);
    expect(readBundleVersion(out)).toBe('1.0.0');
  });
});

describe.skipIf(!isDarwin)('installAppBundle (macOS, real ditto/swap)', () => {
  let root: string;
  let home: string;
  let installDir: string;
  beforeEach(() => {
    root = join(tmpdir(), `dc-install-${Math.random().toString(36).slice(2)}`);
    home = join(root, 'home');
    installDir = join(root, 'Applications');
    mkdirSync(home, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('installs to <installDir>/dreamcontext-beta.app, no quarantine, writes manifest', () => {
    const src = makeFakeApp(root, 'whatever.app', '0.8.0');
    const res = installAppBundle(src, { installDir, home });

    const target = join(installDir, APP_BUNDLE_NAME);
    expect(res.path).toBe(target);
    expect(res.version).toBe('0.8.0');
    expect(res.replaced).toBe(false);
    expect(existsSync(target)).toBe(true);

    // No quarantine attribute on the installed bundle.
    const attrs = execFileSync('xattr', [target], { encoding: 'utf-8' }).toString();
    expect(attrs).not.toContain('com.apple.quarantine');

    // Manifest recorded.
    const man = readAppManifest(home);
    expect(man?.version).toBe('0.8.0');
    expect(man?.path).toBe(target);
  });

  it('replaces an existing install atomically and bumps the version', () => {
    installAppBundle(makeFakeApp(join(root, 'a'), 'a.app', '0.8.0'), { installDir, home });
    const res = installAppBundle(makeFakeApp(join(root, 'b'), 'b.app', '0.9.0'), { installDir, home });

    expect(res.replaced).toBe(true);
    expect(res.version).toBe('0.9.0');
    expect(readBundleVersion(join(installDir, APP_BUNDLE_NAME))).toBe('0.9.0');
    expect(readAppManifest(home)?.version).toBe('0.9.0');

    // No staging/backup leftovers.
    const leftovers = readFileSync; // noop ref to keep import used
    void leftovers;
    expect(existsSync(join(installDir, `.${APP_BUNDLE_NAME}.new-${process.pid}`))).toBe(false);
    expect(existsSync(join(installDir, `.${APP_BUNDLE_NAME}.old-${process.pid}`))).toBe(false);
  });
});

// ── The two defects the owner hit on 2026-09-21, in one sitting ─────────────────────────
//
// He ended up with `dreamcontext-beta.app` in BOTH `/Applications` and `~/Applications`, and
// `app status` told him the one he was looking at was not running. Two separate bugs that
// compound: the duplicate is what an update creates, and the false negative is what stops
// anyone noticing which copy is live.

describe('installDirFor — an update updates the app you HAVE', () => {
  it('goes beside the installed bundle, not to ~/Applications', () => {
    // The whole defect: `status` reads the manifest (here /Applications) while install wrote
    // to ~/Applications unconditionally, so `update` laid down a SECOND bundle and the user
    // updated one copy while launching the other.
    const home = mkdtempSync(join(tmpdir(), 'dc-app-dir-'));
    const installed = join(home, 'Elsewhere');
    mkdirSync(join(installed, APP_BUNDLE_NAME), { recursive: true });
    writeAppManifest(
      { version: '0.28.0', path: join(installed, APP_BUNDLE_NAME), installedAt: 1, source: 'local' },
      home,
    );
    expect(installDirFor(undefined, home)).toBe(installed);
    expect(installDirFor(undefined, home)).not.toBe(defaultInstallDir(home));
  });

  it('falls back to ~/Applications when nothing is installed yet', () => {
    const home = mkdtempSync(join(tmpdir(), 'dc-app-dir-'));
    expect(installDirFor(undefined, home)).toBe(defaultInstallDir(home));
  });

  it('falls back when the manifest points at a bundle that is GONE', () => {
    // A manifest outliving its bundle must not send an install into a directory the user
    // deleted — that would silently resurrect the copy they just removed.
    const home = mkdtempSync(join(tmpdir(), 'dc-app-dir-'));
    writeAppManifest(
      { version: '0.28.0', path: join(home, 'Deleted', APP_BUNDLE_NAME), installedAt: 1, source: 'local' },
      home,
    );
    expect(installDirFor(undefined, home)).toBe(defaultInstallDir(home));
  });

  it('an explicit --dir still wins — that is how you move it on purpose', () => {
    const home = mkdtempSync(join(tmpdir(), 'dc-app-dir-'));
    mkdirSync(join(home, 'Applications', APP_BUNDLE_NAME), { recursive: true });
    writeAppManifest(
      { version: '0.28.0', path: join(home, 'Applications', APP_BUNDLE_NAME), installedAt: 1, source: 'local' },
      home,
    );
    expect(installDirFor('/Applications', home)).toBe('/Applications');
  });
});

describe('appRunningIn — a running app reports running', () => {
  const SELF = 4242;
  const MARKER = `${APP_BUNDLE_NAME}/Contents/MacOS/`;
  // Real `ps -Ao pid=,args=` output, including the leading-space alignment ps actually emits.
  const PS = [
    '    1 /sbin/launchd',
    ' 94896 /Applications/dreamcontext-beta.app/Contents/MacOS/dreamcontext-desktop',
    ' 12864 /usr/bin/node /Users/x/projects/dreamcontext/dist/index.js dashboard',
  ].join('\n');

  it('finds the app ps can see — the case pgrep answered "no" to', () => {
    // Measured 2026-09-21: `ps -A` listed 660 processes, `pgrep -f .` listed 644, and the
    // running app was in the difference. No pattern found it, not even a 5-char prefix.
    expect(appRunningIn(PS, SELF, MARKER)).toBe(true);
  });

  it('…at the OTHER install path too, where the 66-char truncation bites', () => {
    const ps = ' 1932 /Users/mehmetnuraydin/Applications/dreamcontext-beta.app/Contents/MacOS/dreamcontext-desktop';
    expect(appRunningIn(ps, SELF, MARKER)).toBe(true);
  });

  it('says no when nothing is running', () => {
    expect(appRunningIn('    1 /sbin/launchd\n  500 /usr/bin/ssh-agent', SELF, MARKER)).toBe(false);
  });

  it('does NOT match the command asking the question', () => {
    // The reason the old marker was lengthened past the bare bundle name in the first place:
    // `app install --from …/dreamcontext-beta.app` carries the path on its own command line.
    // Dropping our own pid is what lets the marker stay long AND stay honest.
    const ps = ` ${SELF} node dreamcontext app install --from /tmp/dreamcontext-beta.app/Contents/MacOS/`;
    expect(appRunningIn(ps, SELF, MARKER)).toBe(false);
  });

  it('the bundle NAME alone is not evidence — only the executable directory is', () => {
    // A bundle sitting in a tarball, being copied, or named in any command is not a launched
    // app. Only `<bundle>/Contents/MacOS/` means a process is executing out of it.
    const ps = ' 777 /usr/bin/ditto /tmp/build/dreamcontext-beta.app /Applications/dreamcontext-beta.app';
    expect(appRunningIn(ps, SELF, MARKER)).toBe(false);
  });

  it('scoped to ONE bundle, so a stale copy elsewhere is not your app', () => {
    // `isAppRunning(installed.path)` narrows the marker to the installed bundle — otherwise a
    // forgotten copy under ~/Applications would report the /Applications app as running.
    const scoped = `${join('/Applications', APP_BUNDLE_NAME)}/Contents/MacOS/`;
    const ps = ' 999 /Users/x/Applications/dreamcontext-beta.app/Contents/MacOS/dreamcontext-desktop';
    expect(appRunningIn(ps, SELF, scoped)).toBe(false);
    expect(appRunningIn(ps, SELF, MARKER)).toBe(true);
  });
});
