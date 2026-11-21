/**
 * Telegram'da Super sade konuşur (owner 2026-11-21, "Hepsini uygula" on Doc's diagnosis, his 17:15
 * and 17:31 notes), the hub against a fake Telegram: one turn is one message, a line before a tool
 * call never goes, a job's status is one message edited in place, the same warning once a day, a
 * raw API error never, the night's results in one morning message, ONE pinned agenda edited in
 * place, and a voice day keeps speaking.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTelegram, textUpdate } from '../helpers/fake-telegram.js';
import { TelegramHub, keyOf } from '../../src/server/telegram/hub.js';
import * as reg from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperPadItem } from '../../src/lib/super/types.js';
import { scopeOfContextRoot } from '../../src/lib/telegram/config.js';
import { parseTelegramPrefix } from '../../src/lib/telegram/contract.js';
import { resetWindowControl } from '../../src/lib/window-control.js';
import { API_DOWN_LINE, dayOf } from '../../src/server/telegram/sade.js';

const TOKEN = '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OWNER = 777;
const SID = '11111111-2222-4333-8444-555555555555';

let home: string;
let project: string;
let root: string;
let tg: FakeTelegram;
let hub: TelegramHub;
/** The hub's clock: a fixed local time the tests move. */
let clock = 0;
const at = (h: number, m = 0, day = 21): number => new Date(2026, 10, day, h, m).getTime();

async function superState(pad: SuperPadItem[] = []): Promise<void> {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SID, enabled: true, pad }));
  resetSuperIndex();
  await readSuperState(root);
}

const drained = () => new Promise((r) => setTimeout(r, 40));
const quiet = () => new Promise((r) => setTimeout(r, 60));

async function start(grace = 0, extra: Partial<ConstructorParameters<typeof TelegramHub>[0]> = {}): Promise<void> {
  hub = new TelegramHub({
    ...extra, textGraceMs: grace, sadeTickMs: 0, home, fetchImpl: tg.fetch, pollTimeoutS: 0, sleep: async () => {}, now: () => clock,
    vaults: () => [{ name: 'acme', contextRoot: root }], openLink: () => {}, injectorWaitMs: 300,
  });
  await hub.start();
  await superState();
  const s = await hub.beginPairing({ scope: scopeOfContextRoot(root), target: 'super', token: TOKEN, projectName: 'acme', contextRoot: root });
  const payload = new URL(s.deepLink).searchParams.get('start')!;
  await drained();
  tg.push(TOKEN, textUpdate(OWNER, `/start ${payload}`));
  await vi.waitFor(() => expect(hub.pairingPreview(s.pairingId)).not.toBeNull(), { timeout: 5000 });
  expect(await hub.confirmPairing(s.pairingId, { botId: 123456, userId: OWNER })).toBe('ok');
  await drained();
}

const assistant = (h: reg.ChatHandle, text: string) => h.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } });
const toolCall = (h: reg.ChatHandle) => h.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: `tu${Math.random()}`, name: 'Bash', input: { command: 'ls' } }] } });
const result = (h: reg.ChatHandle) => h.observe({ type: 'result', subtype: 'success', is_error: false, result: '' });

/** He writes on Telegram; the Super's chat takes it. Returns the chat and the turn's ref. */
async function hisMessage(words = 'durum ne?'): Promise<{ h: reg.ChatHandle; ref: string }> {
  const h = reg.registerChat({ sessionId: SID, conversationId: null, vault: 'acme', mode: 'super' });
  const sent: string[] = [];
  reg.registerChatInjector(SID, { sessionId: SID, chatRegistryId: SID, sendOwnerText: vi.fn(async (t: string) => { sent.push(t); return { ok: true as const }; }), interrupt: vi.fn() });
  tg.push(TOKEN, textUpdate(OWNER, words));
  await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 10_000 });
  return { h, ref: parseTelegramPrefix(sent[0]).ref! };
}

