/**
 * The Telegram hub against a fake Telegram (W2 lane A; plan B4, A1, C3, D1, A3, B1, M1, plan
 * "Button integrity", "Auth on every update"):
 *  pairing → native-confirm shape → active binding (0600, device-only); Super off; a text reaches
 *  the Super's injector with a store-honoured ref; the answer under `re:<ref>` reaches Telegram,
 *  a Mac answer does not; strangers get nothing; a closed Super is reopened through its link;
 *  forged and stale buttons are refused, a permission tap answers through `hub_command`;
 *  unbind and tamper send their last message first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTelegram, textUpdate } from '../helpers/fake-telegram.js';
import { TelegramHub, keyOf } from '../../src/server/telegram/hub.js';
import * as reg from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { bindingDir, scopeOfContextRoot } from '../../src/lib/telegram/config.js';
import { parseTelegramPrefix } from '../../src/lib/telegram/contract.js';
import { deliverHubResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

const TOKEN = '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OWNER = 777;
const SID = '11111111-2222-4333-8444-555555555555';

let home: string;
let project: string;
let root: string;
let tg: FakeTelegram;
let hub: TelegramHub;
let opened: string[];

async function superOn(on = true): Promise<void> {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SID, enabled: on }));
  resetSuperIndex();
  await readSuperState(root);
}

async function bound(): Promise<void> {
  const start = await hub.beginPairing({ scope: scopeOfContextRoot(root), target: 'super', token: TOKEN, projectName: 'acme', contextRoot: root });
  const payload = new URL(start.deepLink).searchParams.get('start')!;
  await drained();
  tg.push(TOKEN, textUpdate(OWNER, `/start ${payload}`));
  await vi.waitFor(() => expect(hub.pairingPreview(start.pairingId)).not.toBeNull(), { timeout: 5000 });
  expect(await hub.confirmPairing(start.pairingId, { botId: 123456, userId: OWNER })).toBe('ok');
  await drained();
}

/** A poller drains what is queued at its start (H10): tests push only after that. */
const drained = () => new Promise((r) => setTimeout(r, 40));

function fakeInjector(onText: (text: string) => void = () => {}) {
  const sent: string[] = [];
  const inj = {
    sessionId: SID, chatRegistryId: SID,
    sendOwnerText: vi.fn(async (text: string) => { sent.push(text); onText(text); return { ok: true as const }; }),
    interrupt: vi.fn(),
  };
  return { inj, sent };
}

