/**
 * Codex as a dreamcontext dependency: one pinned version from the official npm registry, unpacked
 * under `~/.dreamcontext/tools/codex`, beside anything the user has. The user's nvm, Homebrew and
 * global npm folders are never written to, so an install of theirs is never replaced; the finder
 * reads the managed folder first, which is how an update reaches them without touching theirs.
 *
 * The launcher it writes execs the native program, so it depends on no PATH and no Node.
 * Nothing lands until it passed: npm's own record of what it fetched must name the official
 * registry and the sha512 pinned in `codex-pin.ts`, and the program must answer `--version`.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { managedCodexBin, managedCodexBinDir, managedCodexRoot } from '../codex-bin.js';
import { CODEX_PIN, type CodexPlatform } from '../codex-pin.js';
import { DownloadError, type downloadVerified } from './download.js';
import { managedNodeRoot, managedNpmGlobal } from './platform.js';

export interface CodexInstallResult {
  ok: boolean;
  reason?: 'refused' | 'checksum' | 'failed' | 'canceled' | 'timeout' | 'permission' | 'offline';
  detail?: string;
}

export interface CodexInstallEnv {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** Runs a program with no shell; `stream` lines reach the person's progress view. */
  run(file: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; stream?: boolean }): Promise<{ ok: boolean; stdout: string; stderr: string; canceled?: boolean; timedOut?: boolean }>;
  /** One line of progress for the person watching. */
  say(line: string): void;
  npm: string | null;
  env: NodeJS.ProcessEnv;
}

const NPM_TIMEOUT_MS = 8 * 60_000;
const refuse = (detail: string): CodexInstallResult => ({ ok: false, reason: 'refused', detail });

export function codexPlatformKey(platform: NodeJS.Platform, arch: string): CodexPlatform | null {
  const key = `${platform}-${arch}`;
  return key in CODEX_PIN.platforms ? key as CodexPlatform : null;
}

const isLink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** A folder name that is safe between double quotes in the launcher. */
const SHELL_SAFE = /^[A-Za-z0-9._\/ +@,=-]+$/;

/** The launcher: no Node, no PATH. The first comment line is how the version is read back. */
export function codexLauncher(native: string, packageRoot: string, version: string): string {
  return [
    '#!/bin/sh',
    `# dreamcontext codex ${version}`,
    `export CODEX_MANAGED_PACKAGE_ROOT="${packageRoot}"`,
    'export CODEX_MANAGED_BY_NPM=1',
    `exec "${native}" "$@"`,
    '',
  ].join('\n');
}

interface LockEntry { resolved?: string; integrity?: string }

/** What npm says it fetched must be what the pin names. Empty = fine, else why not. */
export function verifyFetched(lockText: string, key: CodexPlatform): string {
  const packages: Record<string, LockEntry> = {};
  try {
    // npm keys this file relative to where it ran, so the prefix of a key means nothing.
    const raw = (JSON.parse(lockText) as { packages?: Record<string, LockEntry> }).packages ?? {};
    for (const [k, v] of Object.entries(raw)) if (k) packages[k.slice(Math.max(0, k.lastIndexOf('node_modules/')))] = v;
  } catch { return 'npm left no readable record of the download.'; }
  const want: Array<[string, string]> = [
    [`node_modules/${CODEX_PIN.package}`, CODEX_PIN.integrity],
    [`node_modules/${CODEX_PIN.package}-${key}`, CODEX_PIN.platforms[key].integrity],
  ];
  for (const [path, integrity] of want) {
    const e = packages[path];
    if (!e) return `${path} was not installed.`;
    if (!e.resolved?.startsWith(CODEX_PIN.registry)) return `${path} did not come from the official npm registry.`;
    if (e.integrity !== integrity) return `${path} does not match the pinned hash.`;
  }
  // Nothing else may have arrived with it: Codex has no other dependency.
  const extra = Object.keys(packages).filter((p) => p && !want.some(([w]) => w === p));
  return extra.length ? `Unexpected package: ${extra[0]}` : '';
}

function failed(r: { canceled?: boolean; timedOut?: boolean; stderr: string; stdout: string }, what: string): CodexInstallResult {
  if (r.canceled) return { ok: false, reason: 'canceled', detail: 'Canceled.' };
  if (r.timedOut) return { ok: false, reason: 'timeout', detail: `${what} took too long.` };
  const all = `${r.stdout}\n${r.stderr}`;
  if (/ENOTFOUND|ETIMEDOUT|ECONNRE|EAI_AGAIN|\bnetwork\b/i.test(all)) return { ok: false, reason: 'offline', detail: `${what} could not reach the npm registry. Check your internet connection and try again.` };
  if (/EACCES|permission denied/i.test(all)) return { ok: false, reason: 'permission', detail: `${what} was not allowed to write its folder.` };
  // npm ends on where its log went; the reason is the line before that.
  const why = all.split('\n').map((l) => l.trim()).filter((l) => l && !/complete log|debug-0\.log|^npm (ERR!|error)\s*$/.test(l)).pop();
  return { ok: false, reason: 'failed', detail: why ? why.slice(0, 200) : `${what} did not finish.` };
}

