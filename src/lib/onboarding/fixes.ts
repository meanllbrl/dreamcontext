import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import runtimePins from '../../../assets/runtime-pins.json' with { type: 'json' };
import { accountEnvFor, resolveConfigDir } from '../claude-accounts.js';
import { claudeAuthStatus, resetClaudeAuthCache } from '../claude-auth.js';
import {
  CLI_RC_MARKER, NODE_RC_MARKER, RC_MARKER, claudeAwarePath, ensureDirOnShellPath, findClaudeBin, fixClaudeShellPath,
  type ShellPathFix,
} from '../claude-path.js';
import { ensureCliInstalled, type EnsureCliResult } from '../ensure-cli.js';
import { cliAwarePath } from '../automations/cli-path.js';
import { withNodeDirOnPath } from '../git-sync/credentials.js';
import { commandLineToolsInstalled, gitAvailable } from '../git-sync/git.js';
import { DownloadError, downloadVerified } from './download.js';
import { defaultGithubDeps, runGhSignin, runGithubSignin, type GhExec, type GithubDeps } from './github.js';
import { managedNodeRoot, managedNpmGlobal } from './platform.js';
import { SHELL_FACTS_SCRIPT, parseShellFacts, resolveTestSeamUrl } from './runner.js';
import type { FixId, ProbeContext, ShellFacts, ShellResult } from './types.js';

// ─── Contract (plan §3) ────────────────────────────────────────────────────────

/** Where a fix run reports to: the server's run store, or the CLI's terminal. */
export interface RunSink {
  output(chunk: string): void;
  progress(received: number, total: number | null): void;
  awaiting(kind: 'browser' | 'system-dialog' | null): void;
  deviceCode(c: { userCode: string; verificationUri: string; expiresAt: number }): void;
  onCancel(kill: () => void): void;
}

export interface FixOutcome {
  ok: boolean;
  reason?: 'offline' | 'permission' | 'checksum' | 'timeout' | 'canceled' | 'refused' | 'failed';
  detail?: string;
}

export interface FixOptions {
  /** Default true. False is the old `/api/agent/install` `git` behaviour: done once the macOS dialog opens. */
  waitForDialog?: boolean;
}

/** The argv a TTY runs with inherited stdio for a sign-in (the CLI surface). */
export const CLI_INTERACTIVE: Partial<Record<FixId, string[]>> = {
  'claude-signin': ['claude', 'auth', 'login'],
  'github-signin': ['gh', 'auth', 'login', '--web', '--git-protocol', 'https'],
  'gh-signin': ['gh', 'auth', 'login', '--web', '--git-protocol', 'https'],
};

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Anthropic's native installer. Constant: never built from input. */
export const CLAUDE_INSTALLER_URL = 'https://claude.ai/install.sh';
/** Seam for the browser verify: honoured only as plain http on 127.0.0.1. */
export const CLAUDE_INSTALLER_SEAM = 'DREAMCONTEXT_CLAUDE_INSTALLER_URL';
const CLAUDE_INSTALLER_MAX_BYTES = 1024 * 1024;
const CLAUDE_INSTALL_TIMEOUT_MS = 10 * 60_000;
const CLAUDE_LOGIN_TIMEOUT_MS = 5 * 60_000;
const NPM_TIMEOUT_MS = 5 * 60_000;
const DIALOG_POLL_MS = 5_000;
const DIALOG_WAIT_MS = 30 * 60_000;
const SHELL_LOOKUP_TIMEOUT_MS = 15_000;
const VERSION_TIMEOUT_MS = 15_000;

interface GhPin { file: string; sha256: string; size: number; format: 'zip' | 'tar.gz' }
interface Pins { gh: { version: string; base: string; files: Record<string, GhPin> } }

// ─── Injectable effects ────────────────────────────────────────────────────────

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  input?: string;
  /** Stream stdout/stderr to the sink as it arrives. Off for anything that may print a secret. */
  stream?: boolean;
}

