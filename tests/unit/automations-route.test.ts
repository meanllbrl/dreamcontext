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
import { createAutomation, writeFlowSection, deriveFlowFromManifest } from '../../src/lib/automations/store.js';
import { approveAutomation } from '../../src/lib/automations/registry.js';
import { APPROVAL_DIFF_FIELDS, FLOW_GRAPH_VERSION, type FlowGraph } from '../../src/lib/automations/types.js';
import { createQuestion, claimQuestion } from '../../src/lib/automations/hitl.js';
import { enqueueFire } from '../../src/lib/automations/queue.js';
import { recordRun } from '../../src/lib/automations/store.js';
import { recordAutomationSession } from '../../src/lib/automations/session-registry.js';
import { mkdirSync as mkdirp, writeFileSync as writeFileP } from 'node:fs';
import { readTelegramConfigForSlug, writeTelegramConfigForSlug } from '../../src/lib/automations/telegram.js';
import {
  handleAutomationsList,
  handleAutomationsRunStatus,
  handleAutomationsShow,
  handleAutomationsRunNow,
  handleAutomationsApprove,
  handleAutomationsFlow,
  handleAutomationsQuestionsList,
  handleAutomationsQuestionAnswer,
  handleAutomationsTelegramGet,
  handleAutomationsTelegramSet,
  handleAutomationsQueue,
  handleAutomationsAttention,
  handleAutomationsAttentionAck,
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

/** For the routes below that DO read a JSON body (questions answer, telegram
 *  set). Buffers, not strings: `parseJsonBody` concats with `Buffer.concat`,
 *  which throws on string chunks and degrades to a null body — a string-chunk
 *  helper would make every "the body was honoured" assertion pass vacuously. */
function makePostReqWithBody(body?: unknown): IncomingMessage {
  const readable = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf-8')]);
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

/** A transcript on disk under the fake HOME. A session id with no transcript is
 *  deliberately not offered by the routes (`--resume` would fresh-pin a blank
 *  chat claiming to be the run), so any fixture expected to surface needs one. */
function seedTranscript(id: string): void {
  const dir = join(fakeHome, '.claude', 'projects', 'dc-route-proj');
  mkdirp(dir, { recursive: true });
  writeFileP(join(dir, `${id}.jsonl`), `{"sessionId":"${id}","type":"user"}\n`, 'utf-8');
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

  /**
   * `questions` and `queue` (C2/T13) — the same load-bearing shape as `runs`
   * above: both are literal 3-segment sub-paths, exactly like `/:slug`, so
   * registration order between them and `/:slug` decides which one wins.
   */
  it('/api/automations/questions and /api/automations/queue resolve to their own handlers, never captured as a :slug', () => {
    // Mirrors index.ts's exact registration order for this route family.
    const router = new Router();
    router.get('/api/automations', handleAutomationsList);
    router.get('/api/automations/runs', handleAutomationsRunStatus);
    router.get('/api/automations/questions', handleAutomationsQuestionsList);
    router.post('/api/automations/questions/:id', handleAutomationsQuestionAnswer);
    router.get('/api/automations/queue', handleAutomationsQueue);
    router.get('/api/automations/:slug', handleAutomationsShow);
    router.get('/api/automations/:slug/flow', handleAutomationsFlow);
    router.get('/api/automations/:slug/telegram', handleAutomationsTelegramGet);
    router.post('/api/automations/:slug/telegram', handleAutomationsTelegramSet);

    const questionsMatch = router.match('GET', '/api/automations/questions');
    expect(questionsMatch?.handler).toBe(handleAutomationsQuestionsList);
    expect(questionsMatch?.params).toEqual({});

    const answerMatch = router.match('POST', '/api/automations/questions/q_abc123');
    expect(answerMatch?.handler).toBe(handleAutomationsQuestionAnswer);
    expect(answerMatch?.params).toEqual({ id: 'q_abc123' });

    const queueMatch = router.match('GET', '/api/automations/queue');
    expect(queueMatch?.handler).toBe(handleAutomationsQueue);
    expect(queueMatch?.params).toEqual({});

    // …and the :slug routes it sits in front of still resolve normally,
    // including the 4-segment `/flow` and `/telegram` sub-paths, whose
    // ordering relative to `/:slug` is NOT load-bearing (different shape).
    const slugMatch = router.match('GET', '/api/automations/eod-digest');
    expect(slugMatch?.handler).toBe(handleAutomationsShow);
    expect(slugMatch?.params).toEqual({ slug: 'eod-digest' });

    const flowMatch = router.match('GET', '/api/automations/eod-digest/flow');
    expect(flowMatch?.handler).toBe(handleAutomationsFlow);
    expect(flowMatch?.params).toEqual({ slug: 'eod-digest' });

    const telegramGetMatch = router.match('GET', '/api/automations/eod-digest/telegram');
    expect(telegramGetMatch?.handler).toBe(handleAutomationsTelegramGet);
    const telegramPostMatch = router.match('POST', '/api/automations/eod-digest/telegram');
    expect(telegramPostMatch?.handler).toBe(handleAutomationsTelegramSet);
  });

  it('WOULD misroute /questions and /queue as a slug if registered after /:slug (proves the ordering is load-bearing)', () => {
    const router = new Router();
    router.get('/api/automations/:slug', handleAutomationsShow);
    router.get('/api/automations/questions', handleAutomationsQuestionsList);
    router.get('/api/automations/queue', handleAutomationsQueue);

    const questionsMatch = router.match('GET', '/api/automations/questions');
    expect(questionsMatch?.handler).toBe(handleAutomationsShow);
    expect(questionsMatch?.params).toEqual({ slug: 'questions' });

    const queueMatch = router.match('GET', '/api/automations/queue');
    expect(queueMatch?.handler).toBe(handleAutomationsShow);
    expect(queueMatch?.params).toEqual({ slug: 'queue' });
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

// ─── flow ────────────────────────────────────────────────────────────────────

describe('GET /api/automations/:slug/flow', () => {
  it('404s for a missing slug', async () => {
    const { res, status } = makeRes();
    await handleAutomationsFlow(getReq, res, { slug: 'nope' }, contextRoot);
    expect(status()).toBe(404);
  });

  it('returns a DERIVED graph when the manifest has no ## Flow block', async () => {
    const manifest = makeAutomation('flow-derived', { approve: false });

    const { res, status, body } = makeRes();
    await handleAutomationsFlow(getReq, res, { slug: 'flow-derived' }, contextRoot);
    expect(status()).toBe(200);
    expect(body().derived).toBe(true);
    expect(body().flow).toEqual(deriveFlowFromManifest(manifest));
  });

  it('returns the AUTHORED graph verbatim when the manifest has a ## Flow block', async () => {
    makeAutomation('flow-authored', { approve: false });
    const graph: FlowGraph = {
      version: FLOW_GRAPH_VERSION,
      nodes: [
        { id: 'trigger', kind: 'trigger', label: 'every day at 09:00' },
        { id: 'run', kind: 'agent', label: 'Custom step' },
      ],
      edges: [{ from: 'trigger', to: 'run' }],
    };
    writeFlowSection(contextRoot, 'flow-authored', graph);

    const { res, status, body } = makeRes();
    await handleAutomationsFlow(getReq, res, { slug: 'flow-authored' }, contextRoot);
    expect(status()).toBe(200);
    expect(body().derived).toBe(false);
    expect(body().flow).toEqual(graph);
  });
});

// ─── questions (human-in-the-loop) ──────────────────────────────────────────

describe('GET /api/automations/questions', () => {
  it('reports an empty queue when nothing is pending — not an error', async () => {
    const { res, status, body } = makeRes();
    await handleAutomationsQuestionsList(getReq, res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body()).toEqual({ questions: [] });
  });

  it('returns pending questions across every slug, oldest first', async () => {
    makeAutomation('q-slug-a', { approve: false });
    makeAutomation('q-slug-b', { approve: false });
    const older = createQuestion(contextRoot, {
      slug: 'q-slug-a',
      runFiredAt: '2026-08-01T18:00:00.000Z',
      kind: 'flow-hitl',
      sessionId: null,
      channel: 'chat',
      question: 'Which template?',
      nowISO: '2026-08-01T18:00:01.000Z',
    });
    const newer = createQuestion(contextRoot, {
      slug: 'q-slug-b',
      runFiredAt: '2026-08-02T09:00:00.000Z',
      kind: 'approval',
      sessionId: null,
      channel: 'chat',
      question: 'Approve the edited manifest?',
      nowISO: '2026-08-02T09:00:01.000Z',
    });

    const { res, status, body } = makeRes();
    await handleAutomationsQuestionsList(getReq, res, {}, contextRoot);
    expect(status()).toBe(200);
    const ids = (body().questions as Array<{ id: string }>).map((q) => q.id);
    expect(ids).toEqual([older.id, newer.id]);
  });
});

describe('POST /api/automations/questions/:id', () => {
  it('404s for an unknown id', async () => {
    const { res, status, body } = makeRes();
    await handleAutomationsQuestionAnswer(makePostReqWithBody({ answer: 'approve' }), res, { id: 'nope' }, contextRoot);
    expect(status()).toBe(404);
    expect(body().error).toBe('not_found');
  });

  it('400s on an empty answer', async () => {
    makeAutomation('q-empty', { approve: false });
    const question = createQuestion(contextRoot, {
      slug: 'q-empty',
      runFiredAt: new Date().toISOString(),
      kind: 'approval',
      sessionId: null,
      channel: 'chat',
      question: 'Approve?',
    });

    const { res, status } = makeRes();
    await handleAutomationsQuestionAnswer(makePostReqWithBody({ answer: '   ' }), res, { id: question.id }, contextRoot);
    expect(status()).toBe(400);
  });

  describe("kind: 'approval' (the sha256 tripwire's own gate, wearing a dashboard face)", () => {
    it('approve/yes claims, approves the manifest, and starts a fresh run through the SAME run-now primitive', async () => {
      makeAutomation('q-approve', { approve: false });
      vi.mocked(runAutomation).mockResolvedValueOnce(fakeOutcome('q-approve', 'ok'));
      const question = createQuestion(contextRoot, {
        slug: 'q-approve',
        runFiredAt: new Date().toISOString(),
        kind: 'approval',
        sessionId: null,
        channel: 'chat',
        question: 'The manifest changed — approve it?',
      });

      const { res, status, body } = makeRes();
      // Whitespace + uppercase, to prove the decision is normalized before matching.
      await handleAutomationsQuestionAnswer(makePostReqWithBody({ answer: '  APPROVE  ' }), res, { id: question.id }, contextRoot);
      expect(status()).toBe(200);
      expect(body()).toMatchObject({ status: 'ok', approved: true, started: true });

      const showRes = makeRes();
      await handleAutomationsShow(getReq, showRes.res, { slug: 'q-approve' }, contextRoot);
      expect(showRes.body().approved).toBe(true);

      await vi.waitFor(() => expect(currentAutomationJob(contextRoot)?.status).toBe('success'));
    });

    it('reject/no claims and records the decision, but approves nothing and starts nothing', async () => {
      makeAutomation('q-reject', { approve: false });
      const question = createQuestion(contextRoot, {
        slug: 'q-reject',
        runFiredAt: new Date().toISOString(),
        kind: 'approval',
        sessionId: null,
        channel: 'chat',
        question: 'The manifest changed — approve it?',
      });

      const { res, status, body } = makeRes();
      await handleAutomationsQuestionAnswer(makePostReqWithBody({ answer: 'no' }), res, { id: question.id }, contextRoot);
      expect(status()).toBe(200);
      expect(body()).toMatchObject({ status: 'ok', approved: false });
      expect(body().job).toBeUndefined();
      expect(body().started).toBeUndefined();

      const showRes = makeRes();
      await handleAutomationsShow(getReq, showRes.res, { slug: 'q-reject' }, contextRoot);
      expect(showRes.body().approved).toBe(false);
      expect(currentAutomationJob(contextRoot)).toBeNull();

      // The question itself is no longer pending — it does not keep re-asking
      // the same diff forever — but nothing ran and nothing was approved.
      const listRes = makeRes();
      await handleAutomationsQuestionsList(getReq, listRes.res, {}, contextRoot);
      expect(listRes.body().questions).toEqual([]);
    });

    /**
     * THE DEFECT this coverage exists to lock closed: an approval question
     * must never treat free text as consent. "no, this looks wrong" reads as
     * a refusal to a human — converting it into approval would be worse than
     * no gate at all, because the human believes they said no.
     */
    it('free text is NEVER interpreted as consent — 400, and nothing is decided', async () => {
      makeAutomation('q-freetext', { approve: false });
      const question = createQuestion(contextRoot, {
        slug: 'q-freetext',
        runFiredAt: new Date().toISOString(),
        kind: 'approval',
        sessionId: null,
        channel: 'chat',
        question: 'The manifest changed — approve it?',
      });

      const { res, status, body } = makeRes();
      await handleAutomationsQuestionAnswer(
        makePostReqWithBody({ answer: 'no, this looks wrong' }),
        res,
        { id: question.id },
        contextRoot,
      );
      expect(status()).toBe(400);
      expect(body().error).toBe('bad_request');

      // Nothing was decided: the question is still open for a real decision,
      // the manifest is exactly as unapproved as before, and nothing ran.
      const listRes = makeRes();
      await handleAutomationsQuestionsList(getReq, listRes.res, {}, contextRoot);
      expect((listRes.body().questions as Array<{ id: string }>).map((q) => q.id)).toEqual([question.id]);

      const showRes = makeRes();
      await handleAutomationsShow(getReq, showRes.res, { slug: 'q-freetext' }, contextRoot);
      expect(showRes.body().approved).toBe(false);
      expect(currentAutomationJob(contextRoot)).toBeNull();
    });

    it('a second answer to an already-claimed question is 409 — disk is the authority, not the route\'s initial list read', async () => {
      makeAutomation('q-race', { approve: false });
      const question = createQuestion(contextRoot, {
        slug: 'q-race',
        runFiredAt: new Date().toISOString(),
        kind: 'approval',
        sessionId: null,
        channel: 'chat',
        question: 'The manifest changed — approve it?',
      });

      const { res, status, body } = makeRes();
      const pending = handleAutomationsQuestionAnswer(
        makePostReqWithBody({ answer: 'approve' }),
        res,
        { id: question.id },
        contextRoot,
      );

      // Claim it out from under the in-flight request. Deterministic, not a
      // timing race: this line runs SYNCHRONOUSLY, before the pending call's
      // own `await parseJsonBody(req)` has had a chance to resolve (that
      // resolution needs the request stream's 'data'/'end' events, which only
      // fire on a later tick) — so this always wins.
      claimQuestion(contextRoot, question, 'answered elsewhere', 'cli');

      await pending;
      expect(status()).toBe(409);
      expect(body().error).toBe('refused');
    });
  });

  it("kind: 'flow-hitl' routes through resumeWithAnswer, and free text IS accepted (refused here only for lack of a bound session, never for its shape)", async () => {
    makeAutomation('q-flow', { approve: true });
    const question = createQuestion(contextRoot, {
      slug: 'q-flow',
      runFiredAt: new Date().toISOString(),
      kind: 'flow-hitl',
      sessionId: null,
      channel: 'chat',
      question: 'Which template should I use?',
    });

    const { res, status, body } = makeRes();
    await handleAutomationsQuestionAnswer(
      makePostReqWithBody({ answer: 'the first one, please' }),
      res,
      { id: question.id },
      contextRoot,
    );
    // Refused — but because nothing bound this question to a resumable
    // session on this machine, not because of the free-text shape (which the
    // approval branch above would have rejected at 400). Proves the route
    // actually dispatched to `resumeWithAnswer`, and never spawns when it
    // cannot resume.
    expect(status()).toBe(409);
    expect(body().error).toBe('refused');
    expect(mockedSpawn).not.toHaveBeenCalled();
  });
});

// ─── per-automation telegram ─────────────────────────────────────────────────

describe('GET/POST /api/automations/:slug/telegram', () => {
  it('404s for a missing slug on both verbs', async () => {
    const getRes = makeRes();
    await handleAutomationsTelegramGet(getReq, getRes.res, { slug: 'nope' }, contextRoot);
    expect(getRes.status()).toBe(404);

    const postRes = makeRes();
    await handleAutomationsTelegramSet(
      makePostReqWithBody({ botToken: 'x', chatId: '1' }),
      postRes.res,
      { slug: 'nope' },
      contextRoot,
    );
    expect(postRes.status()).toBe(404);
  });

  it('reads as not configured before any bot is set', async () => {
    makeAutomation('bot-unset', { approve: false });
    const { res, status, body } = makeRes();
    await handleAutomationsTelegramGet(getReq, res, { slug: 'bot-unset' }, contextRoot);
    expect(status()).toBe(200);
    expect(body()).toEqual({ telegram: { configured: false, chatId: null } });
  });

  it('400s on a malformed body — missing botToken or chatId', async () => {
    makeAutomation('bot-bad-body', { approve: false });

    const missingToken = makeRes();
    await handleAutomationsTelegramSet(
      makePostReqWithBody({ chatId: '123' }),
      missingToken.res,
      { slug: 'bot-bad-body' },
      contextRoot,
    );
    expect(missingToken.status()).toBe(400);

    const emptyBody = makeRes();
    await handleAutomationsTelegramSet(makePostReqWithBody({}), emptyBody.res, { slug: 'bot-bad-body' }, contextRoot);
    expect(emptyBody.status()).toBe(400);

    // …and neither malformed attempt actually wrote a config.
    expect(readTelegramConfigForSlug('bot-bad-body')).toBeNull();
  });

  it('sets the bot, and the token NEVER appears in either response body — asserted on the serialized JSON, not just object shape', async () => {
    makeAutomation('bot-secret', { approve: false });
    const secretToken = 'super-secret-bot-token-123456';

    const setRes = makeRes();
    await handleAutomationsTelegramSet(
      makePostReqWithBody({ botToken: secretToken, chatId: '555' }),
      setRes.res,
      { slug: 'bot-secret' },
      contextRoot,
    );
    expect(setRes.status()).toBe(200);
    expect(setRes.body()).toEqual({ telegram: { configured: true, chatId: '555' } });
    expect(JSON.stringify(setRes.body())).not.toContain(secretToken);

    const getRes = makeRes();
    await handleAutomationsTelegramGet(getReq, getRes.res, { slug: 'bot-secret' }, contextRoot);
    expect(getRes.body()).toEqual({ telegram: { configured: true, chatId: '555' } });
    expect(JSON.stringify(getRes.body())).not.toContain(secretToken);

    // …and it really was written (never leaked over HTTP, but not silently
    // dropped either) — the channel poller has to read it from somewhere.
    expect(readTelegramConfigForSlug('bot-secret')?.botToken).toBe(secretToken);
  });

  it('preserves the getUpdates offset across a re-save, so re-saving credentials never replays already-processed updates', async () => {
    makeAutomation('bot-reoffset', { approve: false });
    writeTelegramConfigForSlug('bot-reoffset', { botToken: 'old-token', chatId: '1', offset: 42 });

    const { res, status } = makeRes();
    await handleAutomationsTelegramSet(
      makePostReqWithBody({ botToken: 'new-token', chatId: '2' }),
      res,
      { slug: 'bot-reoffset' },
      contextRoot,
    );
    expect(status()).toBe(200);

    expect(readTelegramConfigForSlug('bot-reoffset')).toMatchObject({
      botToken: 'new-token',
      chatId: '2',
      offset: 42,
    });
  });
});

// ─── queue ───────────────────────────────────────────────────────────────────

describe('GET /api/automations/queue', () => {
  it('reports an empty queue when nothing is waiting', async () => {
    const { res, status, body } = makeRes();
    await handleAutomationsQueue(getReq, res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body()).toEqual({ queue: [] });
  });

  it('returns queued fires for this project, and a GET never drains them', async () => {
    makeAutomation('queued-one', { approve: true });
    const firedAt = new Date('2026-08-01T18:00:00.000Z').toISOString();
    enqueueFire(projectRoot, 'queued-one', firedAt);

    const first = makeRes();
    await handleAutomationsQueue(getReq, first.res, {}, contextRoot);
    expect(first.status()).toBe(200);
    expect(first.body().queue).toEqual([{ slug: 'queued-one', firedAt, enqueuedAt: expect.any(String) }]);

    // A second GET sees the SAME entry — proof it was never drained by the first.
    const second = makeRes();
    await handleAutomationsQueue(getReq, second.res, {}, contextRoot);
    expect(second.body().queue).toEqual(first.body().queue);
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


// ─── The pending question on the list row ──────────────────────────────────
//
// The list used to carry `pendingQuestionId: string | null` and nothing more,
// which left the board able to say a verdict was owed but not what on — the
// words lived behind `/questions`, which is only fetched once the run's chat
// is already open, i.e. behind the thing the user was trying to reach.

describe('GET /api/automations — the pending question', () => {
  it('carries the question text and the ASKING session, not just an id', async () => {
    makeAutomation('asks');
    createQuestion(contextRoot, {
      slug: 'asks',
      runFiredAt: '2026-08-26T06:30:00.000Z',
      kind: 'flow-hitl',
      sessionId: '11111111-1111-4111-8111-111111111111',
      channel: 'chat',
      question: 'Onay kartı: onayla / reddet / geri bildirim ver',
      choices: [],
      nowISO: '2026-08-26T06:54:00.000Z',
    });
    // Bound by THIS machine's runner AND with a transcript on disk — the only
    // case the uuid is offered.
    recordAutomationSession('asks', '11111111-1111-4111-8111-111111111111');
    seedTranscript('11111111-1111-4111-8111-111111111111');
    const { res, status, body } = makeRes();
    await handleAutomationsList(getReq, res, {}, contextRoot);
    expect(status()).toBe(200);
    const row = (body().automations as Array<Record<string, unknown>>)[0];
    expect(row.pendingQuestion).toMatchObject({
      kind: 'flow-hitl',
      question: 'Onay kartı: onayla / reddet / geri bildirim ver',
      sessionId: '11111111-1111-4111-8111-111111111111',
      runFiredAt: '2026-08-26T06:30:00.000Z',
    });
  });

  it('WITHHOLDS the session id of a question this machine never bound, but still shows the question', async () => {
    // A question record travels inside the brain; its gitignore coverage is
    // best-effort. A pulled-in one must not hand this client a resumable
    // bypassPermissions uuid — the WS gate scans automations/cache/*.json only,
    // so it would not catch this source. The words still render: seeing what a
    // teammate's automation asks is fine; resuming their conversation is not.
    makeAutomation('foreign');
    createQuestion(contextRoot, {
      slug: 'foreign',
      runFiredAt: '2026-08-26T06:30:00.000Z',
      kind: 'flow-hitl',
      sessionId: '99999999-9999-4999-8999-999999999999',
      channel: 'chat',
      question: 'Ship it?',
      choices: [],
      nowISO: '2026-08-26T06:54:00.000Z',
    });
    const { res, body } = makeRes();
    await handleAutomationsList(getReq, res, {}, contextRoot);
    const row = (body().automations as Array<Record<string, unknown>>)[0];
    expect(row.pendingQuestion).toMatchObject({ question: 'Ship it?', sessionId: null });
  });

  it('is null when nothing is open, and drops the answered-question fields', async () => {
    makeAutomation('quiet');
    const { res, body } = makeRes();
    await handleAutomationsList(getReq, res, {}, contextRoot);
    const row = (body().automations as Array<Record<string, unknown>>)[0];
    expect(row.pendingQuestion).toBeNull();
  });

  it('never leaks the answer-side fields a pending question does not have', async () => {
    makeAutomation('asks');
    createQuestion(contextRoot, {
      slug: 'asks',
      runFiredAt: '2026-08-26T06:30:00.000Z',
      kind: 'flow-hitl',
      sessionId: '11111111-1111-4111-8111-111111111111',
      channel: 'chat',
      question: 'q?',
      choices: [],
      nowISO: '2026-08-26T06:54:00.000Z',
    });
    recordAutomationSession('asks', '11111111-1111-4111-8111-111111111111');
    seedTranscript('11111111-1111-4111-8111-111111111111');
    const { res, body } = makeRes();
    await handleAutomationsList(getReq, res, {}, contextRoot);
    const row = (body().automations as Array<Record<string, unknown>>)[0];
    expect(Object.keys(row.pendingQuestion as object).sort())
      .toEqual(['choices', 'createdAt', 'id', 'kind', 'question', 'runFiredAt', 'sessionId']);
  });
});

// ─── Attention (D7) ────────────────────────────────────────────────────────

describe('GET /api/automations/attention', () => {
  it('returns runs needing a human WITHOUT advancing the watermark', async () => {
    makeAutomation('breaks');
    recordRun(contextRoot, 'breaks', {
      firedAt: '2026-08-28T06:30:00.000Z',
      startedAt: '2026-08-28T06:30:01.000Z',
      finishedAt: '2026-08-28T06:31:00.000Z',
      status: 'failed',
      durationMs: 59000,
      outputPath: null,
      error: 'boom',
      exitCode: 1,
      sessionId: '11111111-1111-4111-8111-111111111111',
      costUsd: null,
      numTurns: null,
      permissionDenials: 0,
    });
    recordAutomationSession('breaks', '11111111-1111-4111-8111-111111111111');
    seedTranscript('11111111-1111-4111-8111-111111111111');

    const first = makeRes();
    await handleAutomationsAttention(getReq, first.res, {}, contextRoot);
    expect(first.status()).toBe(200);
    expect((first.body().runs as unknown[])).toHaveLength(1);
    expect(first.body().watermark).toBeNull();

    // A read must not consume: closing the app mid-open is the exact moment
    // this feature exists to cover.
    const second = makeRes();
    await handleAutomationsAttention(getReq, second.res, {}, contextRoot);
    expect((second.body().runs as unknown[])).toHaveLength(1);
  });

  it('ack narrows the window, and a bad mark is refused rather than written', async () => {
    makeAutomation('breaks');
    recordRun(contextRoot, 'breaks', {
      firedAt: '2026-08-28T06:30:00.000Z',
      startedAt: '2026-08-28T06:30:01.000Z',
      finishedAt: '2026-08-28T06:31:00.000Z',
      status: 'timeout',
      durationMs: 59000,
      outputPath: null,
      error: 'timed out',
      exitCode: null,
      sessionId: '11111111-1111-4111-8111-111111111111',
      costUsd: null,
      numTurns: null,
      permissionDenials: 0,
    });
    recordAutomationSession('breaks', '11111111-1111-4111-8111-111111111111');
    seedTranscript('11111111-1111-4111-8111-111111111111');

    const bad = makeRes();
    await handleAutomationsAttentionAck(makePostReqWithBody({ upTo: 'nope' }), bad.res, {}, contextRoot);
    expect(bad.status()).toBe(400);

    const stillThere = makeRes();
    await handleAutomationsAttention(getReq, stillThere.res, {}, contextRoot);
    expect((stillThere.body().runs as unknown[])).toHaveLength(1);

    const ack = makeRes();
    await handleAutomationsAttentionAck(
      makePostReqWithBody({ upTo: '2026-08-28T06:31:00.000Z' }), ack.res, {}, contextRoot,
    );
    expect(ack.status()).toBe(200);

    const after = makeRes();
    await handleAutomationsAttention(getReq, after.res, {}, contextRoot);
    expect((after.body().runs as unknown[])).toEqual([]);
    expect(after.body().watermark).toBe('2026-08-28T06:31:00.000Z');
  });
});
