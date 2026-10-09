import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** `POST /api/agent/install` keeps its targets but now runs them through the onboarding
 *  recipes in the shared run store. `git` keeps the old "done once the dialog opens". */

const runFix = vi.fn();
vi.mock('../../src/lib/onboarding/fixes.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/onboarding/fixes.js')>()),
  runFix: (...a: unknown[]) => runFix(...a),
}));
const gitAvailable = vi.fn(() => false);
vi.mock('../../src/lib/git-sync/git.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/git-sync/git.js')>()),
  gitAvailable: () => gitAvailable(),
}));

const { handleAgentInstall, handleAgentInstallStatus } = await import('../../src/server/routes/agent-terminal.js');
const { resetInstallRunsForTests } = await import('../../src/server/install-runs.js');

function req(method: string, url: string, body?: unknown): IncomingMessage {
  const s = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(s, { method, url, headers: { host: 'localhost:4173' }, socket: { remoteAddress: '::1' } });
  return s;
}
async function call(h: (q: IncomingMessage, s: ServerResponse) => Promise<void>, q: IncomingMessage) {
  const out = { status: 0, body: '' };
  const r = { writeHead(c: number) { out.status = c; return r; }, end(b?: string) { out.body = b ?? ''; } };
  await h(q, r as unknown as ServerResponse);
  return { status: out.status, body: JSON.parse(out.body) as Record<string, unknown> };
}
async function install(target: string) {
  return call(handleAgentInstall, req('POST', '/api/agent/install', { target }));
}
async function status(runId: string) {
  return (await call(handleAgentInstallStatus, req('GET', `/api/agent/install/status?id=${runId}`))).body;
}

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) { Object.defineProperty(process, 'platform', { value: p, configurable: true }); }

beforeEach(() => {
  vi.stubEnv('DREAMCONTEXT_DESKTOP', '1');
  vi.stubEnv('DREAMCONTEXT_CLOUD', '');
  resetInstallRunsForTests();
  runFix.mockReset().mockResolvedValue({ ok: true });
  gitAvailable.mockReset().mockReturnValue(false);
});
afterEach(() => {
  setPlatform(realPlatform);
  resetInstallRunsForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('legacy targets map to the onboarding fixes', () => {
  it.each([
    ['claude', 'claude-install'],
    ['pty', 'pty-install'],
    ['claude-path', 'claude-path'],
  ])('%s runs %s and reports done under its own target', async (target, fix) => {
    const r = await install(target);
    expect(r.status).toBe(200);
    expect(runFix.mock.calls[0][0]).toBe(fix);
    expect(runFix.mock.calls[0][4]).toEqual({});
    await vi.waitFor(async () => expect(await status(r.body.runId as string)).toMatchObject({ state: 'done', target }));
  });

  it('git runs git-install with waitForDialog false and is done once the dialog opens', async () => {
    setPlatform('darwin');
    const r = await install('git');
    expect(runFix.mock.calls[0][0]).toBe('git-install');
    expect(runFix.mock.calls[0][4]).toEqual({ waitForDialog: false });
    await vi.waitFor(async () => expect((await status(r.body.runId as string)).state).toBe('done'));
    expect(String((await status(r.body.runId as string)).output)).toContain('Follow the macOS window');
  });

  it('git off macOS answers 501 with this machine\'s own command and runs nothing', async () => {
    setPlatform('win32');
    const r = await install('git');
    expect(r.status).toBe(501);
    expect(String(r.body.message)).toContain('winget install Git.Git');
    expect(runFix).not.toHaveBeenCalled();
  });

  it('a failed recipe reports error with its detail', async () => {
    runFix.mockResolvedValue({ ok: false, reason: 'offline', detail: 'No internet connection.' });
    const r = await install('claude');
    await vi.waitFor(async () => expect(await status(r.body.runId as string)).toMatchObject({ state: 'error', outcome: 'offline' }));
    expect(String((await status(r.body.runId as string)).output)).toContain('No internet connection.');
  });

  it('400 for an unknown target', async () => {
    const r = await install('nope');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('bad_target');
  });

  it('an unknown run id reads as unknown', async () => {
    expect(await status('does-not-exist')).toEqual({ state: 'unknown', output: '' });
  });
});
