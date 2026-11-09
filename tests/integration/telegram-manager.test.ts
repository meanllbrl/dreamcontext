/**
 * Rust-confirmed id records and the manager bot on the real router (plan V/W3/Y4, X, Z, AA, AB):
 *  - forward ON needs the page's request + the owner-keyed confirm with what was shown; OFF is
 *    keyless; a removed vault → 410;
 *  - manager: a creation goes live only with the owner key; a `managed_bot` from another creator
 *    or for a voided link is ignored; the owner's → getManagedBotToken once, managed binding,
 *    first message; Kaldır revokes the token first; re-adopt start needs the key and the
 *    preview's hash; a 409 on the manager poll raises the alarm.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { FakeTelegram, textUpdate } from '../helpers/fake-telegram.js';
import { TelegramHub, setTelegramHub } from '../../src/server/telegram/hub.js';
import { wireManager } from '../../src/server/telegram/manager.js';
import { apiVaultGate, buildRouter } from '../../src/server/index.js';
import { setOwnerKey } from '../../src/server/owner-key.js';
import { bindingDir, readBinding, readForward, scopeOfContextRoot } from '../../src/lib/telegram/config.js';

const MANAGER = '900001:MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM';
const MEMBER = '222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const KEY = 'k'.repeat(64);
const OWNER = 777;
const PAGE = { origin: 'http://127.0.0.1:4111', 'sec-fetch-site': 'same-origin' };
const KEYED = { ...PAGE, 'x-dreamcontext-owner-key': KEY };
let home: string; let project: string; let root: string; let tg: FakeTelegram; let hub: TelegramHub;
const router = buildRouter();
const drained = () => new Promise((r) => setTimeout(r, 40));

beforeAll(() => { process.env.DREAMCONTEXT_DESKTOP = '1'; });

function req(method: string, url: string, headers: Record<string, string>, body?: unknown): IncomingMessage {
  const r = new EventEmitter() as IncomingMessage & EventEmitter;
  Object.assign(r, { method, url, headers: { host: '127.0.0.1:4111', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  setImmediate(() => { if (body !== undefined) r.emit('data', Buffer.from(JSON.stringify(body))); r.emit('end'); });
  return r;
}
async function call(method: string, url: string, headers: Record<string, string> = {}, body?: unknown) {
  const m = router.match(method, url)!;
  let done: () => void = () => {};
  const out = { status: 0, body: '', p: new Promise<void>((r) => { done = r; }), setHeader() {}, writeHead(s: number) { this.status = s; return this; }, end(b?: string) { this.body = b ?? ''; done(); }, write() { return true; } };
  await m.handler(req(method, url, headers, body), out as unknown as ServerResponse, m.params, root);
  await out.p;
  return { status: out.status, json: out.body ? JSON.parse(out.body) : null };
}
async function pair(token: string, bindUrl: string, botId: number): Promise<void> {
  const r = await call('POST', bindUrl, PAGE, { token });
  await drained();
  tg.push(token, textUpdate(OWNER, `/start ${new URL(r.json.deepLink).searchParams.get('start')}`));
  await vi.waitFor(async () => expect((await call('GET', `/api/telegram-pairing/${r.json.pairingId}`)).status).toBe(200), { timeout: 5000 });
  expect((await call('POST', `/api/telegram-pairing/${r.json.pairingId}/confirm`, KEYED, { botId, userId: OWNER })).status).toBe(200);
  await drained();
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tg-mgr-home-'));
  project = mkdtempSync(join(tmpdir(), 'tg-mgr-proj-'));
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'agents'), { recursive: true });
  mkdirSync(join(root, 'automations'), { recursive: true });
  writeFileSync(join(root, 'agents', 'ua-manager.md'), '---\ntitle: UA Manager · Kampanya yöneticisi\n---\n## Prompt\n\nYou run UA.\n');
  tg = new FakeTelegram(); tg.addBot(MANAGER, 'acme_mgr_bot'); tg.addBot(MEMBER, 'ua_bot');
  tg.addBot('555:NEWTOKENNEWTOKENNEWTOKENNEWTOKEN12', 'ua_manager_x1y2_bot');
  hub = new TelegramHub({ home, fetchImpl: tg.fetch, pollTimeoutS: 0, sleep: async () => {}, vaults: () => [{ name: 'acme', contextRoot: root }] });
  wireManager(hub);
  await hub.start();
  setTelegramHub(hub);
  setOwnerKey(KEY);
});
afterEach(async () => {
  await hub.stop(); setTelegramHub(null); setOwnerKey(null);
  rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true });
});

describe('forward ON/OFF (W3, Y4, Z1)', () => {
  it('ON needs the page\'s request and the keyed confirm with what was shown; OFF is keyless', async () => {
    await pair(MEMBER, '/api/telegram/ua-manager/bind', 222222);
    const m = hub.manager!;
    // A routine of this member: stubbed through the manager's own reader.
    vi.spyOn(m, 'forwardRequest').mockImplementation(function (this: typeof m, ctx: string, target: string, routine: string) {
      const rec = (this as unknown as { mint: (r: Record<string, unknown>) => { id: string } }).mint({
        kind: 'forward', contextRoot: ctx, projectKey: 'pk', projectName: 'acme', target, scope: scopeOfContextRoot(ctx), routine, routineTitle: 'Günlük', approvalHash: 'h1', botUsername: 'ua_bot',
      });
      return { forwardRequestId: rec.id };
    });
    expect((await call('POST', '/api/telegram/ua-manager/forward/request', {}, { routine: 'daily' })).status).toBe(403);
    const { forwardRequestId: id } = (await call('POST', '/api/telegram/ua-manager/forward/request', PAGE, { routine: 'daily' })).json;
    expect((await call('GET', `/api/telegram-forward/${id}/preview`)).json).toEqual({ projectName: 'acme', projectKey: 'pk', routineTitle: 'Günlük', botUsername: 'ua_bot', approvalHash: 'h1' });
    expect((await call('POST', `/api/telegram-forward/${id}/confirm`, PAGE, { projectKey: 'pk', approvalHash: 'h1' })).status).toBe(403);
    // The routine is not really there: its current hash does not match → 409, nothing stored.
    expect((await call('POST', `/api/telegram-forward/${id}/confirm`, KEYED, { projectKey: 'pk', approvalHash: 'h1' })).status).toBe(409);
    expect(readForward(bindingDir(scopeOfContextRoot(root), 'ua-manager', home), home).routines).toEqual([]);
    expect((await call('POST', '/api/telegram/ua-manager/forward', PAGE, { routine: 'daily', on: true })).status).toBe(403);
    expect((await call('POST', '/api/telegram/ua-manager/forward', PAGE, { routine: 'daily', on: false })).status).toBe(200);
  });

  it('a record whose vault was removed before confirm → 410', async () => {
    await pair(MEMBER, '/api/telegram/ua-manager/bind', 222222);
    const m = hub.manager! as unknown as { mint: (r: Record<string, unknown>) => { id: string } };
    const { id } = m.mint({ kind: 'forward', contextRoot: root, projectKey: 'pk', projectName: 'acme', target: 'ua-manager', scope: scopeOfContextRoot(root), routine: 'daily', approvalHash: 'h1', botUsername: 'ua_bot' });
    renameSync(project, `${project}-gone`);
    expect((await call('POST', `/api/telegram-forward/${id}/confirm`, KEYED, { projectKey: 'pk', approvalHash: 'h1' })).status).toBe(410);
    renameSync(`${project}-gone`, project);
  });
});

describe('the manager and one-tap bots (X, Z, AA)', () => {
  it('creation goes live only with the key; strangers and voided links are ignored; the owner\'s bot is adopted once', async () => {
    await pair(MANAGER, '/api/telegram-manager/bind', 900001);
    expect((await call('GET', '/api/telegram')).json.manager).toMatchObject({ target: '@manager', state: 'active', botUsername: 'acme_mgr_bot' });
    const first = (await call('POST', '/api/telegram/ua-manager/creation/request', PAGE)).json.creationId;
    expect((await call('POST', `/api/telegram-creation/${first}/start`, PAGE)).status).toBe(403);
    const a = (await call('POST', `/api/telegram-creation/${first}/start`, KEYED)).json;
    // The link carries the member's title as the app shows it, not its slug.
    expect(a.link).toMatch(/^https:\/\/t\.me\/newbot\/acme_mgr_bot\/ua_manager_[0-9a-z]{4}_bot\?name=UA\+Manager\+%C2%B7\+Kampanya\+y%C3%B6neticisi$/);
    // A second start voids the first link.
    const second = (await call('POST', '/api/telegram/ua-manager/creation/request', PAGE)).json.creationId;
    await call('POST', `/api/telegram-creation/${second}/start`, KEYED);
    const voidedName = new URL(a.link).pathname.split('/')[3];
    tg.push(MANAGER, { managed_bot: { bot: { id: 555, is_bot: true, username: voidedName }, user: { id: OWNER } } });
    await vi.waitFor(() => expect(hub.manager!.ignored).toBe(1));
    tg.push(MANAGER, { managed_bot: { bot: { id: 555, is_bot: true, username: 'x_bot' }, user: { id: 4242 } } });
    await vi.waitFor(() => expect(hub.manager!.ignored).toBe(2));
    expect(tg.sent('getManagedBotToken')).toHaveLength(0);
    // A network blip on the token fetch: the creation is not spent; the re-delivered update adopts it.
    tg.failOnce.set('getManagedBotToken', 502);
    tg.push(MANAGER, { managed_bot: { bot: { id: 555, is_bot: true, username: 'ua_manager_x1y2_bot' }, user: { id: OWNER } } });
    await vi.waitFor(() => expect(readBinding(scopeOfContextRoot(root), 'ua-manager', home).ok).toBe(true), { timeout: 5000 });
    expect(tg.sent('getManagedBotToken')).toHaveLength(2);
    const b = readBinding(scopeOfContextRoot(root), 'ua-manager', home);
    expect(b.ok && b.binding.managed && b.binding.managerBotId === 900001 && b.binding.chatId === OWNER).toBe(true);
    await vi.waitFor(() => expect(tg.texts().some((t) => t.startsWith('Ben UA Manager · Kampanya yöneticisi'))).toBe(true));
    // The adopted bot takes the member's name and role line with ITS OWN token; no photo is set (none here).
    const NEW = '555:NEWTOKENNEWTOKENNEWTOKENNEWTOKEN12';
    await vi.waitFor(() => expect(tg.sent('setMyDescription').some((c) => c.token === NEW)).toBe(true));
    expect(tg.sent('setMyName').filter((c) => c.token === NEW).map((c) => c.params.name)).toEqual(['UA Manager · Kampanya yöneticisi']);
    expect(tg.sent('setMyShortDescription').find((c) => c.token === NEW)?.params.short_description).toBe('Kampanya yöneticisi · acme projesinin AI Team üyesi.');
    expect(tg.sent('setMyProfilePhoto')).toHaveLength(0);
    // Kaldır: the token is revoked through the manager BEFORE the folder goes.
    expect((await call('DELETE', '/api/telegram/ua-manager', PAGE)).status).toBe(200);
    expect(tg.sent('replaceManagedBotToken')).toHaveLength(1);
    expect(readBinding(scopeOfContextRoot(root), 'ua-manager', home).ok).toBe(false);
    // Re-adopt: the page mints, but only the keyed start with the preview's hash rebinds.
    const { readoptId } = (await call('POST', '/api/telegram/ua-manager/readopt/request', PAGE)).json;
    const prev = (await call('GET', `/api/telegram-readopt/${readoptId}/preview`)).json;
    expect(prev).toMatchObject({ target: 'ua-manager', botUsername: 'ua_manager_x1y2_bot' });
    expect((await call('POST', `/api/telegram-readopt/${readoptId}/start`, PAGE, { approvalHash: prev.approvalHash })).status).toBe(403);
    expect((await call('POST', `/api/telegram-readopt/${readoptId}/start`, KEYED, { approvalHash: 'nope' })).status).toBe(409);
    expect(readBinding(scopeOfContextRoot(root), 'ua-manager', home).ok).toBe(false);
  });

  it('re-pairing the manager with its own token re-keys managed bots; a failed replace keeps that bot polling', async () => {
    await pair(MANAGER, '/api/telegram-manager/bind', 900001);
    const id = (await call('POST', '/api/telegram/ua-manager/creation/request', PAGE)).json.creationId;
    await call('POST', `/api/telegram-creation/${id}/start`, KEYED);
    tg.push(MANAGER, { managed_bot: { bot: { id: 555, is_bot: true, username: 'ua_manager_x1y2_bot' }, user: { id: OWNER } } });
    await vi.waitFor(() => expect(readBinding(scopeOfContextRoot(root), 'ua-manager', home).ok).toBe(true), { timeout: 5000 });
    await drained();
    // A failed replace: the bot goes on polling its old (still live) token.
    tg.failOnce.set('replaceManagedBotToken', 502);
    await pair(MANAGER, '/api/telegram-manager/bind', 900001);
    await vi.waitFor(() => expect(tg.sent('replaceManagedBotToken')).toHaveLength(1), { timeout: 5000 });
    const key = `${scopeOfContextRoot(root)}/ua-manager`;
    await vi.waitFor(() => expect(hub.active.get(key)?.halted).toBeFalsy(), { timeout: 5000 });
    await drained();
    tg.push('555:NEWTOKENNEWTOKENNEWTOKENNEWTOKEN12', textUpdate(4242, 'stranger'));
    await vi.waitFor(() => expect(hub.strangers.total).toBeGreaterThan(0), { timeout: 5000 });
    expect(hub.manager!.alarm).toBeNull();
    // A working re-key replaces the token through the manager.
    await pair(MANAGER, '/api/telegram-manager/bind', 900001);
    await vi.waitFor(() => expect(tg.sent('replaceManagedBotToken')).toHaveLength(2), { timeout: 5000 });
  }, 20_000);

  it('Settings sees its manager pairing go pending after /start, with no vault header (2026-11-08)', async () => {
    // The desktop server runs with --launcher: nothing pinned, Settings sends no vault header.
    for (const [m, p] of [['GET', '/api/telegram-manager/status'], ['POST', '/api/telegram-manager/bind'], ['DELETE', '/api/telegram-manager'], ['GET', '/api/telegram-pairing/x'], ['POST', '/api/telegram-pairing/x/confirm']] as const) {
      expect(apiVaultGate(req(m, p, PAGE), p, null)).toEqual({ ok: true, root: null });
    }
    const start = (await call('POST', '/api/telegram-manager/bind', PAGE, { token: MANAGER })).json;
    await drained();
    // Before /start: waiting, never a pending row (the confirm must not open early).
    expect((await call('GET', '/api/telegram-manager/status')).json.manager).toBeNull();
    tg.push(MANAGER, textUpdate(OWNER, `/start ${new URL(start.deepLink).searchParams.get('start')}`));
    // What TelegramSettings polls: the row that raises the native confirm.
    await vi.waitFor(async () => expect((await call('GET', '/api/telegram-manager/status')).json.manager)
      .toEqual({ scope: 'global', target: '@manager', state: 'pending', botUsername: 'acme_mgr_bot', userLabel: '@owner' }), { timeout: 5000 });
    expect((await call('GET', '/api/telegram')).json.manager).toMatchObject({ state: 'pending', userLabel: '@owner' });
    expect((await call('POST', `/api/telegram-pairing/${start.pairingId}/confirm`, KEYED, { botId: 900001, userId: OWNER })).status).toBe(200);
    expect((await call('GET', '/api/telegram-manager/status')).json.manager).toMatchObject({ target: '@manager', state: 'active', botUsername: 'acme_mgr_bot' });
  });

  it('creation without a manager → 409 no_manager; a 409 on the manager poll raises the alarm', async () => {
    expect((await call('POST', '/api/telegram/ua-manager/creation/request', PAGE)).json.error).toBe('no_manager');
    await pair(MANAGER, '/api/telegram-manager/bind', 900001);
    tg.failing.set('getUpdates', 409);
    await vi.waitFor(() => expect(hub.manager!.alarm).toBe('conflict'), { timeout: 5000 });
    expect((await call('GET', '/api/telegram-manager/status')).json.alarm).toBe('conflict');
  });
});