const answers = (n0: number) => tg.texts().slice(n0).filter((t) => !t.startsWith('ℹ️') && !t.startsWith('⚠️'));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tg-sade-home-'));
  project = mkdtempSync(join(tmpdir(), 'tg-sade-proj-'));
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'acme', path: project }] }));
  reg._resetChatRegistry();
  resetWindowControl();
  tg = new FakeTelegram();
  tg.addBot(TOKEN, 'acme_super_bot');
  clock = at(14);
});
afterEach(async () => {
  await hub?.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('one turn, one message (AC2)', () => {
  it('a text with three sections answering his message goes as ONE message', async () => {
    await start();
    const { h, ref } = await hisMessage();
    const n = tg.texts().length;
    assistant(h, `<!-- re:${ref} -->\n**Üç iş var.**\n\n<!-- re:${ref} -->\nBirincisi bitti.\n\n<!-- re:${ref} -->\nİkincisi sürüyor.`);
    await vi.waitFor(() => expect(answers(n)).toHaveLength(1), { timeout: 5000 });
    await quiet();
    expect(answers(n)).toHaveLength(1);
    expect(answers(n)[0]).toContain('Birincisi bitti.');
    expect(answers(n)[0]).toContain('İkincisi sürüyor.');
  });

  it('a short line before a tool call never goes; the answer after it goes once, at the turn end', async () => {
    await start(5_000);
    const { h, ref } = await hisMessage();
    const n = tg.texts().length;
    assistant(h, `<!-- re:${ref} -->\nBakıyorum.`);
    toolCall(h);
    await quiet();
    expect(answers(n)).toHaveLength(0);
    assistant(h, '**Hazır.**\n\nTestler geçti.');
    result(h);
    await vi.waitFor(() => expect(answers(n)).toHaveLength(1), { timeout: 5000 });
    await quiet();
    expect(answers(n)).toEqual(['<b>Hazır.</b>\n\nTestler geçti.']);
  });

  it('a line between tool calls that carries news is kept: it joins the answer in the same message', async () => {
    await start(5_000);
    const { h, ref } = await hisMessage();
    const n = tg.texts().length;
    const news = `<!-- re:${ref} -->\n**Birinci kontrol geçti.** ${'Giriş, ödeme ve takvim sayfaları açıldı, on dört kayıt eksiksiz göründü. '.repeat(3)}`;
    assistant(h, news);
    toolCall(h);
    assistant(h, 'İkinci kontrol de geçti.');
    result(h);
    await vi.waitFor(() => expect(answers(n)).toHaveLength(1), { timeout: 5000 });
    expect(answers(n)[0]).toContain('Birinci kontrol geçti.');
    expect(answers(n)[0]).toContain('İkinci kontrol de geçti.');
  });
});

describe('a line before a tool call never goes because something else was sent (review r1)', () => {
  it('"Bakıyorum.", a tool call, a status block, the answer: the status message and ONE answer, no "Bakıyorum."', async () => {
    await start(5_000);
    const { h, ref } = await hisMessage();
    const n = tg.texts().length;
    assistant(h, `<!-- re:${ref} -->\nBakıyorum.`);
    toolCall(h);
    assistant(h, '```dream-status rapor\nRapor işi\nVeri okunuyor\n```');
    await vi.waitFor(() => expect(tg.texts().slice(n).some((t) => t.includes('Rapor işi'))).toBe(true), { timeout: 5000 });
    assistant(h, '**Rapor hazır.**');
    result(h);
    await vi.waitFor(() => expect(answers(n).some((t) => t.includes('Rapor hazır.'))).toBe(true), { timeout: 5000 });
    await quiet();
    expect(tg.texts().slice(n).some((t) => t.includes('Bakıyorum'))).toBe(false);
    expect(answers(n).filter((t) => !t.includes('Rapor işi'))).toEqual(['<b>Rapor hazır.</b>']);
  });
});

describe("a job's status is one message, edited in place (AC5)", () => {
  it('three blocks of the same job: one silent send, then two edits of that message; done turns it into its result', async () => {
    await start();
    const { h } = await hisMessage('telegram işini başlat');
    const n = tg.sent().length;
    const block = (info: string, ...lines: string[]) => assistant(h, `\`\`\`dream-status ${info}\n${lines.join('\n')}\n\`\`\``);
    block('telegram-sade', 'Telegram sade konuşma', 'Plan okunuyor');
    await vi.waitFor(() => expect(tg.sent().length).toBe(n + 1), { timeout: 5000 });
    const first = tg.sent()[n];
    expect(first.params.disable_notification).toBe(true);
    expect(String(first.params.text)).toContain('⏳');
    block('telegram-sade', 'Telegram sade konuşma', 'Testler çalışıyor', '- Kural yazıldı');
    block('telegram-sade done', 'Telegram sade konuşma', 'Bitti: üç dalga, testler geçti');
    await vi.waitFor(() => expect(tg.sent('editMessageText')).toHaveLength(2), { timeout: 5000 });
    const mid = (first.result as { message_id: number }).message_id;
    expect(tg.sent('editMessageText').every((c) => c.params.message_id === mid)).toBe(true);
    expect(String(tg.sent('editMessageText')[1].params.text)).toBe('✅ <b>Telegram sade konuşma</b>\nBitti: üç dalga, testler geçti');
    await quiet();
    expect(tg.sent().length).toBe(n + 1);
  });

  it('a "done" edit that fails on a 429 is tried again on the next look, never a second message (review r2)', async () => {
    await start();
    const { h } = await hisMessage('işi başlat');
    const n = tg.sent().length;
    assistant(h, '```dream-status rapor\nRapor işi\nVeri okunuyor\n```');
    await vi.waitFor(() => expect(tg.sent().length).toBe(n + 1), { timeout: 5000 });
    const mid = (tg.sent()[n].result as { message_id: number }).message_id;
    tg.failOnce.set('editMessageText', 429);
    assistant(h, '```dream-status rapor done\nRapor işi\nBitti\n```');
    await vi.waitFor(() => expect(tg.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(1), { timeout: 5000 });
    await quiet();
    await hub.tickSade();
    const edits = tg.calls.filter((c) => c.method === 'editMessageText');
    expect(edits).toHaveLength(2);
    expect(edits[1].params.message_id).toBe(mid);
    expect(String(edits[1].params.text)).toContain('Bitti');
    await hub.tickSade();
    expect(tg.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(2);
    expect(tg.sent().length).toBe(n + 1);
  });

  it('a retry of an older state racing the "done" edit never leaves the job running (review r3)', async () => {
    await start();
    const { h } = await hisMessage('işi başlat');
    const n = tg.sent().length;
    const block = (info: string, now: string) => assistant(h, `\`\`\`dream-status ${info}\nRapor işi\n${now}\n\`\`\``);
    block('rapor', 'Veri okunuyor');
    await vi.waitFor(() => expect(tg.sent().length).toBe(n + 1), { timeout: 5000 });
    tg.failOnce.set('editMessageText', 429);
    block('rapor', 'Testler çalışıyor');
    await vi.waitFor(() => expect(tg.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(1), { timeout: 5000 });
    await quiet();
    // The done edit is slow; the timer's retry fires while it is on its way.
    tg.slowMethods.set('editMessageText', 300);
    block('rapor done', 'Bitti');
    await new Promise((r) => setTimeout(r, 50));
    await hub.tickSade();
    await vi.waitFor(() => expect(tg.calls.filter((c) => c.method === 'editMessageText').length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    await quiet(); await quiet();
    await hub.tickSade();
    const edits = tg.calls.filter((c) => c.method === 'editMessageText');
    expect(String(edits.at(-1)!.params.text)).toContain('Bitti');
    expect(edits.slice(1).some((c) => String(c.params.text).includes('Testler çalışıyor'))).toBe(false);
    expect(tg.sent().length).toBe(n + 1);
  });
});

describe('warnings (AC5)', () => {
  it('the same notice twice in a day goes once; a day later again', async () => {
    await start();
    const ab = hub.active.get(keyOf(scopeOfContextRoot(root), 'super'))!;
    const n = tg.texts().length;
    expect(await hub.noticeOnce(ab, 'warn', 'Pil düşük; Mac uyuyabilir, işler durabilir.', true)).toBe(true);
    expect(await hub.noticeOnce(ab, 'warn', 'Pil düşük; Mac uyuyabilir, işler durabilir.', true)).toBe(false);
    expect(tg.texts().slice(n)).toHaveLength(1);
    clock += 25 * 60 * 60 * 1000;
    expect(await hub.noticeOnce(ab, 'warn', 'Pil düşük; Mac uyuyabilir, işler durabilir.', true)).toBe(true);
  });

  it('a notice whose send failed is not counted as said: the next one goes (review r1)', async () => {
    await start();
    const ab = hub.active.get(keyOf(scopeOfContextRoot(root), 'super'))!;
    tg.failOnce.set('sendMessage', 500);
    expect(await hub.noticeOnce(ab, 'warn', 'Isı yüksek; Mac yavaşlayabilir.', true)).toBe(false);
    expect(await hub.noticeOnce(ab, 'warn', 'Isı yüksek; Mac yavaşlayabilir.', true)).toBe(true);
  });

  it('the second outage turn the same day is not silent: its end says it got no answer (review r1)', async () => {
    await start();
    const first = await hisMessage();
    first.h.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'API Error: 403 Attention Required! | Cloudflare' }] } });
    result(first.h);
    await vi.waitFor(() => expect(tg.texts().some((t) => t.includes(API_DOWN_LINE.slice(0, 20)))).toBe(true), { timeout: 5000 });
    await quiet();
    const n = tg.texts().length;
    const second = await hisMessage('cevap ver');
    second.h.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'API Error: 403 Attention Required! | Cloudflare' }] } });
    result(second.h);
    await vi.waitFor(() => expect(tg.texts().slice(n).some((t) => t.includes('cevap yazmadan bitti'))).toBe(true), { timeout: 5000 });
    expect(tg.texts().slice(n).some((t) => t.includes(API_DOWN_LINE.slice(0, 20)))).toBe(false);
  });

  it('a short answer that quotes another service\'s error is an answer, not an outage (review r1)', async () => {
    await start();
    const { h, ref } = await hisMessage();
    const n = tg.texts().length;
    assistant(h, `<!-- re:${ref} -->\nÖdeme sağlayıcısının webhook'u API Error: 429 döndü, yarın tekrar denenir.`);
    result(h);
    await vi.waitFor(() => expect(answers(n).some((t) => t.includes('429 döndü'))).toBe(true), { timeout: 5000 });
    expect(tg.texts().slice(n).some((t) => t.includes(API_DOWN_LINE.slice(0, 20)))).toBe(false);
  });

  it('a raw API error the CLI wrote never reaches his phone: one Turkish line instead, once', async () => {
    await start();
    const { h } = await hisMessage();
    const n = tg.texts().length;
    assistant(h, 'Failed to authenticate. API Error: 403 Attention Required! | Cloudflare');
    assistant(h, 'API Error: 403 Attention Required! | Cloudflare');
    await vi.waitFor(() => expect(tg.texts().slice(n).length).toBeGreaterThan(0), { timeout: 5000 });
    await quiet();
    const out = tg.texts().slice(n);
    expect(out.some((t) => /Cloudflare|403/.test(t))).toBe(false);
    expect(out.filter((t) => t.includes(API_DOWN_LINE.slice(0, 20)))).toHaveLength(1);
  });
});

