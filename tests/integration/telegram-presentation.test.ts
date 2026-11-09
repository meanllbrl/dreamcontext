/**
 * Wave 5 against a fake Telegram and a fake Super window (plan L1, L2, M1, M4, M5, N1, N5, N6,
 * P4, S1, T1-T3): the Super's stage presentations, dream blocks as pictures and buttons, late
 * results, the native commands and Super'i aç.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { FakeTelegram, textUpdate } from '../helpers/fake-telegram.js';
import { TelegramHub } from '../../src/server/telegram/hub.js';
import { wireTelegramAsks, _resetTelegramAsks } from '../../src/server/telegram/asks.js';
import { wireTelegramW5 } from '../../src/server/telegram/w5.js';
import * as reg from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { noteStageVerb } from '../../src/lib/super/stage-events.js';
import { announceOwnerHead, _resetOwnerQuestions } from '../../src/lib/super/owner-question.js';
import { scopeOfContextRoot } from '../../src/lib/telegram/config.js';
import { parseTelegramPrefix } from '../../src/lib/telegram/contract.js';
import { deliverHubResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

const TOKEN = '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OWNER = 777;
const SID = '11111111-2222-4333-8444-555555555555';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(80, 7)]);
const SECRET = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

let vault: string; let home: string; let project: string; let root: string; let tg: FakeTelegram; let hub: TelegramHub;
let unwire: Array<() => void>; let clock: number; let hubFrames: Record<string, unknown>[]; let session: { on: boolean; url: string | null; channel: 'full' | 'telegram' | null; via: boolean };
const drained = (ms = 40) => new Promise((r) => setTimeout(r, ms));

async function writeState(extra: Record<string, unknown>): Promise<void> {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SID, enabled: true, ...extra }));
  resetSuperIndex();
  await readSuperState(root);
}

/** The Super window: answers html_snapshot with a PNG, interrupt/super_handover with ok. */
function superWindow(answer: (f: Record<string, unknown>) => Record<string, unknown> = () => ({ ok: true })) {
  const { token } = mintWindowToken({
    send: (f) => {
      hubFrames.push(f);
      const r = f.verb === 'html_snapshot' ? { ok: true, pngs: [PNG.toString('base64')] } : answer(f);
      setImmediate(() => deliverHubResult(token, f.id, r as never));
      return true;
    },
    sessionId: SID, mode: 'super', vault, contextRoot: root,
  });
  return token;
}

