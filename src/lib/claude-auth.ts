import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isCloud, spawnAsWorker } from '../server/cloud-mode.js';
import { resolve as resolvePath } from 'node:path';
import { claudeAwarePath, findClaudeBin } from './claude-path.js';
import { accountEnvFor, assertConfinedConfigDir, isRealHomeConfigDir, listClaudeAccounts, resolveConfigDir, sandboxDirFor } from './claude-accounts.js';

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
 * The cloud (AC17, SMOKE #7/#8): after the codespace slept for hours the access token is expired,
 * so the first `claude` against an account dir has to REFRESH it, and on a cold container that
 * takes longer than {@link PROBE_TIMEOUT_MS}. Killing it there left the CLI's refresh lock held,
 * and the next chat turns on that dir failed with "another Claude Code process is refreshing it".
 * So in the cloud a `claude` we start against an account dir is never killed mid-run: a caller
 * stops WAITING at its budget (the answer is unknown), the child finishes on its own, and only
 * this bound kills its process group as a last resort.
 */
export const CLOUD_REFRESH_HARD_LIMIT_MS = 120_000;
/** The cloud: the most a caller (a chat spawn, go's account list) waits for a dir to go idle. */
export const CLOUD_AUTH_MAX_WAIT_MS = 60_000;

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
/** The cloud: one probe per dir, kept until its child EXITS (not until a caller gave up on it).
 *  Never dropped by {@link resetClaudeAuthCache}, so a reset cannot start a second refresher. */
const cloudRuns = new Map<string, Promise<ClaudeAuthStatus>>();
/** The cloud: per dir, settles once every `claude` we started against it has exited. */
const busy = new Map<string, Promise<void>>();

/** The cloud: count `done` as a `claude` running against `configDir` until it settles. The usage
 *  probe registers its child here too, so chats and probes on one account never overlap. */
export function holdClaudeAccountDir(configDir: string, done: Promise<unknown>): void {
  const key = resolvePath(configDir);
  const next = Promise.all([busy.get(key), done.catch(() => undefined)]).then(() => undefined);
  busy.set(key, next);
  void next.then(() => { if (busy.get(key) === next) busy.delete(key); });
}

/** Whether a `claude` we started is still running against `configDir` (cloud bookkeeping only). */
export function isClaudeAccountDirBusy(configDir: string): boolean {
  return busy.has(resolvePath(configDir));
}

/**
 * Wait (at most `maxWaitMs`) until no probe or refresh we started is running against
 * `configDir`. Resolves at once for an idle dir; other dirs never delay it. Never rejects.
 */
export function awaitClaudeAccountIdle(configDir: string, maxWaitMs: number = CLOUD_AUTH_MAX_WAIT_MS): Promise<void> {
  const pending = busy.get(resolvePath(configDir));
  if (!pending) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, maxWaitMs));
    timer.unref?.();
    void pending.then(() => { clearTimeout(timer); resolve(); });
  });
}

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
  // The cloud (D13): no login lives in the mirror's real ~/.claude, so "this machine's
  // account" is the preferred account's own sandbox; the probe runs as dcuser (runProbe).
  const dir = configDir === undefined
    ? (isCloud() ? resolveConfigDir(null) : homedir())
    : assertConfinedConfigDir(configDir);
  const key = resolvePath(dir);
  const hit = cached.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.value);
  if (isCloud()) return cloudProbe(dir, key, timeoutMs);
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
 * The cloud's probe: joins the dir's running probe or starts one AFTER whatever else we run
 * against the dir has exited, and gives the caller its budget (capped at
 * {@link CLOUD_AUTH_MAX_WAIT_MS} instead of {@link PROBE_TIMEOUT_MS}: a refresh on a cold
 * container is slow, and waiting longer for it costs nothing once it is no longer killed). Past
 * the budget the caller gets unknown while the child runs on; its real answer is cached when it
 * lands.
 */
function cloudProbe(dir: string, key: string, timeoutMs?: number): Promise<ClaudeAuthStatus> {
  let run = cloudRuns.get(key);
  if (!run) {
    const idle = awaitClaudeAccountIdle(dir, CLOUD_REFRESH_HARD_LIMIT_MS);
    run = idle.then(() => runCloudProbe(dir)).then((value) => {
      cached.set(key, { at: Date.now(), value });
      cloudRuns.delete(key);
      return value;
    });
    cloudRuns.set(key, run);
    holdClaudeAccountDir(dir, run);
  }
  const budget = Math.min(
    CLOUD_AUTH_MAX_WAIT_MS,
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : PROBE_TIMEOUT_MS,
  );
  const answer = run;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(failed('The sign-in check is still running (the CLI may be refreshing its sign-in).')), budget);
    timer.unref?.();
    void answer.then((v) => { clearTimeout(timer); resolve(v); });
  });
}

/** One `claude auth status` as dcuser, resolved only when it exits (or at the hard limit). */
function runCloudProbe(dir: string): Promise<ClaudeAuthStatus> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnAsWorker('/bin/bash', ['-lc', 'claude auth status --json'], {
        cwd: tmpdir(),
        ...(isRealHomeConfigDir(dir) ? {} : { account: { configDir: dir } }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
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
    // Last resort only: the whole group (bash and the claude under it), never just the leader.
    const timer = setTimeout(() => {
      killGroup(child);
      done(failed('The sign-in check did not finish.'));
    }, CLOUD_REFRESH_HARD_LIMIT_MS);
    timer.unref?.();
    child.stdout?.on('data', (c: Buffer) => { out += c.toString('utf-8'); });
    child.stderr?.on('data', (c: Buffer) => { err += c.toString('utf-8'); });
    child.on('error', (e) => done(failed(e.message)));
    child.on('close', (code) => done(parseAuthStatus(out, err, code)));
  });
}

/** SIGKILL a detached child's process group (falls back to the child alone). */
export function killGroup(child: { pid?: number; kill: (sig?: NodeJS.Signals) => boolean }): void {
  try {
    if (child.pid) { process.kill(-child.pid, 'SIGKILL'); return; }
  } catch { /* no group: the child alone below */ }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

/**
 * The cloud's boot warm-up (AC17): sign-in check each registered account that has a sandbox,
 * ONE AT A TIME, waiting for each child to exit, so an expired token is refreshed before the
 * phone's first turn needs it. Fire-and-forget from the cloud server's boot; a no-op anywhere
 * else. Never throws.
 */
export async function warmCloudAccountLogins(home: string = homedir()): Promise<void> {
  if (!isCloud()) return;
  let ids: string[];
  try { ids = listClaudeAccounts(home).map((a) => a.id); } catch { return; }
  for (const id of ids) {
    try {
      const dir = sandboxDirFor(id, home);
      if (!existsSync(dir)) continue;
      await claudeAuthStatus(dir, CLOUD_AUTH_MAX_WAIT_MS);
      await awaitClaudeAccountIdle(dir, CLOUD_REFRESH_HARD_LIMIT_MS);
    } catch { /* the next account still warms */ }
  }
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
      // The laptop (the cloud runs `runCloudProbe`): a cwd outside every hands-free locked root
      // (never the server's own cwd).
      child = bin
        ? spawn(bin, ['auth', 'status', '--json'], { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], env })
        : spawn(shell, ['-ilc', 'claude auth status --json'], { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], env });
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