export type RunResult = ShellResult & { canceled?: boolean; timedOut?: boolean };

/** Everything a recipe does to the outside world. Tests replace any of it. */
export interface FixDeps {
  /** Spawn `file args` (no shell), in its own process group; cancel and timeout kill the group. */
  run(file: string, args: string[], o: RunOptions, sink: RunSink, signal: AbortSignal): Promise<RunResult>;
  download: typeof downloadVerified;
  ensureCliInstalled(onOutput: (chunk: string) => void): Promise<EnsureCliResult>;
  addToShellPath(dir: string, marker: string): ShellPathFix;
  fixClaudeShellPath(): { ok: boolean; message: string };
  findClaudeBin(): string | null;
  preferredConfigDir(): string;
  accountEnv(configDir: string): Record<string, string | undefined>;
  claudeLogin(o: { configDir: string; onSpawned: (pid: number) => void }): Promise<{ spawned: boolean; timedOut: boolean }>;
  claudeLoggedIn(configDir: string): Promise<boolean>;
  cltInstalled(): boolean;
  gitUsable(): boolean;
  ptyInstallDir(): Promise<string | null>;
  /** Homebrew, from what the login shell found or its usual folders. */
  brewPath(facts: ShellFacts): string | null;
  /** The GitHub command line tool, from the login shell or its usual folders. */
  ghPath(home: string, facts: ShellFacts): string | null;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  pins: Pins;
  github: GithubDeps;
  env: NodeJS.ProcessEnv;
}

// ─── Process plumbing ──────────────────────────────────────────────────────────

function killGroup(pid: number): void {
  try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 3_000).unref();
}

const OUTPUT_CAP = 16_000;

function defaultRun(file: string, args: string[], o: RunOptions, sink: RunSink, signal: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let canceled = false;
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: (err as Error).message, code: null });
      return;
    }
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const kill = () => { if (child.pid) killGroup(child.pid); };
    const onAbort = () => { canceled = true; kill(); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    sink.onCancel(onAbort);
    if (signal.aborted) onAbort();
    const take = (which: 'out' | 'err') => (c: Buffer) => {
      const text = c.toString('utf-8');
      if (which === 'out') stdout = (stdout + text).slice(-OUTPUT_CAP);
      else stderr = (stderr + text).slice(-OUTPUT_CAP);
      if (o.stream) sink.output(text);
    };
    child.stdout?.on('data', take('out'));
    child.stderr?.on('data', take('err'));
    child.on('error', (err) => finish({ ok: false, stdout, stderr: `${stderr}${err.message}`, code: null, canceled, timedOut }));
    child.on('close', (code) => finish({ ok: code === 0 && !canceled && !timedOut, stdout, stderr, code, canceled, timedOut }));
    if (o.input !== undefined) child.stdin?.end(o.input);
    else child.stdin?.end();
  });
}

const BREW_CANDIDATES = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew', '/home/linuxbrew/.linuxbrew/bin/brew'];