function chat() {
  const h = reg.registerChat({ sessionId: SID, conversationId: null, vault, mode: 'super' });
  const sent: string[] = [];
  reg.registerChatInjector(SID, {
    sessionId: SID, chatRegistryId: SID,
    sendOwnerText: async (t) => { sent.push(t); h.userSent(t, { source: 'telegram-text' }); return { ok: true }; },
    interrupt: vi.fn(),
  });
  return { h, sent };
}
const assistant = (h: reg.ChatHandle, text: string) => h.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } });
const endTurn = (h: reg.ChatHandle) => h.observe({ type: 'result', subtype: 'success', is_error: false, parent_tool_use_id: null });
const media = () => tg.calls.filter((c) => ['sendPhoto', 'sendMediaGroup', 'sendVideo', 'sendDocument'].includes(c.method));
function buttonMsg(label: string) {
  return [...tg.sent()].reverse().find((c) => JSON.stringify(c.params.reply_markup ?? {}).includes(label))!;
}
function tap(msg: ReturnType<typeof buttonMsg>, idx: number) {
  const kb = (msg.params.reply_markup as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard.flat().filter((b) => b.callback_data);
  tg.push(TOKEN, { callback_query: { id: `cb${idx}${Math.random()}`, data: kb[idx].callback_data, from: { id: OWNER }, message: { message_id: msg.result!.message_id, chat: { id: OWNER, type: 'private' }, text: String(msg.params.text).replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') } } });
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tg-w5-home-'));
  project = mkdtempSync(join(tmpdir(), 'tg-w5-proj-'));
  root = join(project, '_dream_context');
  vault = basename(project);
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: vault, path: project }] }));
  for (const n of ['a', 'b', 'c']) writeFileSync(join(project, `${n}.png`), PNG);
  writeFileSync(join(project, '.gitignore'), '');
  reg._resetChatRegistry(); resetWindowControl(); _resetTelegramAsks(); _resetOwnerQuestions();
  clock = Date.parse('2026-11-08T10:00:00Z');
  hubFrames = [];
  session = { on: false, url: null, channel: null, via: false };
  tg = new FakeTelegram(); tg.addBot(TOKEN, 'acme_super_bot');
  hub = new TelegramHub({ home, fetchImpl: tg.fetch, pollTimeoutS: 0, sleep: async () => {}, vaults: () => [{ name: vault, contextRoot: root }], injectorWaitMs: 300, now: () => clock, openLink: () => {}, handsfree: { streamsTo: () => false, isOn: () => true } });
  unwire = [wireTelegramAsks(hub), wireTelegramW5(hub, {
    settleMs: 5, isGitIgnored: () => false,
    session: () => ({ isOn: () => session.on, startedVia: session.via ? { scope: scopeOfContextRoot(root), target: 'super' } : null, channel: session.channel, status: () => ({ url: session.url }) }),
    commands: { windowWaitMs: 200, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))) },
  })];
  await hub.start();
  const start = await hub.beginPairing({ scope: scopeOfContextRoot(root), target: 'super', token: TOKEN, projectName: vault, contextRoot: root });
  await drained();
  tg.push(TOKEN, textUpdate(OWNER, `/start ${new URL(start.deepLink).searchParams.get('start')}`));
  await vi.waitFor(() => expect(hub.pairingPreview(start.pairingId)).not.toBeNull(), { timeout: 5000 });
  await hub.confirmPairing(start.pairingId, { botId: 123456, userId: OWNER });
  await drained();
  await writeState({});
});
afterEach(async () => {
  for (const u of unwire) u();
  await hub.stop();
  rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true });
});

const images = ['a', 'b', 'c'].map((n) => ({ id: `image-${n}`, kind: 'image', ref: `${n}.png`, shape: 'square', place: 'main', title: `Resim ${n.toUpperCase()}` }));
const present = (ids: string[]) => noteStageVerb({ vault, contextRoot: root, sessionId: SID, superId: 'main', verb: 'present', ids });

