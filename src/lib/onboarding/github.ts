import {
  BRAIN_OAUTH_CLIENT_ID, BRAIN_OAUTH_SCOPE, fetchAuthenticatedLogin, pollDeviceFlow, startDeviceFlow,
  type FetchImpl,
} from '../git-sync/oauth.js';
import {
  readGlobalGitHubNeedsReconnect, readGlobalGitHubToken, setGlobalGitHubAuthValid, setGlobalGitHubLogin, writeGlobalGitHubToken,
} from '../git-sync/auth-store.js';
import type { ShellResult } from './types.js';

/**
 * GitHub sign-in for onboarding: one sign-in shared by dreamcontext (clone, brain sync)
 * and the GitHub command line tool (`gh`, which Claude uses for pull requests).
 *
 * Three rules hold everywhere here:
 *  - a token is never put in argv, env or any output: it reaches `gh` on stdin only;
 *  - a `gh` token is imported only when its scopes are a subset of what onboarding
 *    itself would ask for ({@link GH_IMPORTABLE_SCOPES}) and include `repo`;
 *  - a valid token dreamcontext already stores is never replaced or widened by these
 *    flows (a token GitHub rejected, flagged needs-reconnect, is replaced).
 */

/** What onboarding asks GitHub for when `gh` is present: the three scopes `gh` requires. */
export const ONBOARDING_GITHUB_SCOPE = 'repo read:org gist';
export const GH_IMPORTABLE_SCOPES: readonly string[] = ['repo', 'read:org', 'gist'];

/** Runs `gh` (no shell). `input` is written to stdin. */
export type GhExec = (args: string[], o: { timeoutMs: number; input?: string }) => Promise<ShellResult>;

export interface DeviceCodeSink {
  deviceCode(c: { userCode: string; verificationUri: string; expiresAt: number }): void;
}

