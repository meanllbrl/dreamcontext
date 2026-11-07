/**
 * The per-app macOS bundle: `~/Applications/Dreamcontext Apps/<slug>-<hash6>.app`.
 *
 * Each dreamcontext App opens in its own `.app` whose executable is a copy of the shell's
 * `app-runner` (desktop/app-runner), so the app has its own Dock icon, name and Cmd-Tab
 * entry, and macOS keeps one instance of it. Plan: dreamcontext-apps plan r19, "Kontrat",
 * "Dosya yerleşimi", "W1".
 *
 * - The path NEVER derives from the display name (only slug + project hash);
 *   CFBundleDisplayName carries the name, plist-escaped.
 * - `Contents/Resources/dreamcontext-app.json` = { schema:1, projectRoot, vault, slug, name,
 *   appBundleId }, where appBundleId is the dreamcontext SHELL's id (the runner's only
 *   source for it when desktop-server.json is absent).
 * - Built in a temp dir and renamed into place; stale = runner sha + inputs + icon hash.
 * - ad-hoc signed (`codesign --force --deep -s -`), quarantine cleared, registered with
 *   LaunchServices (the src/lib/automations/notifier.ts pattern).
 * The caller skips this while the app's window is running: a rename under a live runner
 * would swap its bundle mid-run.
 */

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { writeDefaultIcon } from './icon.js';
import { decodePng, maskToTile } from './png.js';

export const APP_SLUG_RE = /^[a-z][a-z0-9-]{0,63}$/;
const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;
const STAMP_FILE = 'dreamcontext-bundle.stamp';
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

/**
 * Stable per (project, slug): the data dir, the runner's bundle id and the bundle name use it.
 * An installed app adds its installId, so nothing (data, approvals, port) is inherited from an
 * earlier app of the same slug (paylasilan-app-ler plan r2).
 */
export function appHash(projectRoot: string, slug: string, installId?: string): string {
  let root = projectRoot;
  try {
    root = realpathSync(projectRoot);
  } catch { /* a project that is gone still hashes */ }
  return createHash('sha256').update(installId ? `${root}\0${slug}\0${installId}` : `${root}\0${slug}`).digest('hex').slice(0, 16);
}

export function appsBundleDir(home: string = homedir()): string {
  return join(home, 'Applications', 'Dreamcontext Apps');
}

export function appBundlePath(home: string, slug: string, hash: string): string {
  if (!APP_SLUG_RE.test(slug)) throw new Error(`bad app slug: ${slug}`);
  return join(appsBundleDir(home), `${slug}-${hash.slice(0, 6)}.app`);
}

/** The runner's own CFBundleIdentifier. The app opens BY PATH, not by this id. */
export function runnerBundleId(hash: string): string {
  return `com.dreamcontext.app.${hash}`;
}

/** A display name: no control characters or line breaks, 60 characters (the manifest rule). */
export function cleanDisplayName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(flat).slice(0, 60).join('') || 'App';
}

export function plistEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export interface BundleInput {
  home?: string;
  projectRoot: string;
  vault: string;
  slug: string;
  name: string;
  /** PNG/JPEG/ICNS inside the app root (the caller realpath-checks it). Absent = the default letter. */
  iconPath?: string | null;
  /** The runner binary to copy in: the shell's `Contents/MacOS/app-runner` (DREAMCONTEXT_APP_RUNNER). */
  runnerPath: string;
  /** The dreamcontext SHELL's bundle id, stamped into the bundle. */
  appBundleId: string;
  version?: string;
}

export interface BundleDeps {
  exec?: (cmd: string, args: string[]) => void;
  platform?: NodeJS.Platform;
}

export type BundleResult =
  | { ok: true; path: string; hash: string; bundleId: string; built: boolean }
  | { ok: false; reason: string };

