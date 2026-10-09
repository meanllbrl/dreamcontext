import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  globalSecretsPath, readGlobalGitHubLogin, readGlobalGitHubNeedsReconnect, readGlobalGitHubToken, SecretsPathError,
  setGlobalGitHubAuthValid, writeGlobalGitHubToken,
} from '../../src/lib/git-sync/auth-store.js';
import {
  deviceSignIn, feedTokenToGh, importGhToken, ONBOARDING_GITHUB_SCOPE, parseLoginFromApiOutput, parseScopesHeader,
  runGhSignin, runGithubSignin, scopesImportable, type GhExec, type GithubDeps,
} from '../../src/lib/onboarding/github.js';
import type { ShellResult } from '../../src/lib/onboarding/types.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-gh-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const GH_TOKEN_VALUE = 'gho_fakeTokenValue123';

function apiOutput(scopes: string | null, login = 'octo-user'): string {
  const headers = ['HTTP/2.0 200 OK', 'Content-Type: application/json'];
  if (scopes !== null) headers.push(`X-Oauth-Scopes: ${scopes}`);
  return `${headers.join('\r\n')}\r\n\r\n{"login":"${login}","id":1}`;
}

interface GhCall { args: string[]; input?: string }

/** A fake `gh`: authed or not, with a given token scope list; records every call. */
function fakeGh(o: { authed: boolean; scopes: string | null }): { gh: GhExec; calls: GhCall[] } {
  const calls: GhCall[] = [];
  const gh: GhExec = async (args, opts) => {
    calls.push({ args, input: opts.input });
    const r = (ok: boolean, stdout = ''): ShellResult => ({ ok, stdout, stderr: '' });
    if (args[0] === 'auth' && args[1] === 'status') return r(o.authed);
    if (args[0] === 'api') return r(o.authed, apiOutput(o.scopes));
    if (args[0] === 'auth' && args[1] === 'token') return r(o.authed, `${GH_TOKEN_VALUE}\n`);
    if (args[0] === 'auth' && args[1] === 'login') return r(true);
    return r(false);
  };
  return { gh, calls };
}

/** A fake GitHub for the device flow: one pending poll, then authorized. Records the scope asked. */
function fakeGithub(result: 'authorized' | 'denied' = 'authorized'): { deps: GithubDeps; scopes: string[] } {
  const scopes: string[] = [];
  let polls = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/login/device/code')) {
      scopes.push(new URLSearchParams(String(init?.body)).get('scope') ?? '');
      return Response.json({ device_code: 'dev-code', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 });
    }
    if (url.endsWith('/login/oauth/access_token')) {
      polls += 1;
      if (polls === 1) return Response.json({ error: 'authorization_pending' });
      return result === 'authorized' ? Response.json({ access_token: 'gho_deviceToken' }) : Response.json({ error: 'access_denied' });
    }
    if (url.endsWith('/user')) return Response.json({ login: 'device-user' });
    throw new TypeError('unexpected ' + url);
  }) as typeof fetch;
  let clock = 0;
  return {
    scopes,
    deps: { fetchImpl, clientId: 'client', sleep: async (ms) => { clock += ms; }, now: () => clock, home },
  };
}

const sink = () => {
  const codes: string[] = [];
  return { codes, s: { deviceCode: (c: { userCode: string }) => { codes.push(c.userCode); } } };
};

describe('scope parsing', () => {
  it('reads X-OAuth-Scopes and the login from `gh api -i user`', () => {
    expect(parseScopesHeader(apiOutput('gist, read:org, repo'))).toEqual(['gist', 'read:org', 'repo']);
    expect(parseScopesHeader(apiOutput(null))).toBeNull();
    expect(parseLoginFromApiOutput(apiOutput('repo', 'Öğretmen'))).toBe('Öğretmen');
  });

  it('imports only a subset of repo/read:org/gist that includes repo', () => {
    expect(scopesImportable(['repo'])).toBe(true);
    expect(scopesImportable(['repo', 'read:org', 'gist'])).toBe(true);
    expect(scopesImportable(['repo', 'workflow'])).toBe(false);
    expect(scopesImportable(['read:org', 'gist'])).toBe(false);
    expect(scopesImportable(null)).toBe(false);
  });
});

