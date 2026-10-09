import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, sep } from 'node:path';
import { homedir } from 'node:os';
import { withNodeDirOnPath } from './git-sync/credentials.js';
import { CLI_RC_MARKER, ensureDirOnShellPath } from './claude-path.js';
import { managedNodeRoot, managedNpmGlobal } from './onboarding/platform.js';
import type { ShellResult } from './onboarding/types.js';

export type { ShellResult } from './onboarding/types.js';

const execFileAsync = promisify(execFile);

export type CliInstallStatus = 'present' | 'installed' | 'failed';

export interface EnsureCliResult {
  status: CliInstallStatus;
  /** Human-readable note (shown to the user only when status is 'failed'). */
  message?: string;
}

export type ShellRunner = (script: string, timeoutMs: number) => Promise<ShellResult>;

/**
 * Probe for a PATH-resolvable `dreamcontext`. A plain `-lc` lookup is fast (~0.04s) and
 * correct on most machines, but `~/.zshrc` (where nvm / `~/.local/bin` PATH exports
 * usually live) is sourced by zsh for INTERACTIVE shells only, so a `dreamcontext`
 * reachable solely through it reports "missing" under `-lc` alone. The `||` falls back to
 * an interactive probe (`-ic`, ~1.3s) ONLY when the fast path resolves nothing.
 */
export const CLI_PROBE_SCRIPT = 'command -v dreamcontext || "${SHELL:-/bin/zsh}" -ic "command -v dreamcontext" 2>/dev/null';

/** The global install itself (trusted package published by the project owner). */
export const CLI_INSTALL_SCRIPT = 'npm install -g dreamcontext@latest';

/** The private prefix used when npm's own global folder is not writable (EACCES). */
function userPrefixInstallScript(prefix: string): string {
  return `npm install -g --prefix '${prefix.replace(/'/g, `'\\''`)}' dreamcontext@latest`;
}

/**
 * The environment the login shell starts from. The running node's folder is on PATH so
 * `npm` resolves even when the app runs on its private Node (which the user's shell may
 * not know about yet), and that private Node installs globals into its fixed
 * `npm-global` folder, so a later Node version bump never loses them.
 */
function installEnv(execPath: string = process.execPath, home: string = homedir()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: withNodeDirOnPath(process.env.PATH) };
  if (execPath.startsWith(managedNodeRoot(home) + sep)) env.npm_config_prefix = managedNpmGlobal(home);
  return env;
}

/**
 * Run a script in the user's LOGIN shell so their nvm/brew/volta/asdf PATH is
 * present. A Finder-launched .app inherits only a minimal PATH (/usr/bin:/bin),
 * so a bare `npm`/`dreamcontext` lookup would miss the real install — exactly
 * the reason the Rust shell resolves `node` via `$SHELL -lc` too.
 */
const loginShellRunner: ShellRunner = async (script, timeoutMs) => {
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const { stdout, stderr } = await execFileAsync(shell, ['-lc', script], { timeout: timeoutMs, env: installEnv() });
    return { ok: true, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
    return {
      ok: false,
      stdout: String(e?.stdout ?? ''),
      stderr: String(e?.stderr ?? e?.message ?? ''),
    };
  }
};

export interface EnsureCliOptions {
  /** Output of each step, as it finishes (the onboarding run's detail tail). */
  onOutput?: (chunk: string) => void;
  /** Home folder (tests). */
  home?: string;
  /** Puts a folder on the user's shell PATH (tests inject a recorder). */
  addToShellPath?: (dir: string) => { ok: boolean };
}

function defaultAddToShellPath(dir: string): { ok: boolean } {
  const fix = ensureDirOnShellPath(dir, CLI_RC_MARKER);
  return { ok: !fix.refused && (fix.wrote.length > 0 || fix.alreadyConfigured.length > 0) };
}

/**
 * Ensure the `dreamcontext` CLI is resolvable on the user's PATH so a scaffolded
 * project's `npx dreamcontext hook …` calls work when the project is later opened
 * in Claude Code. The desktop app BUNDLES its own copy of the CLI (used to run
 * the server + scaffold), but that copy is not on PATH — the project hooks need a
 * globally installed `dreamcontext`. Installs it from npm only when missing.
 *
 * When npm's global folder is not writable (a system Node owned by root), the install
 * is retried into the user's own `~/.dreamcontext/npm-global` and that folder's `bin`
 * goes on the shell PATH. Never sudo.
 *
 * Best-effort and non-throwing: a failure here never blocks project creation; it
 * is surfaced to the user with the manual command to run.
 */
export async function ensureCliInstalled(
  runner: ShellRunner = loginShellRunner,
  opts: EnsureCliOptions = {},
): Promise<EnsureCliResult> {
  const out = (r: ShellResult) => {
    const text = `${r.stdout}${r.stderr}`.trim();
    if (text) opts.onOutput?.(`${text}\n`);
  };

  const probe = await runner(CLI_PROBE_SCRIPT, 15_000);
  if (probe.ok && probe.stdout.trim()) {
    return { status: 'present' };
  }

  // Need npm to install it.
  const npmCheck = await runner('command -v npm', 10_000);
  if (!npmCheck.ok || !npmCheck.stdout.trim()) {
    return {
      status: 'failed',
      message: 'npm was not found. Install Node.js, then run: npm install -g dreamcontext',
    };
  }

  const install = await runner(CLI_INSTALL_SCRIPT, 180_000);
  out(install);
  if (install.ok) return { status: 'installed' };

  if (/EACCES/.test(`${install.stderr}${install.stdout}`)) {
    const prefix = managedNpmGlobal(opts.home);
    const retry = await runner(userPrefixInstallScript(prefix), 180_000);
    out(retry);
    if (retry.ok) {
      (opts.addToShellPath ?? defaultAddToShellPath)(join(prefix, 'bin'));
      return { status: 'installed' };
    }
  }
  return {
    status: 'failed',
    message: 'Could not auto-install the CLI. Run manually: npm install -g dreamcontext',
  };
}
