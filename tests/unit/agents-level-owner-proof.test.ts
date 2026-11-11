/**
 * A member's autonomy level is the owner's to change (uye-bildirim K3 "Level"; plan criterion 5).
 *
 * `POST /api/agents/:slug/update` already refused a request with no Origin. A level CHANGE (the
 * sent level differs from the stored one) now takes the owner's proof: the shell's owner key on
 * the desktop (`fromOwnerPage`), or the phone's own signed-in session. A save that leaves the
 * level as it is keeps today's guard, so the rest of the identity form works as before. This
 * closes plan-r9's residual: an agent that reaches the local API with a forged Origin could raise
 * its own level. The reply says where the new level holds: a narrower one now, a wider one at
 * the member's next session start.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAgent, getAgent } from '../../src/lib/agents/store.js';
import { handleAgentsUpdate } from '../../src/server/routes/agents.js';
import { OWNER_KEY_HEADER, setOwnerKey } from '../../src/server/owner-key.js';
import { markPhoneSocket } from '../../src/server/phone-origin.js';
import { _resetCrewSeats } from '../../src/server/routes/crew-binding.js';

const KEY = 'e7'.repeat(32);
const ORIGIN_ONLY = { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
const OWNER = { ...ORIGIN_ONLY, [OWNER_KEY_HEADER]: KEY };
const NOW = new Date('2026-11-10T09:00:00.000Z');

let projectRoot: string;
let contextRoot: string;
let realHome: string | undefined;
let fakeHome: string;

function makeRes() {
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    writeHead(code: number) { status = code; },
    end(data: string) { try { body = JSON.parse(data); } catch { body = {}; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body };
}
function post(headers: Record<string, string>, body: unknown, socket: object = { remoteAddress: '127.0.0.1', setTimeout() {} }): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: '/', headers, socket, setTimeout() {} }) as unknown as IncomingMessage;
}
async function update(headers: Record<string, string>, body: Record<string, unknown>, socket?: object) {
  const r = makeRes();
  await handleAgentsUpdate(post(headers, body, socket), r.res, { slug: 'scout' }, contextRoot);
  return { status: r.status(), body: r.body() };
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-agents-routes-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'automations'), { recursive: true });
  realHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), 'dc-agents-routes-home-'));
  process.env.HOME = fakeHome;
  setOwnerKey(KEY);
  _resetCrewSeats();
  createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout.' }, { approve: { now: NOW } });
});
afterEach(() => {
  setOwnerKey(null);
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('a level change needs the owner\'s proof', () => {
  it('403 owner_page_only with the right Origin and no key; the level stays', async () => {
    const r = await update(ORIGIN_ONLY, { autonomy: 'free' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('owner_page_only');
    expect(getAgent(contextRoot, 'scout')?.autonomy).toBe('balanced');
    // Nothing else in the same request was written either.
    expect((await update(ORIGIN_ONLY, { autonomy: 'ask', title: 'Renamed' })).status).toBe(403);
    expect(getAgent(contextRoot, 'scout')?.title).toBe('Scout');
  });

  it('200 with the owner key; a wider level holds from the next session start', async () => {
    const r = await update(OWNER, { autonomy: 'free' });
    expect(r.status).toBe(200);
    expect(getAgent(contextRoot, 'scout')?.autonomy).toBe('free');
    expect(r.body.applies).toBe('next_session');
  });

  it('a narrower level holds now', async () => {
    const r = await update(OWNER, { autonomy: 'ask' });
    expect(r.status).toBe(200);
    expect(r.body.applies).toBe('now');
  });

  it('the phone\'s own session may change it, as that route accepts the phone today', async () => {
    const socket = { remoteAddress: '127.0.0.1', setTimeout() {} };
    markPhoneSocket(socket);
    const r = await update(ORIGIN_ONLY, { autonomy: 'ask' }, socket);
    expect(r.status).toBe(200);
    expect(getAgent(contextRoot, 'scout')?.autonomy).toBe('ask');
  });
});

describe('a save that keeps the level keeps today\'s guard', () => {
  it('the same level, or none, passes with the Origin alone; no `applies`', async () => {
    const same = await update(ORIGIN_ONLY, { autonomy: 'balanced', title: 'Scout Two' });
    expect(same.status).toBe(200);
    expect(same.body.applies).toBeUndefined();
    expect(getAgent(contextRoot, 'scout')?.title).toBe('Scout Two');
    expect((await update(ORIGIN_ONLY, { prompt: 'Scout the market.' })).status).toBe(200);
  });

  it('no Origin at all is still refused, as before', async () => {
    const r = await update({ host: '127.0.0.1:4173', 'content-type': 'application/json' }, { title: 'x' });
    expect(r.status).toBe(403);
  });
});