function ghCandidates(home: string): string[] {
  return [join(home, '.local', 'bin', 'gh'), '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];
}

export const defaultFixDeps: FixDeps = {
  run: defaultRun,
  download: downloadVerified,
  ensureCliInstalled: (onOutput) => ensureCliInstalled(undefined, { onOutput }),
  addToShellPath: (dir, marker) => ensureDirOnShellPath(dir, marker),
  fixClaudeShellPath,
  findClaudeBin,
  preferredConfigDir: () => resolveConfigDir(null),
  accountEnv: (configDir) => accountEnvFor(configDir),
  async claudeLogin({ configDir, onSpawned }) {
    // Lazy: the automations runner is heavy and only this recipe needs it.
    const { executeClaudeDetached } = await import('../automations/runner.js');
    const r = await executeClaudeDetached(['auth', 'login'], {
      cwd: homedir(),
      env: accountEnvFor(configDir),
      discardOutput: true,
      timeoutMs: CLAUDE_LOGIN_TIMEOUT_MS,
      onSpawned: (child) => { if (child.pid) onSpawned(child.pid); },
    });
    return { spawned: r.spawned, timedOut: r.timedOut };
  },
  async claudeLoggedIn(configDir) {
    resetClaudeAuthCache(configDir);
    return (await claudeAuthStatus(configDir)).loggedIn === true;
  },
  cltInstalled: commandLineToolsInstalled,
  gitUsable: () => gitAvailable(),
  async ptyInstallDir() {
    // Same folder the in-app installer has always used: the CLI's own package root, or
    // the user-level native-modules folder inside the .app (see agent-terminal.ts).
    const mod = await import('../../server/routes/agent-terminal.js');
    return mod.cliPackageRoot() ?? mod.ensureNativeModulesDir();
  },
  brewPath: (facts) => facts.brew ?? BREW_CANDIDATES.find((p) => existsSync(p)) ?? null,
  ghPath: (home, facts) => facts.gh ?? ghCandidates(home).find((p) => existsSync(p)) ?? null,
  sleep: (ms, signal) => new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  }),
  now: Date.now,
  pins: runtimePins as Pins,
  github: defaultGithubDeps,
  env: process.env,
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

const fail = (reason: NonNullable<FixOutcome['reason']>, detail: string): FixOutcome => ({ ok: false, reason, detail });

function runFailure(r: RunResult, what: string): FixOutcome {
  if (r.canceled) return fail('canceled', 'Canceled.');
  if (r.timedOut) return fail('timeout', `${what} took too long.`);
  if (/EACCES|permission denied/i.test(r.stderr)) return fail('permission', tail(r));
  return fail('failed', tail(r) || `${what} did not finish.`);
}

