/**
 * The Telegram binding routes on the real router (plan A1, B4, C4, AA1; W3 route proposal):
 *  - bind from a no-Origin client → 403; from the page → a pending pairing (never a token back);
 *  - confirm with forged Origin + Sec-Fetch-Site but no owner key → 403; malformed id → 400;
 *    a pairing swapped between GET and POST → 409; the owner key → 200;
 *  - GET /api/telegram never carries a token or a pairing payload;
 *  - the Rust-called prefixes are vault-agnostic; everything else under /api/telegram is not.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { FakeTelegram, textUpdate } from '../helpers/fake-telegram.js';
import { TelegramHub, setTelegramHub } from '../../src/server/telegram/hub.js';
import { buildRouter, isVaultAgnostic } from '../../src/server/index.js';
import { setOwnerKey } from '../../src/server/owner-key.js';
import { scopeOfContextRoot } from '../../src/lib/telegram/config.js';

const TOKEN = '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const KEY = 'k'.repeat(64);
let home: string;
let root: string;
let tg: FakeTelegram;
let hub: TelegramHub;
const router = buildRouter();

beforeAll(() => { process.env.DREAMCONTEXT_DESKTOP = '1'; });

function req(method: string, url: string, headers: Record<string, string> = {}, body?: unknown): IncomingMessage {
  const r = new EventEmitter() as IncomingMessage & EventEmitter;
  Object.assign(r, { method, url, headers: { host: '127.0.0.1:4111', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  setImmediate(() => { if (body !== undefined) r.emit('data', Buffer.from(JSON.stringify(body))); r.emit('end'); });
  return r;
}
function res(): ServerResponse & { status: number; body: string; done: Promise<void> } {
  let finish: () => void = () => {};
  const out = { status: 0, body: '', headers: {} as Record<string, unknown>, done: new Promise<void>((r) => { finish = r; }),
    setHeader(k: string, v: unknown) { this.headers[k] = v; },
    writeHead(s: number, h?: Record<string, unknown>) { this.status = s; Object.assign(this.headers, h ?? {}); return this; },
    end(b?: string) { this.body = b ?? ''; finish(); }, write() { return true; },
  };
  return out as unknown as ServerResponse & { status: number; body: string; done: Promise<void> };
}
async function call(method: string, url: string, headers: Record<string, string> = {}, body?: unknown) {
  const m = router.match(method, url.split('?')[0]);
  if (!m) throw new Error(`no route ${method} ${url}`);
  const r = res();
  await m.handler(req(method, url, headers, body), r, m.params, root);
  await r.done;
  return { status: r.status, json: r.body ? JSON.parse(r.body) : null, raw: r.body };
}
const PAGE = { origin: 'http://127.0.0.1:4111', 'sec-fetch-site': 'same-origin' };

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tg-routes-home-'));
  const project = mkdtempSync(join(tmpdir(), 'tg-routes-proj-'));
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  tg = new FakeTelegram();
  tg.addBot(TOKEN, 'acme_super_bot');
  hub = new TelegramHub({ home, fetchImpl: tg.fetch, pollTimeoutS: 0, sleep: async () => {}, vaults: () => [{ name: 'acme', contextRoot: root }] });
  await hub.start();
  setTelegramHub(hub);
  setOwnerKey(KEY);
});
afterEach(async () => {
  await hub.stop();
  setTelegramHub(null);
  setOwnerKey(null);
  rmSync(home, { recursive: true, force: true });
});

describe('telegram routes', () => {
  it('bind needs the page; confirm needs the owner key; a malformed id is refused; status leaks nothing', async () => {
    expect((await call('POST', '/api/telegram/super/bind', {}, { token: TOKEN })).status).toBe(403);
    const bound = await call('POST', '/api/telegram/super/bind', PAGE, { token: TOKEN });
    expect(bound.status).toBe(200);
    expect(bound.raw).not.toContain(TOKEN);
    const { pairingId, deepLink } = bound.json as { pairingId: string; deepLink: string };
    await new Promise((r) => setTimeout(r, 40));
    tg.push(TOKEN, textUpdate(777, `/start ${new URL(deepLink).searchParams.get('start')}`));
    await vi.waitFor(async () => expect((await call('GET', `/api/telegram-pairing/${pairingId}`)).status).toBe(200), { timeout: 5000 });
    const preview = await call('GET', `/api/telegram-pairing/${pairingId}`);
    expect(preview.json).toMatchObject({ userId: 777, botId: 123456, target: 'super' });
    expect((await call('GET', '/api/telegram-pairing/short')).status).toBe(400);
    // Forged page headers, no key.
    expect((await call('POST', `/api/telegram-pairing/${pairingId}/confirm`, PAGE, { botId: 123456, userId: 777 })).status).toBe(403);
    // The key, but what was shown no longer matches.
    expect((await call('POST', `/api/telegram-pairing/${pairingId}/confirm`, { ...PAGE, 'x-dreamcontext-owner-key': KEY }, { botId: 123456, userId: 1 })).status).toBe(409);
    expect((await call('POST', `/api/telegram-pairing/${pairingId}/confirm`, { ...PAGE, 'x-dreamcontext-owner-key': KEY }, { botId: 123456, userId: 777 })).status).toBe(200);
    const status = await call('GET', '/api/telegram', PAGE);
    expect(status.json.rows).toEqual([expect.objectContaining({ scope: scopeOfContextRoot(root), target: 'super', state: 'active' })]);
    expect(status.raw).not.toContain(TOKEN);
    expect(status.raw).not.toContain(new URL(deepLink).searchParams.get('start')!);
  });

  it('a new bind voids the previous pairing: its confirm is 409', async () => {
    const a = (await call('POST', '/api/telegram/super/bind', PAGE, { token: TOKEN })).json as { pairingId: string };
    await call('POST', '/api/telegram/super/bind', PAGE, { token: TOKEN });
    expect((await call('POST', `/api/telegram-pairing/${a.pairingId}/confirm`, { ...PAGE, 'x-dreamcontext-owner-key': KEY }, { botId: 123456, userId: 777 })).status).toBe(409);
  });

  it('hub verbs have no HTTP surface: /api/window/answer_pending and /api/window/html_snapshot do not exist (A2)', () => {
    for (const verb of ['answer_pending', 'html_snapshot', 'render_card', 'run_report', 'super_handover', 'interrupt']) {
      const m = router.match('POST', `/api/window/${verb}`);
      expect(m === null || !/answer_pending|html_snapshot|render_card|run_report|super_handover|interrupt/.test(m.path)).toBe(true);
    }
  });

  it('the Rust-called prefixes are vault-agnostic, the page routes are not', () => {
    for (const p of ['/api/telegram-pairing/x', '/api/telegram-forward/x/preview', '/api/telegram-creation/x/start', '/api/telegram-readopt/x/start', '/api/telegram-manager/status']) expect(isVaultAgnostic(p)).toBe(true);
    for (const p of ['/api/telegram', '/api/telegram/super/bind']) expect(isVaultAgnostic(p)).toBe(false);
  });
});
