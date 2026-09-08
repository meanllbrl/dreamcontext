import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { claudeAwarePath, findClaudeBin } from './claude-path.js';
import { accountEnvFor, assertConfinedConfigDir } from './claude-accounts.js';

/**
 * Is Claude Code actually signed in?
 *
 * Every agent surface we spawn (embedded terminal, Chat, sleep runs, tab titling,
 * Sleepy capture) runs the user's own `claude` binary, so ALL of them fail the
 * same way when its credentials are missing or expired — and they fail late, at
 * the first turn, after the user has typed a message. The interactive TUI at
 * least shows its own sign-in screen; the headless surfaces (Chat, `-p` runs)
 * answer with an `authentication_failed` frame whose stated remedy — `/login` —
 * is a command those surfaces cannot run ("/login isn't available in this
 * environment").
 *
 * `claude auth status --json` (CLI 2.1.x+) is the cheap, non-interactive answer:
 * ~0.6s, no browser, no keychain prompt beyond what the CLI itself already has.
 * It lets the UI say "not signed in, here's the button" BEFORE a wasted turn, and
 * lets the Chat sign-in banner name the exact command for THIS CLI.
 *
 * Deliberately advisory, never a gate: third-party providers (Bedrock/Vertex),
 * `apiKeyHelper` setups and CLIs older than the `auth` subcommand can all be
 * perfectly usable while this probe reports `loggedIn: null`. The authoritative
 * signal is still the runtime frame — nothing here blocks a spawn.
 */

export interface ClaudeAuthStatus {
  /** `true`/`false` when the CLI answered; `null` when we could not tell (probe
   *  failed, timed out, or this CLI predates `claude auth`). */
  loggedIn: boolean | null;
  /** Whether `claude auth status` exists on this CLI at all. */
  supported: boolean;
  /** `authMethod` as reported ("claude.ai", "console", …). */
  method?: string;
  email?: string;
  /** `orgId` as reported. Carried because the same email can hold seats in more than one
   *  organization, each with its OWN rate limits — so an org switch is a genuine account
   *  change even though the email is unchanged. `claude-auth-watch.ts` folds it into the
   *  identity fingerprint for exactly that case. */
  orgId?: string;
  /** `subscriptionType` as reported ("max", "pro", …). */
  subscription?: string;
  /** The command that starts an interactive sign-in on THIS CLI — what the UI
   *  types into a terminal pane and what it prints as the manual fallback. */
  loginCommand: string;
  /** `projectsDirectory` as reported. Carried so a caller can VERIFY that an account
   *  sandbox's shared `projects/` symlink actually took effect, instead of assuming it did:
   *  `projectsDirectory` follows `CLAUDE_CONFIG_DIR`, so a sandbox whose symlink is missing
   *  reports a path inside itself rather than the shared store. */
  projectsDirectory?: string;
  /** Why the probe couldn't answer. Only set when `loggedIn` is null. */
  error?: string;
}

/** The sign-in command for a CLI that has the `auth` subcommand. */
export const CLAUDE_LOGIN_COMMAND = 'claude auth login';
/** Fallback for a CLI without it: the TUI, where `/login` is typed by hand. */
export const CLAUDE_LOGIN_FALLBACK = 'claude';

/** How long a probe result is reused before re-running the CLI. Short enough that
 *  the user's "I just signed in — retry" click re-probes for real. */
const CACHE_MS = 5_000;
/** The CLI answers in well under a second; anything past this is a hung spawn. Exported so a
 *  caller that escalates TO this probe can subtract it from its own budget instead of stacking. */
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * Turn one `claude auth status --json` run into a status. Pure + exported so the
 * shapes this has to survive (logged out, an old CLI with no `auth` command,
 * banner noise around the JSON, garbage) are pinned by tests rather than by a
 * live CLI.
 *
 * The exit code is deliberately NOT the discriminant: a logged-out CLI may answer
 * `{"loggedIn": false}` with a non-zero code, so any parseable payload wins over
 * the code. Only when there is no payload does stderr decide between "this CLI has
 * no `auth` command" and "the probe failed".
 */
export function parseAuthStatus(stdout: string, stderr: string, code: number | null): ClaudeAuthStatus {
  const payload = extractJson(stdout);
  if (payload && typeof payload.loggedIn === 'boolean') {
    return {
      loggedIn: payload.loggedIn,
      supported: true,
      loginCommand: CLAUDE_LOGIN_COMMAND,
      ...str(payload.authMethod) ? { method: str(payload.authMethod) } : {},
      ...str(payload.email) ? { email: str(payload.email) } : {},
      ...str(payload.orgId) ? { orgId: str(payload.orgId) } : {},
      ...str(payload.subscriptionType) ? { subscription: str(payload.subscriptionType) } : {},
      ...str(payload.projectsDirectory) ? { projectsDirectory: str(payload.projectsDirectory) } : {},
    };
  }
  // Commander's own message for a subcommand that doesn't exist. A CLI this old
  // still signs in fine — just through the TUI, so the fallback command is the
  // honest one to offer.
  const unknown = /unknown (command|option)/i.test(stderr) || /unknown (command|option)/i.test(stdout);
  return {
    loggedIn: null,
    supported: !unknown,
    loginCommand: unknown ? CLAUDE_LOGIN_FALLBACK : CLAUDE_LOGIN_COMMAND,
    error: unknown
      ? 'This Claude Code version has no `claude auth status` command.'
      : (stderr.trim() || stdout.trim() || `claude auth status exited with code ${code ?? 'null'}`).slice(0, 400),
  };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** The first JSON object in `out`, tolerating a banner/update notice around it. */
function extractJson(out: string): Record<string, unknown> | null {
  const text = out.trim();
  if (!text) return null;
  const candidates = [text];
  const open = text.indexOf('{');
  const close = text.lastIndexOf('}');
  if (open !== -1 && close > open) candidates.push(text.slice(open, close + 1));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* try the next slice */ }
  }
  return null;
}

