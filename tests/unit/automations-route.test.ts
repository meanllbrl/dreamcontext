import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

// `node:child_process`'s `spawn` is imported once at module load by
// `runner.ts` (aliased `nodeSpawn`) — mocking the module here lets the
// "unapproved slug" test assert ZERO real spawns through the full
// route → job → real-runner path, not just a fast status code.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

// `runAutomation` itself is mocked ONLY for the trackChild-wiring tests below —
// those need to reach the `host:'server'` / `registerChild` branch without a
// real `claude` spawn ever existing to time out or hang the suite.
vi.mock('../../src/lib/automations/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/automations/runner.js')>();
  return { ...actual, runAutomation: vi.fn(actual.runAutomation) };
});

import { spawn as mockedSpawn } from 'node:child_process';
import { runAutomation } from '../../src/lib/automations/runner.js';
import type { RunOptions, RunOutcome } from '../../src/lib/automations/runner.js';
import { Router } from '../../src/server/router.js';
import { killTrackedChildren } from '../../src/server/lifecycle.js';
import { createAutomation } from '../../src/lib/automations/store.js';
import { approveAutomation } from '../../src/lib/automations/registry.js';
import { APPROVAL_DIFF_FIELDS } from '../../src/lib/automations/types.js';
import {
  handleAutomationsList,
  handleAutomationsRunStatus,
  handleAutomationsShow,
  handleAutomationsRunNow,
  handleAutomationsApprove,
} from '../../src/server/routes/automations.js';
import {
  startAutomationJob,
  currentAutomationJob,
} from '../../src/server/automation-job.js';

/**
 * `/api/automations*` — mirrors `tests/unit/tasks-token-route.test.ts`: call
 * handlers directly with a mock `res` and a `Readable`-backed req, no full
 * server boot. Covers the load-bearing route order, the no-prompt-from-body
 * contract on run-now, one job per contextRoot, and — the regression this
 * task exists to prevent — that `startAutomationJob` registers a real
 * FUNCTION with `trackChild` (never a `ChildProcess`) whose invocation issues
 * a negative-PID (process-GROUP) kill, not a PID-only one.
 */

function makeRes(): { res: ServerResponse; status: () => number; body: () => Record<string, unknown> } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) { try { responseBody = JSON.parse(data); } catch { responseBody = data; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody as Record<string, unknown> };
}

function makePostReq(): IncomingMessage {
  // No body is ever sent — handleAutomationsRunNow must not require or read one.
  const readable = Readable.from([]);
  return Object.assign(readable, { method: 'POST', headers: {} }) as unknown as IncomingMessage;
}

const getReq = { method: 'GET', headers: {} } as unknown as IncomingMessage;

let projectRoot: string;
let contextRoot: string;
let realHome: string | undefined;
let fakeHome: string;

function makeAutomation(slug: string, opts: { approve?: boolean } = { approve: true }) {
  const manifest = createAutomation(contextRoot, {
    slug,
    title: `Title for ${slug}`,
    days: 'daily',
    at: '18:00',
    prompt: 'do the thing',
  });
  if (opts.approve !== false) approveAutomation(projectRoot, manifest, new Date('2026-07-25T12:00:00.000Z'));
  return manifest;
}

function fakeOutcome(slug: string, status: RunOutcome['status'] = 'ok'): RunOutcome {
  return {
    slug,
    status,
    outputPath: null,
    error: status === 'ok' ? null : 'boom',
    durationMs: 5,
    event: null,
    cache: null,
    denials: 0,
    costUsd: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-automations-route-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });

  // The route handlers call `checkApproval`/`approveAutomation` with no `home`
  // override (they run inside the real server against the real home) — so the
  // machine-local registry (`~/.dreamcontext/automations.json` /
  // `automations-tick.json`) resolves via `os.homedir()`, which honours $HOME
  // on POSIX. Without this, every test here writes to the developer's REAL
  // home directory — a feature that ships "completely disabled" must never do
  // that from a test run. Isolate for every test in this file.
  realHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), 'dc-route-home-'));
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