function tail(r: ShellResult): string {
  return `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-6).join('\n');
}

function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function isManagedNode(ctx: ProbeContext): boolean {
  return ctx.execPath.startsWith(managedNodeRoot(ctx.home) + sep);
}

/**
 * Environment with every credential-shaped variable removed, for running a script
 * downloaded from the internet: nothing it runs can read a token from its env.
 */
export function stripSecretsEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === 'GITHUB_TOKEN' || k === 'GH_TOKEN' || /_(TOKEN|KEY|SECRET)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** The env npm-based fixes run with: our node, the CLI shim, Claude's folder; the private prefix on the private Node. */
function npmEnv(ctx: ProbeContext, deps: FixDeps): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...deps.env, PATH: withNodeDirOnPath(cliAwarePath(claudeAwarePath(deps.env.PATH ?? ''))) };
  if (isManagedNode(ctx)) env.npm_config_prefix = managedNpmGlobal(ctx.home);
  return env;
}

let npmQueue: Promise<unknown> = Promise.resolve();
/** npm installs never run two at a time (they share one cache and one global folder). */
function withNpmLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = npmQueue.then(fn, fn);
  npmQueue = next.catch(() => undefined);
  return next;
}

async function shellFacts(ctx: ProbeContext): Promise<ShellFacts> {
  const r = await ctx.runner.loginShell(SHELL_FACTS_SCRIPT, SHELL_LOOKUP_TIMEOUT_MS);
  return parseShellFacts(r.stdout, process.env.SHELL || '/bin/zsh');
}

/** npm as a fresh login shell finds it, else the one beside the running node. */
function resolveNpm(ctx: ProbeContext, facts: ShellFacts): string | null {
  if (facts.npm) return facts.npm;
  const beside = join(dirname(ctx.execPath), 'npm');
  return existsSync(beside) ? beside : null;
}


function shellPathOutcome(fixes: ShellPathFix[]): FixOutcome {
  if (fixes.some((f) => f.refused)) return fail('refused', "That folder's name can't be added automatically.");
  if (fixes.every((f) => f.wrote.length > 0 || f.alreadyConfigured.length > 0)) return { ok: true };
  return fail('failed', 'Could not update your shell startup file.');
}

// ─── Recipes ───────────────────────────────────────────────────────────────────

interface RecipeEnv { ctx: ProbeContext; sink: RunSink; signal: AbortSignal; o: FixOptions; deps: FixDeps }

/** Put the running node (the private Node's stable folders) on the user's shell PATH. */
function nodeShellPath({ ctx, deps }: RecipeEnv): FixOutcome {
  const dirs = isManagedNode(ctx)
    ? [join(managedNodeRoot(ctx.home), 'current', 'bin'), join(managedNpmGlobal(ctx.home), 'bin')]
    : [dirname(ctx.execPath)];
  return shellPathOutcome(dirs.map((d) => deps.addToShellPath(d, NODE_RC_MARKER)));
}

/** Put the folder holding an installed-but-unseen `dreamcontext` on the shell PATH. */
function cliShellPath({ ctx, deps }: RecipeEnv): FixOutcome {
  const dir = [join(managedNpmGlobal(ctx.home), 'bin'), dirname(ctx.execPath)]
    .find((d) => existsSync(join(d, 'dreamcontext')));
  if (!dir) return fail('failed', 'dreamcontext was not found in a known folder.');
  return shellPathOutcome([deps.addToShellPath(dir, CLI_RC_MARKER)]);
}

async function cliInstall({ sink, deps }: RecipeEnv): Promise<FixOutcome> {
  const r = await withNpmLock(() => deps.ensureCliInstalled((c) => sink.output(c)));
  if (r.status === 'failed') return fail(/EACCES/.test(r.message ?? '') ? 'permission' : 'failed', r.message ?? 'Install failed.');
  return { ok: true };
}

/**
 * Anthropic's native installer, hardened: constant https URL (every redirect https), a
 * 1 MiB cap, a `#!` first line, written into a fresh 0700 folder (file opened `wx`), run
 * as `bash -- <file>` with every token-shaped variable stripped, the folder always
 * removed, and the result proven by `claude --version`. npm is the fallback when the
 * installer itself fails (never when the download was refused).
 */
async function claudeInstall(env: RecipeEnv): Promise<FixOutcome> {
  const { ctx, sink, signal, deps } = env;
  const seam = resolveTestSeamUrl(CLAUDE_INSTALLER_SEAM, deps.env);
  const url = seam ?? CLAUDE_INSTALLER_URL;
  const tmp = mkdtempSync(join(tmpdir(), 'dreamcontext-claude-install-'));
  try {
    chmodSync(tmp, 0o700);
    const script = join(tmp, 'install.sh');
    try {
      await deps.download(url, { maxBytes: CLAUDE_INSTALLER_MAX_BYTES, dest: script, signal, allowLoopback: seam !== null });
    } catch (err) {
      if (signal.aborted) return fail('canceled', 'Canceled.');
      const reason = err instanceof DownloadError ? err.reason : 'failed';
      return fail(reason === 'checksum' ? 'refused' : reason, (err as Error).message);
    }
    if (!readFileSync(script, 'utf-8').startsWith('#!')) return fail('refused', 'The installer did not look like a script.');
    chmodSync(script, 0o700);
    const run = await deps.run('/bin/bash', ['--', script], {
      cwd: ctx.home, env: stripSecretsEnv(deps.env), timeoutMs: CLAUDE_INSTALL_TIMEOUT_MS, stream: true,
    }, sink, signal);
    if (run.canceled) return fail('canceled', 'Canceled.');
    const installed = run.ok && (await claudeRuns(env, join(ctx.home, '.local', 'bin', 'claude')));
    if (!installed) {
      const viaNpm = await claudeViaNpm(env);
      if (!viaNpm.ok) return run.ok ? fail('failed', 'Claude was installed but does not start.') : runFailure(run, 'The Claude installer');
    }
    const path = deps.fixClaudeShellPath();
    sink.output(`${path.message}\n`);
    return { ok: true };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function claudeRuns({ sink, signal, deps }: RecipeEnv, bin: string | null): Promise<boolean> {
  if (!bin || !existsSync(bin)) return false;
  const r = await deps.run(bin, ['--version'], { timeoutMs: VERSION_TIMEOUT_MS }, sink, signal);
  return r.ok;
}

async function claudeViaNpm(env: RecipeEnv): Promise<FixOutcome> {
  const { ctx, sink, signal, deps } = env;
  const npm = resolveNpm(ctx, await shellFacts(ctx));
  if (!npm) return fail('failed', 'npm was not found.');
  const r = await withNpmLock(() => deps.run(npm, ['install', '-g', '@anthropic-ai/claude-code'], {
    env: npmEnv(ctx, deps), timeoutMs: NPM_TIMEOUT_MS, stream: true,
  }, sink, signal));
  if (!r.ok) return runFailure(r, 'The Claude install');
  return (await claudeRuns(env, deps.findClaudeBin())) ? { ok: true } : fail('failed', 'Claude was installed but does not start.');
}

function claudePath({ deps }: RecipeEnv): FixOutcome {
  const r = deps.fixClaudeShellPath();
  return r.ok ? { ok: true, detail: r.message } : fail('failed', r.message);
}

/** `claude auth login` into the account new sessions use; opens the browser itself. */
async function claudeSignin({ sink, signal, deps }: RecipeEnv): Promise<FixOutcome> {
  const configDir = deps.preferredConfigDir();
  let pid: number | null = null;
  let canceled = false;
  const cancel = () => { canceled = true; if (pid) killGroup(pid); };
  sink.onCancel(cancel);
  signal.addEventListener('abort', cancel, { once: true });
  sink.awaiting('browser');
  try {
    const r = await deps.claudeLogin({ configDir, onSpawned: (p) => { pid = p; if (canceled) killGroup(p); } });
    if (canceled || signal.aborted) return fail('canceled', 'Canceled.');
    if (!r.spawned) return fail('failed', 'Claude did not start.');
    if (r.timedOut) return fail('timeout', 'The sign-in timed out.');
    return (await deps.claudeLoggedIn(configDir)) ? { ok: true } : fail('failed', 'The sign-in did not complete.');
  } finally {
    sink.awaiting(null);
    signal.removeEventListener('abort', cancel);
  }
}

/** macOS: open Apple's developer-tools installer, then (by default) wait for it to land. */
async function gitInstall({ ctx, sink, signal, o, deps }: RecipeEnv): Promise<FixOutcome> {
  if (ctx.platform !== 'darwin') return fail('refused', 'Install git with your package manager.');
  if (deps.gitUsable()) return { ok: true };
  const r = await deps.run('xcode-select', ['--install'], { timeoutMs: 60_000, stream: true }, sink, signal);
  if (r.canceled) return fail('canceled', 'Canceled.');
  // Exit 1 with "already installed" is fine too; any other failure is real.
  if (!r.ok && !/already installed/i.test(`${r.stdout}${r.stderr}`)) return runFailure(r, 'The macOS installer');
  if (o.waitForDialog === false) return { ok: true };
  sink.awaiting('system-dialog');
  try {
    const deadline = deps.now() + DIALOG_WAIT_MS;
    while (deps.now() < deadline) {
      if (signal.aborted) return fail('canceled', 'Canceled.');
      if (deps.cltInstalled() || deps.gitUsable()) return { ok: true };
      await deps.sleep(DIALOG_POLL_MS, signal);
    }
    return fail('timeout', 'The macOS install did not finish in time.');
  } finally {
    sink.awaiting(null);
  }
}

function ghPinKey(platform: NodeJS.Platform, arch: string): string | null {
  const a = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;
  if (!a || (platform !== 'darwin' && platform !== 'linux')) return null;
  return `${platform}-${a}`;
}

/** The GitHub command line tool: Homebrew when present, else the pinned, checksum-verified archive. */
async function ghInstall(env: RecipeEnv): Promise<FixOutcome> {
  const { ctx, sink, signal, deps } = env;
  const facts = await shellFacts(ctx);
  const brew = deps.brewPath(facts);
  if (brew) {
    const r = await deps.run(brew, ['install', 'gh'], { timeoutMs: NPM_TIMEOUT_MS, stream: true }, sink, signal);
    return r.ok ? { ok: true } : runFailure(r, 'Homebrew');
  }
  const key = ghPinKey(ctx.platform, ctx.arch);
  const pin = key ? deps.pins.gh.files[key] : undefined;
  if (!pin) return fail('refused', 'No GitHub tools download for this system.');

  const dreamDir = join(ctx.home, '.dreamcontext');
  const tools = join(dreamDir, 'tools');
  if (isSymlink(dreamDir) || isSymlink(tools) || isSymlink(join(tools, 'gh'))) {
    return fail('refused', 'A dreamcontext folder points somewhere else.');
  }
  const linkDir = join(ctx.home, '.local', 'bin');
  const link = join(linkDir, 'gh');
  if (existsSync(link) || isSymlink(link)) return fail('refused', 'Something called gh is already installed in your local folder.');

  const versionDir = join(tools, 'gh', deps.pins.gh.version);
  const binary = join(versionDir, 'bin', 'gh');
  if (!existsSync(binary)) {
    const unpacked = await fetchGhArchive(env, pin, versionDir);
    if (!unpacked.ok) return unpacked;
  }
  mkdirSync(linkDir, { recursive: true });
  try {
    symlinkSync(binary, link);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EEXIST'
      ? fail('refused', 'Something called gh is already installed in your local folder.')
      : fail('failed', (err as Error).message);
  }
  const path = shellPathOutcome([deps.addToShellPath(linkDir, RC_MARKER)]);
  if (!path.ok) return path;
  const v = await deps.run(link, ['--version'], { timeoutMs: VERSION_TIMEOUT_MS }, sink, signal);
  return v.ok ? { ok: true } : fail('failed', 'GitHub tools were installed but do not start.');
}

/** Download + verify + unpack the pinned gh archive into `versionDir`. */
async function fetchGhArchive({ sink, signal, deps }: RecipeEnv, pin: GhPin, versionDir: string): Promise<FixOutcome> {
  const parent = dirname(versionDir);
  mkdirSync(parent, { recursive: true });
  const partial = mkdtempSync(join(parent, '.partial-'));
  try {
    const archive = join(partial, pin.file);
    try {
      await deps.download(`${deps.pins.gh.base}${pin.file}`, {
        sha256: pin.sha256, maxBytes: pin.size, dest: archive, signal,
        onProgress: (received, total) => sink.progress(received, total ?? pin.size),
      });
    } catch (err) {
      if (signal.aborted) return fail('canceled', 'Canceled.');
      return fail(err instanceof DownloadError ? err.reason : 'failed', (err as Error).message);
    }
    const root = join(partial, 'root');
    mkdirSync(root);
    const unpack = pin.format === 'zip'
      ? await deps.run('/usr/bin/ditto', ['-x', '-k', archive, root], { timeoutMs: 120_000 }, sink, signal)
      : await deps.run('tar', ['-xzf', archive, '-C', root], { timeoutMs: 120_000 }, sink, signal);
    if (!unpack.ok) return runFailure(unpack, 'Unpacking');
    const top = readdirSync(root).filter((n) => !n.startsWith('.'));
    const inner = top.length === 1 ? join(root, top[0]) : root;
    if (!existsSync(join(inner, 'bin', 'gh')) || isSymlink(join(inner, 'bin', 'gh'))) {
      return fail('failed', 'The GitHub tools archive did not contain the program.');
    }
    renameSync(inner, versionDir);
    return { ok: true };
  } finally {
    rmSync(partial, { recursive: true, force: true });
  }
}

/** A `gh` runner for the GitHub flows: no shell, `GH_TOKEN`/`GITHUB_TOKEN` removed so `gh` uses its own store. */
function ghExec(ghPath: string, env: RecipeEnv): GhExec {
  const { sink, signal, deps } = env;
  const childEnv = { ...deps.env };
  delete childEnv.GH_TOKEN;
  delete childEnv.GITHUB_TOKEN;
  return (args, o) => deps.run(ghPath, args, { timeoutMs: o.timeoutMs, input: o.input, env: childEnv, stream: false }, sink, signal);
}

async function resolveGh(ctx: ProbeContext, deps: FixDeps): Promise<string | null> {
  return deps.ghPath(ctx.home, await shellFacts(ctx));
}

async function githubSignin(env: RecipeEnv): Promise<FixOutcome> {
  const ghPath = await resolveGh(env.ctx, env.deps);
  const r = await runGithubSignin(ghPath ? ghExec(ghPath, env) : null, env.sink, env.signal, { ...env.deps.github, home: env.ctx.home });
  return r.ok ? { ok: true } : fail(r.reason, r.detail);
}

async function ghSignin(env: RecipeEnv): Promise<FixOutcome> {
  const ghPath = await resolveGh(env.ctx, env.deps);
  if (!ghPath) return fail('failed', "GitHub's command line tool is not installed.");
  const r = await runGhSignin(ghExec(ghPath, env), env.sink, env.signal, { ...env.deps.github, home: env.ctx.home });
  return r.ok ? { ok: true } : fail(r.reason, r.detail);
}

/** node-pty for the built-in terminal, into the same folder the in-app installer always used. */
async function ptyInstall({ ctx, sink, signal, deps }: RecipeEnv): Promise<FixOutcome> {
  const npm = resolveNpm(ctx, await shellFacts(ctx));
  if (!npm) return fail('failed', 'npm was not found.');
  const cwd = await deps.ptyInstallDir();
  if (!cwd) return fail('failed', "Couldn't find a folder to install the built-in terminal into.");
  const r = await withNpmLock(() => deps.run(npm, ['install', 'node-pty@^1.1.0', '--no-save'], {
    cwd, env: npmEnv(ctx, deps), timeoutMs: NPM_TIMEOUT_MS, stream: true,
  }, sink, signal));
  return r.ok ? { ok: true } : runFailure(r, 'The install');
}

const RECIPES: Readonly<Record<FixId, (env: RecipeEnv) => FixOutcome | Promise<FixOutcome>>> = {
  'node-shell-path': nodeShellPath,
  'cli-install': cliInstall,
  'cli-shell-path': cliShellPath,
  'claude-install': claudeInstall,
  'claude-path': claudePath,
  'claude-signin': claudeSignin,
  'git-install': gitInstall,
  'gh-install': ghInstall,
  'github-signin': githubSignin,
  'gh-signin': ghSignin,
  'pty-install': ptyInstall,
};

/**
 * Run one fix. Never throws: every failure comes back as a {@link FixOutcome} with a
 * reason and a plain detail. Active-state bookkeeping (`markFixActive`/`markFixDone`)
 * belongs to the caller (the server run store, or the CLI session).
 */
export async function runFix(
  id: FixId,
  ctx: ProbeContext,
  sink: RunSink,
  signal: AbortSignal,
  o: FixOptions = {},
  deps: FixDeps = defaultFixDeps,
): Promise<FixOutcome> {
  if (signal.aborted) return fail('canceled', 'Canceled.');
  try {
    return await RECIPES[id]({ ctx, sink, signal, o, deps });
  } catch (err) {
    if (signal.aborted) return fail('canceled', 'Canceled.');
    return fail('failed', (err as Error).message);
  }
}
