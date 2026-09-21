import { Command } from 'commander';
import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  renameSync,
  readdirSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import chalk from 'chalk';
import { compareVersions } from '../../lib/version-check.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Bundle name installed on disk (matches the Tauri productName). */
export const APP_BUNDLE_NAME = 'dreamcontext-beta.app';
/** GitHub repo that publishes the desktop releases. */
export const APP_RELEASE_REPO = 'meanllbrl/dreamcontext';

// ─── Platform ──────────────────────────────────────────────────────────────────

export interface Platform {
  os: 'darwin' | 'win32' | 'linux' | 'other';
  /** Tauri-style arch token: aarch64 | x86_64 | other. */
  arch: 'aarch64' | 'x86_64' | 'other';
}

/** Detect the current platform, mapping node's arch tokens to Tauri's. */
export function detectPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Platform {
  const os: Platform['os'] =
    platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'win32' : platform === 'linux' ? 'linux' : 'other';
  const a: Platform['arch'] = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : 'other';
  return { os, arch: a };
}

/**
 * Release asset filename for a given version + arch (macOS).
 * Mirrors the Tauri bundle naming (`dreamcontext-beta_<ver>_<arch>.app.tar.gz`).
 */
export function appArtifactName(version: string, arch: Platform['arch']): string {
  return `dreamcontext-beta_${version}_${arch}.app.tar.gz`;
}

/**
 * PURE: pick the asset matching this arch from a list of release asset names.
 * Returns the matching name or null. Prefers an exact arch match.
 */
export function pickAssetForArch(assetNames: string[], arch: Platform['arch']): string | null {
  const appAssets = assetNames.filter((n) => n.endsWith('.app.tar.gz'));
  const exact = appAssets.find((n) => n.includes(`_${arch}.`));
  return exact ?? null;
}

// ─── Paths ───────────────────────────────────────────────────────────────────

/** User-writable install dir (no admin needed) — where a FIRST install goes. */
export function defaultInstallDir(home: string = homedir()): string {
  return join(home, 'Applications');
}

/**
 * Where an install/update should actually write: beside the bundle that is already
 * installed, falling back to {@link defaultInstallDir} when there is none.
 *
 * WHY THIS EXISTS (owner report, 2026-09-21: "iki app yarattın"). `app status` reads the
 * MANIFEST, which records the path the bundle was installed to; `app install`/`app update`
 * wrote to `~/Applications` unconditionally. Move the app to `/Applications` once — by hand,
 * or with `--dir` — and the two stop agreeing: `update` lays a SECOND bundle down in
 * `~/Applications` while `status` keeps reporting the first, so the user updates one copy and
 * keeps launching the other. Both copies then sit in Spotlight and Launchpad under one name.
 *
 * An update is by definition an update OF SOMETHING, so the honest default is that thing's
 * own directory. An explicit `--dir` still wins — that is how you deliberately move it, and
 * the manifest then follows it there.
 */
export function installDirFor(explicit: string | undefined, home: string = homedir()): string {
  if (explicit) return resolve(explicit);
  const installed = readAppManifest(home);
  if (installed?.path && existsSync(installed.path)) return dirname(installed.path);
  return defaultInstallDir(home);
}

/** Installed-app manifest path: ~/.dreamcontext/app.json. */
export function appManifestPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'app.json');
}

export interface AppManifest {
  version: string;
  path: string;
  installedAt: number;
  source: string; // 'local' | 'github' | a URL/path
}

export function readAppManifest(home: string = homedir()): AppManifest | null {
  const p = appManifestPath(home);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as Partial<AppManifest>;
    if (!parsed || typeof parsed.version !== 'string' || typeof parsed.path !== 'string') return null;
    return {
      version: parsed.version,
      path: parsed.path,
      installedAt: typeof parsed.installedAt === 'number' ? parsed.installedAt : 0,
      source: typeof parsed.source === 'string' ? parsed.source : 'unknown',
    };
  } catch {
    return null;
  }
}

