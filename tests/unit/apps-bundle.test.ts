import { decodePng, cornersTransparent, encodePng } from '../../src/lib/apps/png.js';
import { renderDefaultIcon } from '../../src/lib/apps/icon.js';
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, mkdirSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appBundlePath,
  appHash,
  appsBundleDir,
  bundleIsStale,
  cleanDisplayName,
  ensureAppBundle,
  mayBuildBundle,
  mayRetireRunner,
  removeAppBundle,
  renderInfoPlist,
  runnerBundleId,
  shouldRefreshIdleBundle,
} from '../../src/lib/apps/bundle.js';

/**
 * The per-app macOS bundle (dreamcontext-apps plan r19, W1): its own Dock identity, a path
 * that never derives from the display name, the shell's bundle id stamped in, temp+rename,
 * and no rebuild while nothing changed.
 */

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const home = tmp('dc-bundle-home-');
  const project = tmp('dc-bundle-proj-');
  const runner = join(tmp('dc-bundle-runner-'), 'app-runner');
  writeFileSync(runner, 'runner-v1');
  const calls: Array<[string, string[]]> = [];
  const exec = (cmd: string, args: string[]) => {
    calls.push([cmd, args]);
    // iconutil writes the icns the bundle expects.
    if (cmd.endsWith('iconutil')) writeFileSync(args[args.indexOf('-o') + 1], 'icns');
  };
  const input = { home, hash: appHash(project, 'meta-ads'), projectRoot: project, vault: 'acme', slug: 'meta-ads', name: 'Meta Ads', runnerPath: runner, appBundleId: 'com.dreamcontext.beta' };
  return { home, project, runner, calls, exec, input };
}

