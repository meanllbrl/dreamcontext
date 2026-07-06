import { describe, it, expect } from 'vitest';
import {
  startDeviceFlow,
  pollDeviceFlow,
  fetchAuthenticatedLogin,
  isOAuthAppConfigured,
  resolveBrainOAuthClientId,
  PLACEHOLDER_CLIENT_ID,
  DEFAULT_BRAIN_OAUTH_CLIENT_ID,
  BRAIN_OAUTH_SCOPE,
} from '../../src/lib/git-sync/oauth.js';

function jsonRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('git-sync/oauth — device flow (injected fetch, zero network)', () => {
  it('startDeviceFlow posts client_id + scope=repo and returns the code pair', async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      return jsonRes(200, {
        device_code: 'DEV123',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      });
    }) as unknown as typeof fetch;

    const started = await startDeviceFlow('Iv1.test', fetchImpl);
    expect(started.deviceCode).toBe('DEV123');
    expect(started.userCode).toBe('ABCD-EFGH');
    expect(started.interval).toBe(5);
    expect(calls[0].url).toContain('login/device/code');
    expect(calls[0].body).toContain('client_id=Iv1.test');
    expect(calls[0].body).toContain(`scope=${BRAIN_OAUTH_SCOPE}`);
  });

  it('pollDeviceFlow maps authorization_pending → pending', async () => {
    const fetchImpl = (async () => jsonRes(200, { error: 'authorization_pending' })) as unknown as typeof fetch;
    const res = await pollDeviceFlow('Iv1.test', 'DEV123', fetchImpl);
    expect(res.status).toBe('pending');
  });

  it('pollDeviceFlow maps slow_down → slow_down with the bumped interval', async () => {
    const fetchImpl = (async () => jsonRes(200, { error: 'slow_down', interval: 12 })) as unknown as typeof fetch;
    const res = await pollDeviceFlow('Iv1.test', 'DEV123', fetchImpl);
    expect(res.status).toBe('slow_down');
    if (res.status === 'slow_down') expect(res.interval).toBe(12);
  });

  it('pollDeviceFlow maps an access_token → authorized', async () => {
    const fetchImpl = (async () => jsonRes(200, { access_token: 'ghp_authorized' })) as unknown as typeof fetch;
    const res = await pollDeviceFlow('Iv1.test', 'DEV123', fetchImpl);
    expect(res.status).toBe('authorized');
    if (res.status === 'authorized') expect(res.token).toBe('ghp_authorized');
  });

  it('pollDeviceFlow maps expired_token / access_denied to terminal states', async () => {
    const expired = await pollDeviceFlow('Iv1.test', 'DEV123', (async () => jsonRes(200, { error: 'expired_token' })) as unknown as typeof fetch);
    expect(expired.status).toBe('expired');
    const denied = await pollDeviceFlow('Iv1.test', 'DEV123', (async () => jsonRes(200, { error: 'access_denied' })) as unknown as typeof fetch);
    expect(denied.status).toBe('denied');
  });

  it('isOAuthAppConfigured is false for the placeholder/empty, true for a real client_id', () => {
    expect(isOAuthAppConfigured(PLACEHOLDER_CLIENT_ID)).toBe(false);
    expect(isOAuthAppConfigured('')).toBe(false);
    expect(isOAuthAppConfigured('   ')).toBe(false);
    expect(isOAuthAppConfigured('Iv1.realclient')).toBe(true);
    expect(isOAuthAppConfigured('Ov23liAbCd')).toBe(true);
  });

  it('resolveBrainOAuthClientId reads the env var live, falling back to the registered default', () => {
    const prev = process.env.DREAMCONTEXT_GITHUB_CLIENT_ID;
    try {
      delete process.env.DREAMCONTEXT_GITHUB_CLIENT_ID;
      expect(resolveBrainOAuthClientId()).toBe(DEFAULT_BRAIN_OAUTH_CLIENT_ID);
      expect(isOAuthAppConfigured()).toBe(true);
      process.env.DREAMCONTEXT_GITHUB_CLIENT_ID = 'Iv1.fromenv';
      expect(resolveBrainOAuthClientId()).toBe('Iv1.fromenv');
      expect(isOAuthAppConfigured()).toBe(true);
      // Explicitly setting the placeholder forces PAT-only mode.
      process.env.DREAMCONTEXT_GITHUB_CLIENT_ID = PLACEHOLDER_CLIENT_ID;
      expect(resolveBrainOAuthClientId()).toBe(PLACEHOLDER_CLIENT_ID);
      expect(isOAuthAppConfigured()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.DREAMCONTEXT_GITHUB_CLIENT_ID;
      else process.env.DREAMCONTEXT_GITHUB_CLIENT_ID = prev;
    }
  });

  it('fetchAuthenticatedLogin returns the login on 200 and null on 401', async () => {
    const ok = await fetchAuthenticatedLogin('ghp_valid', (async () => jsonRes(200, { login: 'octocat' })) as unknown as typeof fetch);
    expect(ok).toBe('octocat');
    const bad = await fetchAuthenticatedLogin('ghp_bad', (async () => jsonRes(401, { message: 'Bad credentials' })) as unknown as typeof fetch);
    expect(bad).toBeNull();
  });
});