describe('importGhToken', () => {
  it('stores a subset-scoped gh token with its login', async () => {
    const { gh } = fakeGh({ authed: true, scopes: 'gist, read:org, repo' });
    expect(await importGhToken(gh, home)).toEqual({ login: 'octo-user' });
    expect(readGlobalGitHubToken(home)?.token).toBe(GH_TOKEN_VALUE);
    expect(readGlobalGitHubLogin(home)).toBe('octo-user');
    expect(statSync(globalSecretsPath(home)).mode & 0o777).toBe(0o600);
  });

  it('a token with an extra scope is not stored and its value is never read', async () => {
    const { gh, calls } = fakeGh({ authed: true, scopes: 'repo, workflow' });
    expect(await importGhToken(gh, home)).toBeNull();
    expect(readGlobalGitHubToken(home)).toBeNull();
    expect(calls.some((c) => c.args[0] === 'auth' && c.args[1] === 'token')).toBe(false);
  });

  it('never replaces a token dreamcontext already stores', async () => {
    writeGlobalGitHubToken('gho_existingRepoOnly', home);
    const { gh, calls } = fakeGh({ authed: true, scopes: 'repo' });
    expect(await importGhToken(gh, home)).toBeNull();
    expect(readGlobalGitHubToken(home)?.token).toBe('gho_existingRepoOnly');
    expect(calls).toEqual([]);
  });
});

describe('feedTokenToGh', () => {
  it('passes the token on stdin only, never in argv', async () => {
    const { gh, calls } = fakeGh({ authed: false, scopes: null });
    expect(await feedTokenToGh(gh, 'gho_secret')).toBe(true);
    expect(calls[0].input).toBe('gho_secret\n');
    expect(calls[0].args.join(' ')).not.toContain('gho_secret');
  });
});

describe('deviceSignIn', () => {
  it('publishes the code and returns the token once approved', async () => {
    const { deps, scopes } = fakeGithub();
    const { codes, s } = sink();
    const r = await deviceSignIn(s, new AbortController().signal, 'repo', deps);
    expect(r).toEqual({ ok: true, token: 'gho_deviceToken' });
    expect(codes).toEqual(['ABCD-1234']);
    expect(scopes).toEqual(['repo']);
  });

  it('a denied sign-in is refused, and a canceled one says so', async () => {
    const denied = fakeGithub('denied');
    expect(await deviceSignIn(sink().s, new AbortController().signal, 'repo', denied.deps)).toMatchObject({ ok: false, reason: 'refused' });
    const ac = new AbortController();
    ac.abort();
    const c = fakeGithub();
    expect(await deviceSignIn(sink().s, ac.signal, 'repo', c.deps)).toMatchObject({ ok: false, reason: 'canceled' });
  });
});

describe('runGithubSignin', () => {
  it('leaves a stored repo-only token alone: no device flow, no widening', async () => {
    writeGlobalGitHubToken('gho_existingRepoOnly', home);
    const { deps, scopes } = fakeGithub();
    const { gh, calls } = fakeGh({ authed: false, scopes: null });
    expect(await runGithubSignin(gh, sink().s, new AbortController().signal, deps)).toEqual({ ok: true, login: null });
    expect(scopes).toEqual([]);
    expect(calls).toEqual([]);
    expect(readGlobalGitHubToken(home)?.token).toBe('gho_existingRepoOnly');
  });

  it('imports a signed-in gh with subset scopes, with no browser step', async () => {
    const { deps, scopes } = fakeGithub();
    const { gh } = fakeGh({ authed: true, scopes: 'repo' });
    expect(await runGithubSignin(gh, sink().s, new AbortController().signal, deps)).toEqual({ ok: true, login: 'octo-user' });
    expect(scopes).toEqual([]);
  });

  it('a wider gh token falls back to the device flow; with gh present it asks for the gh scopes', async () => {
    const { deps, scopes } = fakeGithub();
    const { gh } = fakeGh({ authed: true, scopes: 'repo, admin:org' });
    const r = await runGithubSignin(gh, sink().s, new AbortController().signal, deps);
    expect(r).toEqual({ ok: true, login: 'device-user' });
    expect(scopes).toEqual([ONBOARDING_GITHUB_SCOPE]);
    expect(readGlobalGitHubToken(home)?.token).toBe('gho_deviceToken');
  });

  it('feeds gh the device token over stdin when gh is installed but signed out', async () => {
    const { deps } = fakeGithub();
    const { gh, calls } = fakeGh({ authed: false, scopes: null });
    await runGithubSignin(gh, sink().s, new AbortController().signal, deps);
    const login = calls.find((c) => c.args.includes('--with-token'));
    expect(login?.input).toBe('gho_deviceToken\n');
  });

  it('without gh it asks for repo only', async () => {
    const { deps, scopes } = fakeGithub();
    await runGithubSignin(null, sink().s, new AbortController().signal, deps);
    expect(scopes).toEqual(['repo']);
  });
});

