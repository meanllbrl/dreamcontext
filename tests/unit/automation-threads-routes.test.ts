import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Doubled for the reply routes: a real resume spawns `claude`. Hoisted so the mock is
 *  in place before `automation-job.ts` binds it. */
const resumeWithMessage = vi.hoisted(() => vi.fn(async () => ({ status: 'ok', error: null, result: null })));
vi.mock('../../src/lib/automations/verdict.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/automations/verdict.js')>()),
  resumeWithMessage,
}));
/** The machine-local session binding — the authority a reply resolves through. Doubled so
 *  a test can say "this machine has run it" without running it. */
const latestBoundSession = vi.hoisted(() => vi.fn<() => string | null>(() => null));
vi.mock('../../src/lib/automations/session-registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/automations/session-registry.js')>()),
  latestBoundSession,
}));

const {
  handleAutomationsThreads,
  handleAutomationsThreadGet,
  handleAutomationsThreadRead,
  handleAutomationsThreadReply,
  handleAutomationsReplyJob,
  handleAutomationsSay,
} = await import('../../src/server/routes/automations.js');
const { createAutomation, getAutomation, setAutomationEnabled } =
  await import('../../src/lib/automations/store.js');
const { appendThreadEntry, readThread } = await import('../../src/lib/automations/threads.js');
const { approveAutomation, revokeApproval } = await import('../../src/lib/automations/registry.js');
const { createQuestion } = await import('../../src/lib/automations/hitl.js');

