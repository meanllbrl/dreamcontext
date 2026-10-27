// ─── Full-machine upgrade (CLI + desktop app + every project, in one job) ────────
//
// The header "Update available" badge (POST /api/launcher/upgrade) and the desktop app's own
// self-update (src/server/self-update-job.ts) both run THIS: the SAME `dreamcontext upgrade
// --yes` the CLI exposes — npm-installs the latest CLI into the install the app runs, updates
// the installed desktop app unless it updates itself, then refreshes every registered project —
// as ONE background job. Singleton: only one upgrade runs machine-wide at a time (it mutates the
// global npm install AND the shared .app bundle, so a second concurrent run would race). State is
// lost on server restart, which is fine — the on-disk result is what matters, and a re-poll
// after restart simply reports `idle`.

import { spawn } from 'node:child_process';

export interface UpgradeRun {
  state: 'running' | 'done' | 'error';
  /** Combined stdout+stderr tail — a live log for the badge popover. */
  output: string;
  startedAt: number;
  endedAt?: number;
  /** Who started it: the badge (`manual`) or the app's self-update (`auto`). */
  trigger: 'manual' | 'auto';
}

/** Safety ceiling: npm install + app download + N project refreshes. */
export const UPGRADE_MAX_MS = 12 * 60 * 1000;

let upgradeRun: UpgradeRun | null = null;
let upgradeDone: Promise<UpgradeRun> | null = null;

/** The current or last run in this server, or null when none has run. */
export function getUpgradeRun(): UpgradeRun | null {
  return upgradeRun;
}

/** Test-only: forget the last run. */
export function __resetUpgradeRun(): void {
  upgradeRun = null;
  upgradeDone = null;
}

export interface StartUpgradeOpts {
  trigger: UpgradeRun['trigger'];
  env?: NodeJS.ProcessEnv;
  /** The CLI to run `upgrade --yes` with (default: DREAMCONTEXT_CLI, else this process's entry). */
  cliEntry?: string;
  execPath?: string;
  spawnImpl?: typeof spawn;
  maxMs?: number;
}

/**
 * Start the one-shot full upgrade, or join the one already running. `done` resolves when it
 * ends (never rejects). Returns `{ error: 'no_cli' }` when there is no CLI entry to run.
 *
 * The CLI is spawned inside an INTERACTIVE LOGIN shell (`$SHELL -ilc`) so `npm` resolves even
 * when the desktop app was launched from Finder/Spotlight (which do NOT inherit the user's
 * interactive-shell PATH) — the same PATH fix used by the agent-terminal and Sleepy capture.
 * `$0`/`$1` are argv positionals, never interpolated into the command string (no shell
 * injection).
 */
export function startUpgradeRun(opts: StartUpgradeOpts): { run: UpgradeRun; done: Promise<UpgradeRun> } | { error: 'no_cli' } {
  if (upgradeRun?.state === 'running' && upgradeDone) return { run: upgradeRun, done: upgradeDone };
  const env = opts.env ?? process.env;
  const cliEntry = opts.cliEntry ?? (env.DREAMCONTEXT_CLI || process.argv[1]);
  if (!cliEntry) return { error: 'no_cli' };

  const run: UpgradeRun = { state: 'running', output: '', startedAt: Date.now(), trigger: opts.trigger };
  upgradeRun = run;
  let finish: (r: UpgradeRun) => void = () => {};
  const done = new Promise<UpgradeRun>((resolve) => { finish = resolve; });
  upgradeDone = done;
  const end = (state: 'done' | 'error', output?: string) => {
    if (run.state !== 'running') return;
    run.state = state;
    if (output !== undefined) run.output = output;
    run.endedAt = Date.now();
    finish(run);
  };

  try {
    const shell = env.SHELL || '/bin/zsh';
    const child = (opts.spawnImpl ?? spawn)(
      shell,
      ['-ilc', 'exec "$0" "$1" upgrade --yes', opts.execPath ?? process.execPath, cliEntry],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...env } },
    );
    // Keep only the tail so a chatty npm/update run can't grow memory unbounded.
    const append = (chunk: Buffer) => {
      run.output = (run.output + chunk.toString('utf-8')).slice(-8000);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const guard = setTimeout(() => {
      if (run.state !== 'running') return;
      end('error', (run.output + '\n\nUpgrade timed out.').slice(-8000));
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, opts.maxMs ?? UPGRADE_MAX_MS);
    guard.unref?.();

    child.on('error', (err) => {
      clearTimeout(guard);
      end('error', `Couldn't start the upgrade: ${err.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(guard);
      if (run.state !== 'running') return;
      end(code === 0 ? 'done' : 'error', code !== 0 && !run.output.trim() ? `Upgrade exited with code ${code}` : undefined);
    });
  } catch (err) {
    end('error', `Couldn't start the upgrade: ${err instanceof Error ? err.message : 'spawn failed'}`);
  }
  return { run, done };
}