export function writeAppManifest(manifest: AppManifest, home: string = homedir()): void {
  const p = appManifestPath(home);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

// ─── Shell helpers (no shell string — arg arrays only) ─────────────────────────

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

function runCapture(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf-8' }).toString().trim();
}

// ─── Bundle validation + version read ──────────────────────────────────────────

/** Throw unless `appDir` looks like a real .app bundle. */
export function validateAppBundle(appDir: string): void {
  if (!appDir.endsWith('.app') || !existsSync(appDir)) {
    throw new Error(`Not a .app bundle: ${appDir}`);
  }
  const macos = join(appDir, 'Contents', 'MacOS');
  const plist = join(appDir, 'Contents', 'Info.plist');
  if (!existsSync(macos) || !existsSync(plist)) {
    throw new Error(`Malformed .app (missing Contents/MacOS or Info.plist): ${appDir}`);
  }
}

/** Read CFBundleShortVersionString from a .app's Info.plist via plutil. */
export function readBundleVersion(appDir: string): string | null {
  const plist = join(appDir, 'Contents', 'Info.plist');
  try {
    return runCapture('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]) || null;
  } catch {
    return null;
  }
}

// ─── Source materialization ────────────────────────────────────────────────────

/** Find the single top-level *.app inside a directory. */
function findAppInDir(dir: string): string | null {
  const entries = readdirSync(dir).filter((e) => e.endsWith('.app'));
  return entries.length > 0 ? join(dir, entries[0]) : null;
}

/**
 * Turn `source` (a .app dir, a .tar.gz, or a .zip) into a concrete .app directory,
 * extracting into `workDir` when needed. Returns the .app path.
 */
export function materializeAppBundle(source: string, workDir: string): string {
  const src = resolve(source);
  if (!existsSync(src)) throw new Error(`Source not found: ${src}`);

  if (src.endsWith('.app')) {
    return src;
  }
  if (src.endsWith('.tar.gz') || src.endsWith('.tgz')) {
    run('tar', ['-xzf', src, '-C', workDir]);
  } else if (src.endsWith('.zip')) {
    // ditto preserves macOS metadata + code signature better than unzip.
    run('ditto', ['-x', '-k', src, workDir]);
  } else {
    throw new Error(`Unsupported source (expect .app, .tar.gz, or .zip): ${src}`);
  }
  const app = findAppInDir(workDir);
  if (!app) throw new Error(`No .app found inside archive: ${src}`);
  return app;
}

// ─── Core install (atomic swap, no-quarantine) ─────────────────────────────────

export interface InstallResult {
  version: string | null;
  path: string;
  replaced: boolean;
  wasRunning: boolean;
  /** Result of `codesign --verify` on the installed bundle (null = check errored). */
  signatureValid: boolean | null;
}

/** Verify a bundle's code signature. Returns true/false, or null if codesign errored unexpectedly. */
export function verifyCodesign(appDir: string): boolean | null {
  try {
    execFileSync('codesign', ['--verify', '--deep', appDir], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide "is the app running" from a process listing.
 *
 * Split out from {@link isAppRunning} so the rule is testable without a running app: the
 * caller supplies `ps` output and this answers. `selfPid` is excluded because `app install
 * --from .../dreamcontext-beta.app` and `app status` both carry the bundle path on their OWN
 * command line, and a check that matches itself always says yes.
 *
 * The marker is the bundle's EXECUTABLE directory, never the bundle name alone: only a
 * launched app runs out of `<bundle>/Contents/MacOS/`, while the name appears in any command
 * that merely mentions the path.
 */
export function appRunningIn(psOutput: string, selfPid: number, marker: string): boolean {
  // An ABSOLUTE marker is anchored to the start of the command, never merely contained in it.
  // `/Applications/…` is a SUFFIX of `/Users/me/Applications/…`, so a substring test reports
  // the copy under the home directory as the one in /Applications — which is exactly the
  // situation this check has to tell apart, since the duplicate is what prompted the fix.
  // A relative marker (the bundle-name fallback, when no install path is known) has no
  // anchor available and stays a containment test.
  const anchored = marker.startsWith('/');
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    if (Number(m[1]) === selfPid) continue;
    if (anchored ? m[2].startsWith(marker) : m[2].includes(marker)) return true;
  }
  return false;
}

/**
 * True if a dreamcontext-beta process is currently running.
 *
 * ── Why this reads `ps` and not `pgrep` (measured 2026-09-21) ───────────────────────
 * It used to be `pgrep -f "<bundle>/Contents/MacOS/"`, and that answered "no" for an app the
 * owner was looking at. Two independent reasons, either one fatal:
 *
 *   1. macOS `pgrep -f` matches only the first ~66 characters of a process's argument
 *      string. At the default install path the marker lands at chars 35..72 and straddles
 *      the cutoff, so it can never be seen — 100% of the time, not intermittently.
 *   2. Worse, and the one that made the first explanation look sufficient when it was not:
 *      `pgrep` cannot see some live processes AT ALL. Measured on this machine while the app
 *      was running from `/Applications` (marker at chars 15..51, comfortably inside any
 *      truncation window): `ps -A` listed 660 processes, `pgrep -f .` listed 644, and the
 *      app was in the 16-process difference. No pattern found it — not the full path, not
 *      the bare binary name, not a five-character prefix.
 *
 * `ps -Ao pid=,args=` lists it with its full argv in the same shell, so the fix is to stop
 * asking pgrep. That also retires the conflict the old comment was stuck in: the marker had
 * been lengthened past the bare bundle name to stop the command from matching itself, which
 * is exactly what pushed it out of pgrep's window. Matching in-process lets us keep the long
 * marker AND drop our own pid, so both constraints hold at once.
 *
 * `path` narrows the check to ONE bundle — the installed one — so a stale copy somewhere
 * else on disk is not reported as "your app is running".
 */
export function isAppRunning(path?: string): boolean {
  try {
    const out = execFileSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 }).toString();
    const marker = path ? join(path, 'Contents', 'MacOS') + '/' : `${APP_BUNDLE_NAME}/Contents/MacOS/`;
    return appRunningIn(out, process.pid, marker);
  } catch {
    // `ps` failing is not evidence the app is stopped, but a status line has to say
    // something; "no" is the same answer the old code gave and the safer one to act on.
    return false;
  }
}

/**
 * Install a .app bundle from `source` into `installDir`, atomically.
 *
 * Crucially, delivery is via CLI tools (tar/ditto/cp) which do NOT set the
 * macOS `com.apple.quarantine` attribute — so Gatekeeper's notarization check
 * never fires and the ad-hoc-signed app launches without a right-click dance.
 * We still strip quarantine defensively in case the source carried it.
 */
export function installAppBundle(
  source: string,
  opts: { installDir?: string; sourceLabel?: string; home?: string } = {},
): InstallResult {
  if (detectPlatform().os !== 'darwin') {
    throw new Error('Desktop app install is currently macOS-only.');
  }
  const home = opts.home ?? homedir();
  const installDir = opts.installDir ?? defaultInstallDir(home);
  mkdirSync(installDir, { recursive: true });

  const workDir = mkdtempSync(join(tmpdir(), 'dc-app-'));
  try {
    const appDir = materializeAppBundle(source, workDir);
    validateAppBundle(appDir);

    const target = join(installDir, APP_BUNDLE_NAME);
    const staging = join(installDir, `.${APP_BUNDLE_NAME}.new-${process.pid}`);
    const backup = join(installDir, `.${APP_BUNDLE_NAME}.old-${process.pid}`);

    // Clean any leftover staging/backup from a prior crash.
    rmSync(staging, { recursive: true, force: true });
    rmSync(backup, { recursive: true, force: true });

    let wasRunning: boolean;
    let replaced: boolean;
    try {
      // Copy into the install volume (ditto preserves signature + metadata).
      run('ditto', [appDir, staging]);
      // Belt-and-suspenders: ensure no quarantine bit survives onto the staged copy.
      try {
        run('xattr', ['-dr', 'com.apple.quarantine', staging]);
      } catch {
        /* no quarantine attr present — fine */
      }

      wasRunning = isAppRunning();
      replaced = existsSync(target);

      // Atomic-ish swap on the same volume.
      if (replaced) renameSync(target, backup);
      renameSync(staging, target);
    } catch (e) {
      // Roll back if the final rename failed after moving the old bundle aside.
      if (existsSync(target) === false && existsSync(backup)) {
        try {
          renameSync(backup, target);
        } catch {
          /* best-effort rollback */
        }
      }
      // Never leave a half-written staging bundle behind on the install volume.
      rmSync(staging, { recursive: true, force: true });
      throw e;
    }
    rmSync(backup, { recursive: true, force: true });

    const version = readBundleVersion(target);
    writeAppManifest(
      {
        version: version ?? 'unknown',
        path: target,
        installedAt: Date.now(),
        source: opts.sourceLabel ?? 'local',
      },
      home,
    );

    const signatureValid = verifyCodesign(target);
    return { version, path: target, replaced, wasRunning, signatureValid };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// ─── GitHub release source (structured; usable once Faz 1 publishes) ────────────

interface GithubAsset {
  name: string;
  browser_download_url: string;
}
interface GithubRelease {
  tag_name: string;
  assets: GithubAsset[];
}

/** Strip a leading 'v' from a release tag → bare semver. */
export function versionFromTag(tag: string): string {
  return tag.replace(/^v/, '');
}

/**
 * Fetch the latest desktop release metadata from GitHub. Returns null on any
 * failure (offline, no releases yet, rate-limited). Never throws.
 */
export async function fetchLatestRelease(
  repo: string = APP_RELEASE_REPO,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubRelease | null> {
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dreamcontext-cli' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as GithubRelease;
    if (!json || typeof json.tag_name !== 'string' || !Array.isArray(json.assets)) return null;
    return json;
  } catch {
    return null;
  }
}

/** Download a URL to a local file via fetch (no quarantine bit, unlike a browser). */
async function downloadTo(url: string, destFile: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'dreamcontext-cli' } });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(destFile, buf);
}

/** SHA-256 of a file, hex. */
function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Resolve + download the latest release artifact for this platform into a temp
 * file, verifying its checksum if a matching `<asset>.sha256` asset is present.
 * Returns { archivePath, version } or null if no suitable release exists.
 */
export async function downloadLatestArtifact(
  repo: string = APP_RELEASE_REPO,
  fetchImpl: typeof fetch = fetch,
): Promise<{ archivePath: string; version: string } | null> {
  const plat = detectPlatform();
  if (plat.os !== 'darwin') return null;
  const release = await fetchLatestRelease(repo, fetchImpl);
  if (!release) return null;
  const assetName = pickAssetForArch(release.assets.map((a) => a.name), plat.arch);
  if (!assetName) return null;
  const asset = release.assets.find((a) => a.name === assetName)!;

  // REQUIRE a checksum. A downloaded artifact is installed (often by the silent
  // background auto-update path), so we must not install an unverified binary.
  // The .sha256 must be published alongside each asset (CI's job). If it's
  // missing, refuse rather than trust the download. (ad-hoc code-signing proves
  // integrity-in-transit at best, never origin — it is NOT a substitute.)
  const sumAsset = release.assets.find((a) => a.name === `${assetName}.sha256`);
  if (!sumAsset) {
    throw new Error(
      `Release ${release.tag_name} is missing ${assetName}.sha256 — refusing to install an unverified binary.`,
    );
  }

  const workDir = mkdtempSync(join(tmpdir(), 'dc-app-dl-'));
  try {
    const archivePath = join(workDir, assetName);
    await downloadTo(asset.browser_download_url, archivePath, fetchImpl);

    const sumFile = join(workDir, `${assetName}.sha256`);
    await downloadTo(sumAsset.browser_download_url, sumFile, fetchImpl);
    const expected = readFileSync(sumFile, 'utf-8').trim().split(/\s+/)[0].toLowerCase();
    const actual = sha256File(archivePath).toLowerCase();
    if (!expected || expected !== actual) {
      throw new Error(`Checksum mismatch for ${assetName}: expected ${expected || '(empty)'}, got ${actual}`);
    }

    return { archivePath, version: versionFromTag(release.tag_name) };
  } catch (e) {
    rmSync(workDir, { recursive: true, force: true });
    throw e;
  }
}

// ─── Auto-sync trigger (rides the CLI hook's 24h cadence) ──────────────────────
//
// Most updates need NO app replacement — the app runs the global CLI (thin-shell
// pivot), so server/dashboard/logic updates ride the CLI auto-upgrade. Only when
// the Tauri SHELL itself changes (and a new .app release is published) does the
// bundle need replacing. This trigger covers that rare case: when the app is
// already installed, kick off a best-effort `dreamcontext app update` in the
// background. It no-ops gracefully until GitHub releases exist (Faz 1).

/** App auto-update is on by default; opt out with DREAMCONTEXT_APP_AUTO_UPDATE=0 (or master =0). */
export function appAutoUpdateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DREAMCONTEXT_VERSION_CHECK === '0') return false;
  return env.DREAMCONTEXT_APP_AUTO_UPDATE !== '0';
}

