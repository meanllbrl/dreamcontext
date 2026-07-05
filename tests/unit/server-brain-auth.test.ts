import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleBrainAuthDeviceStart,
  handleBrainAuthDevicePoll,
  handleBrainAuthStatus,
  handleBrainAuthToken,
  handleBrainAuthLogout,
  __setBrainAuthFetch,
  __setBrainAuthHome,
} from '../../src/server/routes/brain-auth.js';
import { globalSecretsPath, writeGlobalGitHubToken } from '../../src/lib/git-sync/auth-store.js';

function makeRes(): { res: ServerResponse; status: () => number; body: () => any } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) { try { responseBody = JSON.parse(data); } catch { responseBody = data; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody as any };
}

function makeReq(method: string, bodyObj?: unknown): IncomingMessage {
  const chunks = bodyObj === undefined ? [] : [Buffer.from(JSON.stringify(bodyObj))];
  const readable = Readable.from(chunks);
  return Object.assign(readable, { method, headers: { 'content-type': 'application/json' } }) as unknown as IncomingMessage;
}

function jsonRes(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-authhome-'));
  __setBrainAuthHome(home);
  process.env.DREAMCONTEXT_DESKTOP = '1';
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
});
afterEach(() => {
  __setBrainAuthHome(undefined);
  __setBrainAuthFetch(globalThis.fetch);
  delete process.env.DREAMCONTEXT_DESKTOP;
  rmSync(home, { recursive: true, force: true });
});

describe('brain-auth — desktop gate', () => {
  it('403s every route outside the desktop app', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    const { res, status } = makeRes();
    await handleBrainAuthStatus(makeReq('GET'), res);
    expect(status()).toBe(403);
  });
});

describe('brain-auth — device flow (B1)', () => {
  it('device/start returns a UUID sessionId + userCode and NEVER returns the deviceCode', async () => {
    __setBrainAuthFetch((async () => jsonRes(200, {
      device_code: 'SECRET-DEVICE-CODE', user_code: 'ABCD-EFGH',
      verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5,
    })) as unknown as typeof fetch);
    const { res, status, body } = makeRes();
    await handleBrainAuthDeviceStart(makeReq('POST', {}), res);
    expect(status()).toBe(200);
    expect(body().sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body().userCode).toBe('ABCD-EFGH');
    // The device_code must never leave the server.
    expect(JSON.stringify(body())).not.toContain('SECRET-DEVICE-CODE');
    expect(body().deviceCode).toBeUndefined();
  });

  it('poll: pending → slow_down bumps interval → authorized writes a 0600 token, never echoed', async () => {
    // start with interval:0 so poll #1 and #2 are never short-circuited by the
    // lastPolledAt guard (0ms minimum gap) — they actually reach GitHub, so
    // poll #2 genuinely observes the server-side slow_down bump. The
    // short-circuit itself is asserted separately below with a real interval.
    __setBrainAuthFetch((async () => jsonRes(200, {
      device_code: 'DEV', user_code: 'AA-BB', verification_uri: 'x', expires_in: 900, interval: 0,
    })) as unknown as typeof fetch);
    const start = makeRes();
    await handleBrainAuthDeviceStart(makeReq('POST', {}), start.res);
    const sessionId = start.body().sessionId;

    // pending
    __setBrainAuthFetch((async () => jsonRes(200, { error: 'authorization_pending' })) as unknown as typeof fetch);
    const p1 = makeRes();
    await handleBrainAuthDevicePoll(makeReq('POST', { sessionId }), p1.res);
    expect(p1.body().status).toBe('pending');

    // slow_down bumps the stored interval — reaches GitHub because interval is
    // still 0 at this point (not yet bumped), so no short-circuit applies.
    __setBrainAuthFetch((async () => jsonRes(200, { error: 'slow_down', interval: 60 })) as unknown as typeof fetch);
    const p2 = makeRes();
    await handleBrainAuthDevicePoll(makeReq('POST', { sessionId }), p2.res);
    expect(p2.body().status).toBe('slow_down');
    expect(p2.body().interval).toBe(60);

    // Immediate re-poll: NOW the bumped interval (60s) is in effect, so this
    // poll is short-circuited to slow_down WITHOUT calling GitHub at all.
    let called = false;
    __setBrainAuthFetch((async () => { called = true; return jsonRes(200, { access_token: 'x' }); }) as unknown as typeof fetch);
    const p3 = makeRes();
    await handleBrainAuthDevicePoll(makeReq('POST', { sessionId }), p3.res);
    expect(p3.body().status).toBe('slow_down');
    expect(called).toBe(false);
  });

  it('poll authorized: persists the token 0600 and returns the login WITHOUT the token', async () => {
    __setBrainAuthFetch((async () => jsonRes(200, {
      device_code: 'DEV', user_code: 'AA-BB', verification_uri: 'x', expires_in: 900, interval: 0,
    })) as unknown as typeof fetch);
    const start = makeRes();
    await handleBrainAuthDeviceStart(makeReq('POST', {}), start.res);
    const sessionId = start.body().sessionId;

    // access_token on the /access_token call, login on the /user call.
    __setBrainAuthFetch((async (url: string) => {
      if (String(url).includes('/user')) return jsonRes(200, { login: 'octocat' });
      return jsonRes(200, { access_token: 'ghp_secretauth' });
    }) as unknown as typeof fetch);
    const poll = makeRes();
    await handleBrainAuthDevicePoll(makeReq('POST', { sessionId }), poll.res);

    expect(poll.body().status).toBe('authorized');
    expect(poll.body().login).toBe('octocat');
    // The token is never in the response body.
    expect(JSON.stringify(poll.body())).not.toContain('ghp_secretauth');
    // The token IS persisted to the global store at mode 0600.
    const path = globalSecretsPath(home);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf-8')).toContain('ghp_secretauth');
  });

  it('poll with an unknown session 404s', async () => {
    const { res, status } = makeRes();
    await handleBrainAuthDevicePoll(makeReq('POST', { sessionId: 'nope' }), res);
    expect(status()).toBe(404);
  });
});

