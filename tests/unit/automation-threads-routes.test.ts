import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleAutomationsThreads,
  handleAutomationsThreadGet,
  handleAutomationsThreadRead,
} from '../../src/server/routes/automations.js';
import { createAutomation } from '../../src/lib/automations/store.js';
import { appendThreadEntry } from '../../src/lib/automations/threads.js';

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