/**
 * Memoized results, KEYED BY CONFIG DIRECTORY.
 *
 * This was a single unkeyed slot while the app knew one account. With N accounts a single
 * slot would hand account B's probe result to a caller asking about account A — the two are
 * separate credential stores, so one cached answer cannot stand for both.
 */
const cached = new Map<string, { at: number; value: ClaudeAuthStatus }>();
const inFlight = new Map<string, Promise<ClaudeAuthStatus>>();

/** Drop the memoized results (after a sign-in run, or for a test). One dir, or all of them. */
export function resetClaudeAuthCache(configDir?: string): void {
  if (configDir === undefined) {
    cached.clear();
    inFlight.clear();
    return;
  }
  const key = resolvePath(configDir);
  cached.delete(key);
  inFlight.delete(key);
}

/**
 * Run the probe (memoized for {@link CACHE_MS} per config dir, with concurrent callers on the
 * same dir sharing one run). Never throws — a failed probe is a `loggedIn: null` status, which
 * every consumer treats as "unknown", never as "signed out".
 *
 * `configDir` names WHICH credential store the spawned `claude` reads. It is optional, and
 * omitting it keeps today's behaviour exactly: the real HOME, with no `CLAUDE_CONFIG_DIR` set.
 *
 * The confinement assertion below is REPEATED here rather than left to `resolveConfigDir`,
 * for the same reason `readUsageLimits` repeats it: both functions take a raw directory and
 * decide which credential store a spawn reads. Asserting in only one of them would make the
 * single-gate guarantee depend on every caller — today's and tomorrow's — remembering to come
 * through the gate, which is the dependency this design exists to remove.
 */
export function claudeAuthStatus(configDir?: string, timeoutMs?: number): Promise<ClaudeAuthStatus> {
  const dir = configDir === undefined ? homedir() : assertConfinedConfigDir(configDir);
  const key = resolvePath(dir);
  const hit = cached.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.value);
  const running = inFlight.get(key);
  if (running) return running;
  const promise = runProbe(dir, timeoutMs).then((value) => {
    cached.set(key, { at: Date.now(), value });
    inFlight.delete(key);
    return value;
  });
  inFlight.set(key, promise);
  return promise;
}

/**
 * `timeoutMs` lets a caller that already owns a budget (the usage probe's escalation to this
 * authoritative judge) hand over WHAT IS LEFT of it rather than adding a second 10s ceiling
 * on top of its own — an escalation that stacks budgets makes the unhappy path feel frozen.
 */
function runProbe(dir: string, timeoutMs?: number): Promise<ClaudeAuthStatus> {
  // A caller-supplied budget is honoured but never allowed to exceed the module's own
  // ceiling, and never allowed to be zero or negative (which would kill the child instantly).
  const budget = Math.min(
    PROBE_TIMEOUT_MS,
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : PROBE_TIMEOUT_MS,
  );
  return new Promise((resolve) => {
    // Spawn the binary DIRECTLY when we can find it (no shell, no rc sourcing —
    // the probe stays sub-second even with a heavy zshrc); fall back to the same
    // interactive login shell every other spawn site uses so a `claude` that only
    // the user's rc knows about is still reachable. Either way PATH is
    // claude-aware, so `~/.local/bin` installs resolve without an rc edit.
    const bin = findClaudeBin();
    const shell = process.env.SHELL || '/bin/zsh';
    // `accountEnvFor` sets `CLAUDE_CONFIG_DIR` for a sandbox and REMOVES it for the real HOME.
    // The three states are not interchangeable: `CLAUDE_CONFIG_DIR=$HOME` would move the CLI's
    // projects directory to `~/projects`, and leaving an INHERITED value in place would ask
    // this judge about whichever account the parent process happened to be running as.
    const env = { ...process.env, PATH: claudeAwarePath(), ...accountEnvFor(dir) } as NodeJS.ProcessEnv;
    let child: ReturnType<typeof spawn>;
    try {
      child = bin
        ? spawn(bin, ['auth', 'status', '--json'], { stdio: ['ignore', 'pipe', 'pipe'], env })
        : spawn(shell, ['-ilc', 'claude auth status --json'], { stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (err) {
      resolve(failed((err as Error)?.message ?? String(err)));
      return;
    }

    let out = '';
    let err = '';
    let settled = false;
    const done = (v: ClaudeAuthStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      done(failed('The sign-in check timed out.'));
    }, budget);

    child.stdout?.on('data', (c: Buffer) => { out += c.toString('utf-8'); });
    child.stderr?.on('data', (c: Buffer) => { err += c.toString('utf-8'); });
    child.on('error', (e) => done(failed(e.message)));
    child.on('close', (code) => done(parseAuthStatus(out, err, code)));
  });
}

function failed(message: string): ClaudeAuthStatus {
  return { loggedIn: null, supported: true, loginCommand: CLAUDE_LOGIN_COMMAND, error: message.slice(0, 400) };
}
