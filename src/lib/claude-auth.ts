import { spawn } from 'node:child_process';
import { claudeAwarePath, findClaudeBin } from './claude-path.js';

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
/** The CLI answers in well under a second; anything past this is a hung spawn. */
const PROBE_TIMEOUT_MS = 10_000;

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

let cached: { at: number; value: ClaudeAuthStatus } | null = null;
let inFlight: Promise<ClaudeAuthStatus> | null = null;

/** Drop the memoized result (after a sign-in run, or for a test). */
export function resetClaudeAuthCache(): void {
  cached = null;
  inFlight = null;
}

/**
 * Run the probe (memoized for {@link CACHE_MS}, with concurrent callers sharing one
 * run). Never throws — a failed probe is a `loggedIn: null` status, which every
 * consumer treats as "unknown", never as "signed out".
 */
export function claudeAuthStatus(): Promise<ClaudeAuthStatus> {
  if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.value);
  if (inFlight) return inFlight;
  inFlight = runProbe().then((value) => {
    cached = { at: Date.now(), value };
    inFlight = null;
    return value;
  });
  return inFlight;
}

function runProbe(): Promise<ClaudeAuthStatus> {
  return new Promise((resolve) => {
    // Spawn the binary DIRECTLY when we can find it (no shell, no rc sourcing —
    // the probe stays sub-second even with a heavy zshrc); fall back to the same
    // interactive login shell every other spawn site uses so a `claude` that only
    // the user's rc knows about is still reachable. Either way PATH is
    // claude-aware, so `~/.local/bin` installs resolve without an rc edit.
    const bin = findClaudeBin();
    const shell = process.env.SHELL || '/bin/zsh';
    const env = { ...process.env, PATH: claudeAwarePath() } as NodeJS.ProcessEnv;
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
    }, PROBE_TIMEOUT_MS);

    child.stdout?.on('data', (c: Buffer) => { out += c.toString('utf-8'); });
    child.stderr?.on('data', (c: Buffer) => { err += c.toString('utf-8'); });
    child.on('error', (e) => done(failed(e.message)));
    child.on('close', (code) => done(parseAuthStatus(out, err, code)));
  });
}

function failed(message: string): ClaudeAuthStatus {
  return { loggedIn: null, supported: true, loginCommand: CLAUDE_LOGIN_COMMAND, error: message.slice(0, 400) };
}
