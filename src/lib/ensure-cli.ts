import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type CliInstallStatus = 'present' | 'installed' | 'failed';

export interface EnsureCliResult {
  status: CliInstallStatus;
  /** Human-readable note (shown to the user only when status is 'failed'). */
  message?: string;
}

export interface ShellResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type ShellRunner = (script: string, timeoutMs: number) => Promise<ShellResult>;

/**
 * Run a script in the user's LOGIN shell so their nvm/brew/volta/asdf PATH is
 * present. A Finder-launched .app inherits only a minimal PATH (/usr/bin:/bin),
 * so a bare `npm`/`dreamcontext` lookup would miss the real install — exactly
 * the reason the Rust shell resolves `node` via `$SHELL -lc` too.
 */
const loginShellRunner: ShellRunner = async (script, timeoutMs) => {
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const { stdout, stderr } = await execFileAsync(shell, ['-lc', script], { timeout: timeoutMs });
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

/**
 * Ensure the `dreamcontext` CLI is resolvable on the user's PATH so a scaffolded
 * project's `npx dreamcontext hook …` calls work when the project is later opened
 * in Claude Code. The desktop app BUNDLES its own copy of the CLI (used to run
 * the server + scaffold), but that copy is not on PATH — the project hooks need a
 * globally installed `dreamcontext`. Installs it from npm only when missing.
 *
 * Best-effort and non-throwing: a failure here never blocks project creation; it
 * is surfaced to the user with the manual command to run.
 */
export async function ensureCliInstalled(runner: ShellRunner = loginShellRunner): Promise<EnsureCliResult> {
  // Already resolvable on PATH? (npx resolves global installs, so this is the
  // exact condition the project hooks depend on.)
  const probe = await runner('command -v dreamcontext', 15_000);
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

  // Install globally from npm (trusted package published by the project owner).
  const install = await runner('npm install -g dreamcontext@latest', 180_000);
  if (!install.ok) {
    return {
      status: 'failed',
      message: 'Could not auto-install the CLI. Run manually: npm install -g dreamcontext',
    };
  }
  return { status: 'installed' };
}