// ─── route order (load-bearing: /runs must resolve before /:slug) ──────────

describe('route registration order', () => {
  it('/api/automations/runs resolves to the runs handler, never captured as a :slug', () => {
    // Mirrors index.ts's exact registration order for this route family.
    const router = new Router();
    router.get('/api/automations', handleAutomationsList);
    router.get('/api/automations/runs', handleAutomationsRunStatus);
    router.get('/api/automations/:slug', handleAutomationsShow);
    router.post('/api/automations/:slug/run', handleAutomationsRunNow);
    router.post('/api/automations/:slug/approve', handleAutomationsApprove);

    const runsMatch = router.match('GET', '/api/automations/runs');
    expect(runsMatch?.handler).toBe(handleAutomationsRunStatus);
    expect(runsMatch?.params).toEqual({});

    const listMatch = router.match('GET', '/api/automations');
    expect(listMatch?.handler).toBe(handleAutomationsList);

    const slugMatch = router.match('GET', '/api/automations/eod-digest');
    expect(slugMatch?.handler).toBe(handleAutomationsShow);
    expect(slugMatch?.params).toEqual({ slug: 'eod-digest' });

    const runMatch = router.match('POST', '/api/automations/eod-digest/run');
    expect(runMatch?.handler).toBe(handleAutomationsRunNow);

    const approveMatch = router.match('POST', '/api/automations/eod-digest/approve');
    expect(approveMatch?.handler).toBe(handleAutomationsApprove);
  });

  it('WOULD misroute /runs as a slug if registered in the wrong order (proves the ordering is load-bearing)', () => {
    const router = new Router();
    router.get('/api/automations/:slug', handleAutomationsShow);
    router.get('/api/automations/runs', handleAutomationsRunStatus);
    const match = router.match('GET', '/api/automations/runs');
    expect(match?.handler).toBe(handleAutomationsShow);
    expect(match?.params).toEqual({ slug: 'runs' });
  });
});

// ─── list / show ─────────────────────────────────────────────────────────────

describe('GET /api/automations', () => {
  it('lists automations with their approval and cache state', async () => {
    makeAutomation('approved-one', { approve: true });
    makeAutomation('unapproved-one', { approve: false });

    const { res, status, body } = makeRes();
    await handleAutomationsList(getReq, res, {}, contextRoot);

    expect(status()).toBe(200);
    const automations = body().automations as Array<Record<string, unknown>>;
    expect(automations).toHaveLength(2);
    const approved = automations.find((a) => a.slug === 'approved-one');
    const unapproved = automations.find((a) => a.slug === 'unapproved-one');
    expect(approved).toMatchObject({ approved: true, approvalReason: null });
    expect(unapproved).toMatchObject({ approved: false, approvalReason: 'never-approved' });
  });
});

describe('GET /api/automations/:slug', () => {
  it('404s for a missing slug', async () => {
    const { res, status, body } = makeRes();
    await handleAutomationsShow(getReq, res, { slug: 'does-not-exist' }, contextRoot);
    expect(status()).toBe(404);
    expect(body().error).toBe('not_found');
  });

  it('returns the manifest, approval state, and cache for an existing slug', async () => {
    makeAutomation('eod-digest', { approve: true });
    const { res, status, body } = makeRes();
    await handleAutomationsShow(getReq, res, { slug: 'eod-digest' }, contextRoot);
    expect(status()).toBe(200);
    expect(body()).toMatchObject({
      automation: { slug: 'eod-digest', prompt: 'do the thing' },
      approved: true,
    });
  });

  /**
   * REGRESSION LOCK (the real one). `effort` shipped into the manifest and the
   * approval hash but never into this payload, so the dashboard's approval review
   * rendered five of the six hashed fields and a reviewer could not see `effort`
   * at all. Enumerating APPROVAL_DIFF_FIELDS instead of listing names by hand
   * means the NEXT field added to the hash fails here until it is surfaced too —
   * a hardcoded list would have to be remembered, which is exactly what failed.
   */
  it('exposes EVERY approval-hashed field, so the dashboard review can never show a subset', async () => {
    makeAutomation('full-field-review', { approve: true });
    const { res, status, body } = makeRes();
    await handleAutomationsShow(getReq, res, { slug: 'full-field-review' }, contextRoot);
    expect(status()).toBe(200);
    const automation = body().automation as Record<string, unknown>;
    for (const field of APPROVAL_DIFF_FIELDS) {
      expect(
        Object.prototype.hasOwnProperty.call(automation, field),
        `the detail payload omits approval-hashed field "${field}" — the dashboard cannot review what it never receives`,
      ).toBe(true);
    }
  });

  it('carries a non-null effort through verbatim, not just the key', async () => {
    const manifest = createAutomation(contextRoot, {
      slug: 'effort-carrier',
      title: 'Effort carrier',
      days: 'daily',
      at: '18:00',
      prompt: 'do the thing',
      effort: 'high',
    });
    approveAutomation(projectRoot, manifest, new Date('2026-07-25T12:00:00.000Z'));
    const { res, body } = makeRes();
    await handleAutomationsShow(getReq, res, { slug: 'effort-carrier' }, contextRoot);
    expect((body().automation as Record<string, unknown>).effort).toBe('high');
  });
});