/**
 * The three routes the `#agents` feed reads. What is under test is the CONTRACT
 * the dashboard depends on — the shape of the payload, and the one rule that a
 * GET never consumes unread.
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

function makeGetReq(url: string): IncomingMessage {
  return Object.assign(Readable.from([]), { method: 'GET', headers: {}, url }) as unknown as IncomingMessage;
}

function makePostReq(body?: unknown): IncomingMessage {
  const readable = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf-8')]);
  return Object.assign(readable, { method: 'POST', headers: {} }) as unknown as IncomingMessage;
}

let projectRoot: string;
let contextRoot: string;
let home: string;
let realHome: string | undefined;

const RUN_A = '2026-09-20T09:00:00.000Z';
const RUN_B = '2026-09-20T18:00:00.000Z';

beforeEach(() => {
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'dc-threads-routes-home-'));
  process.env.HOME = home;
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-threads-routes-')));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  resumeWithMessage.mockReset();
  resumeWithMessage.mockResolvedValue({ status: 'ok', error: null, result: null });
  latestBoundSession.mockReset();
  latestBoundSession.mockReturnValue(null);
  createAutomation(contextRoot, { slug: 'digest', title: 'Daily digest', days: 'daily', at: '18:00', prompt: 'go' });

  appendThreadEntry(contextRoot, 'digest', {
    runId: RUN_A, kind: 'system', event: 'started', text: 'Run started.', via: 'runner',
    now: new Date('2026-09-20T09:00:01.000Z'),
  });
  appendThreadEntry(contextRoot, 'digest', {
    runId: RUN_B, kind: 'system', event: 'started', text: 'Run started.', via: 'runner',
    now: new Date('2026-09-20T18:00:01.000Z'),
  });
  appendThreadEntry(contextRoot, 'digest', {
    runId: RUN_B, kind: 'agent', text: 'WAU is down 4%.', via: 'cli',
    now: new Date('2026-09-20T18:04:00.000Z'),
  });
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('GET /api/automations/threads', () => {
  it('returns one message per run with its unread counts and the agent roster', async () => {
    const { res, status, body } = makeRes();
    await handleAutomationsThreads(makeGetReq('/api/automations/threads'), res, {}, contextRoot);

    expect(status()).toBe(200);
    const feed = body() as unknown as {
      messages: { runId: string; text: string; unread: boolean }[];
      unreadBySlug: Record<string, number>;
      unreadTotal: number;
      agents: { slug: string }[];
    };
    expect(feed.messages.map((m) => m.runId)).toEqual([RUN_A, RUN_B]);
    expect(feed.messages[1].text).toBe('WAU is down 4%.');
    expect(feed.unreadTotal).toBe(3);
    expect(feed.unreadBySlug).toEqual({ digest: 3 });
    expect(feed.agents.map((a) => a.slug)).toEqual(['digest']);
  });

  it('honours ?limit, keeping the newest', async () => {
    const { res, body } = makeRes();
    await handleAutomationsThreads(makeGetReq('/api/automations/threads?limit=1'), res, {}, contextRoot);
    expect((body() as unknown as { messages: { runId: string }[] }).messages.map((m) => m.runId)).toEqual([RUN_B]);
  });

  it('NEVER consumes unread — the badge survives any number of polls', async () => {
    for (let i = 0; i < 3; i++) {
      const { res } = makeRes();
      await handleAutomationsThreads(makeGetReq('/api/automations/threads'), res, {}, contextRoot);
    }
    const { res, body } = makeRes();
    await handleAutomationsThreads(makeGetReq('/api/automations/threads'), res, {}, contextRoot);
    expect((body() as unknown as { unreadTotal: number }).unreadTotal).toBe(3);
  });
});

describe('GET /api/automations/:slug/thread', () => {
  it('returns only the asked-for run\'s entries, in id order', async () => {
    const { res, status, body } = makeRes();
    await handleAutomationsThreadGet(
      makeGetReq(`/api/automations/digest/thread?run=${encodeURIComponent(RUN_B)}`),
      res, { slug: 'digest' }, contextRoot,
    );
    expect(status()).toBe(200);
    const payload = body() as unknown as { entries: { runId: string; event?: string; text: string }[]; title: string };
    expect(payload.title).toBe('Daily digest');
    expect(payload.entries).toHaveLength(2);
    expect(payload.entries.every((e) => e.runId === RUN_B)).toBe(true);
    expect(payload.entries[0].event).toBe('started');
  });

  it('with no run, returns the agent\'s whole channel', async () => {
    const { res, body } = makeRes();
    await handleAutomationsThreadGet(makeGetReq('/api/automations/digest/thread'), res, { slug: 'digest' }, contextRoot);
    expect((body() as unknown as { entries: unknown[] }).entries).toHaveLength(3);
  });

  it('404s an unknown slug', async () => {
    const { res, status } = makeRes();
    await handleAutomationsThreadGet(makeGetReq('/api/automations/nope/thread'), res, { slug: 'nope' }, contextRoot);
    expect(status()).toBe(404);
  });
});

describe('POST /api/automations/threads/read', () => {
  it('advances the watermark and reports the remaining unread', async () => {
    const { res: feedRes, body: feedBody } = makeRes();
    await handleAutomationsThreads(makeGetReq('/api/automations/threads'), feedRes, {}, contextRoot);
    const first = (feedBody() as unknown as { messages: { newestId: string }[] }).messages[0];

    const { res, status, body } = makeRes();
    await handleAutomationsThreadRead(
      makePostReq({ slug: 'digest', upToId: first.newestId }), res, {}, contextRoot,
    );
    expect(status()).toBe(200);
    expect((body() as unknown as { unread: { count: number } }).unread.count).toBe(2);
  });

  it('is monotonic — acking an older id leaves the watermark where it is', async () => {
    const { res: feedRes, body: feedBody } = makeRes();
    await handleAutomationsThreads(makeGetReq('/api/automations/threads'), feedRes, {}, contextRoot);
    const messages = (feedBody() as unknown as { messages: { newestId: string }[] }).messages;

    const ack = async (id: string): Promise<number> => {
      const { res, body } = makeRes();
      await handleAutomationsThreadRead(makePostReq({ slug: 'digest', upToId: id }), res, {}, contextRoot);
      return (body() as unknown as { unread: { count: number } }).unread.count;
    };
    expect(await ack(messages[1].newestId)).toBe(0);
    expect(await ack(messages[0].newestId)).toBe(0);
  });

  it('400s a body without a slug or an id, and 404s an unknown slug', async () => {
    const bad = makeRes();
    await handleAutomationsThreadRead(makePostReq({ slug: 'digest' }), bad.res, {}, contextRoot);
    expect(bad.status()).toBe(400);

    const missing = makeRes();
    await handleAutomationsThreadRead(makePostReq({ slug: 'nope', upToId: 'x' }), missing.res, {}, contextRoot);
    expect(missing.status()).toBe(404);
  });
});

// ─── The reply route ───────────────────────────────────────────────────────

/** Newest run in the seeded fixture — the only one the reply route accepts. */
const NEWEST = RUN_B;

/** Make the fixture repliable: approved, enabled, and bound on this machine. */
function makeRepliable(): void {
  const manifest = getAutomation(contextRoot, 'digest')!;
  approveAutomation(projectRoot, manifest, new Date(), home);
  latestBoundSession.mockReturnValue('sess-abc');
}

async function reply(body: unknown, slug = 'digest') {
  const r = makeRes();
  await handleAutomationsThreadReply(makePostReq(body), r.res, { slug }, contextRoot);
  return r;
}

