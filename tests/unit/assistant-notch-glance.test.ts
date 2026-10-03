/**
 * The notch's glance (the reel teardown, 2026-10-03): the open island lists what every project
 * is doing, asking first, and answers a permission prompt right there (Allow / Deny, Y / N).
 *
 * Pinned: the glance leaves idle and gone out, puts asking first and wraps project text; the
 * owner's answer refuses a stale prompt id and a non-loopback caller; the notch-side reader
 * drops junk rows and strips the wrapper; the mood ladder.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

process.env.HOME = mkdtempSync(`${tmpdir()}/assistant-glance-home-`);

const routes = await import('../../src/server/routes/assistant.js');
const registry = await import('../../src/lib/assistant/chat-registry.js');
const { addVault } = await import('../../src/lib/vaults.js');
const { mkdirSync } = await import('node:fs');
const { join } = await import('node:path');
const { readGlance, unwrapUntrusted, notchMood, glanceStatus, EMPTY_ROLLUP } = await import('../../dashboard/src/components/assistant/notchModel');

function makeRes() {
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    writeHead(code: number) { status = code; },
    setHeader() {},
    end(data?: string) { try { body = JSON.parse(String(data)); } catch { body = {}; } },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body };
}

function req(method: string, url: string, body?: unknown, remote = '127.0.0.1'): IncomingMessage {
  return Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method, url,
    headers: { host: '127.0.0.1:4173', 'content-type': 'application/json' },
    socket: { remoteAddress: remote, setTimeout() {} },
    setTimeout() {},
  }) as unknown as IncomingMessage;
}

let n = 0;
const chat = (vault = 'acme') => registry.registerChat({ sessionId: `g-${++n}`, conversationId: null, vault, mode: 'basic' });
const askBash = (h: ReturnType<typeof chat>, id = 'r1') =>
  h.observe({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'git push origin main' } } });

describe('GET /api/assistant/glance', () => {
  beforeAll(() => { process.env.DREAMCONTEXT_DESKTOP = '1'; });
  beforeEach(() => registry._resetChatRegistry());

  const glance = async (remote?: string) => {
    const r = makeRes();
    await routes.handleAssistantGlance(req('GET', '/api/assistant/glance', undefined, remote), r.res);
    return r;
  };

  it('lists asking first, working next, and leaves idle and gone out', async () => {
    const w = chat('beta'); w.userSent('write the tests');
    const done = chat('gamma'); done.userSent('hi'); done.observe({ type: 'result', subtype: 'success' });
    const gone = chat('delta'); gone.exited();
    const a = chat('acme'); askBash(a);
    const rows = (await glance()).body().chats as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.vault, r.activity])).toEqual([['acme', 'asking'], ['beta', 'working']]);
    const ask = rows[0].ask as Record<string, unknown>;
    expect(ask).toMatchObject({ id: 'r1', kind: 'permission', tool: 'Bash' });
    expect(String(ask.text)).toMatch(/^<untrusted-project-output vault="acme">[\s\S]*git push origin main[\s\S]*<\/untrusted-project-output>$/);
  });

  it('refuses a non-loopback caller', async () => {
    expect((await glance('10.0.0.7')).status()).toBe(403);
  });
});

describe('POST /api/assistant/answer (the owner\'s Allow / Deny)', () => {
  beforeEach(() => registry._resetChatRegistry());
  const answer = async (body: unknown, remote?: string) => {
    const r = makeRes();
    await routes.handleAssistantOwnerAnswer(req('POST', '/api/assistant/answer', body, remote), r.res);
    return r;
  };

  it('refuses a missing choice, an unknown chat and a prompt that is no longer waiting', async () => {
    const a = chat(); askBash(a, 'r1');
    expect((await answer({ sessionId: a.sessionId, question: 'r1', choice: 'maybe' })).status()).toBe(400);
    expect((await answer({ sessionId: 'nope', question: 'r1', choice: 'allow' })).status()).toBe(404);
    const stale = await answer({ sessionId: a.sessionId, question: 'r0', choice: 'allow' });
    expect(stale.status()).toBe(409);
    expect(stale.body()).toMatchObject({ error: 'not_waiting' });
  });

  it('with no notch to relay through, says so instead of pretending', async () => {
    const a = chat(); askBash(a, 'r1');
    const r = await answer({ sessionId: a.sessionId, question: 'r1', choice: 'deny' });
    expect(r.status()).toBe(409);
    expect(r.body()).toMatchObject({ ok: false, error: 'no_surface' });
  });

  it('refuses a non-loopback caller', async () => {
    expect((await answer({ sessionId: 'x', question: 'y', choice: 'allow' }, '100.64.0.9')).status()).toBe(403);
  });
});

describe('the notch side', () => {
  it('strips the wrapper and drops junk rows', () => {
    const rows = readGlance({ chats: [
      { sessionId: 's1', vault: 'acme', activity: 'asking', title: '', ask: { id: 'r1', kind: 'permission', tool: 'Bash', text: '<untrusted-project-output vault="acme">git push</untrusted-project-output>' } },
      { sessionId: 's2', vault: 'beta', activity: 'idle' },
      { vault: 'gamma', activity: 'working' },
      'junk',
    ] });
    expect(rows).toHaveLength(1);
    expect(rows[0].ask?.text).toBe('git push');
    expect(glanceStatus(rows[0])).toBe('needs permission');
    expect(readGlance(null)).toEqual([]);
    expect(unwrapUntrusted('plain')).toBe('plain');
  });

  it('the mood ladder: asking > working > done > idle', () => {
    expect(notchMood({ ...EMPTY_ROLLUP, asking: 1, working: 2 }, true)).toBe('asking');
    expect(notchMood({ ...EMPTY_ROLLUP, proposals: 1 }, false)).toBe('asking');
    expect(notchMood({ ...EMPTY_ROLLUP, starting: 1 }, true)).toBe('working');
    expect(notchMood(EMPTY_ROLLUP, true)).toBe('done');
    expect(notchMood(EMPTY_ROLLUP, false)).toBe('idle');
  });
});

describe('hand-offs: what the Assistant gave to whom, and where it stands', () => {
  const D = () => import('../../src/lib/assistant/delegations.js');
  const ID = '11111111-2222-4333-8444-555555555555';

  beforeAll(() => {
    const root = join(process.env.HOME!, 'p', 'tilki');
    mkdirSync(join(root, '_dream_context'), { recursive: true });
    addVault('tilki', root, process.env.HOME);
  });
  beforeEach(async () => { registry._resetChatRegistry(); (await D())._resetDelegations(); });

  it('keeps the brief, follows the chat, and lists it in the glance', async () => {
    const d = await D();
    const h = registry.registerChat({ sessionId: ID, conversationId: null, vault: 'tilki', mode: 'basic' });
    h.userSent('write the FAQ');
    d.recordDelegation(ID, 'tilki', 'Write the landing FAQ section');
    expect(d.listDelegations()).toMatchObject([{ sessionId: ID, vault: 'tilki', brief: 'Write the landing FAQ section', activity: 'working', endedAt: null }]);
    // A later send without a brief keeps the first one.
    d.recordDelegation(ID, 'tilki');
    expect(d.listDelegations()[0].brief).toBe('Write the landing FAQ section');

    const r = makeRes();
    await routes.handleAssistantGlance(req('GET', '/api/assistant/glance'), r.res);
    const rows = r.body().delegations as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ sessionId: ID, vault: 'tilki', activity: 'working' });
    expect(String(rows[0].brief)).toContain('<untrusted-project-output vault="tilki">');
  });

  it('a closed hand-off is remembered with its last reply, and the owner can clear it', async () => {
    const d = await D();
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      const h = registry.registerChat({ sessionId: ID, conversationId: null, vault: 'tilki', mode: 'basic' });
      h.userSent('go');
      h.observe({ type: 'assistant', message: { content: [{ type: 'text', text: 'FAQ written, 6 questions.' }] } });
      d.recordDelegation(ID, 'tilki', 'Write the FAQ');
      h.exited();
      vi.advanceTimersByTime(d.GONE_DEBOUNCE_MS + 10);
      const [row] = d.listDelegations();
      expect(row).toMatchObject({ sessionId: ID, activity: 'gone', lastText: 'FAQ written, 6 questions.', brief: 'Write the FAQ' });
      expect(row.endedAt).not.toBeNull();
      expect(d.dismissDelegation(ID)).toBe(true);
      expect(d.listDelegations()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the pill headline', () => {
  it('says the most urgent thing, the name only when nothing else', async () => {
    const { pillHeadline, handoffPhase, readHandoffs } = await import('../../dashboard/src/components/assistant/notchModel');
    const base = { name: 'Dreamy', asker: null, proposals: 0, finished: null, handoffs: [], working: 0 };
    expect(pillHeadline(base)).toBe('Dreamy');
    expect(pillHeadline({ ...base, working: 2 })).toBe('2 working');
    const hs = readHandoffs({ delegations: [{ sessionId: 's', vault: 'tilki', activity: 'working', startedAt: 1, endedAt: null, brief: '', lastText: '', ask: null }] });
    expect(handoffPhase(hs[0])).toBe('running');
    expect(pillHeadline({ ...base, handoffs: hs, working: 1 })).toBe('tilki is on it');
    expect(pillHeadline({ ...base, handoffs: hs, finished: 'korus' })).toBe('korus finished');
    expect(pillHeadline({ ...base, proposals: 2, finished: 'korus' })).toBe('2 waiting for your yes');
    expect(pillHeadline({ ...base, asker: 'korus', proposals: 2 })).toBe('korus needs you');
  });
});
