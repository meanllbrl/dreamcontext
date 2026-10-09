import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import type { ProbeRunner, ShellFacts, ShellResult } from './types.js';

/** The PATH a Finder-launched app starts with: what "a fresh Terminal" builds on. */
export const FINDER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** Answers online when no test seam is set. Any HTTP answer counts. */
export const DEFAULT_PROBE_URL = 'https://registry.npmjs.org/-/ping';

/**
 * One POSIX script, run once inside the user's login shell, that answers every "can a
 * new Terminal find X" question at the same time (one ~1 s shell instead of eight).
 *
 * Every answer is a `__DC__key=value` line, so banners an rc file prints (nvm, conda,
 * motd) can never be read as an answer.
 *
 * git is the delicate one: on a Mac without the Command Line Tools, `/usr/bin/git` is a
 * stub and running it opens Apple's install dialog. So on macOS the stub is only run
 * once `xcode-select -p` says the tools exist; a git from anywhere else is run as usual,
 * and `git` is reported only when `--version` actually succeeded.
 */
export const SHELL_FACTS_SCRIPT = [
  'p() { printf "__DC__%s=%s\\n" "$1" "$2"; }',
  'p shell "${SHELL:-}"',
  'n=$(command -v node 2>/dev/null)',
  'p node "$n"',
  'if [ -n "$n" ]; then p nodeVersion "$("$n" --version 2>/dev/null)"; fi',
  'p npm "$(command -v npm 2>/dev/null)"',
  'p dreamcontext "$(command -v dreamcontext 2>/dev/null)"',
  'p claude "$(command -v claude 2>/dev/null)"',
  'p gh "$(command -v gh 2>/dev/null)"',
  'p brew "$(command -v brew 2>/dev/null)"',
  'clt=0',
  'if [ "$(uname -s)" = Darwin ]; then',
  '  x=$(command -v xcode-select 2>/dev/null)',
  '  if [ -n "$x" ] && "$x" -p >/dev/null 2>&1; then clt=1; fi',
  'fi',
  'p clt "$clt"',
  'g=$(command -v git 2>/dev/null)',
  'if [ -n "$g" ]; then',
  '  if [ "$(uname -s)" != Darwin ] || [ "$g" != /usr/bin/git ] || [ "$clt" = 1 ]; then',
  '    if "$g" --version >/dev/null 2>&1; then p git "$g"; fi',
  '  fi',
  'fi',
].join('\n');

const FACT_LINE = /^__DC__([A-Za-z]+)=(.*)$/;

/** Read the `__DC__` lines of {@link SHELL_FACTS_SCRIPT}; everything else is ignored. */
export function parseShellFacts(stdout: string, shell: string): ShellFacts {
  const facts: ShellFacts = { shell };
  for (const raw of stdout.split('\n')) {
    const m = FACT_LINE.exec(raw.replace(/\r$/, ''));
    if (!m) continue;
    const [, key, value] = m;
    const v = value.trim();
    switch (key) {
      case 'node': if (v) facts.node = v; break;
      case 'nodeVersion': if (v) facts.nodeVersion = v; break;
      case 'npm': if (v) facts.npm = v; break;
      case 'dreamcontext': if (v) facts.dreamcontext = v; break;
      case 'claude': if (v) facts.claude = v; break;
      case 'gh': if (v) facts.gh = v; break;
      case 'git': if (v) facts.git = v; break;
      case 'brew': if (v) facts.brew = v; break;
      case 'clt': facts.cltInstalled = v === '1'; break;
      default: break; // `shell` and anything unknown: the caller already knows its shell
    }
  }
  return facts;
}

/**
 * The argv that runs a POSIX `script` with the PATH of `shell`'s interactive login.
 * The login shell builds the user's PATH (nvm, Homebrew, ~/.local/bin), then hands the
 * script to `/bin/sh`, so the script itself never depends on zsh or fish syntax. The
 * script is an argv operand the outer shell never re-parses.
 */
export function loginShellArgs(shell: string, script: string): string[] {
  const ref = basename(shell) === 'fish' ? '$argv[1]' : '"$0"';
  return ['-ilc', `exec /bin/sh -c ${ref}`, script];
}

function runChild(
  file: string,
  args: string[],
  o: { timeoutMs: number; env?: NodeJS.ProcessEnv; input?: string; cwd?: string },
): Promise<ShellResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: ShellResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { env: o.env, cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: (err as Error).message, code: null });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ ok: false, stdout, stderr: `${stderr}\n[timed out after ${o.timeoutMs} ms]`.trim(), code: null });
    }, o.timeoutMs);
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });
    child.on('error', (err) => finish({ ok: false, stdout, stderr: err.message, code: null }));
    child.on('close', (code) => finish({ ok: code === 0, stdout, stderr, code }));
    if (o.input !== undefined) child.stdin?.end(o.input);
    else child.stdin?.end();
  });
}

/** The real runner: spawns processes and fetches. Tests inject their own. */
export const defaultProbeRunner: ProbeRunner = {
  loginShell(script, timeoutMs) {
    const shell = process.env.SHELL || '/bin/zsh';
    return runChild(shell, loginShellArgs(shell, script), {
      timeoutMs,
      env: { ...process.env, PATH: FINDER_PATH },
    });
  },
  exec(file, args, o) {
    return runChild(file, args, o);
  },
  async fetchOk(url, timeoutMs) {
    try {
      await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * A test-seam URL from the environment, accepted only when it parses as plain http on
 * 127.0.0.1. Decided by `new URL()`, never by a prefix check, so `http://127.0.0.1.evil`
 * or `http://127.0.0.1@evil` cannot pass.
 */
export function resolveTestSeamUrl(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[name];
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password) {
      return url.toString();
    }
  } catch {
    /* not a URL */
  }
  return null;
}

/** The network probe target: the verify seam when set and valid, else the npm registry ping. */
export function resolveProbeUrl(env: NodeJS.ProcessEnv = process.env): string {
  return resolveTestSeamUrl('DREAMCONTEXT_ONBOARDING_PROBE_URL', env) ?? DEFAULT_PROBE_URL;
}