describe('POST /api/automations/:slug/thread/reply — the refusal ladder, in order', () => {
  it('404s an unknown slug', async () => {
    const { status } = await reply({ text: 'hi', runId: NEWEST }, 'nope');
    expect(status()).toBe(404);
  });

  it('409 reply_disabled BEFORE anything else — and writes nothing', async () => {
    makeRepliable();
    setAutomationEnabled(contextRoot, 'digest', false);
    const before = readThread(contextRoot, 'digest').length;
    const { status, body } = await reply({ text: 'hi', runId: NEWEST });
    expect(status()).toBe(409);
    expect(body().error).toBe('reply_disabled');
    expect(readThread(contextRoot, 'digest')).toHaveLength(before);
  });

  it('409 reply_unapproved — the run lock is not an authorisation check', async () => {
    // Bound and enabled, but approval revoked: resumeWithMessage would happily spawn a
    // bypassPermissions child on a manifest this machine no longer approves.
    latestBoundSession.mockReturnValue('sess-abc');
    const manifest = getAutomation(contextRoot, 'digest')!;
    approveAutomation(projectRoot, manifest, new Date(), home);
    revokeApproval(projectRoot, 'digest', home);
    const before = readThread(contextRoot, 'digest').length;
    const { status, body } = await reply({ text: 'hi', runId: NEWEST });
    expect(status()).toBe(409);
    expect(body().error).toBe('reply_unapproved');
    expect(readThread(contextRoot, 'digest')).toHaveLength(before);
  });

  it('400 bad_text on empty, whitespace-only and over-long', async () => {
    makeRepliable();
    for (const text of ['', '   ', 'x'.repeat(2001)]) {
      const { status, body } = await reply({ text, runId: NEWEST });
      expect(status()).toBe(400);
      expect(body().error).toBe('bad_text');
    }
  });

  it('400 bad_run for anything that is not an exact ISO round-trip', async () => {
    makeRepliable();
    for (const runId of ['', 'yesterday', '2026-09-20', '2026-09-20T18:00:00Z', 42 as unknown as string]) {
      const { status, body } = await reply({ text: 'hi', runId });
      expect(status()).toBe(400);
      expect(body().error).toBe('bad_run');
    }
  });

  it('409 stale_run for a real but older run — the session resolves to the LATEST', async () => {
    makeRepliable();
    const before = readThread(contextRoot, 'digest').length;
    const { status, body } = await reply({ text: 'hi', runId: RUN_A });
    expect(status()).toBe(409);
    expect(body().error).toBe('stale_run');
    expect(body().message).toContain('moved on');
    expect(readThread(contextRoot, 'digest')).toHaveLength(before);
  });

  it('409 not_bound when no run on THIS machine ever produced a session, appending nothing', async () => {
    const manifest = getAutomation(contextRoot, 'digest')!;
    approveAutomation(projectRoot, manifest, new Date(), home);
    latestBoundSession.mockReturnValue(null);
    const before = readThread(contextRoot, 'digest').length;
    const { status, body } = await reply({ text: 'hi', runId: NEWEST });
    expect(status()).toBe(409);
    expect(body().error).toBe('not_bound');
    expect(readThread(contextRoot, 'digest')).toHaveLength(before);
  });

  it('409 question_pending routes the human to the question instead', async () => {
    makeRepliable();
    createQuestion(contextRoot, {
      slug: 'digest', runFiredAt: NEWEST, kind: 'flow-hitl', sessionId: 'sess-abc',
      channel: 'chat', question: 'Ship it?', choices: ['yes', 'no'],
    });
    const { status, body } = await reply({ text: 'hi', runId: NEWEST });
    expect(status()).toBe(409);
    expect(body().error).toBe('question_pending');
    expect(body().message).toContain('answer that first');
  });

  it('A9a — 409 busy while a run-now job holds the slot, and appends NOTHING', async () => {
    makeRepliable();
    const { startAutomationJob } = await import('../../src/server/automation-job.js');
    // A never-settling run keeps `currentAutomationJob` reporting `running`.
    const runner = await import('../../src/lib/automations/runner.js');
    const spy = vi.spyOn(runner, 'runAutomation').mockImplementation(() => new Promise(() => {}));
    startAutomationJob(contextRoot, 'digest');

    const before = readThread(contextRoot, 'digest').length;
    const { status, body } = await reply({ text: 'hi', runId: NEWEST });
    expect(status()).toBe(409);
    expect(body().error).toBe('busy');
    expect(readThread(contextRoot, 'digest')).toHaveLength(before);
    spy.mockRestore();
  });

  it('happy path — 202 with the entry and a reply-job id, and the user entry is on disk', async () => {
    makeRepliable();
    const { status, body } = await reply({ text: 'what changed?', runId: NEWEST });
    expect(status()).toBe(202);
    const payload = body() as unknown as { entry: { id: string; kind: string; text: string }; job: { id: string; status: string } };
    expect(payload.entry.kind).toBe('user');
    expect(payload.entry.text).toBe('what changed?');
    expect(payload.job.id).toBeTruthy();
    expect(payload.job.status).toBe('running');
    expect(readThread(contextRoot, 'digest', { runId: NEWEST }).some((e) => e.kind === 'user')).toBe(true);
  });
});