describe('the night (AC7)', () => {
  it("03:00, he is not writing: a job's result waits; at 08:00 it comes in ONE morning message", async () => {
    clock = at(23, 0, 20);
    await start();
    const { h, ref } = await hisMessage('gece şu işi bitir');
    assistant(h, `<!-- re:${ref} -->\nTamam, başladım.`);
    result(h);
    await quiet();
    clock = at(3, 0);
    const n = tg.texts().length;
    h.userSent(''); // an event turn: no words of his
    assistant(h, '<!-- re:abc123 -->\n**Rapor işi bitti.**');
    await quiet();
    clock = at(4, 0);
    assistant(h, '<!-- re:abc124 -->\n**Ödeme kontrolü bitti.**');
    await quiet();
    await hub.tickSade();
    expect(tg.texts().slice(n)).toEqual([]);
    clock = at(8, 0);
    await hub.tickSade();
    await vi.waitFor(() => expect(tg.texts().slice(n)).toHaveLength(1), { timeout: 5000 });
    expect(tg.texts().slice(n)[0]).toContain('Gece 2 iş bitti.');
    expect(tg.texts().slice(n)[0]).toContain('Rapor işi bitti.');
    expect(tg.texts().slice(n)[0]).toContain('Ödeme kontrolü bitti.');
  });
});