describe('turn end sends no receipt', () => {
  it('an answered turn sends no "Bitti · N iş" line', async () => {
    const { h, sent } = chat();
    superWindow();
    tg.push(TOKEN, textUpdate(OWNER, 'selam'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await writeState({ children: { c1: { sessionId: 'c1', brief: 'Paywall testi', row: 'working', startedAt: 1, adopted: false } } });
    assistant(h, `<!-- re:${parseTelegramPrefix(sent[0]).ref} -->\nMerhaba`);
    endTurn(h);
    await new Promise((r) => setTimeout(r, 200));
    expect(tg.texts().some((t) => t.includes('Bitti ·'))).toBe(false);
  });

  it('a turn that ended with no text says one plain line', async () => {
    const { h, sent } = chat();
    superWindow();
    tg.push(TOKEN, textUpdate(OWNER, 'selam'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    endTurn(h);
    await vi.waitFor(() => expect(tg.texts().some((t) => t.includes('cevap yazmadan bitti'))).toBe(true));
    expect(tg.texts().some((t) => t.includes('Bitti ·'))).toBe(false);
  });
});

describe('stage presentations (L1, L2, N1)', () => {
  it('a present of 3 cards during a Telegram turn → one album of 3 in stage order with the layout caption, then Telefonda aç', async () => {
    const { h, sent } = chat();
    superWindow();
    tg.push(TOKEN, textUpdate(OWNER, 'resimleri göster'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await writeState({ containers: images, view: { mode: 'present', cards: ['image-c', 'image-a', 'image-b'], layout: 'filmstrip' } });
    present(['image-a', 'image-b', 'image-c']);
    endTurn(h);
    await vi.waitFor(() => expect(tg.calls.some((c) => c.method === 'sendMediaGroup')).toBe(true));
    const album = tg.calls.find((c) => c.method === 'sendMediaGroup')!;
    const items = JSON.parse(String(album.params.media)) as { type: string; caption?: string }[];
    expect(items.map((i) => i.type)).toEqual(['photo', 'photo', 'photo']);
    expect(items[0].caption).toBe('Film şeridi: Resim C · Resim A · Resim B');
    await drained(80);
    // Every card arrived as a photo: no phone line at all.
    expect(buttonMsg('Telefon linkini aç')).toBeFalsy();
    expect(tg.texts().some((t) => t.includes('Telefon linki'))).toBe(false);
  });

  it('with Telegram + link on for this bot, Telefonda aç is a URL button to the bare origin under the hub\'s own line', async () => {
    session = { on: true, url: 'https://quiet-fox.trycloudflare.com/login?t=SECRETLOGIN', channel: 'full', via: true };
    const { h, sent } = chat();
    superWindow();
    tg.push(TOKEN, textUpdate(OWNER, 'göster'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    reg.adoptOwnerWaits(SID, [{ wait: { kind: 'secret', id: 'sec-1', line: 'Firebase token' } as never, since: clock }]);
    await writeState({ containers: images.slice(0, 1), view: { mode: 'float' } });
    noteStageVerb({ vault, contextRoot: root, sessionId: SID, superId: 'main', verb: 'open', ids: ['image-a'] });
    endTurn(h);
    await vi.waitFor(() => expect(buttonMsg('Telefonda aç')).toBeTruthy());
    const msg = buttonMsg('Telefonda aç');
    expect(String(msg.params.text)).toMatch(/^🔒 <i>Telefon linki quiet-fox\.trycloudflare\.com; şifreni yalnız bu adrese yaz\.<\/i>$/);
    const url = (msg.params.reply_markup as { inline_keyboard: { url: string }[][] }).inline_keyboard[0][0].url;
    expect(url.startsWith('https://quiet-fox.trycloudflare.com/?vault=')).toBe(true);
    expect(JSON.stringify(tg.calls)).not.toContain('SECRETLOGIN');
  });

  it('with a live origin, a presentation that fully arrived as a photo sends no phone message', async () => {
    session = { on: true, url: 'https://quiet-fox.trycloudflare.com/login?t=X', channel: 'full', via: true };
    const { h, sent } = chat();
    superWindow();
    tg.push(TOKEN, textUpdate(OWNER, 'göster'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await writeState({ containers: images.slice(0, 1), view: { mode: 'float' } });
    noteStageVerb({ vault, contextRoot: root, sessionId: SID, superId: 'main', verb: 'open', ids: ['image-a'] });
    endTurn(h);
    await vi.waitFor(() => expect(tg.calls.some((c) => c.method === 'sendPhoto')).toBe(true));
    await drained(80);
    expect(buttonMsg('Telefonda aç')).toBeFalsy();
  });

  it('a picture Telegram would refuse (an 11 MB photo) goes as its text line beside the album, never silence', async () => {
    writeFileSync(join(project, 'big.png'), Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]));
    const { h, sent } = chat();
    superWindow();
    tg.push(TOKEN, textUpdate(OWNER, 'göster'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const big = { id: 'image-big', kind: 'image', ref: 'big.png', shape: 'square', place: 'main', title: 'Büyük' };
    await writeState({ containers: [...images, big], view: { mode: 'present', cards: ['image-a', 'image-big', 'image-b'], layout: 'grid' } });
    present(['image-a']);
    endTurn(h);
    await vi.waitFor(() => expect(tg.texts().some((t) => t.includes("Büyük (Mac'te)"))).toBe(true));
    const album = tg.calls.find((c) => c.method === 'sendMediaGroup')!;
    expect(JSON.parse(String(album.params.media))).toHaveLength(2);
  });

  it('a failed album send leaves every card as a text line under the head', async () => {
    tg.failing.set('sendMediaGroup', 400);
    const { h, sent } = chat();
    superWindow();
    tg.push(TOKEN, textUpdate(OWNER, 'göster'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await writeState({ containers: images, view: { mode: 'present', cards: ['image-a', 'image-b'], layout: 'compare' } });
    present(['image-a']);
    endTurn(h);
    await vi.waitFor(() => expect(tg.texts().some((t) => t.includes('Karşılaştırma: Resim A · Resim B') && t.includes("Resim A (Mac'te)") && t.includes("Resim B (Mac'te)"))).toBe(true));
  });

  it('Telegram-only hands-free: a photo sends no phone line; an unsent card never gets a mode-change instruction', async () => {
    session = { on: true, url: null, channel: 'telegram', via: true };
    const { h, sent } = chat();
    superWindow();
    tg.push(TOKEN, textUpdate(OWNER, 'göster'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await writeState({ containers: images.slice(0, 1), view: { mode: 'float' } });
    noteStageVerb({ vault, contextRoot: root, sessionId: SID, superId: 'main', verb: 'open', ids: ['image-a'] });
    endTurn(h);
    await vi.waitFor(() => expect(tg.calls.some((c) => c.method === 'sendPhoto')).toBe(true));
    await drained(80);
    expect(tg.texts().some((t) => t.includes('Telefon linki'))).toBe(false);
    // A card that cannot travel (secret pending): only the "(Mac'te)" line, still no mode text.
    reg.adoptOwnerWaits(SID, [{ wait: { kind: 'secret', id: 'sec-1', line: 'Firebase token' } as never, since: clock }]);
    await writeState({ containers: images.slice(0, 1), view: { mode: 'float' } });
    tg.push(TOKEN, textUpdate(OWNER, 'tekrar'));
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    noteStageVerb({ vault, contextRoot: root, sessionId: SID, superId: 'main', verb: 'open', ids: ['image-a'] });
    endTurn(h);
    await vi.waitFor(() => expect(tg.texts().some((t) => t.includes("(Mac'te)"))).toBe(true));
    await drained(80);
    expect(tg.texts().some((t) => t.includes('Telefon linki') || t.includes('/handsfree'))).toBe(false);
    expect(tg.sent().some((c) => JSON.stringify(c.params.reply_markup ?? {}).includes('Telefon linkini aç'))).toBe(false);
  });

  it('an all-photo presentation cut at the 10-card cap still offers the phone link', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `image-m${i}`, kind: 'image', ref: 'a.png', shape: 'square', place: 'main', title: `M${i}` }));
    const { h, sent } = chat();
    superWindow();
    tg.push(TOKEN, textUpdate(OWNER, 'göster'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await writeState({ containers: many, view: { mode: 'present', cards: many.map((c) => c.id), layout: 'grid' } });
    present(many.map((c) => c.id));
    endTurn(h);
    await vi.waitFor(() => expect(buttonMsg('Telefon linkini aç')).toBeTruthy());
  });

  it('an owner arrangement on the Mac sends nothing; outside a Telegram turn with streaming off nothing either', async () => {
    const { h } = chat();
    superWindow();
    await writeState({ containers: images, view: { mode: 'present', cards: ['image-a', 'image-b'], layout: 'compare', by: 'owner' } });
    // The owner's layout door fires no stage event; even an agent verb over his view sends nothing.
    h.userSent('mac');
    present(['image-a']);
    endTurn(h);
    await drained(80);
    expect(media()).toHaveLength(0);
    await writeState({ containers: images, view: { mode: 'present', cards: ['image-a', 'image-b'], layout: 'compare' } });
    h.userSent('mac again');
    present(['image-a', 'image-b']);
    endTurn(h);
    await drained(80);
    expect(media()).toHaveLength(0);
  });

  it('no picture while a secret card is pending: the cards go as text lines', async () => {
    const { h, sent } = chat();
    superWindow();
    tg.push(TOKEN, textUpdate(OWNER, 'göster'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    reg.adoptOwnerWaits(SID, [{ wait: { kind: 'secret', id: 'sec-1', line: 'Firebase token' } as never, since: clock }]);
    await writeState({ containers: images, view: { mode: 'present', cards: ['image-a', 'image-b'], layout: 'compare' } });
    present(['image-a', 'image-b']);
    endTurn(h);
    await vi.waitFor(() => expect(tg.texts().some((t) => t.includes("Resim: Resim A (Mac'te)"))).toBe(true));
    expect(media()).toHaveLength(0);
  });

  it('an insight card with no window mounted falls back to its title line', async () => {
    const { h, sent } = chat();
    tg.push(TOKEN, textUpdate(OWNER, 'mrr'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await writeState({ containers: [{ id: 'insight-mrr', kind: 'insight', ref: 'mrr', shape: 'square', place: 'main', title: 'MRR' }], view: { mode: 'float' } });
    noteStageVerb({ vault, contextRoot: root, sessionId: SID, superId: 'main', verb: 'open', ids: ['insight-mrr'] });
    endTurn(h);
    await vi.waitFor(() => expect(tg.texts().some((t) => t.includes("Insight: MRR (Mac'te)"))).toBe(true));
    expect(media()).toHaveLength(0);
  });
});

describe('answers: blocks, late results (M1, M5, N7, S1, T3)', () => {
  it('a dream-html block becomes a picture from server-held bytes; a secret-shaped block one text line, no sendPhoto', async () => {
    const { h, sent } = chat();
    superWindow();
    tg.push(TOKEN, textUpdate(OWNER, 'kart'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const { ref } = parseTelegramPrefix(sent[0]);
    assistant(h, `<!-- re:${ref} -->\nİşte:\n\`\`\`dream-html\n<div class="dc-card"><div class="dc-card-title">Gelir AUTHORED-MARK</div></div>\n\`\`\``);
    await vi.waitFor(() => expect(tg.calls.some((c) => c.method === 'sendPhoto')).toBe(true));
    const snap = hubFrames.find((f) => f.verb === 'html_snapshot')!;
    const page = String((snap.args as { html: string }).html);
    expect(page.replace(/srcdoc="[^"]*"/, '')).not.toContain('AUTHORED-MARK');
    expect(tg.texts().join('\n')).not.toContain('dream-html');
    const photos = tg.calls.filter((c) => c.method === 'sendPhoto').length;
    assistant(h, `<!-- re:${ref} -->\n\`\`\`dream-html\n<div class="dc-card"><h2>Anahtar</h2><p>${SECRET}</p></div>\n\`\`\``);
    await vi.waitFor(() => expect(tg.texts()).toContain("ℹ️ <i>Bu kart Telegram'a gitmedi, Mac'te: Anahtar</i>"));
    expect(tg.calls.filter((c) => c.method === 'sendPhoto').length).toBe(photos);
  });

  it('dream-actions arrive as buttons, never JSON; an ask needs a confirm tap before it is sent', async () => {
    const { h, sent } = chat();
    tg.push(TOKEN, textUpdate(OWNER, 'ne yapayım'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const { ref } = parseTelegramPrefix(sent[0]);
    assistant(h, `<!-- re:${ref} -->\nSeç:\n\`\`\`dream-actions\n[{"label":"Docs","action":"url","url":"https://docs.example.com/x"},{"label":"Testleri koş","action":"ask","text":"run npm test"}]\n\`\`\``);
    await vi.waitFor(() => expect(buttonMsg('▸ Testleri koş')).toBeTruthy());
    expect(JSON.stringify(tg.sent().map((c) => c.params.text))).not.toContain('"action"');
    const kb = JSON.stringify(buttonMsg('▸ Testleri koş').params.reply_markup);
    expect(kb).toContain('https://docs.example.com/x');
    tap(buttonMsg('▸ Testleri koş'), 0);
    await vi.waitFor(() => expect(buttonMsg('Gönder')).toBeTruthy());
    expect(sent).toHaveLength(1);
    tap(buttonMsg('Gönder'), 0);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(parseTelegramPrefix(sent[1]).body).toBe('run npm test');
  });

  it('a late child result 2 h after the Telegram message still reaches Telegram', async () => {
    const { h, sent } = chat();
    tg.push(TOKEN, textUpdate(OWNER, 'testi koş, bitince söyle'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const { ref } = parseTelegramPrefix(sent[0]);
    endTurn(h);
    await drained();
    clock += 2 * 60 * 60 * 1000;
    h.userSent('[super events] child done', { source: undefined });
    assistant(h, `<!-- re:${ref} -->\nTestler geçti, 412/412.`);
    await vi.waitFor(() => expect(tg.texts()).toContain('Testler geçti, 412/412.'));
  });

  it('a Mac-started job blocked on the owner reaches the Super bot', async () => {
    // A real `owner` item names the card he must act on (the store drops one without `wait`).
    const item = { id: 'own-1', kind: 'owner', sessionId: SID, state: 'pending', createdAt: 1, ownerText: 'Deploy için onayını bekliyorum', wait: { kind: 'run', id: 'run-1' } };
    await writeState({ queue: [item] });
    announceOwnerHead(() => vault, await readSuperState(root), item as never);
    await vi.waitFor(() => expect(tg.texts().some((t) => t.includes('Deploy için onayını bekliyorum'))).toBe(true));
  });

  it('a reply to a bot message carries the Mac\'s reply header', async () => {
    const { h, sent } = chat();
    tg.push(TOKEN, textUpdate(OWNER, 'özetle'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const { ref } = parseTelegramPrefix(sent[0]);
    const full = `<!-- re:${ref} -->\nÜç seçenek var: A, B, C.`;
    assistant(h, full);
    await vi.waitFor(() => expect(tg.texts()).toContain('Üç seçenek var: A, B, C.'));
    const botMsg = tg.sent().find((c) => String(c.params.text).includes('Üç seçenek'))!;
    tg.push(TOKEN, textUpdate(OWNER, 'B olsun', { reply_to_message: { message_id: botMsg.result!.message_id } }));
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const { body } = parseTelegramPrefix(sent[1]);
    expect(body).toMatch(/^\[Reply to message ref=[0-9a-z]{6} from=super\]\nquote: "Üç seçenek var: A, B, C\."\n\nB olsun$/);
  });
});

describe('a rich ask outlives an expired note capture (capture.ts)', () => {
  it('Not ekle, 6 min later a text → a turn; the ask is still open and Gönder answers it', async () => {
    const { sent } = chat();
    const item = { id: 'ask-9', kind: 'ask', sessionId: SID, state: 'escalated', createdAt: 1, ask: { questions: [
      { question: 'Hangi ülkeler?', multiSelect: true, options: [{ label: 'TR' }, { label: 'DE' }] },
      { question: 'Ne zaman?', options: [{ label: 'Bugün' }, { label: 'Yarın' }] },
    ] } };
    await writeState({ queue: [item] });
    announceOwnerHead(() => vault, await readSuperState(root), item as never);
    await vi.waitFor(() => expect(buttonMsg('Belirsiz, tekrar sor')).toBeTruthy());
    const q2 = buttonMsg('Belirsiz, tekrar sor');
    const q2Text = String(q2.params.text).replace(/<[^>]+>/g, '');
    const press = (label: string) => {
      const edit = [...tg.calls].reverse().find((c) => c.method === 'editMessageReplyMarkup' && c.params.message_id === q2.result!.message_id);
      const kb = ((edit ?? q2).params.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat();
      const btn = kb.find((b) => b.text === label || b.text === `✓ ${label}`)!;
      tg.push(TOKEN, { callback_query: { id: `cb${Math.random()}`, data: btn.callback_data, from: { id: OWNER }, message: { message_id: q2.result!.message_id, chat: { id: OWNER, type: 'private' }, text: q2Text, ...(edit ? { edit_date: 9 } : {}) } } });
    };
    press('Not ekle');
    await vi.waitFor(() => expect(tg.texts().some((t) => t.startsWith('⏳ <i>Notunu yaz'))).toBe(true));
    // Small steps: a jump past the poller's wake gap reads as the Mac waking from sleep (drained).
    for (let i = 0; i < 12; i++) { clock += 30_000; await drained(15); }
    tg.push(TOKEN, textUpdate(OWNER, 'başka bir şey: raporu at'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(parseTelegramPrefix(sent[0]).body).toBe('başka bir şey: raporu at');
    press('Yarın');
    await vi.waitFor(() => expect(tg.calls.some((c) => c.method === 'editMessageReplyMarkup')).toBe(true));
    press('Gönder');
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(parseTelegramPrefix(sent[1]).body).toContain('"Ne zaman?"="Yarın"');
  });
});

describe('member posts keep their blocks as lines (no hub drawing there)', () => {
  it('a dream-html block in a non-answer send stays a "Mac\'te" line', async () => {
    const ab = [...hub.active.values()][0];
    await hub.sendMarkdown(ab, 'Rapor hazır\n```dream-html\n<div class="dc-card"><h2>Haftalık</h2></div>\n```');
    await vi.waitFor(() => expect(tg.texts().some((t) => t.includes("Mac'te: Haftalık"))).toBe(true));
  });
});

describe('commands (M4, N5, N6, P4)', () => {
  it('/dur goes to the window as interrupt (one), /durum lists the jobs', async () => {
    const { h, sent } = chat();
    superWindow();
    tg.push(TOKEN, textUpdate(OWNER, 'uzun iş'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    tg.push(TOKEN, textUpdate(OWNER, '/dur'));
    await vi.waitFor(() => expect(hubFrames.some((f) => f.verb === 'interrupt')).toBe(true));
    await vi.waitFor(() => expect(tg.texts()).toContain('ℹ️ <i>Durduruldu.</i>'));
    expect(reg.chatInjector(SID)!.interrupt).not.toHaveBeenCalled();
    endTurn(h);
    await writeState({ children: { c1: { sessionId: 'c1', brief: 'Paywall testi', row: 'working', startedAt: 1, adopted: false } } });
    tg.push(TOKEN, textUpdate(OWNER, '/durum'));
    await vi.waitFor(() => expect(tg.texts().some((t) => t.includes('<i>Paywall testi</i> · çalışıyor'))).toBe(true));
  });

  it('/gundem: Bitti moves the line to done (no turn); Yaz makes the next text carry the agenda block', async () => {
    const { sent } = chat();
    await writeState({ pad: [{ id: 'n1', section: 'now', text: 'Paywall testini bitir', at: 1 }, { id: 'n2', section: 'now', text: 'Raporu yaz', at: 1 }], padSeq: 2 });
    tg.push(TOKEN, textUpdate(OWNER, '/gundem'));
    await vi.waitFor(() => expect(buttonMsg('1 Bitti')).toBeTruthy());
    tap(buttonMsg('1 Bitti'), 0);
    await vi.waitFor(async () => { resetSuperIndex(); expect((await readSuperState(root)).pad?.find((p) => p.id === 'n1')?.section).toBe('done'); });
    expect(sent).toHaveLength(0);
    tap(buttonMsg('2 Yaz'), 3);
    await vi.waitFor(() => expect(tg.texts().some((t) => t.startsWith('⏳ <i>Yaz:'))).toBe(true));
    tg.push(TOKEN, textUpdate(OWNER, 'bunu yarına al'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(parseTelegramPrefix(sent[0]).body).toBe('[About agenda line note=n2 section=now]\nline: "Raporu yaz"\n\nbunu yarına al');
  });

  it('Super off → Super\'i aç runs the window\'s own hand-over adopting nothing', async () => {
    await writeState({ enabled: false });
    reg.registerChat({ sessionId: 'tab-1', conversationId: null, vault, mode: 'agent' });
    const frames: Record<string, unknown>[] = [];
    const { token } = mintWindowToken({ send: (f) => { frames.push(f); setImmediate(() => deliverHubResult(token, f.id, { ok: true, sessionId: SID })); return true; }, sessionId: 'tab-1', mode: 'agent', vault, contextRoot: root });
    tg.push(TOKEN, textUpdate(OWNER, 'merhaba'));
    await vi.waitFor(() => expect(buttonMsg("Super'i aç")).toBeTruthy());
    tap(buttonMsg("Super'i aç"), 0);
    await vi.waitFor(() => expect(frames.some((f) => f.verb === 'super_handover')).toBe(true));
    expect(frames.find((f) => f.verb === 'super_handover')!.args).toEqual({ adopt: [] });
    await vi.waitFor(() => expect(tg.texts()).toContain("ℹ️ <i>Super açıldı; Mac'te açık olan sekmeler buraya devredilmedi.</i>"));
  });
});