describe('runGithubSignin: reconnect', () => {
  it('a valid stored token is a no-op ok: no gh call, no device flow, token unchanged', async () => {
    writeGlobalGitHubToken('gho_valid', home);
    const { deps, scopes } = fakeGithub();
    const { gh, calls } = fakeGh({ authed: true, scopes: 'repo' });
    expect(await runGithubSignin(gh, sink().s, new AbortController().signal, deps)).toEqual({ ok: true, login: null });
    expect(scopes).toEqual([]);
    expect(calls).toEqual([]);
    expect(readGlobalGitHubToken(home)?.token).toBe('gho_valid');
  });

  it('a token GitHub rejected is replaced by the device flow and the reconnect flag cleared', async () => {
    writeGlobalGitHubToken('gho_revoked', home);
    setGlobalGitHubAuthValid(false, home);
    expect(readGlobalGitHubNeedsReconnect(home)).toBe(true);
    const { deps, scopes } = fakeGithub();
    const { codes, s } = sink();
    const r = await runGithubSignin(null, s, new AbortController().signal, deps);
    expect(r).toEqual({ ok: true, login: 'device-user' });
    expect(codes).toEqual(['ABCD-1234']);
    expect(scopes).toEqual(['repo']);
    expect(readGlobalGitHubToken(home)?.token).toBe('gho_deviceToken');
    expect(readGlobalGitHubNeedsReconnect(home)).toBe(false);
  });

  it('a token GitHub rejected is replaced by a scope-checked gh import too', async () => {
    writeGlobalGitHubToken('gho_revoked', home);
    setGlobalGitHubAuthValid(false, home);
    const { deps, scopes } = fakeGithub();
    const { gh } = fakeGh({ authed: true, scopes: 'repo, read:org' });
    expect(await runGithubSignin(gh, sink().s, new AbortController().signal, deps)).toEqual({ ok: true, login: 'octo-user' });
    expect(scopes).toEqual([]);
    expect(readGlobalGitHubToken(home)?.token).toBe(GH_TOKEN_VALUE);
    expect(readGlobalGitHubNeedsReconnect(home)).toBe(false);
  });
});

describe('runGhSignin', () => {
  it('signs gh in with the gh scopes and never replaces the stored token', async () => {
    writeGlobalGitHubToken('gho_existingRepoOnly', home);
    const { deps, scopes } = fakeGithub();
    const { gh, calls } = fakeGh({ authed: false, scopes: null });
    expect(await runGhSignin(gh, sink().s, new AbortController().signal, deps)).toEqual({ ok: true, login: null });
    expect(scopes).toEqual([ONBOARDING_GITHUB_SCOPE]);
    expect(calls.find((c) => c.args.includes('--with-token'))?.input).toBe('gho_deviceToken\n');
    expect(readGlobalGitHubToken(home)?.token).toBe('gho_existingRepoOnly');
  });
});

describe('auth-store symlink refusal', () => {
  it('refuses to write the token through a symlinked .secrets.json', () => {
    const target = join(home, 'elsewhere.json');
    writeFileSync(target, '{}');
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    symlinkSync(target, globalSecretsPath(home));
    expect(() => writeGlobalGitHubToken('gho_x', home)).toThrow(SecretsPathError);
  });
});