describe('ensureAppBundle', () => {
  it('builds an installed app under its registered hash, the one Open looks for (2026-11-09)', () => {
    const { home, project, exec, input } = setup();
    const installed = appHash(project, 'meta-ads', 'abc123installid');
    expect(installed).not.toBe(appHash(project, 'meta-ads'));
    const r = ensureAppBundle({ ...input, hash: installed }, { exec, platform: 'darwin' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toBe(appBundlePath(home, 'meta-ads', installed));
    expect(r.bundleId).toBe(`com.dreamcontext.app.${installed}`);
    expect(readFileSync(join(r.path, 'Contents', 'Info.plist'), 'utf-8')).toContain(`<string>com.dreamcontext.app.${installed}</string>`);
    expect(existsSync(appBundlePath(home, 'meta-ads', appHash(project, 'meta-ads')))).toBe(false);
    expect(bundleIsStale({ ...input, hash: installed })).toBe(false);
  });

  it('refuses a hash that is not one', () => {
    const { exec, input } = setup();
    const r = ensureAppBundle({ ...input, hash: '../x' }, { exec, platform: 'darwin' });
    expect(r).toEqual({ ok: false, reason: 'bad app hash' });
  });

  it('lays out the bundle at <slug>-<hash6>.app with the runner, plist and bundle info', () => {
    const { home, project, calls, exec, input } = setup();
    const r = ensureAppBundle(input, { exec, platform: 'darwin' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hash = appHash(project, 'meta-ads');
    expect(r.path).toBe(join(home, 'Applications', 'Dreamcontext Apps', `meta-ads-${hash.slice(0, 6)}.app`));
    expect(r.bundleId).toBe(`com.dreamcontext.app.${hash}`);
    expect(r.built).toBe(true);

    const exe = join(r.path, 'Contents', 'MacOS', 'app-runner');
    expect(readFileSync(exe, 'utf-8')).toBe('runner-v1');
    if (process.platform !== 'win32') expect(statSync(exe).mode & 0o111).toBeTruthy(); // Windows has no POSIX mode bits

    const plist = readFileSync(join(r.path, 'Contents', 'Info.plist'), 'utf-8');
    expect(plist).toContain('<key>CFBundleExecutable</key><string>app-runner</string>');
    expect(plist).toContain(`<key>CFBundleIdentifier</key><string>com.dreamcontext.app.${hash}</string>`);
    expect(plist).toContain('<key>CFBundleDisplayName</key><string>Meta Ads</string>');
    expect(plist).toContain('<key>LSFileQuarantineEnabled</key><true/>');

    const info = JSON.parse(readFileSync(join(r.path, 'Contents', 'Resources', 'dreamcontext-app.json'), 'utf-8'));
    expect(info).toEqual({ schema: 1, projectRoot: project, vault: 'acme', slug: 'meta-ads', name: 'Meta Ads', appBundleId: 'com.dreamcontext.beta' });

    // Quarantine cleared and ad-hoc signed before the rename, registered after it.
    const sealing = calls.filter(([c]) => !/sips|iconutil/.test(c));
    expect(sealing.map(([c]) => c.split('/').pop())).toEqual(['xattr', 'codesign', 'lsregister']);
    expect(sealing[1][1]).toEqual(['--force', '--deep', '-s', '-', expect.stringMatching(/\.tmp\.app$/)]);
    expect(sealing[2][1]).toEqual(['-f', r.path]);
    // No temp or old bundles left behind.
    expect(readdirSync(appsBundleDir(home))).toEqual([`meta-ads-${hash.slice(0, 6)}.app`]);
  });

  it('never derives the path from the display name; the name is plist-escaped and one line', () => {
    const { home, exec, input } = setup();
    const r = ensureAppBundle({ ...input, name: '../../Evil </string><key>X</key>\n<string>' }, { exec, platform: 'darwin' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path.startsWith(join(appsBundleDir(home), 'meta-ads-'))).toBe(true);
    const plist = readFileSync(join(r.path, 'Contents', 'Info.plist'), 'utf-8');
    expect(plist).toContain('<key>CFBundleDisplayName</key><string>../../Evil &lt;/string&gt;&lt;key&gt;X&lt;/key&gt; &lt;string&gt;</string>');
    expect(plist.match(/<key>X<\/key>/)).toBeNull();
  });

  it('keeps a fresh bundle and rebuilds when the runner, name or icon changes', () => {
    const { runner, exec, input, project } = setup();
    expect(ensureAppBundle(input, { exec, platform: 'darwin' })).toMatchObject({ ok: true, built: true });
    expect(ensureAppBundle(input, { exec, platform: 'darwin' })).toMatchObject({ ok: true, built: false });

    writeFileSync(runner, 'runner-v2');
    const r2 = ensureAppBundle(input, { exec, platform: 'darwin' });
    expect(r2).toMatchObject({ ok: true, built: true });
    if (r2.ok) expect(readFileSync(join(r2.path, 'Contents', 'MacOS', 'app-runner'), 'utf-8')).toBe('runner-v2');

    expect(ensureAppBundle({ ...input, name: 'Meta Reklam' }, { exec, platform: 'darwin' })).toMatchObject({ ok: true, built: true });

    const icon = join(project, 'icon.png');
    writeFileSync(icon, 'png-1');
    const withIcon = { ...input, name: 'Meta Reklam', iconPath: icon };
    const r3 = ensureAppBundle(withIcon, { exec, platform: 'darwin' });
    expect(r3).toMatchObject({ ok: true, built: true });
    if (r3.ok) expect(existsSync(join(r3.path, 'Contents', 'Resources', 'AppIcon.icns'))).toBe(true);
    expect(ensureAppBundle(withIcon, { exec, platform: 'darwin' })).toMatchObject({ ok: true, built: false });
    writeFileSync(icon, 'png-2');
    expect(ensureAppBundle(withIcon, { exec, platform: 'darwin' })).toMatchObject({ ok: true, built: true });
  });

  it('masks a full-bleed icon into the rounded tile before the iconset, and keeps a self-tiled one as it is', () => {
    const { project, input } = setup();
    const fed: string[] = [];
    let tileSeen: Buffer | null = null;
    const exec = (cmd: string, args: string[]) => {
      if (cmd.endsWith('iconutil')) { writeFileSync(args[args.indexOf('-o') + 1], 'icns'); return; }
      if (!cmd.endsWith('sips')) return;
      const src = args[args.length - 3];
      const out = args[args.length - 1];
      // sips at 1024 stands in: copies the PNG it is given (both test icons are 1024 already).
      if (out.endsWith('full.png')) { writeFileSync(out, readFileSync(src)); return; }
      fed.push(src);
      if (src.endsWith('tile.png') && !tileSeen) tileSeen = readFileSync(src);
    };
    const full = join(project, 'full.png');
    writeFileSync(full, encodePng({ width: 1024, height: 1024, data: Buffer.alloc(1024 * 1024 * 4, 220) }));
    ensureAppBundle({ ...input, iconPath: full }, { exec, platform: 'darwin' });
    expect(fed.length).toBe(10);
    expect(fed.every((f) => f.endsWith('tile.png'))).toBe(true);
    const tile = decodePng(tileSeen!)!;
    expect(tile.width).toBe(1024);
    expect(cornersTransparent(tile)).toBe(true);

    fed.length = 0;
    const own = join(project, 'own.png');
    writeFileSync(own, renderDefaultIcon('meta-ads', 'Meta Ads'));
    ensureAppBundle({ ...input, slug: 'meta-ads-2', iconPath: own }, { exec, platform: 'darwin' });
    expect(fed.every((f) => f === own)).toBe(true);
  });

  it('turns a PNG icon into an icns through sips + iconutil, and copies an icns as is', () => {
    const { project, calls, exec, input } = setup();
    const png = join(project, 'logo.png');
    writeFileSync(png, 'png');
    ensureAppBundle({ ...input, iconPath: png }, { exec, platform: 'darwin' });
    // One to read the icon at 1024 (the tile mask), then the ten iconset sizes.
    expect(calls.filter(([c]) => c.endsWith('sips'))).toHaveLength(11);
    expect(calls.some(([c]) => c.endsWith('iconutil'))).toBe(true);

    const icns = join(project, 'logo.icns');
    writeFileSync(icns, 'real-icns');
    const r = ensureAppBundle({ ...input, slug: 'other', iconPath: icns }, { exec, platform: 'darwin' });
    expect(r.ok && readFileSync(join(r.path, 'Contents', 'Resources', 'AppIcon.icns'), 'utf-8')).toBe('real-icns');
  });

  it('refuses a bad slug, a bad shell id, a missing runner and other platforms', () => {
    const { exec, input } = setup();
    expect(ensureAppBundle({ ...input, slug: '../x' }, { exec, platform: 'darwin' })).toMatchObject({ ok: false });
    expect(ensureAppBundle({ ...input, appBundleId: 'com.x; rm' }, { exec, platform: 'darwin' })).toMatchObject({ ok: false });
    expect(ensureAppBundle({ ...input, runnerPath: '/nope/app-runner' }, { exec, platform: 'darwin' })).toMatchObject({ ok: false, reason: expect.stringMatching(/app-runner not found/) });
    expect(ensureAppBundle(input, { exec, platform: 'linux' })).toMatchObject({ ok: false, reason: expect.stringMatching(/macOS/) });
  });
});

describe('removeAppBundle', () => {
  it('removes the bundle, and refuses one that is a symlink out of the apps dir', () => {
    const { home, exec, input, project } = setup();
    const r = ensureAppBundle(input, { exec, platform: 'darwin' });
    expect(r.ok).toBe(true);
    const hash = appHash(project, 'meta-ads');
    expect(removeAppBundle(home, 'meta-ads', hash, exec)).toBe(true);
    expect(existsSync(appBundlePath(home, 'meta-ads', hash))).toBe(false);

    const outside = tmp('dc-bundle-outside-');
    mkdirSync(join(outside, 'Contents'));
    symlinkSync(outside, appBundlePath(home, 'meta-ads', hash));
    expect(removeAppBundle(home, 'meta-ads', hash, exec)).toBe(false);
    expect(existsSync(join(outside, 'Contents'))).toBe(true);
  });
});

describe('helpers', () => {
  it('hash and ids are stable per project + slug', () => {
    const { project } = setup();
    expect(appHash(project, 'a')).toBe(appHash(project, 'a'));
    expect(appHash(project, 'a')).not.toBe(appHash(project, 'b'));
    expect(appHash(project, 'a')).toMatch(/^[0-9a-f]{16}$/);
    expect(runnerBundleId('abc')).toBe('com.dreamcontext.app.abc');
  });

  it('cleans a display name to one line of 60 characters', () => {
    expect(cleanDisplayName('Meta\nAds\u0007')).toBe('Meta Ads');
    expect(Array.from(cleanDisplayName('ş'.repeat(80)))).toHaveLength(60);
    expect(cleanDisplayName('\n\n')).toBe('App');
  });

  it('the short CFBundleName stays within 15 characters', () => {
    expect(renderInfoPlist({ bundleId: 'a.b', name: 'Çok Uzun Bir Reklam Yöneticisi', version: '1' })).toContain('<key>CFBundleName</key><string>Çok Uzun Bir Re</string>');
  });
});

describe('the default icon in the bundle', () => {
  it('builds an app with no icon from its own letter, never from a copied logo', () => {
    const { input, exec, calls } = setup();
    const r = ensureAppBundle({ ...input, iconPath: null }, { exec, platform: 'darwin' });
    expect(r.ok).toBe(true);
    expect(calls.some(([c]) => c.endsWith('iconutil'))).toBe(true);
    if (r.ok) expect(readFileSync(join(r.path, 'Contents', 'Resources', 'AppIcon.icns'), 'utf-8')).toBe('icns');
  });

  it('falls back to the letter when the icon cannot be converted', () => {
    const { input, project, exec, calls } = setup();
    const bad = join(project, 'icon.gif');
    writeFileSync(bad, 'gif');
    const r = ensureAppBundle({ ...input, iconPath: bad }, { exec, platform: 'darwin' });
    expect(r.ok).toBe(true);
    expect(calls.some(([c]) => c.endsWith('iconutil'))).toBe(true);
  });
});

describe('when a new icon reaches the Dock', () => {
  it('sees the bundle go stale when the icon changes, and fresh once it is rebuilt', () => {
    const { input, project, exec } = setup();
    const icon = join(project, 'icon.png');
    writeFileSync(icon, 'one');
    const withIcon = { ...input, iconPath: icon };
    expect(bundleIsStale(withIcon)).toBe(true);
    ensureAppBundle(withIcon, { exec, platform: 'darwin' });
    expect(bundleIsStale(withIcon)).toBe(false);
    writeFileSync(icon, 'two');
    expect(bundleIsStale(withIcon)).toBe(true);
  });

  it('ends a runner for a new bundle only when the owner stopped it', () => {
    expect(mayRetireRunner({ stoppedByOwner: true, processRunning: true, stale: true })).toBe(true);
    expect(mayRetireRunner({ stoppedByOwner: false, processRunning: true, stale: true })).toBe(false);
    expect(mayRetireRunner({ stoppedByOwner: true, processRunning: true, stale: false })).toBe(false);
    expect(mayRetireRunner({ stoppedByOwner: true, processRunning: false, stale: true })).toBe(false);
    expect(mayRetireRunner({ stoppedByOwner: true, processRunning: null, stale: true })).toBe(false);
  });

  it('refreshes a closed bundle for a Dock click, only when nothing can be running it', () => {
    expect(shouldRefreshIdleBundle({ bundleExists: true, stale: true, processRunning: false })).toBe(true);
    expect(shouldRefreshIdleBundle({ bundleExists: true, stale: true, processRunning: true })).toBe(false);
    expect(shouldRefreshIdleBundle({ bundleExists: true, stale: true, processRunning: null })).toBe(false);
    expect(shouldRefreshIdleBundle({ bundleExists: true, stale: false, processRunning: false })).toBe(false);
    expect(shouldRefreshIdleBundle({ bundleExists: false, stale: true, processRunning: false })).toBe(false);
  });

  it('believes the OS over a lease: a killed runner does not block the rebuild', () => {
    expect(mayBuildBundle({ processRunning: false, leaseAlive: true, bundleExists: true })).toBe(true);
    expect(mayBuildBundle({ processRunning: true, leaseAlive: false, bundleExists: true })).toBe(false);
    expect(mayBuildBundle({ processRunning: null, leaseAlive: true, bundleExists: true })).toBe(false);
    expect(mayBuildBundle({ processRunning: null, leaseAlive: false, bundleExists: true })).toBe(true);
    expect(mayBuildBundle({ processRunning: true, leaseAlive: true, bundleExists: false })).toBe(true);
  });
});