describe('brain-auth — status + PAT fallback (B2)', () => {
  it('status reports connected + global source, never the token', async () => {
    writeGlobalGitHubToken('ghp_status', home);
    const { res, status, body } = makeRes();
    await handleBrainAuthStatus(makeReq('GET'), res);
    expect(status()).toBe(200);
    expect(body().connected).toBe(true);
    expect(body().source).toBe('global');
    expect(JSON.stringify(body())).not.toContain('ghp_status');
  });

  it('token: a valid PAT is accepted (200, login) and never echoed', async () => {
    __setBrainAuthFetch((async () => jsonRes(200, { login: 'octocat' })) as unknown as typeof fetch);
    const { res, status, body } = makeRes();
    await handleBrainAuthToken(makeReq('POST', { token: 'ghp_validpat' }), res);
    expect(status()).toBe(200);
    expect(body().login).toBe('octocat');
    expect(JSON.stringify(body())).not.toContain('ghp_validpat');
    expect(readFileSync(globalSecretsPath(home), 'utf-8')).toContain('ghp_validpat');
  });

  it('token: an invalid PAT 400s invalid_token', async () => {
    __setBrainAuthFetch((async () => jsonRes(401, { message: 'Bad credentials' })) as unknown as typeof fetch);
    const { res, status, body } = makeRes();
    await handleBrainAuthToken(makeReq('POST', { token: 'ghp_bad' }), res);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_token');
  });

  it('logout clears the store', async () => {
    writeGlobalGitHubToken('ghp_x', home);
    const { res, status, body } = makeRes();
    await handleBrainAuthLogout(makeReq('POST', {}), res);
    expect(status()).toBe(200);
    expect(body().connected).toBe(false);
  });
});