const realExec = (cmd: string, args: string[]): void => {
  execFileSync(cmd, args, { stdio: 'ignore', timeout: 60_000 });
};

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function renderInfoPlist(p: { bundleId: string; name: string; version: string }): string {
  const name = plistEscape(p.name);
  // CFBundleName is the short (menu bar) name; macOS truncates past 15 characters.
  const short = plistEscape(Array.from(p.name).slice(0, 15).join(''));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>tr</string>
  <key>CFBundleExecutable</key><string>app-runner</string>
  <key>CFBundleIdentifier</key><string>${plistEscape(p.bundleId)}</string>
  <key>CFBundleName</key><string>${short}</string>
  <key>CFBundleDisplayName</key><string>${name}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${plistEscape(p.version)}</string>
  <key>CFBundleVersion</key><string>${plistEscape(p.version)}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSFileQuarantineEnabled</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSSupportsAutomaticTermination</key><false/>
  <key>NSSupportsSuddenTermination</key><false/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
`;
}

/** What goes into Resources/dreamcontext-app.json. */
export function renderBundleInfo(p: { projectRoot: string; vault: string; slug: string; name: string; appBundleId: string }): string {
  return JSON.stringify({ schema: 1, projectRoot: p.projectRoot, vault: p.vault, slug: p.slug, name: p.name, appBundleId: p.appBundleId }, null, 2) + '\n';
}

/**
 * Turn a PNG/JPEG into an .icns with sips + iconutil; an .icns is copied as is. Returns
 * false when the conversion is not possible (the caller falls back to the default icon).
 */
function makeIcns(src: string, dest: string, exec: (cmd: string, args: string[]) => void): boolean {
  const ext = extname(src).toLowerCase();
  if (ext === '.icns') {
    copyFileSync(src, dest);
    return true;
  }
  if (ext !== '.png' && ext !== '.jpg' && ext !== '.jpeg') return false;
  const work = mkdtempSync(join(tmpdir(), 'dc-icon-'));
  try {
    const set = join(work, 'AppIcon.iconset');
    mkdirSync(set);
    // One mask everywhere (app-paylasim-magaza r2): a full-bleed square icon gets the same rounded
    // tile the Apps page draws; an icon that draws its own tile (transparent corners) stays as it is.
    try {
      const full = join(work, 'full.png');
      exec('/usr/bin/sips', ['-s', 'format', 'png', '-z', '1024', '1024', src, '--out', full]);
      const img = existsSync(full) ? decodePng(readFileSync(full)) : null;
      const tile = img ? maskToTile(img) : null;
      if (tile) { src = join(work, 'tile.png'); writeFileSync(src, tile); }
    } catch { /* the icon goes as it is */ }
    for (const size of [16, 32, 128, 256, 512]) {
      exec('/usr/bin/sips', ['-s', 'format', 'png', '-z', String(size), String(size), src, '--out', join(set, `icon_${size}x${size}.png`)]);
      exec('/usr/bin/sips', ['-s', 'format', 'png', '-z', String(size * 2), String(size * 2), src, '--out', join(set, `icon_${size}x${size}@2x.png`)]);
    }
    exec('/usr/bin/iconutil', ['-c', 'icns', set, '-o', dest]);
    return existsSync(dest);
  } catch {
    return false;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The app's own letter, never dreamcontext's logo: no icon must not mean the same Dock tile. */
function makeDefaultIcns(slug: string, name: string, dest: string, exec: (cmd: string, args: string[]) => void): void {
  const work = mkdtempSync(join(tmpdir(), 'dc-default-icon-'));
  try {
    makeIcns(writeDefaultIcon(work, slug, name), dest, exec);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Build (or keep) the app's bundle. Fresh when the stamp matches: no work, `built:false`.
 */
/** The stamp's icon part when the app has none: bump it when the default letter's drawing changes. */
const DEFAULT_ICON_STAMP = 'default-letter-1';

function bundleParts(input: BundleInput): { name: string; plist: string; infoJson: string; iconSrc: string | null; stamp: string } {
  const name = cleanDisplayName(input.name);
  const bundleId = runnerBundleId(appHash(input.projectRoot, input.slug));
  const iconSrc = input.iconPath && existsSync(input.iconPath) ? input.iconPath : null;
  const infoJson = renderBundleInfo({ projectRoot: input.projectRoot, vault: input.vault, slug: input.slug, name, appBundleId: input.appBundleId });
  const plist = renderInfoPlist({ bundleId, name, version: input.version ?? '1.0' });
  const stamp = createHash('sha256')
    .update(sha256File(input.runnerPath))
    .update('\0')
    .update(plist)
    .update('\0')
    .update(infoJson)
    .update('\0')
    // `tile-1`: the Dock icon is masked into the rounded tile; bump it when that drawing changes.
    .update(iconSrc ? `tile-1:${sha256File(iconSrc)}` : DEFAULT_ICON_STAMP)
    .digest('hex');
  return { name, plist, infoJson, iconSrc, stamp };
}

/**
 * May the bundle be (re)built on this open? Never under a running window, but "running" is the
 * OS's word: only when it cannot be asked does the heartbeat lease decide, because a killed
 * runner's lease outlives it by a whole TTL and a rebuild skipped on it keeps the old icon.
 */
export function mayBuildBundle(s: { processRunning: boolean | null; leaseAlive: boolean; bundleExists: boolean }): boolean {
  return !(s.processRunning ?? s.leaseAlive) || !s.bundleExists;
}

/**
 * May a runner be ended to take a new bundle? Only one the owner stopped, on its Stopped screen
 * with nothing to lose, whose bundle really changed. A working window is never ended for this.
 */
export function mayRetireRunner(s: { stoppedByOwner: boolean; processRunning: boolean | null; stale: boolean }): boolean {
  return s.stoppedByOwner && s.processRunning === true && s.stale;
}

/**
 * Refresh a closed app's bundle between launches? A Dock tile, Finder or a notification starts
 * the bundle directly, past every server path, so the new icon has to be in place before them.
 * Only an existing bundle, and only when the OS says with certainty that nothing runs it.
 */
export function shouldRefreshIdleBundle(s: { bundleExists: boolean; stale: boolean; processRunning: boolean | null }): boolean {
  return s.bundleExists && s.stale && s.processRunning === false;
}

/** Would `ensureAppBundle` rebuild? True when the bundle is missing or anything in it changed. */
export function bundleIsStale(input: BundleInput): boolean {
  try {
    const path = appBundlePath(input.home ?? homedir(), input.slug, appHash(input.projectRoot, input.slug));
    return readFileSync(join(path, 'Contents', 'Resources', STAMP_FILE), 'utf-8').trim() !== bundleParts(input).stamp;
  } catch {
    return true;
  }
}

/**
 * Is a process of this bundle running, by the OS's own table? null = could not ask. A heartbeat
 * lease outlives a killed process by its TTL; this does not.
 */
export function bundleRunState(bundleId: string): boolean | null {
  if (process.platform !== 'darwin' || !/^[A-Za-z0-9.-]+$/.test(bundleId)) return null;
  try {
    return execFileSync('/usr/bin/lsappinfo', ['find', `bundleid=${bundleId}`], { encoding: 'utf-8', timeout: 3000 }).trim() !== '';
  } catch {
    return null;
  }
}

/** The running process's pid, or null. */
export function bundlePid(bundleId: string): number | null {
  if (process.platform !== 'darwin' || !/^[A-Za-z0-9.-]+$/.test(bundleId)) return null;
  try {
    const m = /"pid"=(\d+)/.exec(execFileSync('/usr/bin/lsappinfo', ['info', '-only', 'pid', '-app', bundleId], { encoding: 'utf-8', timeout: 3000 }));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export function ensureAppBundle(input: BundleInput, deps: BundleDeps = {}): BundleResult {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') return { ok: false, reason: 'app windows are macOS-only' };
  const exec = deps.exec ?? realExec;
  const home = input.home ?? homedir();
  if (!APP_SLUG_RE.test(input.slug)) return { ok: false, reason: `bad app slug: ${input.slug}` };
  if (!BUNDLE_ID_RE.test(input.appBundleId) || !input.appBundleId.includes('.')) {
    return { ok: false, reason: 'bad dreamcontext bundle id' };
  }
  if (!input.runnerPath || !existsSync(input.runnerPath)) {
    return { ok: false, reason: 'app-runner not found: update the dreamcontext app (DREAMCONTEXT_APP_RUNNER is unset)' };
  }
  const hash = appHash(input.projectRoot, input.slug);
  const bundleId = runnerBundleId(hash);
  const dir = appsBundleDir(home);
  const finalPath = appBundlePath(home, input.slug, hash);

  const { name, plist, infoJson, iconSrc, stamp } = bundleParts(input);

  try {
    const stampPath = join(finalPath, 'Contents', 'Resources', STAMP_FILE);
    if (existsSync(stampPath) && readFileSync(stampPath, 'utf-8').trim() === stamp) {
      return { ok: true, path: finalPath, hash, bundleId, built: false };
    }
  } catch { /* rebuild */ }

  try {
    mkdirSync(dir, { recursive: true });
    if (lstatSync(dir).isSymbolicLink()) return { ok: false, reason: `${dir} is a symlink` };
    const tmp = join(dir, `.${input.slug}-${hash.slice(0, 6)}.${randomBytes(4).toString('hex')}.tmp.app`);
    const contents = join(tmp, 'Contents');
    mkdirSync(join(contents, 'MacOS'), { recursive: true });
    mkdirSync(join(contents, 'Resources'), { recursive: true });
    writeFileSync(join(contents, 'Info.plist'), plist);
    writeFileSync(join(contents, 'PkgInfo'), 'APPL????');
    const exe = join(contents, 'MacOS', 'app-runner');
    copyFileSync(input.runnerPath, exe);
    chmodSync(exe, 0o755);
    writeFileSync(join(contents, 'Resources', 'dreamcontext-app.json'), infoJson, { mode: 0o644 });
    const icns = join(contents, 'Resources', 'AppIcon.icns');
    if (!iconSrc || !makeIcns(iconSrc, icns, exec)) makeDefaultIcns(input.slug, name, icns, exec);
    // The stamp is sealed with everything else: nothing is written after signing.
    writeFileSync(join(contents, 'Resources', STAMP_FILE), stamp + '\n');
    try { exec('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', tmp]); } catch { /* nothing to clear */ }
    // Ad-hoc: a copied, edited bundle has no valid signature, and LaunchServices may refuse it.
    try { exec('/usr/bin/codesign', ['--force', '--deep', '-s', '-', tmp]); } catch { /* best effort */ }

    // Swap: old aside, new in, old gone. A crash between the renames leaves the new bundle
    // or the old one in place, never a half-built one.
    let aside: string | null = null;
    if (existsSync(finalPath)) {
      aside = join(dir, `.${input.slug}-${hash.slice(0, 6)}.${randomBytes(4).toString('hex')}.old.app`);
      renameSync(finalPath, aside);
    }
    renameSync(tmp, finalPath);
    if (aside) rmSync(aside, { recursive: true, force: true });
    try { exec(LSREGISTER, ['-f', finalPath]); } catch { /* a hint; open(1) registers on demand */ }
    return { ok: true, path: finalPath, hash, bundleId, built: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * Remove an app's bundle. Refuses anything whose realpath is not directly inside
 * `~/Applications/Dreamcontext Apps/` (a symlinked bundle path must not delete elsewhere).
 */
export function removeAppBundle(home: string, slug: string, hash: string, exec: (cmd: string, args: string[]) => void = realExec): boolean {
  const path = appBundlePath(home, slug, hash);
  if (!existsSync(path)) return false;
  try {
    if (lstatSync(path).isSymbolicLink()) return false;
    const real = realpathSync(path);
    const parent = realpathSync(appsBundleDir(home));
    if (real !== join(parent, `${slug}-${hash.slice(0, 6)}.app`)) return false;
    try { exec(LSREGISTER, ['-u', real]); } catch { /* unregister is a hint */ }
    rmSync(real, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** The runner binary the shell ships: `DREAMCONTEXT_APP_RUNNER`, set by the desktop shell at spawn. */
export function shellRunnerPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const p = env.DREAMCONTEXT_APP_RUNNER;
  return p && existsSync(p) ? p : null;
}