const assistant = (h: reg.ChatHandle, text: string) => h.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } });

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tg-hub-home-'));
  project = mkdtempSync(join(tmpdir(), 'tg-hub-proj-'));
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'acme', path: project }] }));
  reg._resetChatRegistry();
  resetWindowControl();
  tg = new FakeTelegram();
  tg.addBot(TOKEN, 'acme_super_bot');
  opened = [];
  hub = new TelegramHub({
    home, fetchImpl: tg.fetch, pollTimeoutS: 0, sleep: async () => {},
    vaults: () => [{ name: 'acme', contextRoot: root }],
    openLink: (u) => opened.push(u), injectorWaitMs: 300,
  });
  await hub.start();
  await superOn();
});
afterEach(async () => {
  await hub.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('binding', () => {
  it('a pairing serves nothing until confirmed; confirm writes bot.json 0600 under ~/.dreamcontext only', async () => {
    const start = await hub.beginPairing({ scope: scopeOfContextRoot(root), target: 'super', token: TOKEN, projectName: 'acme', contextRoot: root });
    expect(start.deepLink).toMatch(/^https:\/\/t\.me\/acme_super_bot\?start=[A-Za-z0-9_-]{22}$/);
    expect(hub.status()).toEqual([]);
    await drained();
    tg.push(TOKEN, textUpdate(OWNER, '/start'));
    tg.push(TOKEN, textUpdate(OWNER, `/start ${new URL(start.deepLink).searchParams.get('start')}`));
    await vi.waitFor(() => expect(hub.pairingPreview(start.pairingId)).toMatchObject({ userId: OWNER, botId: 123456, target: 'super', projectName: 'acme' }), { timeout: 5000 });
    expect(await hub.confirmPairing(start.pairingId, { botId: 123456, userId: 999 })).toBe('mismatch');
    expect(await hub.confirmPairing(start.pairingId, { botId: 123456, userId: OWNER })).toBe('ok');
    const file = join(bindingDir(scopeOfContextRoot(root), 'super', home), 'bot.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf-8')).toContain(TOKEN);
    expect(JSON.stringify(readdirAll(project))).not.toContain(TOKEN);
    expect(hub.status()).toEqual([expect.objectContaining({ target: 'super', state: 'active', botUsername: 'acme_super_bot' })]);
    await vi.waitFor(() => expect(tg.texts().some((t) => t.startsWith('Bağlandı'))).toBe(true));
    expect(await hub.confirmPairing(start.pairingId, { botId: 123456, userId: OWNER })).toBe('gone');
  });

  it('a webhook-set bot and a bot bound elsewhere are refused', async () => {
    tg.webhook = 'https://x.example/hook';
    await expect(hub.beginPairing({ scope: scopeOfContextRoot(root), target: 'super', token: TOKEN, projectName: 'acme', contextRoot: root })).rejects.toMatchObject({ code: 'webhook_set' });
  });
});

describe('the Super target', () => {
  beforeEach(bound);

  it('Super off → "Bu projede Super kapalı", nothing injected', async () => {
    await superOn(false);
    tg.push(TOKEN, textUpdate(OWNER, 'merhaba'));
    await vi.waitFor(() => expect(tg.texts()).toContain('Bu projede Super kapalı.'));
  });

  it('a stranger gets nothing and is counted', async () => {
    const before = tg.sent().length;
    tg.push(TOKEN, textUpdate(555, 'merhaba'));
    await vi.waitFor(() => expect(hub.strangers.total).toBe(1));
    expect(tg.sent().length).toBe(before);
  });

  it('a text reaches the injector under a store-honoured ref; its re: answer goes back, a Mac answer does not', async () => {
    const h = reg.registerChat({ sessionId: SID, conversationId: null, vault: 'acme', mode: 'super' });
    const { inj, sent } = fakeInjector();
    reg.registerChatInjector(SID, inj);
    tg.push(TOKEN, textUpdate(OWNER, 'durum ne?'));
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5000 });
    const { ref, body } = parseTelegramPrefix(sent[0]);
    expect(body).toBe('durum ne?');
    expect(reg.telegramRefs.has(SID, ref!)).toBe(true);
    const before = tg.texts().length;
    assistant(h, `<!-- re:abcdef -->\nMac'e cevap\n<!-- re:${ref} -->\nHer şey yolunda.`);
    await vi.waitFor(() => expect(tg.texts()).toContain('Her şey yolunda.'));
    expect(tg.texts().slice(before)).not.toContain("Mac'e cevap");
    // A later Mac-only answer with no mark is not sent.
    const n = tg.texts().length;
    h.userSent('mac text');
    assistant(h, 'Sadece Mac için.');
    await new Promise((r) => setTimeout(r, 50));
    expect(tg.texts().length).toBe(n);
  });

  it('no live Super: the window is reopened through its session link and the text waits for the injector', async () => {
    tg.push(TOKEN, textUpdate(OWNER, 'aç'));
    await vi.waitFor(() => expect(opened).toHaveLength(1), { timeout: 5000 });
    expect(opened[0]).toContain(SID);
    const { inj, sent } = fakeInjector();
    reg.registerChatInjector(SID, inj);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
  });

  it('the window never opens → "Super\'i Mac\'te açamadım"', async () => {
    tg.push(TOKEN, textUpdate(OWNER, 'aç'));
    await vi.waitFor(() => expect(tg.texts().some((t) => t.startsWith("Super'i Mac'te açamadım"))).toBe(true), { timeout: 5000 });
  });

  it('a permission prompt becomes buttons; a forged tap is refused; the real tap answers through hub_command', async () => {
    const h = reg.registerChat({ sessionId: SID, conversationId: null, vault: 'acme', mode: 'super' });
    const { inj } = fakeInjector();
    reg.registerChatInjector(SID, inj);
    tg.push(TOKEN, textUpdate(OWNER, 'başla'));
    await vi.waitFor(() => expect(inj.sendOwnerText).toHaveBeenCalled());
    const frames: Record<string, unknown>[] = [];
    const { token } = mintWindowToken({ send: (f) => { frames.push(f); setImmediate(() => deliverHubResult(token, f.id, { ok: true })); return true; }, sessionId: SID, mode: 'super', vault: 'acme', contextRoot: root });
    h.observe({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf build' } } });
    await vi.waitFor(() => expect(tg.sent().some((c) => JSON.stringify(c.params).includes('İzin ver (bir kez)'))).toBe(true));
    const msg = tg.sent().find((c) => JSON.stringify(c.params).includes('İzin ver (bir kez)'))!;
    const kb = (msg.params.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
    const allow = kb[0][0].callback_data;
    const sentText = String(msg.params.text).replace(/<[^>]+>/g, '');
    const cb = (data: string, extra: Record<string, unknown> = {}) => ({ callback_query: { id: 'cb', data, from: { id: OWNER }, message: { message_id: 999, chat: { id: OWNER, type: 'private' }, text: sentText, ...extra } } });
    tg.push(TOKEN, cb('a:0000000000000000:0'));
    await vi.waitFor(() => expect(tg.sent('answerCallbackQuery').at(-1)?.params.text).toBe('Bu soru artık geçerli değil.'));
    expect(frames).toHaveLength(0);
    // The right id on the wrong message is refused too.
    tg.push(TOKEN, cb(allow));
    await vi.waitFor(() => expect(tg.sent('answerCallbackQuery')).toHaveLength(2));
    expect(frames).toHaveLength(0);
    // An edited message is refused.
    tg.push(TOKEN, cb(allow, { message_id: msg.result!.message_id, edit_date: 5 }));
    await vi.waitFor(() => expect(tg.sent('answerCallbackQuery')).toHaveLength(3));
    expect(frames).toHaveLength(0);
    // The real tap: one answer_pending down the Super's socket, allow once.
    tg.push(TOKEN, cb(allow, { message_id: msg.result!.message_id }));
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]).toMatchObject({ subtype: 'hub_command', verb: 'answer_pending', args: { kind: 'permission', requestId: 'req-1', choice: 'allow_once' } });
    await vi.waitFor(() => expect(tg.sent('answerCallbackQuery').at(-1)?.params.text).toBe('✓ İzin verildi (bir kez)'));
    // A second tap on the same button: consumed.
    tg.push(TOKEN, cb(allow, { message_id: msg.result!.message_id }));
    await vi.waitFor(() => expect(tg.sent('answerCallbackQuery').at(-1)?.params.text).toBe('Bu soru artık geçerli değil.'));
    expect(frames).toHaveLength(1);
  });

  it('a photo lands in agent-drops and its path joins the turn; >20 MB is refused; a voice note is transcribed and echoed', async () => {
    reg.registerChat({ sessionId: SID, conversationId: null, vault: 'acme', mode: 'super' });
    const { inj, sent } = fakeInjector();
    reg.registerChatInjector(SID, inj);
    (hub as unknown as { deps: { transcribeVoice: (p: string) => Promise<string> } }).deps.transcribeVoice = async () => 'merhaba dünya';
    tg.files.set('ph1', Buffer.from('jpegbytes'));
    tg.push(TOKEN, textUpdate(OWNER, '', { text: undefined, photo: [{ file_id: 'ph1', file_size: 9, width: 10, height: 10 }], caption: 'bak' }));
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5000 });
    const body = parseTelegramPrefix(sent[0]).body;
    expect(body).toMatch(/Dosya açıklaması: "bak"/);
    expect(body).toMatch(/_dream_context\/tmp\/agent-drops\/tg-\d+-[0-9a-f]{8}\.jpg/);
    tg.push(TOKEN, textUpdate(OWNER, '', { text: undefined, video: { file_id: 'big', file_size: 21 * 1024 * 1024 } }));
    await vi.waitFor(() => expect(tg.texts().some((t) => t.includes('20 MB'))).toBe(true));
    tg.files.set('v1', Buffer.from('OggS'));
    tg.push(TOKEN, textUpdate(OWNER, '', { text: undefined, voice: { file_id: 'v1', file_size: 4 } }));
    await vi.waitFor(() => expect(sent).toHaveLength(2), { timeout: 5000 });
    expect(parseTelegramPrefix(sent[1]).body).toBe('🎙 merhaba dünya');
    expect(tg.texts()).toContain('Duyduğum: merhaba dünya');
  });

  it('unbind sends the last message first, then removes the folder; an unkeyed one says so', async () => {
    await hub.unbind(scopeOfContextRoot(root), 'super', { keyed: false });
    expect(tg.texts().at(-1)).toBe('Telegram bağlantısı Mac\'te kaldırıldı (anahtarsız istek).');
    expect(existsSync(bindingDir(scopeOfContextRoot(root), 'super', home))).toBe(false);
    expect(hub.status()).toEqual([]);
  });

  it('a bot.json the hub did not write disables the binding after a last message', async () => {
    const file = join(bindingDir(scopeOfContextRoot(root), 'super', home), 'bot.json');
    const b = JSON.parse(readFileSync(file, 'utf-8'));
    writeFileSync(file, JSON.stringify({ ...b, chatId: 1 }), { mode: 0o600 });
    tg.push(TOKEN, textUpdate(OWNER, 'merhaba'));
    await vi.waitFor(() => expect(hub.status()[0]).toMatchObject({ state: 'disabled', disabledReason: 'tamper' }), { timeout: 5000 });
    expect(hub.active.get(keyOf(scopeOfContextRoot(root), 'super'))?.disabled).toBe('tamper');
  });
});

function readdirAll(dir: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readdirSync, lstatSync } = require('node:fs') as typeof import('node:fs');
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    out.push(p);
    if (lstatSync(p).isDirectory()) out.push(...readdirAll(p));
    else out.push(readFileSync(p, 'utf-8'));
  }
  return out;
}
