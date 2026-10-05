import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const runClaudeUpdateCheck = vi.fn();
vi.mock('../../src/lib/claude-update.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/claude-update.js')>()),
  runClaudeUpdateCheck: (...args: unknown[]) => runClaudeUpdateCheck(...args),
}));

const { claudeUpdateJobDisabledReason, startClaudeUpdateJob } = await import('../../src/server/claude-update-job.js');
const { handleAgentInstall, handleAgentInstallStatus } = await import('../../src/server/routes/agent-terminal.js');

/** The app-owned desktop server: the Tauri shell's pid is this process's ppid. */
const APP_ENV = { DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_PARENT_PID: '4242' };

beforeEach(() => {
  runClaudeUpdateCheck.mockReset();
  runClaudeUpdateCheck.mockResolvedValue({ ok: true, ran: true, message: 'Claude Code is up to date (2.1.289).', record: null });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('claudeUpdateJobDisabledReason', () => {
  it('runs only in the desktop app, never in the cloud or a test run', () => {
    expect(claudeUpdateJobDisabledReason(APP_ENV, 4242)).toBeNull();
    expect(claudeUpdateJobDisabledReason({}, 4242)).toBe('not the desktop app');
    expect(claudeUpdateJobDisabledReason({ ...APP_ENV, DREAMCONTEXT_CLOUD: '1' }, 4242)).toBe('cloud server');
    expect(claudeUpdateJobDisabledReason({ ...APP_ENV, VITEST: 'true' }, 4242)).toBe('test run');
    expect(claudeUpdateJobDisabledReason({ ...APP_ENV, NODE_ENV: 'test' }, 4242)).toBe('test run');
    expect(claudeUpdateJobDisabledReason({ ...APP_ENV, DREAMCONTEXT_CLAUDE_AUTOUPDATE: '0' }, 4242)).toBe('DREAMCONTEXT_CLAUDE_AUTOUPDATE=0');
  });

  it('runs only in the app-owned server, not a builder/verify dashboard that inherited DESKTOP=1', () => {
    const notOwned = 'ppid is not DREAMCONTEXT_PARENT_PID (not the app-owned server)';
    expect(claudeUpdateJobDisabledReason(APP_ENV, 9999)).toBe(notOwned);
    expect(claudeUpdateJobDisabledReason({ DREAMCONTEXT_DESKTOP: '1' }, 4242)).toBe(notOwned);
    expect(startClaudeUpdateJob({ env: APP_ENV, ppid: 9999 })).toBeUndefined();
    expect(console.log).toHaveBeenCalledWith(`  [claude-update] disabled: ${notOwned}`);
    expect(claudeUpdateJobDisabledReason(APP_ENV, 4242)).toBeNull();
  });
});

describe('startClaudeUpdateJob', () => {
  it('returns undefined and logs when gated off', () => {
    expect(startClaudeUpdateJob({ env: {} })).toBeUndefined();
    expect(console.log).toHaveBeenCalledWith('  [claude-update] disabled: not the desktop app');
    expect(runClaudeUpdateCheck).not.toHaveBeenCalled();
  });

  it('ticks after the first delay, then every interval, until stopped', async () => {
    vi.useFakeTimers();
    const stop = startClaudeUpdateJob({ env: APP_ENV, ppid: 4242, firstTickMs: 30_000, tickMs: 1000 })!;
    expect(stop).toBeTypeOf('function');
    await vi.advanceTimersByTimeAsync(29_999);
    expect(runClaudeUpdateCheck).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runClaudeUpdateCheck).toHaveBeenCalledTimes(1);
    expect(runClaudeUpdateCheck.mock.calls[0][0]).toEqual({});
    await vi.advanceTimersByTimeAsync(2000);
    expect(runClaudeUpdateCheck).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runClaudeUpdateCheck).toHaveBeenCalledTimes(3);
  });

  it('hourly ticks against the real 6 h throttle check at 6 h after the last check, not 12 h', async () => {
    vi.useFakeTimers({ now: 0 });
    const real = await vi.importActual<typeof import('../../src/lib/claude-update.js')>('../../src/lib/claude-update.js');
    runClaudeUpdateCheck.mockImplementation((o, d) => real.runClaudeUpdateCheck(o, d));
    const home = mkdtempSync(join(tmpdir(), 'dc-claude-update-job-'));
    const H = 60 * 60_000;
    try {
      // Each probe takes 2 min of (fake) wall time, the drift that made a 6 h timer skip.
      const probeStarts: number[] = [];
      const run = vi.fn((script: string) => {
        if (script === real.CLAUDE_VERSION_SCRIPT) probeStarts.push(Date.now());
        return new Promise<{ code: number; output: string }>((res) =>
          setTimeout(() => res({ code: 0, output: 'DA= DU=\n2.1.289 (Claude Code)\n' }), 2 * 60_000));
      });
      const fetchLatest = (async () => new Response(JSON.stringify({ latest: '2.1.289' }))) as unknown as typeof fetch;
      const stop = startClaudeUpdateJob({
        env: APP_ENV, ppid: 4242,
        deps: { home, env: {}, run, fetch: fetchLatest, now: () => Date.now() },
      })!;
      await vi.advanceTimersByTimeAsync(30_000 + 2 * 60_000);
      expect(probeStarts).toEqual([30_000]);
      expect(real.readClaudeUpdateRecord(home)).toMatchObject({ checkedAt: 30_000, state: 'current' });
      // Hourly ticks at 1 h .. 5 h after boot are all throttled.
      await vi.advanceTimersByTimeAsync(6 * H - 2 * 60_000 - 1);
      expect(probeStarts).toHaveLength(1);
      // The tick at 30 s + 6 h is exactly 6 h after the last checkedAt: it checks.
      await vi.advanceTimersByTimeAsync(1 + 2 * 60_000);
      expect(probeStarts).toEqual([30_000, 30_000 + 6 * H]);
      await vi.advanceTimersByTimeAsync(6 * H);
      expect(probeStarts).toEqual([30_000, 30_000 + 6 * H, 30_000 + 12 * H]);
      stop();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a stop before the first tick means no tick at all', async () => {
    vi.useFakeTimers();
    const stop = startClaudeUpdateJob({ env: APP_ENV, ppid: 4242, firstTickMs: 100 })!;
    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runClaudeUpdateCheck).not.toHaveBeenCalled();
  });
});