describe('the pinned agenda (AC10, owner 17:31)', () => {
  it('ONE pinned message from the agenda, pinned silently; a change edits it, never a second pin', async () => {
    await start();
    await hisMessage(); // he is on Telegram: away from the Mac
    await superState([
      { id: 'n1', section: 'now', text: 'Telegram sade konuşma', at: clock },
      { id: 'n2', section: 'waiting', text: 'Haber mesajı gitsin mi?', at: clock },
      { id: 'n3', section: 'done', text: 'Hafıza ölçümü', at: clock - 60_000 },
    ]);
    const n = tg.sent().length;
    await hub.tickSade();
    expect(tg.sent().length).toBe(n + 1);
    const pinMsg = tg.sent()[n];
    expect(pinMsg.params.disable_notification).toBe(true);
    expect(String(pinMsg.params.text)).toBe('📌 <b>Gündem</b>\n⏳ Telegram sade konuşma\n✋ Haber mesajı gitsin mi?\n✓ Hafıza ölçümü');
    expect(tg.sent('pinChatMessage')).toHaveLength(1);
    expect(tg.sent('pinChatMessage')[0].params.disable_notification).toBe(true);
    await hub.tickSade();
    expect(tg.sent('editMessageText')).toHaveLength(0); // unchanged: nothing
    await superState([{ id: 'n1', section: 'done', text: 'Telegram sade konuşma', at: clock }]);
    await hub.tickSade();
    expect(tg.sent('editMessageText')).toHaveLength(1);
    expect(tg.sent('editMessageText')[0].params.message_id).toBe((pinMsg.result as { message_id: number }).message_id);
    expect(tg.sent('pinChatMessage')).toHaveLength(1);
    expect(tg.sent().length).toBe(n + 1);
  });

  it('a failed edit (timeout, 429) never makes a second pin; a pin Telegram says is gone is replaced and the old one unpinned (review r1)', async () => {
    await start();
    await hisMessage();
    await superState([{ id: 'n1', section: 'now', text: 'Birinci iş', at: clock }]);
    const n = tg.sent().length;
    // The timer and a turn's end at the same moment: one pin.
    await Promise.all([hub.tickSade(), hub.refreshPin(hub.active.get(keyOf(scopeOfContextRoot(root), 'super'))!)]);
    expect(tg.sent().length).toBe(n + 1);
    expect(tg.sent('pinChatMessage')).toHaveLength(1);
    const first = (tg.sent()[n].result as { message_id: number }).message_id;
    await superState([{ id: 'n1', section: 'now', text: 'İkinci iş', at: clock }]);
    tg.failOnce.set('editMessageText', 429);
    await hub.tickSade();
    expect(tg.sent().length).toBe(n + 1);
    expect(tg.sent('pinChatMessage')).toHaveLength(1);
    tg.failOnce.set('editMessageText', 400);
    tg.failOnceWhy.set('editMessageText', 'Bad Request: message to edit not found');
    await hub.tickSade();
    expect(tg.sent().length).toBe(n + 2);
    expect(tg.sent('unpinChatMessage').map((c) => c.params.message_id)).toEqual([first]);
    expect(tg.sent('pinChatMessage')).toHaveLength(2);
  });
});

