import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FixOutcome } from '../../src/lib/onboarding/fixes.js';
import type { CheckId, ReadinessCheck, ReadinessReport } from '../../src/lib/onboarding/types.js';

/** `/api/onboarding/{readiness,fix,fix/cancel}`: the response contract and the pending
 *  `git init` trigger order. The probe, the recipes and the pending store are stand-ins. */

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
const runPendingGitInits = vi.fn((): string[] => []);
const listPendingGitInits = vi.fn((): string[] => []);
vi.mock('../../src/lib/onboarding/pending-git.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/onboarding/pending-git.js')>()),
  runPendingGitInits: () => runPendingGitInits(),
  listPendingGitInits: () => listPendingGitInits(),
}));

const { handleOnboardingFix, handleOnboardingFixCancel, handleOnboardingReadiness } = await import('../../src/server/routes/onboarding.js');
const { handleAgentInstallStatus } = await import('../../src/server/routes/agent-terminal.js');
const { resetInstallRunsForTests } = await import('../../src/server/install-runs.js');
const { resetReadinessForTests } = await import('../../src/lib/onboarding/readiness.js');

function check(id: CheckId, over: Partial<ReadinessCheck> = {}): ReadinessCheck {
  return { id, tier: 'required', scopes: ['machine'], status: 'ok', dependsOn: [], fix: null, ...over };
}
function report(checks: ReadinessCheck[]): ReadinessReport {
  return {
    version: 1, platform: 'darwin', arch: 'arm64', surface: 'desktop', generatedAt: 1,
    ready: false, online: true, plan: [], next: null, activeFixes: [], checks,
  };
}

function req(method: string, url: string, body?: unknown): IncomingMessage {
  const s = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(s, { method, url, headers: { host: '127.0.0.1:4173' }, socket: { remoteAddress: '127.0.0.1' } });
  return s;
}
function fakeRes() {
  const out = { status: 0, body: '' };
  const r = {
    writeHead(code: number) { out.status = code; return r; },
    end(b?: string) { out.body = b ?? ''; },
  };
  return { out, r: r as unknown as ServerResponse, json: () => JSON.parse(out.body) as Record<string, unknown> };
}
async function call(h: (q: IncomingMessage, s: ServerResponse) => Promise<void>, q: IncomingMessage) {
  const res = fakeRes();
  await h(q, res.r);
  return { status: res.out.status, body: res.json() };
}
async function status(runId: string) {
  return (await call(handleAgentInstallStatus, req('GET', `/api/agent/install/status?id=${runId}`))).body;
}

/** A runFix that stays pending until `settle`. */
function pendingFix() {
  let settle!: (o: FixOutcome) => void;
  runFix.mockImplementation(() => new Promise<FixOutcome>((r) => { settle = r; }));
  return (o: FixOutcome) => settle(o);
}