export interface GithubDeps {
  fetchImpl: FetchImpl;
  clientId: string;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  home?: string;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export const defaultGithubDeps: GithubDeps = {
  fetchImpl: globalThis.fetch,
  clientId: BRAIN_OAUTH_CLIENT_ID,
  sleep: abortableSleep,
  now: Date.now,
};

export type GithubFailure = 'canceled' | 'timeout' | 'refused' | 'failed' | 'offline';
export type GithubResult = { ok: true; login: string | null } | { ok: false; reason: GithubFailure; detail: string };

/**
 * A stored token that still works: present and not flagged by a rejected git op. Only
 * this one is protected; a token GitHub already rejected may be replaced.
 */
export function hasValidStoredToken(home?: string): boolean {
  return readGlobalGitHubToken(home) !== null && !readGlobalGitHubNeedsReconnect(home);
}

/** Store a fresh token and clear the needs-reconnect flag, as the Settings reconnect does. */
function storeToken(token: string, login: string | null, home?: string): void {
  writeGlobalGitHubToken(token, home);
  setGlobalGitHubAuthValid(true, home);
  if (login) setGlobalGitHubLogin(login, home);
}

// ─── Reading what `gh` holds ───────────────────────────────────────────────────

/**
 * The `X-OAuth-Scopes` header of `gh api -i user` output, as a list. Null when the
 * header is absent (a fine-grained or app token has none): such a token is not imported.
 */
export function parseScopesHeader(output: string): string[] | null {
  const m = /^x-oauth-scopes:[ \t]*(.*)$/im.exec(output);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

/** The `login` from the JSON body that follows the headers of `gh api -i user`. */
export function parseLoginFromApiOutput(output: string): string | null {
  const start = output.indexOf('{');
  if (start < 0) return null;
  try {
    const body = JSON.parse(output.slice(start)) as { login?: unknown };
    return typeof body.login === 'string' && body.login ? body.login : null;
  } catch {
    return null;
  }
}

/** Importable: has `repo`, and nothing outside {@link GH_IMPORTABLE_SCOPES}. */
export function scopesImportable(scopes: readonly string[] | null): boolean {
  if (!scopes || !scopes.includes('repo')) return false;
  return scopes.every((s) => GH_IMPORTABLE_SCOPES.includes(s));
}

export async function ghIsAuthed(gh: GhExec): Promise<boolean> {
  const r = await gh(['auth', 'status', '--hostname', 'github.com'], { timeoutMs: 15_000 });
  return r.ok;
}

/**
 * Reuse the sign-in `gh` already has, when its scopes allow it. Returns the login on
 * import, or null when there is nothing safe to import (the caller then runs the
 * device flow). Never writes over a valid stored token; replaces one GitHub rejected.
 */
export async function importGhToken(gh: GhExec, home?: string): Promise<{ login: string | null } | null> {
  if (hasValidStoredToken(home)) return null;
  const api = await gh(['api', '-i', 'user'], { timeoutMs: 20_000 });
  if (!api.ok) return null;
  if (!scopesImportable(parseScopesHeader(api.stdout))) return null;
  const tokenRun = await gh(['auth', 'token', '--hostname', 'github.com'], { timeoutMs: 15_000 });
  const token = tokenRun.ok ? tokenRun.stdout.trim() : '';
  if (!token || /\s/.test(token)) return null;
  const login = parseLoginFromApiOutput(api.stdout);
  storeToken(token, login, home);
  return { login };
}

/** Sign `gh` in with `token`, over stdin only. */
export async function feedTokenToGh(gh: GhExec, token: string): Promise<boolean> {
  const r = await gh(['auth', 'login', '--with-token', '--hostname', 'github.com'], { timeoutMs: 30_000, input: `${token}\n` });
  return r.ok;
}

// ─── Device flow ───────────────────────────────────────────────────────────────

/**
 * Run GitHub's device flow: publish the code through `sink`, then poll until the person
 * approves it, it expires, they deny it, or `signal` cancels. Returns the token (kept in
 * memory only; the caller decides where it goes).
 */
export async function deviceSignIn(
  sink: DeviceCodeSink,
  signal: AbortSignal,
  scope: string,
  deps: GithubDeps = defaultGithubDeps,
): Promise<{ ok: true; token: string } | { ok: false; reason: GithubFailure; detail: string }> {
  let start;
  try {
    start = await startDeviceFlow(deps.clientId, deps.fetchImpl, scope);
  } catch (err) {
    return { ok: false, reason: 'offline', detail: (err as Error).message };
  }
  const expiresAt = deps.now() + start.expiresIn * 1000;
  sink.deviceCode({ userCode: start.userCode, verificationUri: start.verificationUri, expiresAt });
  let interval = Math.max(1, start.interval);
  while (!signal.aborted) {
    if (deps.now() >= expiresAt) return { ok: false, reason: 'timeout', detail: 'The sign-in code expired.' };
    await deps.sleep(interval * 1000, signal);
    if (signal.aborted) break;
    let poll;
    try {
      poll = await pollDeviceFlow(deps.clientId, start.deviceCode, deps.fetchImpl);
    } catch (err) {
      return { ok: false, reason: 'offline', detail: (err as Error).message };
    }
    switch (poll.status) {
      case 'authorized': return { ok: true, token: poll.token };
      case 'pending': break;
      case 'slow_down': interval = Math.max(interval + 5, poll.interval); break;
      case 'expired': return { ok: false, reason: 'timeout', detail: 'The sign-in code expired.' };
      case 'denied': return { ok: false, reason: 'refused', detail: 'The sign-in was declined on GitHub.' };
      case 'error': return { ok: false, reason: 'failed', detail: poll.message };
    }
  }
  return { ok: false, reason: 'canceled', detail: 'Canceled.' };
}

// ─── The two fixes ─────────────────────────────────────────────────────────────

/**
 * `github-signin`: connect dreamcontext to GitHub.
 *  1. A valid token already stored: nothing to do (and nothing is widened). A token
 *     GitHub rejected (needs reconnect) is replaced by steps 2 or 3.
 *  2. `gh` signed in with importable scopes: import it, no browser.
 *  3. Otherwise the device flow, asking for the `gh` scopes only when `gh` is installed
 *     (then `gh` is signed in with the same token); plain `repo` otherwise.
 */
export async function runGithubSignin(
  gh: GhExec | null,
  sink: DeviceCodeSink,
  signal: AbortSignal,
  deps: GithubDeps = defaultGithubDeps,
): Promise<GithubResult> {
  if (hasValidStoredToken(deps.home)) return { ok: true, login: null };
  const ghAuthed = gh ? await ghIsAuthed(gh) : false;
  if (gh && ghAuthed) {
    const imported = await importGhToken(gh, deps.home);
    if (imported) return { ok: true, login: imported.login };
  }
  const scope = gh ? ONBOARDING_GITHUB_SCOPE : BRAIN_OAUTH_SCOPE;
  const flow = await deviceSignIn(sink, signal, scope, deps);
  if (!flow.ok) return flow;
  let login: string | null = null;
  try {
    login = await fetchAuthenticatedLogin(flow.token, deps.fetchImpl);
  } catch {
    login = null; // the token works for git; the login is cosmetic and is cached later
  }
  storeToken(flow.token, login, deps.home);
  if (gh && !ghAuthed) await feedTokenToGh(gh, flow.token);
  return { ok: true, login };
}

/**
 * `gh-signin`: sign `gh` in when dreamcontext already has its own (narrower) token. A
 * device flow with the `gh` scopes, fed to `gh` only: the stored token is never replaced.
 */
export async function runGhSignin(
  gh: GhExec,
  sink: DeviceCodeSink,
  signal: AbortSignal,
  deps: GithubDeps = defaultGithubDeps,
): Promise<GithubResult> {
  if (await ghIsAuthed(gh)) return { ok: true, login: null };
  const flow = await deviceSignIn(sink, signal, ONBOARDING_GITHUB_SCOPE, deps);
  if (!flow.ok) return flow;
  const fed = await feedTokenToGh(gh, flow.token);
  return fed
    ? { ok: true, login: null }
    : { ok: false, reason: 'failed', detail: "GitHub's command line tool did not accept the sign-in." };
}