export type AppUpdateSpawner = () => void;

function defaultAppUpdateSpawner(): void {
  // Re-invoke this CLI's `app update` detached so the hot path never blocks.
  const child = spawnProcess(process.execPath, [process.argv[1], 'app', 'update'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

/**
 * Best-effort: trigger a background app update when the app is installed and
 * auto-update is enabled. Returns true if a trigger was fired. Never throws.
 * Only updates an ALREADY-INSTALLED app — never auto-installs (that would be a
 * surprising macOS-only side effect for plain CLI users).
 */
export function maybeTriggerAppUpdate(
  env: NodeJS.ProcessEnv = process.env,
  deps: { spawner?: AppUpdateSpawner; manifest?: AppManifest | null } = {},
): boolean {
  try {
    if (detectPlatform().os !== 'darwin') return false;
    if (!appAutoUpdateEnabled(env)) return false;
    const installed = deps.manifest !== undefined ? deps.manifest : readAppManifest();
    if (!installed) return false;
    (deps.spawner ?? defaultAppUpdateSpawner)();
    return true;
  } catch {
    return false;
  }
}

// ─── Command actions ────────────────────────────────────────────────────────────

async function doInstall(from: string | undefined, dir: string | undefined): Promise<void> {
  const plat = detectPlatform();
  if (plat.os !== 'darwin') {
    console.log(chalk.yellow('The desktop app is currently macOS-only. Windows/Linux support is planned.'));
    return;
  }

  // For a downloaded artifact we own the temp dir and must clean it up.
  let tempToClean: string | null = null;
  let source = from;
  let sourceLabel = 'local';
  if (!source) {
    console.log(chalk.cyan('Fetching the latest desktop app from GitHub Releases…'));
    let dl: { archivePath: string; version: string } | null = null;
    try {
      dl = await downloadLatestArtifact();
    } catch (e) {
      console.log(chalk.red(`Install aborted: ${(e as Error).message}`));
      return;
    }
    if (!dl) {
      console.log(
        chalk.yellow(
          'No published desktop release found yet.\n' +
            'Build one locally and install it with:  dreamcontext app install --from <path-to.app|.tar.gz>',
        ),
      );
      return;
    }
    source = dl.archivePath;
    sourceLabel = 'github';
    tempToClean = dirname(dl.archivePath);
  }

  try {
    const res = installAppBundle(source, { installDir: installDirFor(dir), sourceLabel });
    console.log(chalk.green(`✓ Installed dreamcontext-beta ${res.version ?? ''}`.trim()) + chalk.dim(` → ${res.path}`));
    if (res.signatureValid === false) {
      console.log(
        chalk.yellow(
          'Warning: the installed app failed code-signature verification. It may still launch (ad-hoc),\n' +
            'but the published artifact should be properly ad-hoc deep-signed at build time.',
        ),
      );
    }
    if (res.wasRunning) {
      console.log(chalk.yellow('The app is currently running — restart it to apply the update.'));
    } else {
      console.log(chalk.dim(`Launch it:  open "${res.path}"`));
    }
  } finally {
    if (tempToClean) rmSync(tempToClean, { recursive: true, force: true });
  }
}

async function doUpdate(from: string | undefined, dir: string | undefined): Promise<void> {
  const installed = readAppManifest();
  if (!installed) {
    console.log(chalk.dim('No installed app recorded — running a fresh install.'));
    await doInstall(from, dir);
    return;
  }
  if (from) {
    await doInstall(from, dir);
    return;
  }
  let dl: { archivePath: string; version: string } | null = null;
  try {
    dl = await downloadLatestArtifact();
  } catch (e) {
    console.log(chalk.red(`Update aborted: ${(e as Error).message}`));
    return;
  }
  if (!dl) {
    console.log(chalk.yellow('No published desktop release available to update to.'));
    return;
  }
  // Own the downloaded temp dir for the whole update; always clean it up.
  try {
    if (compareVersions(installed.version, dl.version) >= 0) {
      console.log(chalk.green(`Desktop app is up to date (${installed.version}).`));
      return;
    }
    const res = installAppBundle(dl.archivePath, { installDir: installDirFor(dir), sourceLabel: 'github' });
    console.log(chalk.green(`✓ Updated dreamcontext-beta ${installed.version} → ${res.version ?? dl.version}`));
    if (res.wasRunning) console.log(chalk.yellow('Restart the app to apply the update.'));
  } finally {
    rmSync(dirname(dl.archivePath), { recursive: true, force: true });
  }
}

function doStatus(): void {
  const installed = readAppManifest();
  if (!installed) {
    console.log('Desktop app: not installed (run `dreamcontext app install`).');
    return;
  }
  const onDisk = existsSync(installed.path);
  console.log(`Desktop app: ${installed.version}`);
  console.log(`  path:      ${installed.path}${onDisk ? '' : chalk.red('  (missing!)')}`);
  console.log(`  source:    ${installed.source}`);
  console.log(`  running:   ${isAppRunning(installed.path) ? 'yes' : 'no'}`);
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerAppCommand(program: Command): void {
  const app = program.command('app').description('Manage the dreamcontext desktop app (install / update / status)');

  app
    .command('install')
    .description('Install the desktop app (no quarantine, no admin)')
    .option('--from <path>', 'Install from a local .app, .tar.gz, or .zip instead of GitHub Releases')
    .option('--dir <dir>', 'Install directory (default: beside the installed app, else ~/Applications)')
    .action(async (opts: { from?: string; dir?: string }) => {
      await doInstall(opts.from, opts.dir);
    });

  app
    .command('update')
    .description('Update the installed desktop app to the latest version')
    .option('--from <path>', 'Update from a local artifact instead of GitHub Releases')
    .option('--dir <dir>', 'Install directory (default: beside the installed app, else ~/Applications)')
    .action(async (opts: { from?: string; dir?: string }) => {
      await doUpdate(opts.from, opts.dir);
    });

  app
    .command('status')
    .description('Show the installed desktop app version and state')
    .action(() => {
      doStatus();
    });
}