beforeEach(() => {
  vi.stubEnv('DREAMCONTEXT_DESKTOP', '1');
  vi.stubEnv('DREAMCONTEXT_CLOUD', '');
  resetInstallRunsForTests();
  resetReadinessForTests();
  getReadiness.mockReset();
  runFix.mockReset();
  runPendingGitInits.mockReset().mockReturnValue([]);
  listPendingGitInits.mockReset().mockReturnValue([]);
  getReadiness.mockResolvedValue(report([check('cli', { status: 'missing', fix: { id: 'cli-install', kind: 'auto', runnable: true, editsShellProfile: false } })]));
});
afterEach(() => { resetInstallRunsForTests(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('POST /api/onboarding/fix', () => {
  it('400 bad_fix for an unknown or missing fix id', async () => {
    expect((await call(handleOnboardingFix, req('POST', '/api/onboarding/fix', { fix: 'rm-rf' }))).status).toBe(400);
    const r = await call(handleOnboardingFix, req('POST', '/api/onboarding/fix', {}));
    expect(r).toMatchObject({ status: 400, body: { error: 'bad_fix' } });
  });

  it('409 blocked with blockedBy when the fix row waits on another check', async () => {
    getReadiness.mockResolvedValue(report([
      check('claude-auth', { status: 'blocked', blockedBy: ['claude'], fix: { id: 'claude-signin', kind: 'browser', runnable: true, editsShellProfile: false } }),
    ]));
    const r = await call(handleOnboardingFix, req('POST', '/api/onboarding/fix', { fix: 'claude-signin' }));
    expect(r).toMatchObject({ status: 409, body: { error: 'blocked', blockedBy: ['claude'] } });
    expect(runFix).not.toHaveBeenCalled();
  });

  it('422 manual_only with the command when the fix cannot run here', async () => {
    getReadiness.mockResolvedValue(report([
      check('git', { status: 'missing', tier: 'recommended', fix: { id: 'git-install', kind: 'manual', runnable: false, manual: 'sudo apt install git', editsShellProfile: false } }),
    ]));
    const r = await call(handleOnboardingFix, req('POST', '/api/onboarding/fix', { fix: 'git-install' }));
    expect(r).toMatchObject({ status: 422, body: { error: 'manual_only', manual: 'sudo apt install git' } });
  });

  it('200 with a run id, then 409 in_progress with the same id while it runs', async () => {
    const settle = pendingFix();
    const first = await call(handleOnboardingFix, req('POST', '/api/onboarding/fix', { fix: 'cli-install' }));
    expect(first).toMatchObject({ status: 200, body: { ok: true } });
    const runId = first.body.runId as string;
    const again = await call(handleOnboardingFix, req('POST', '/api/onboarding/fix', { fix: 'cli-install' }));
    expect(again).toMatchObject({ status: 409, body: { error: 'in_progress', runId } });
    expect(runFix).toHaveBeenCalledTimes(1);
    settle({ ok: true });
    await vi.waitFor(async () => expect((await status(runId)).state).toBe('done'));
  });

  it('cancel stops the run: status becomes error with outcome canceled', async () => {
    runFix.mockImplementation((_id: unknown, _ctx: unknown, _sink: unknown, signal: AbortSignal) =>
      new Promise<FixOutcome>((resolve) => signal.addEventListener('abort', () => resolve({ ok: false, reason: 'canceled', detail: 'Canceled.' }))));
    const start = await call(handleOnboardingFix, req('POST', '/api/onboarding/fix', { fix: 'cli-install' }));
    const runId = start.body.runId as string;
    const cancel = await call(handleOnboardingFixCancel, req('POST', '/api/onboarding/fix/cancel', { runId }));
    expect(cancel).toMatchObject({ status: 200, body: { ok: true, canceled: true } });
    await vi.waitFor(async () => expect(await status(runId)).toMatchObject({ state: 'error', outcome: 'canceled' }));
    const unknown = await call(handleOnboardingFixCancel, req('POST', '/api/onboarding/fix/cancel', { runId: 'nope' }));
    expect(unknown.body).toEqual({ ok: true, canceled: false });
  });
});

describe('GET /api/onboarding/readiness', () => {
  it('returns the report; fresh=1 is passed through', async () => {
    const r = await call(handleOnboardingReadiness, req('GET', '/api/onboarding/readiness?fresh=1'));
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(1);
    expect(getReadiness.mock.calls[0][1]).toEqual({ fresh: true });
  });

  it('reports the browser surface without the desktop flag', async () => {
    vi.stubEnv('DREAMCONTEXT_DESKTOP', '');
    await call(handleOnboardingReadiness, req('GET', '/api/onboarding/readiness'));
    expect((getReadiness.mock.calls[0][0] as { surface: string }).surface).toBe('browser');
  });
});

describe('pending git init trigger order', () => {
  it('a git-install run that ends ok runs them first; the readiness GET runs only what is left, once', async () => {
    const settle = pendingFix();
    getReadiness.mockResolvedValue(report([
      check('git', { status: 'missing', tier: 'recommended', fix: { id: 'git-install', kind: 'system-dialog', runnable: true, editsShellProfile: false } }),
    ]));
    const start = await call(handleOnboardingFix, req('POST', '/api/onboarding/fix', { fix: 'git-install' }));
    const runId = start.body.runId as string;
    settle({ ok: true });
    await vi.waitFor(async () => expect((await status(runId)).state).toBe('done'));
    expect(runPendingGitInits).toHaveBeenCalledTimes(1);

    // Order 1: the completion hook already emptied the list, so the readiness GET does nothing.
    getReadiness.mockResolvedValue(report([check('git', { tier: 'recommended' })]));
    listPendingGitInits.mockReturnValue([]);
    await call(handleOnboardingReadiness, req('GET', '/api/onboarding/readiness'));
    expect(runPendingGitInits).toHaveBeenCalledTimes(1);

    // Order 2: an entry recorded later (no run ended since) is picked up by the GET, once.
    listPendingGitInits.mockReturnValueOnce(['/projects/demo']).mockReturnValue([]);
    await call(handleOnboardingReadiness, req('GET', '/api/onboarding/readiness'));
    await call(handleOnboardingReadiness, req('GET', '/api/onboarding/readiness'));
    expect(runPendingGitInits).toHaveBeenCalledTimes(2);
  });

  it('the readiness GET never runs them while git is not ok', async () => {
    getReadiness.mockResolvedValue(report([check('git', { status: 'missing', tier: 'recommended' })]));
    listPendingGitInits.mockReturnValue(['/projects/demo']);
    await call(handleOnboardingReadiness, req('GET', '/api/onboarding/readiness'));
    expect(runPendingGitInits).not.toHaveBeenCalled();
  });
});
