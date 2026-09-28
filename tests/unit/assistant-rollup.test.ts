/**
 * GET /api/assistant/rollup — the notch pill's glance. Counts chats by ACTIVITY, not raw
 * status: `working` is a turn genuinely in flight, a restored tab nobody typed in is `idle`
 * once its grace passes, and a turn that went silent is `stale`. Counts only, owner-gated.
 *
 * Regression pinned: on 2026-09-26 the owner's server listed 7 resumed-but-untouched tabs as
 * `starting` beside 1 real turn, and the pill said "10 working".
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const HOME = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  const h = fs.mkdtempSync(`${os.tmpdir()}/assistant-rollup-home-`);
  process.env.HOME = h;
  return h;
});

const routes = await import('../../src/server/routes/assistant.js');
const registry = await import('../../src/lib/assistant/chat-registry.js');
const { collectRoster, renderRoster } = await import('../../src/lib/assistant/roster.js');
const { addVault } = await import('../../src/lib/vaults.js');

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

function mkReq(remote = '127.0.0.1'): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method: 'GET',
    url: '/api/assistant/rollup',
    headers: { host: '127.0.0.1:4173' },
    socket: { remoteAddress: remote },
  }) as unknown as IncomingMessage;
}

async function rollup(remote?: string) {
  const r = makeRes();
  await routes.handleAssistantRollup(mkReq(remote), r.res);
  return r;
}

let n = 0;
const chat = (vault = 'acme-app') => registry.registerChat({ sessionId: `s-${++n}`, conversationId: null, vault, mode: 'basic' });
const T0 = Date.parse('2026-09-26T20:00:00.000Z');

describe('GET /api/assistant/rollup', () => {
  beforeAll(() => { process.env.DREAMCONTEXT_DESKTOP = '1'; });
  beforeEach(() => {
    registry._resetChatRegistry();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('returns exactly {starting, working, stale, asking, idle, proposals}, counts only', async () => {
    const r = await rollup();
    expect(r.status()).toBe(200);
    expect(r.body()).toEqual({ starting: 0, working: 0, stale: 0, asking: 0, idle: 0, proposals: 0 });
  });

  it('a restored tab nobody typed in is idle once the grace passes, NOT working', async () => {
    for (let i = 0; i < 7; i++) chat();
    const live = chat();
    live.userSent('fix the login bug');
    expect((await rollup()).body()).toMatchObject({ starting: 7, working: 1, idle: 0 });

    vi.setSystemTime(T0 + registry.STARTING_GRACE_MS + 1);
    live.observe({ type: 'stream_event', event: { type: 'content_block_delta' } });
    expect((await rollup()).body()).toMatchObject({ starting: 0, working: 1, stale: 0, idle: 7 });
  });

  it('a working chat silent past STALE_MS counts as stale, not working', async () => {
    const quiet = chat();
    quiet.userSent('run the migration');
    const busy = chat();
    busy.userSent('write the tests');

    vi.setSystemTime(T0 + registry.STALE_MS + 1);
    busy.observe({ type: 'stream_event', event: { type: 'content_block_delta' } });
    expect((await rollup()).body()).toMatchObject({ working: 1, stale: 1 });
  });

  it('counts asking and idle, and leaves gone out', async () => {
    const asks = chat();
    asks.observe({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
    const done = chat();
    done.userSent('hi');
    done.observe({ type: 'result', subtype: 'success' });
    const ended = chat();
    ended.exited();
    // An owner-blocked chat stays asking however long it waits.
    vi.setSystemTime(T0 + registry.TOOL_STALE_MS * 2);
    expect((await rollup()).body()).toEqual({ starting: 0, working: 0, stale: 0, asking: 1, idle: 1, proposals: 0 });
  });

  it('refuses a non-loopback caller', async () => {
    const r = await rollup('10.0.0.7');
    expect(r.status()).toBe(403);
    expect(r.body()).toMatchObject({ error: 'assistant_local_only' });
  });
});

describe('the briefing roster counts live chats the same way', () => {
  beforeAll(() => {
    const root = join(HOME, 'p', 'acme-app');
    mkdirSync(join(root, '_dream_context'), { recursive: true });
    addVault('acme-app', root, HOME);
  });
  beforeEach(() => {
    registry._resetChatRegistry();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });
  afterEach(() => { vi.useRealTimers(); });

  const acme = () => collectRoster(HOME).vaults.find((v) => v.name === 'acme-app')!;

  it('a chat that never got a message is not working, a silent turn is stale', () => {
    const fresh = chat();
    expect(acme().live).toEqual({ working: 0, stale: 0, asking: 0, idle: 1 });

    const quiet = chat();
    quiet.userSent('run the migration');
    const busy = chat();
    busy.userSent('write the tests');
    vi.setSystemTime(T0 + registry.STALE_MS + 1);
    busy.observe({ type: 'stream_event', event: { type: 'content_block_delta' } });
    fresh.observe({ type: 'system', subtype: 'status' });

    expect(acme().live).toEqual({ working: 1, stale: 1, asking: 0, idle: 1 });
    expect(renderRoster(collectRoster(HOME))).toContain('- live: 1 working, 1 stale (no sign of life for minutes, may be stuck), 1 idle');
  });
});