describe('a voice day (AC7)', () => {
  it('a voice-day turn whose answer was spoken from its words does not end with "no voice was sent" (review r1)', async () => {
    const spoken: string[] = [];
    await start(0, { speakSummary: async (t: string) => { spoken.push(t); return { ok: true as const, ogg: Buffer.from('OggS-fake'), seconds: 9 }; } });
    const ab = hub.active.get(keyOf(scopeOfContextRoot(root), 'super'))!;
    (hub as unknown as { voiceDays: Map<string, string> }).voiceDays.set(ab.key, dayOf(clock));
    const { h, ref } = await hisMessage('rapor ne durumda?');
    const n = tg.calls.length;
    assistant(h, `<!-- re:${ref} -->\n**Rapor hazır.**\n\nÜç sayfa açıldı, hepsi doğru.`);
    result(h);
    await vi.waitFor(() => expect(tg.calls.slice(n).some((c) => c.method === 'sendVoice')).toBe(true), { timeout: 5000 });
    await quiet(); await quiet();
    expect(tg.texts().some((t) => t.includes('ses kaydı yoktu'))).toBe(false);
  });

  it('after he asked for voice, the next answer with no voice block is still spoken', async () => {
    const spoken: string[] = [];
    hub = new TelegramHub({ textGraceMs: 0, sadeTickMs: 0, home, speakSummary: async (t) => { spoken.push(t); return { ok: true, ogg: Buffer.from('OggS-fake'), seconds: 9 }; } });
    const log: string[] = [];
    let mid = 100;
    const ab = {
      key: '0123456789abcdef/super', scope: '0123456789abcdef', target: 'super',
      binding: { v: 1, token: 't', botId: 1, botUsername: 'b', chatId: 777, userId: 777, boundAt: '' },
      transport: {
        sendMessage: async (_c: number, html: string) => { log.push(`text:${html}`); return { message_id: ++mid, text: html }; },
        sendVoice: async () => { log.push('voice'); return { message_id: ++mid }; },
        sendChatAction: async () => true,
      },
      poller: null, done: Promise.resolve(), chain: Promise.resolve(), contextRoot: null, projectName: 'X',
    } as unknown as Parameters<TelegramHub['sendAnswer']>[0];
    hub.active.set(ab.key, ab);
    (hub as unknown as { voiceDays: Map<string, string> }).voiceDays.set(ab.key, dayOf(Date.now()));
    await hub.sendAnswer(ab, '**Rapor hazır.**\n\nÜç sayfa açıldı, hepsi doğru.', null, undefined, 'mac');
    expect(log).toContain('voice');
    expect(spoken[0]).toContain('Üç sayfa açıldı');
    expect(log.filter((l) => l.startsWith('text:'))).toEqual(['text:<b>Rapor hazır.</b>']);
  });
});