/** Fetch, verify and land the pinned Codex. Never throws; the old install stays on any failure. */
export async function installManagedCodex(e: CodexInstallEnv): Promise<CodexInstallResult> {
  const key = codexPlatformKey(e.platform, e.arch);
  if (!key) return refuse('Codex has no automatic install for this system yet.');
  if (!e.npm) return { ok: false, reason: 'failed', detail: 'npm was not found.' };
  const root = managedCodexRoot(e.home);
  if (!SHELL_SAFE.test(root)) return refuse("Your home folder's name can't be used for the install.");
  for (const p of [join(e.home, '.dreamcontext'), join(e.home, '.dreamcontext', 'tools'), root, managedCodexBinDir(e.home), join(root, 'versions')]) {
    if (isLink(p)) return refuse('A dreamcontext folder points somewhere else.');
  }
  mkdirSync(join(root, 'versions'), { recursive: true });
  mkdirSync(managedCodexBinDir(e.home), { recursive: true });
  const partial = mkdtempSync(join(root, '.partial-'));
  try {
    e.say(`Downloading Codex ${CODEX_PIN.version} from npm`);
    const r = await e.run(e.npm, [
      'install', `${CODEX_PIN.package}@${CODEX_PIN.version}`,
      '--prefix', partial,
      `--registry=${CODEX_PIN.registry}`, `--@openai:registry=${CODEX_PIN.registry}`,
      '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier', '--no-save',
    ], { cwd: e.home, env: { ...e.env, npm_config_prefix: undefined, npm_config_global: undefined }, timeoutMs: NPM_TIMEOUT_MS, stream: true });
    if (!r.ok) return failed(r, 'The Codex download');

    e.say('Checking the download against the pinned hash');
    const lock = join(partial, 'node_modules', '.package-lock.json');
    const bad = verifyFetched(existsSync(lock) ? readFileSync(lock, 'utf-8') : '', key);
    if (bad) return { ok: false, reason: 'checksum', detail: bad };
    const relNative = join('node_modules', '@openai', `codex-${key}`, 'vendor', CODEX_PIN.platforms[key].triple, 'bin', 'codex');
    if (!existsSync(join(partial, relNative)) || isLink(join(partial, relNative))) return { ok: false, reason: 'failed', detail: 'The Codex package did not contain the program.' };

    const version = join(root, 'versions', CODEX_PIN.version);
    rmSync(version, { recursive: true, force: true });
    renameSync(partial, version);
    const bin = managedCodexBin(e.home);
    const staged = `${bin}.new`;
    writeFileSync(staged, codexLauncher(join(version, relNative), join(version, 'node_modules', '@openai', 'codex'), CODEX_PIN.version), { mode: 0o755 });
    chmodSync(staged, 0o755);
    const v = await e.run(staged, ['--version'], { cwd: e.home, env: e.env, timeoutMs: 20_000 });
    if (!v.ok || !v.stdout.includes(CODEX_PIN.version)) {
      rmSync(staged, { force: true });
      return { ok: false, reason: 'failed', detail: 'Codex was downloaded but does not start.' };
    }
    renameSync(staged, bin);
    for (const name of readdirSync(join(root, 'versions'))) {
      if (name !== CODEX_PIN.version) rmSync(join(root, 'versions', name), { recursive: true, force: true });
    }
    e.say(`Codex ${CODEX_PIN.version} is installed`);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'failed', detail: (err as Error).message };
  } finally {
    rmSync(partial, { recursive: true, force: true });
  }
}

export interface NodePins { version: string; base: string; files: Record<string, { file: string; sha256: string; size: number }> }

/**
 * A Node at the bridge floor where none exists: the same pinned, checksum-verified build and the
 * same layout as `install.sh` and the desktop shell (`~/.dreamcontext/node/<version>`, `current`).
 * It sits beside the machine's default Node and changes nothing about it.
 */
export async function installPinnedNode(e: {
  home: string; platform: NodeJS.Platform; arch: string; pins: NodePins;
  download: typeof downloadVerified; signal: AbortSignal; say(line: string): void;
  progress(received: number, total: number): void;
  run: CodexInstallEnv['run'];
}): Promise<CodexInstallResult> {
  const pin = e.pins.files[`${e.platform}-${e.arch}`];
  if (!pin) return refuse('No Node download for this system.');
  const root = managedNodeRoot(e.home);
  if (isLink(root)) return refuse('A dreamcontext folder points somewhere else.');
  mkdirSync(root, { recursive: true });
  const target = join(root, e.pins.version);
  if (!existsSync(join(target, 'bin', 'node'))) {
    const partial = mkdtempSync(join(root, '.partial-'));
    try {
      e.say(`Downloading Node ${e.pins.version}`);
      const archive = join(partial, pin.file);
      await e.download(`${e.pins.base}${pin.file}`, { sha256: pin.sha256, maxBytes: pin.size, dest: archive, signal: e.signal, onProgress: (r, t) => e.progress(r, t ?? pin.size) });
      const un = await e.run('tar', ['-xzf', archive, '-C', partial, '--strip-components=1'], { timeoutMs: 120_000 });
      if (!un.ok) return failed(un, 'Unpacking Node');
      rmSync(archive, { force: true });
      writeFileSync(join(partial, 'etc-npmrc'), `prefix=${managedNpmGlobal(e.home)}\n`);
      mkdirSync(join(partial, 'etc'), { recursive: true });
      renameSync(join(partial, 'etc-npmrc'), join(partial, 'etc', 'npmrc'));
      renameSync(partial, target);
    } catch (err) {
      rmSync(partial, { recursive: true, force: true });
      return err instanceof DownloadError ? { ok: false, reason: err.reason === 'refused' ? 'refused' : err.reason === 'checksum' ? 'checksum' : err.reason === 'offline' ? 'offline' : 'failed', detail: err.message } : { ok: false, reason: 'failed', detail: (err as Error).message };
    }
  }
  const current = join(root, 'current');
  if (!existsSync(current)) {
    const staged = `${current}.new`;
    rmSync(staged, { force: true });
    symlinkSync(e.pins.version, staged);
    renameSync(staged, current);
  }
  return { ok: true };
}