describe("POST /api/agent/install target 'claude-update'", () => {
  function fakeRes() {
    const res = { status: 0, body: '' as string };
    const r = {
      writeHead(code: number) { res.status = code; return r; },
      end(body?: string) { res.body = body ?? ''; },
    };
    return { res, r: r as unknown as ServerResponse, json: () => JSON.parse(res.body) as Record<string, unknown> };
  }
  const req = (body: unknown, url = '/api/agent/install'): IncomingMessage => {
    const s = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
    (s as { url?: string }).url = url;
    (s as { headers?: Record<string, string> }).headers = { host: 'localhost' };
    return s;
  };
  async function status(runId: string) {
    const out = fakeRes();
    await handleAgentInstallStatus(req(undefined, `/api/agent/install/status?id=${runId}`), out.r);
    return out.json();
  }

  beforeEach(() => { vi.stubEnv('DREAMCONTEXT_DESKTOP', '1'); });

  it('runs a forced check and reports done with its message', async () => {
    runClaudeUpdateCheck.mockResolvedValue({ ok: true, ran: true, message: 'Updated Claude Code 2.1.284 -> 2.1.289', record: null });
    const out = fakeRes();
    await handleAgentInstall(req({ target: 'claude-update' }), out.r);
    expect(out.res.status).toBe(200);
    const { runId } = out.json() as { runId: string };
    expect(runClaudeUpdateCheck).toHaveBeenCalledWith({ force: true });
    await vi.waitFor(async () => expect((await status(runId)).state).toBe('done'));
    expect(await status(runId)).toMatchObject({ target: 'claude-update', output: 'Updated Claude Code 2.1.284 -> 2.1.289' });
  });

  it('reports error with the failure tail', async () => {
    runClaudeUpdateCheck.mockResolvedValue({ ok: false, ran: true, message: 'run brew upgrade claude-code', record: null });
    const out = fakeRes();
    await handleAgentInstall(req({ target: 'claude-update' }), out.r);
    const { runId } = out.json() as { runId: string };
    await vi.waitFor(async () => expect((await status(runId)).state).toBe('error'));
    expect((await status(runId)).output).toBe('run brew upgrade claude-code');
  });

  it('lists claude-update in the 400 for an unknown target', async () => {
    const out = fakeRes();
    await handleAgentInstall(req({ target: 'nope' }), out.r);
    expect(out.res.status).toBe(400);
    expect(String(out.json().message)).toContain("'claude-update'");
  });
});
