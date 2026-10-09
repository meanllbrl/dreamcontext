import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** The two guards in front of the onboarding and installer routes (security review, binding):
 *  - local desktop: not cloud + desktop flag + loopback peer + loopback `Host`;
 *  - local read: loopback peer + loopback `Host` + no cross-site fetch + no foreign Origin. */

const getReadiness = vi.fn();
vi.mock('../../src/lib/onboarding/readiness.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/onboarding/readiness.js')>()),
  getReadiness: (...a: unknown[]) => getReadiness(...a),
}));
const runFix = vi.fn();
vi.mock('../../src/lib/onboarding/fixes.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/onboarding/fixes.js')>()),
  runFix: (...a: unknown[]) => runFix(...a),
}));

const { handleOnboardingFix, handleOnboardingFixCancel, handleOnboardingReadiness } = await import('../../src/server/routes/onboarding.js');
const { handleAgentInstall, handleAgentInstallStatus } = await import('../../src/server/routes/agent-terminal.js');
const { isLoopbackHostHeader } = await import('../../src/server/routes/agent-spawn-shared.js');
const { classifyCloudRoute } = await import('../../src/server/cloud-mode.js');
const { resetInstallRunsForTests } = await import('../../src/server/install-runs.js');

interface ReqOpts { remote?: string; host?: string; headers?: Record<string, string> }
function req(method: string, url: string, body: unknown, o: ReqOpts = {}): IncomingMessage {
  const s = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(s, {
    method, url,
    headers: { host: o.host ?? '127.0.0.1:4173', ...(o.headers ?? {}) },
    socket: { remoteAddress: o.remote ?? '127.0.0.1' },
  });
  return s;
}
async function statusOf(h: (q: IncomingMessage, s: ServerResponse) => Promise<void>, q: IncomingMessage): Promise<number> {
  let code = 0;
  const r = { writeHead(c: number) { code = c; return r; }, end() { /* body unused */ } };
  await h(q, r as unknown as ServerResponse);
  return code;
}

const WRITE_ROUTES: Array<[string, (q: IncomingMessage, s: ServerResponse) => Promise<void>, string, string, unknown]> = [
  ['fix', handleOnboardingFix, 'POST', '/api/onboarding/fix', { fix: 'cli-install' }],
  ['fix/cancel', handleOnboardingFixCancel, 'POST', '/api/onboarding/fix/cancel', { runId: 'x' }],
  ['agent/install', handleAgentInstall, 'POST', '/api/agent/install', { target: 'claude' }],
  ['agent/install/status', handleAgentInstallStatus, 'GET', '/api/agent/install/status?id=x', undefined],
];

beforeEach(() => {
  vi.stubEnv('DREAMCONTEXT_DESKTOP', '1');
  vi.stubEnv('DREAMCONTEXT_CLOUD', '');
  resetInstallRunsForTests();
  getReadiness.mockReset().mockResolvedValue({ version: 1, checks: [], plan: [], activeFixes: [] });
  runFix.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => { resetInstallRunsForTests(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('local-desktop guard', () => {
  for (const [name, handler, method, url, body] of WRITE_ROUTES) {
    describe(name, () => {
      it('403 for a non-loopback peer', async () => {
        expect(await statusOf(handler, req(method, url, body, { remote: '100.64.0.7' }))).toBe(403);
      });
      it('403 for a foreign Host header (DNS rebinding)', async () => {
        expect(await statusOf(handler, req(method, url, body, { host: 'evil.example:4173' }))).toBe(403);
      });
      it('403 without the desktop flag', async () => {
        vi.stubEnv('DREAMCONTEXT_DESKTOP', '');
        expect(await statusOf(handler, req(method, url, body))).toBe(403);
      });
      it('403 in cloud mode', async () => {
        vi.stubEnv('DREAMCONTEXT_CLOUD', '1');
        expect(await statusOf(handler, req(method, url, body))).toBe(403);
      });
      it('passes the guard from this machine in the desktop app', async () => {
        expect(await statusOf(handler, req(method, url, body))).not.toBe(403);
      });
    });
  }
  it('nothing ran when the guard refused', async () => {
    await statusOf(handleOnboardingFix, req('POST', '/api/onboarding/fix', { fix: 'cli-install' }, { host: 'evil.example' }));
    expect(runFix).not.toHaveBeenCalled();
    expect(getReadiness).not.toHaveBeenCalled();
  });
});

describe('local-read guard (readiness)', () => {
  const read = (o: ReqOpts = {}) => statusOf(handleOnboardingReadiness, req('GET', '/api/onboarding/readiness', undefined, o));

  it('works without the desktop flag', async () => {
    vi.stubEnv('DREAMCONTEXT_DESKTOP', '');
    expect(await read()).toBe(200);
  });
  it('accepts a same-machine Origin', async () => {
    expect(await read({ headers: { origin: 'http://localhost:4173', 'sec-fetch-site': 'same-origin' } })).toBe(200);
  });
  it('403 for a non-loopback peer', async () => { expect(await read({ remote: '192.168.1.9' })).toBe(403); });
  it('403 for a foreign Host', async () => { expect(await read({ host: 'evil.example:4173' })).toBe(403); });
  it('403 for Sec-Fetch-Site: cross-site', async () => { expect(await read({ headers: { 'sec-fetch-site': 'cross-site' } })).toBe(403); });
  it('403 for a foreign Origin', async () => { expect(await read({ headers: { origin: 'https://evil.example' } })).toBe(403); });
  it('403 in cloud mode', async () => {
    vi.stubEnv('DREAMCONTEXT_CLOUD', '1');
    expect(await read()).toBe(403);
  });
});

describe('isLoopbackHostHeader', () => {
  it('accepts only the three loopback spellings, with an optional port', () => {
    for (const host of ['localhost', 'localhost:4173', '127.0.0.1', '127.0.0.1:80', '[::1]', '[::1]:4173', 'LOCALHOST:1']) {
      expect(isLoopbackHostHeader({ headers: { host } })).toBe(true);
    }
    for (const host of ['evil.example', 'localhost.evil.example', '127.0.0.1.nip.io', '10.0.0.1', '', 'localhost:abc']) {
      expect(isLoopbackHostHeader({ headers: { host } })).toBe(false);
    }
    expect(isLoopbackHostHeader({ headers: {} })).toBe(false);
  });
});

describe('cloud classification', () => {
  it('the onboarding routes are unavailable in the hands-free cloud', () => {
    expect(classifyCloudRoute('POST', '/api/onboarding/fix')).toBe('unavailable');
    expect(classifyCloudRoute('POST', '/api/onboarding/fix/cancel')).toBe('unavailable');
    expect(classifyCloudRoute('GET', '/api/onboarding/readiness')).toBe('unavailable');
  });
});