describe('GET /api/automations/reply-job/:id', () => {
  it('reports a live job, and 404s an id this server does not know — terminal for the poller', async () => {
    makeRepliable();
    const { body } = await reply({ text: 'hi', runId: NEWEST });
    const id = (body() as unknown as { job: { id: string } }).job.id;

    const found = makeRes();
    await handleAutomationsReplyJob(makeGetReq(`/api/automations/reply-job/${id}`), found.res, { id }, contextRoot);
    expect(found.status()).toBe(200);
    expect((found.body() as unknown as { job: { slug: string } }).job.slug).toBe('digest');

    const gone = makeRes();
    await handleAutomationsReplyJob(makeGetReq('/api/automations/reply-job/nope'), gone.res, { id: 'nope' }, contextRoot);
    expect(gone.status()).toBe(404);
    expect(gone.body().error).toBe('job_unknown');
  });
});

describe('POST /api/automations/threads/say — one route, two things an @mention can start', () => {
  async function say(body: unknown) {
    const r = makeRes();
    await handleAutomationsSay(makePostReq(body), r.res, {}, contextRoot);
    return r;
  }

  it('a SCHED agent with a bound session is TALKED TO — a reply job, not a run', async () => {
    makeRepliable();   // mode defaults to 'sched' for a scheduled automation
    const { status, body } = await say({ slug: 'digest', text: 'how did it go?' });
    expect(status()).toBe(200);
    const payload = body() as unknown as { job: { kind: string }; mode: string; runId: string };
    expect(payload.job.kind).toBe('reply');
    expect(payload.mode).toBe('sched');
    // THE INVARIANT the feed's ask/answer grouping rests on: the human's words open the run.
    const ordered = readThread(contextRoot, 'digest', { runId: payload.runId });
    expect(ordered[0].kind).toBe('user');
    expect(ordered[0].text).toBe('how did it go?');
  });

  it('a sched agent with NOTHING bound here falls through to a run — there is no conversation to continue', async () => {
    const manifest = getAutomation(contextRoot, 'digest')!;
    approveAutomation(projectRoot, manifest, new Date(), home);
    latestBoundSession.mockReturnValue(null);
    const runner = await import('../../src/lib/automations/runner.js');
    const spy = vi.spyOn(runner, 'runAutomation').mockImplementation(() => new Promise(() => {}));

    const { status, body } = await say({ slug: 'digest', text: 'run please' });
    expect(status()).toBe(200);
    const payload = body() as unknown as { job: { kind: string }; runId: string };
    expect(payload.job.kind).toBe('run');
    expect(readThread(contextRoot, 'digest', { runId: payload.runId })[0].kind).toBe('user');
    spy.mockRestore();
  });

  it('A8 — an @mention to an agent with an open question is refused ASYNCHRONOUSLY, not as a 409', async () => {
    makeRepliable();
    resumeWithMessage.mockResolvedValue({
      status: 'refused',
      error: 'this automation is waiting for your answer to its own question — answer that first',
      result: null,
    });
    const { status, body } = await say({ slug: 'digest', text: 'anything?' });
    // The REQUEST succeeds — the say branch has no pendingQuestion pre-check on purpose.
    expect(status()).toBe(200);
    const runId = (body() as unknown as { runId: string }).runId;

    // …and the refusal arrives in the thread as the job's own terminal entry.
    for (let i = 0; i < 50; i++) {
      const sys = readThread(contextRoot, 'digest', { runId }).filter((e) => e.kind === 'system');
      if (sys.length > 0) {
        expect(sys[0].event).toBe('failed');
        expect(sys[0].text).toContain('answer that first');
        return;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('the refusal never reached the thread');
  });
});

describe('GET /api/automations/:slug/thread — the question join', () => {
  it('carries the run\'s open flow-hitl question with its choices, and null when there is none', async () => {
    const none = makeRes();
    await handleAutomationsThreadGet(
      makeGetReq(`/api/automations/digest/thread?run=${encodeURIComponent(RUN_B)}`),
      none.res, { slug: 'digest' }, contextRoot,
    );
    expect((none.body() as unknown as { question: unknown }).question).toBeNull();

    createQuestion(contextRoot, {
      slug: 'digest', runFiredAt: RUN_B, kind: 'flow-hitl', sessionId: 'sess-abc',
      channel: 'chat', question: 'Ship it?', choices: ['yes', 'no'],
    });
    const asked = makeRes();
    await handleAutomationsThreadGet(
      makeGetReq(`/api/automations/digest/thread?run=${encodeURIComponent(RUN_B)}`),
      asked.res, { slug: 'digest' }, contextRoot,
    );
    const q = (asked.body() as unknown as { question: { text: string; choices: string[] } }).question;
    expect(q.text).toBe('Ship it?');
    expect(q.choices).toEqual(['yes', 'no']);
  });
});