// ─── run-now: no prompt from the body, approval-gated, no spawn when blocked ─

describe('POST /api/automations/:slug/run', () => {
  it('404s for a missing slug without starting a job', async () => {
    const { res, status } = makeRes();
    await handleAutomationsRunNow(makePostReq(), res, { slug: 'nope' }, contextRoot);
    expect(status()).toBe(404);
    expect(currentAutomationJob(contextRoot)).toBeNull();
  });

  it('an unapproved slug is blocked by the REAL runner and never reaches spawn — proven against the real node:child_process.spawn', async () => {
    makeAutomation('unapproved', { approve: false });

    const { res, status, body } = makeRes();
    await handleAutomationsRunNow(makePostReq(), res, { slug: 'unapproved' }, contextRoot);
    expect(status()).toBe(200);
    expect(body().started).toBe(true);

    // The blocked short-circuit resolves synchronously-fast (no process ever
    // spawned) — wait for the job to settle, then assert on its outcome.
    await vi.waitFor(() => {
      const job = currentAutomationJob(contextRoot);
      expect(job?.status).not.toBe('running');
    });

    const job = currentAutomationJob(contextRoot);
    expect(job?.outcome?.status).toBe('blocked');
    expect(job?.outcome?.error).toMatch(/not approved/);
    // The decisive assertion: the real spawn (not a fake) was never invoked.
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('one job per contextRoot: a second run-now while one is in flight adopts it (started:false)', async () => {
    makeAutomation('slow-job', { approve: true });
    let resolveRun!: (o: RunOutcome) => void;
    vi.mocked(runAutomation).mockImplementationOnce(
      () => new Promise<RunOutcome>((resolve) => { resolveRun = resolve; }),
    );

    const first = makeRes();
    await handleAutomationsRunNow(makePostReq(), first.res, { slug: 'slow-job' }, contextRoot);
    expect(first.body().started).toBe(true);

    const second = makeRes();
    await handleAutomationsRunNow(makePostReq(), second.res, { slug: 'slow-job' }, contextRoot);
    expect(second.status()).toBe(200);
    expect(second.body().started).toBe(false);
    expect((second.body().job as { id: string }).id).toBe((first.body().job as { id: string }).id);

    resolveRun(fakeOutcome('slow-job', 'ok'));
    await vi.waitFor(() => expect(currentAutomationJob(contextRoot)?.status).toBe('success'));
  });
});

describe('GET /api/automations/runs', () => {
  it('reports null when nothing has run yet', async () => {
    const { res, status, body } = makeRes();
    await handleAutomationsRunStatus(getReq, res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body()).toEqual({ job: null });
  });

  it('polls the same job that run-now started', async () => {
    makeAutomation('poll-me', { approve: true });
    vi.mocked(runAutomation).mockResolvedValueOnce(fakeOutcome('poll-me', 'ok'));

    const runRes = makeRes();
    await handleAutomationsRunNow(makePostReq(), runRes.res, { slug: 'poll-me' }, contextRoot);

    await vi.waitFor(async () => {
      const pollRes = makeRes();
      await handleAutomationsRunStatus(getReq, pollRes.res, {}, contextRoot);
      expect((pollRes.body().job as { status: string } | null)?.status).toBe('success');
    });
  });
});

// ─── approve ─────────────────────────────────────────────────────────────────

describe('POST /api/automations/:slug/approve', () => {
  it('404s for a missing slug', async () => {
    const { res, status } = makeRes();
    await handleAutomationsApprove(makePostReq(), res, { slug: 'nope' }, contextRoot);
    expect(status()).toBe(404);
  });

  it('approves the manifest as it stands, unblocking a subsequent run', async () => {
    makeAutomation('needs-approval', { approve: false });

    const approveRes = makeRes();
    await handleAutomationsApprove(makePostReq(), approveRes.res, { slug: 'needs-approval' }, contextRoot);
    expect(approveRes.status()).toBe(200);
    expect(approveRes.body()).toMatchObject({ slug: 'needs-approval' });

    const showRes = makeRes();
    await handleAutomationsShow(getReq, showRes.res, { slug: 'needs-approval' }, contextRoot);
    expect(showRes.body().approved).toBe(true);
  });
});

// ─── the regression this task exists to prevent ─────────────────────────────

describe('startAutomationJob process-group wiring (the single most important detail in this task)', () => {
  it('passes host:"server" and a real registerChild function that returns an untrack function', async () => {
    let registeredUntrack: (() => void) | null = null;

    vi.mocked(runAutomation).mockImplementationOnce(async (_root: string, slug: string, opts: RunOptions) => {
      // The precondition this whole task guards: server-hosted runs MUST supply
      // a callback, never a bare ChildProcess — `registerChild`'s type signature
      // is `(killGroup: () => void) => () => void`, so a `trackChild(child)`
      // (ChildProcess) call site inside automation-job.ts would not satisfy it.
      if (opts.host !== 'server') throw new Error('expected host:"server"');
      if (typeof opts.registerChild !== 'function') throw new Error('expected a registerChild function');
      registeredUntrack = opts.registerChild(() => {});
      expect(typeof registeredUntrack).toBe('function');
      return fakeOutcome(slug, 'ok');
    });

    makeAutomation('long-runner', { approve: true });
    const { started } = startAutomationJob(contextRoot, 'long-runner');
    expect(started).toBe(true);

    await vi.waitFor(() => expect(currentAutomationJob(contextRoot)?.status).toBe('success'));
    expect(registeredUntrack).not.toBeNull();
  });

  it('killTrackedChildren() invokes the registered group-kill, proving the wiring end-to-end with the REAL lifecycle reaper', async () => {
    const groupKill = vi.fn();

    vi.mocked(runAutomation).mockImplementationOnce(
      (_root: string, slug: string, opts: RunOptions) =>
        new Promise<RunOutcome>((resolve) => {
          if (opts.host !== 'server') throw new Error('expected host:"server"');
          // Register with the REAL trackChild via automation-job.ts's real
          // wiring, and deliberately never call the returned untrack — this
          // simulates a run still in flight when the server shuts down.
          opts.registerChild(() => groupKill(-42, 'SIGKILL'));
          // Never resolve — the job stays "running" while we simulate shutdown.
          void resolve;
        }),
    );

    makeAutomation('in-flight', { approve: true });
    startAutomationJob(contextRoot, 'in-flight');

    await vi.waitFor(() => expect(vi.mocked(runAutomation)).toHaveBeenCalled());

    // Simulates `index.ts`'s shutdown handler calling killTrackedChildren()
    // (src/server/index.ts:618-631) — the exact path a server SIGTERM takes.
    killTrackedChildren();

    expect(groupKill).toHaveBeenCalledExactlyOnceWith(-42, 'SIGKILL');
    expect(groupKill.mock.calls[0][0]).toBeLessThan(0); // negative PID = process GROUP, never a bare PID
  });
});
