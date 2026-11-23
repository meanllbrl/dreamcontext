/**
 * Owner 2026-11-09 ("sorular Telegram'a ulaşmıyor"), replayed on the real hub with a fake Telegram:
 *  - a question that is NOT the head of his bar (a child's card was open first) reached Telegram
 *    only on his next Telegram message, and `super ask` said `reached: false`;
 *  - a send Telegram refused stayed "sent" forever, with no trace and no retry;
 *  - a child's two-question card printed every question in its first message ("(options: …)"),
 *    an option that carried only a drawing showed nothing, the drawing never came;
 *  - a card arrived after it was answered, and kept its buttons.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { FakeTelegram, textUpdate } from '../helpers/fake-telegram.js';
import { TelegramHub } from '../../src/server/telegram/hub.js';
import { wireTelegramAsks, _resetTelegramAsks } from '../../src/server/telegram/asks.js';
import { wireTelegramW5 } from '../../src/server/telegram/w5.js';
import * as reg from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { announceOwnerHead, ownerQuestionReach, setOwnerQuestionSinks, settleOwnerReach, _resetOwnerQuestions } from '../../src/lib/super/owner-question.js';
import { ownerAbouts, superQueueHead } from '../../src/lib/super/inbox.js';
import { aboutHeads } from '../../src/lib/super/types.js';
import { parseTelegramPrefix } from '../../src/lib/telegram/contract.js';
import { scopeOfContextRoot } from '../../src/lib/telegram/config.js';
import { deliverHubResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

const TOKEN = '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OWNER = 777;
const SID = '11111111-2222-4333-8444-555555555555';
const CHILD = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(80, 7)]);
let vault: string; let home: string; let project: string; let root: string; let tg: FakeTelegram; let hub: TelegramHub; let unwire: Array<() => void>;
let away = true;
/** Hands-free streaming to this chat: an ask's --show cards go with it (rich-asks.ts N3). */
let streams = false;
/** The Mac window's renderer: on (a PNG) or off (no window). */
let windowDraws = true;
/** The headless renderer (page-shot.ts), faked: what it returns. */
let shot: Buffer | null = null;
const quiet = () => new Promise((r) => setTimeout(r, 120));

const CHILDREN = { [CHILD]: { sessionId: CHILD, brief: 'Uygulama işleri', adopted: false, startedAt: 1 } };
const CARD = {
  title: 'App onay kartı → görünüş',
  questions: [
    { question: 'Onay kartı bu çizimdeki gibi olsun mu?', header: 'Kart', description: 'Taslak, son hali değil.', multiSelect: false,
      options: [{ label: 'Bu taslak olur', preview: '<div class="dc-card">Kart</div>' }, { label: 'Değişsin', description: 'Notuna yaz.' }] },
    { question: "Onay kartı Telegram'a ne zaman gitsin?", header: 'Telegram', multiSelect: false,
      options: [{ label: "Mac'te değilken", description: 'Bugünkü kural.' }, { label: 'Her zaman', description: 'İkisine de.' }] },
  ],
};
// What the child question's record carries: every question joined, as the Mac bar shows it.
const OWNER_TEXT = `${CARD.questions[0].question}\n${CARD.questions[1].question} (options: Bu taslak olur | Değişsin)`;

async function writeState(extra: Record<string, unknown>): Promise<void> {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SID, enabled: true, children: CHILDREN, ...extra }));
  resetSuperIndex();
  await readSuperState(root);
}
/** What `afterSuperWrite` does after every record write. */
async function afterWrite(): Promise<void> {
  const s = await readSuperState(root);
  announceOwnerHead(() => vault, s, superQueueHead(s));
}
function childAsks(requestId = 'req-q') {
  const child = reg.registerChat({ sessionId: CHILD, conversationId: null, vault, mode: 'basic' });
  child.observe({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: CARD } });
  return child;
}
const childItem = (state = 'escalated') => ({ id: 'q-child', kind: 'question', direct: true, sessionId: CHILD, requestId: 'req-q', state, createdAt: 5, ownerText: OWNER_TEXT });
const superCard = (id = 'q-super', requestId = 'req-q') => ({ id, kind: 'ask', sessionId: SID, state: 'escalated', createdAt: 5, ownerText: OWNER_TEXT, ask: CARD, requestId });
const superAsk = (id: string, q: string, labels: string[], createdAt: number) => ({ id, kind: 'ask', sessionId: SID, state: 'escalated', createdAt, ownerText: q, ask: { questions: [{ question: q, options: labels.map((label) => ({ label })) }] } });
const withButton = (label: string) => tg.sent().filter((c) => JSON.stringify(c.params.reply_markup ?? {}).includes(label));

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tg-reach-home-'));
  project = mkdtempSync(join(tmpdir(), 'tg-reach-proj-'));
  root = join(project, '_dream_context');
  vault = basename(project);
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: vault, path: project }] }));
  reg._resetChatRegistry(); resetWindowControl(); _resetTelegramAsks(); _resetOwnerQuestions();
  away = true; streams = false; windowDraws = true; shot = null;
  tg = new FakeTelegram(); tg.addBot(TOKEN, 'acme_super_bot');
  hub = new TelegramHub({ textGraceMs: 0, sadeTickMs: 0, home, fetchImpl: tg.fetch, pollTimeoutS: 0, sleep: async () => {}, vaults: () => [{ name: vault, contextRoot: root }], injectorWaitMs: 300, handsfree: { streamsTo: () => streams, isOn: () => away } });
  unwire = [wireTelegramAsks(hub), wireTelegramW5(hub, { settleMs: 5, shoot: async () => shot })];
  await hub.start();
  const start = await hub.beginPairing({ scope: scopeOfContextRoot(root), target: 'super', token: TOKEN, projectName: vault, contextRoot: root });
  await quiet();
  tg.push(TOKEN, textUpdate(OWNER, `/start ${new URL(start.deepLink).searchParams.get('start')}`));
  await vi.waitFor(() => expect(hub.pairingPreview(start.pairingId)).not.toBeNull(), { timeout: 5000 });
  await hub.confirmPairing(start.pairingId, { botId: 123456, userId: OWNER });
  await quiet();
  const { token } = mintWindowToken({
    send: (f) => { setImmediate(() => deliverHubResult(token, f.id, (f.verb === 'html_snapshot' ? (windowDraws ? { ok: true, pngs: [PNG.toString('base64')] } : { ok: false, error: 'no_window' }) : { ok: true }) as never)); return true; },
    sessionId: SID, mode: 'super', vault, contextRoot: root,
  });
  tg.calls.length = 0;
});
afterEach(async () => {
  for (const u of unwire) u();
  await hub.stop();
  rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true });
});

describe('a question behind another reaches Telegram at once (q-mw9bdhrk)', () => {
  it('a child\'s card is never sent; the Super\'s ask asked behind it goes now, and the reply says reached via telegram', async () => {
    childAsks();
    await writeState({ queue: [childItem(), superAsk('ask-1', 'Kart böyle olsun mu?', ['Bu taslak olur', 'Değişsin'], 9)] });
    await afterWrite();
    await settleOwnerReach('ask-1', 3000);
    const reach = ownerQuestionReach(await readSuperState(root), 'ask-1');
    expect(withButton('Bu taslak olur').filter((c) => String(c.params.text).includes('Kart böyle olsun mu?'))).toHaveLength(1);
    expect(withButton('Gönder')).toHaveLength(0);
    expect(tg.texts().some((t) => t.includes('Uygulama işleri soruyor'))).toBe(false);
    expect(reach).toMatchObject({ shown: false, ahead: 1, reached: true, telegram: 'sent' });
    expect(reach.via).toContain('telegram');
  });

  it('at the Mac nothing goes, and reached:false names why; his next Telegram message sends it', async () => {
    away = false;
    await writeState({ queue: [superAsk('ask-1', 'Hangi renk?', ['Mor', 'Yeşil'], 1)] });
    await afterWrite();
    const reach = ownerQuestionReach(await readSuperState(root), 'ask-1');
    expect(reach.reached).toBe(false);
    expect(reach.telegram).toBe('at_mac');
    expect(reach.why).toMatch(/at the Mac/);
    expect(withButton('Yeşil')).toHaveLength(0);
    away = true;
    hub.flushAway();
    await vi.waitFor(() => expect(withButton('Yeşil')).toHaveLength(1));
  });
});

describe('a refused send is not "sent" (q-mw9b0mye)', () => {
  it('reached:false with Telegram\'s refusal and a log line; not re-sent inside its backoff; his next Telegram message sends it', async () => {
    tg.failOnce.set('sendMessage', 400);
    await writeState({ queue: [superAsk('ask-1', 'Hangi renk?', ['Mor', 'Yeşil'], 1)] });
    await afterWrite();
    await settleOwnerReach('ask-1', 3000);
    const reach = ownerQuestionReach(await readSuperState(root), 'ask-1');
    expect(reach).toMatchObject({ reached: false, telegram: 'failed' });
    expect(reach.why).toMatch(/Telegram refused the message.*400/);
    const log = join(home, '.dreamcontext', 'logs', 'telegram-asks.log');
    await vi.waitFor(() => expect(existsSync(log) && readFileSync(log, 'utf8')).toMatch(/ask-1 ask FAILED/));
    // A write inside the backoff sends nothing more (an outage does not burn every try at once).
    await afterWrite();
    await quiet();
    expect(withButton('Yeşil').filter((c) => c.result)).toHaveLength(0);
    // His next Telegram message (turning away) proves he is reachable: it goes at once.
    hub.flushAway();
    await vi.waitFor(() => expect(withButton('Yeşil').filter((c) => c.result)).toHaveLength(1));
    await settleOwnerReach('ask-1', 3000);
    expect(ownerQuestionReach(await readSuperState(root), 'ask-1')).toMatchObject({ reached: true, telegram: 'sent' });
    expect(withButton('Yeşil').filter((c) => c.result)).toHaveLength(1);
    expect(readFileSync(log, 'utf8')).toMatch(/ask-1 ask sent/);
  });
});

describe('a send still on its way is not a reach (review r1)', () => {
  it('the wait ends before Telegram answers: reached:false, telegram "sending", said plainly; then it lands', async () => {
    tg.slowSends.set('Hangi renk?', 600);
    await writeState({ queue: [superAsk('ask-1', 'Hangi renk?', ['Mor', 'Yeşil'], 1)] });
    await afterWrite();
    await settleOwnerReach('ask-1', 50);
    const early = ownerQuestionReach(await readSuperState(root), 'ask-1');
    expect(early).toMatchObject({ reached: false, telegram: 'sending' });
    expect(early.via).not.toContain('telegram');
    expect(early.why).toMatch(/still on its way/);
    await settleOwnerReach('ask-1', 3000);
    expect(ownerQuestionReach(await readSuperState(root), 'ask-1')).toMatchObject({ reached: true, telegram: 'sent' });
  });
});

describe('the Super\'s two-question card, one clean message per question', () => {
  it('title and job once, each question alone, its notes; the drawing as a picture without a live turn', async () => {
    await writeState({ queue: [superCard()] });
    await afterWrite();
    await vi.waitFor(() => expect(withButton('Gönder').length).toBe(1));
    // One message holds the card (telegram-sade, Doc C3); each question its own block in it.
    const card = tg.texts().filter((t) => t.startsWith('❓'));
    expect(card).toHaveLength(1);
    const msgs = card[0].split('\n\n❓');
    expect(msgs[0]).toContain('App onay kartı → görünüş');
    expect(msgs[0]).toContain('Onay kartı bu çizimdeki gibi olsun mu? (1/2)');
    expect(msgs[0]).not.toContain('options:');
    expect(msgs[0]).not.toContain("ne zaman gitsin");
    expect(msgs[0]).not.toContain('Bu taslak olur');
    expect(tg.calls.find((c) => c.method === 'sendPhoto')!.params.caption).toBe('A · Bu taslak olur');
    expect(msgs[1]).not.toContain('App onay kartı');
    expect(msgs[1]).toContain("ne zaman gitsin? (2/2)");
    const photoAt = tg.calls.findIndex((c) => c.method === 'sendPhoto');
    expect(photoAt).toBeGreaterThanOrEqual(0);
    expect(photoAt).toBeLessThan(tg.calls.findIndex((c) => String(c.params.text ?? '').startsWith('❓')));
  });

  it('no Mac window: the headless renderer draws it; neither draws: the option says the drawing is on the Mac', async () => {
    windowDraws = false; shot = PNG;
    await writeState({ queue: [superCard()] });
    await afterWrite();
    await vi.waitFor(() => expect(withButton('Gönder').length).toBe(1));
    expect(tg.calls.some((c) => c.method === 'sendPhoto')).toBe(true);
    // A second card, nothing can draw it.
    tg.calls.length = 0; shot = null;
    await writeState({ queue: [superCard('q-2', 'req-2')] });
    await afterWrite();
    await vi.waitFor(() => expect(withButton('Gönder').length).toBe(1));
    expect(tg.calls.some((c) => c.method === 'sendPhoto')).toBe(false);
    expect(tg.texts().find((t) => t.startsWith('❓'))).toContain("• <b>Bu taslak olur</b>: Çizimi Mac'te (Telegram'a çizilemedi).");
  });
});

describe('a drawing that did not go is never silent (owner 2026-11-10)', () => {
  const askLog = () => { const f = join(home, '.dreamcontext', 'logs', 'telegram-asks.log'); return existsSync(f) ? readFileSync(f, 'utf8') : ''; };
  // An option note as long as a real planner's (the message trims option notes at 300 characters).
  const LONG = `${'Çubukta, Super sohbetinde ve Telegram üzerinde komutun tamamı görünür; '.repeat(5)}sonu.`;
  const longCard = () => ({ ...CARD, questions: [{ ...CARD.questions[0], options: [{ label: 'Bu taslak olur', description: LONG, preview: '<div class="dc-card">Kart</div>' }, CARD.questions[0].options[1]] }, CARD.questions[1]] });

  it('a long option note still says its drawing is on the Mac, and the log says which picture did not go', async () => {
    windowDraws = false; shot = null;
    await writeState({ queue: [{ ...superCard(), ask: longCard() }] });
    await afterWrite();
    await vi.waitFor(() => expect(withButton('Gönder').length).toBe(1));
    expect(tg.calls.some((c) => c.method === 'sendPhoto')).toBe(false);
    const first = tg.texts().find((t) => t.startsWith('❓'))!;
    expect(first).toContain("• <b>Bu taslak olur</b>: Çizimi Mac'te (Telegram'a çizilemedi). Çubukta");
    await vi.waitFor(() => expect(askLog()).toMatch(/q-super pictures 0\/1 NOT ALL SENT \(Bu taslak olur: not drawn\)/));
    await vi.waitFor(() => expect(askLog()).toMatch(/q-super ask sent/));
  });

  it('a drawn picture is logged as sent, and its long note says it is above', async () => {
    await writeState({ queue: [{ ...superCard(), ask: longCard() }] });
    await afterWrite();
    await vi.waitFor(() => expect(withButton('Gönder').length).toBe(1));
    expect(tg.calls.some((c) => c.method === 'sendPhoto')).toBe(true);
    expect(tg.texts().find((t) => t.startsWith('❓'))).toContain('• <b>A · Bu taslak olur</b>: Çubukta');
    await vi.waitFor(() => expect(askLog()).toMatch(/q-super pictures 1\/1(?! NOT)/));
  });

  it('Telegram refuses the picture: the question still goes, its option and the log say so', async () => {
    tg.failing.set('sendPhoto', 400);
    await writeState({ queue: [superCard()] });
    await afterWrite();
    await vi.waitFor(() => expect(withButton('Gönder').length).toBe(1));
    expect(tg.texts().find((t) => t.startsWith('❓'))).toContain("• <b>Bu taslak olur</b>: Çizimi Mac'te (Telegram'a çizilemedi).");
    await vi.waitFor(() => expect(askLog()).toMatch(/q-super pictures 0\/1 NOT ALL SENT \(Bu taslak olur: Telegram refused the picture\)/));
  });
});

describe('answered elsewhere', () => {
  it('a card answered before it went is not sent', async () => {
    await writeState({ queue: [superAsk('ask-1', 'Hangi renk?', ['Mor', 'Yeşil'], 1)] });
    // The record says open to the announcer, but by the time the send runs it is closed.
    const s = await readSuperState(root);
    await writeState({ queue: [{ ...superAsk('ask-1', 'Hangi renk?', ['Mor', 'Yeşil'], 1), state: 'done' }] });
    announceOwnerHead(() => vault, s, superQueueHead(s));
    await quiet();
    expect(withButton('Yeşil')).toHaveLength(0);
  });

  it('a child\'s question never reaches Telegram, open or answered on the Mac (owner 2026-11-15: only the Super speaks there)', async () => {
    const child = childAsks();
    await writeState({ queue: [childItem()] });
    await afterWrite();
    await quiet();
    expect(tg.calls.filter((c) => c.method === 'sendMessage' || c.method === 'sendPhoto')).toHaveLength(0);
    child.answered('req-q', { [CARD.questions[0].question]: 'Bu taslak olur', [CARD.questions[1].question]: "Mac'te değilken" });
    await quiet();
    expect(tg.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0);
    expect(withButton('Gönder')).toHaveLength(0);
  });

  it('a child\'s question the Super put to him itself (queue ask) does reach Telegram, and says Cevaplandı when answered on the Mac', async () => {
    const child = childAsks();
    await writeState({ queue: [{ ...childItem(), superAsked: true }] });
    await afterWrite();
    await vi.waitFor(() => expect(withButton('Gönder').length).toBe(1));
    child.answered('req-q', { [CARD.questions[0].question]: 'Bu taslak olur', [CARD.questions[1].question]: "Mac'te değilken" });
    // One message holds the whole card (telegram-sade): one edit, one line with both answers.
    await vi.waitFor(() => expect(tg.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(1));
    const edits = tg.calls.filter((c) => c.method === 'editMessageText');
    expect(String(edits[0].params.text)).toContain("✓ Cevaplandı: Bu taslak olur · Mac'te değilken");
    for (const e of edits) expect(e.params.reply_markup).toBeUndefined();
  });

  it('a member Super\'s child question mirrored to main goes nowhere on Telegram (owner 2026-11-15)', async () => {
    childAsks();
    const mirror = { id: 'm-1', kind: 'member', of: 'question', member: 'conor', answers: 'q-inner', sessionId: CHILD, requestId: 'req-q', state: 'escalated', createdAt: 5, ownerText: OWNER_TEXT };
    await writeState({ queue: [mirror] });
    await afterWrite();
    await quiet();
    expect(tg.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
  });

  it('the Super\'s ask closed with no answer known: its message says the card closed, never Cevaplandı, buttons gone', async () => {
    await writeState({ queue: [superAsk('ask-1', 'Hangi renk?', ['Mor', 'Yeşil'], 1)] });
    await afterWrite();
    await vi.waitFor(() => expect(withButton('Yeşil')).toHaveLength(1));
    await settleOwnerReach('ask-1', 3000);
    await writeState({ queue: [{ ...superAsk('ask-1', 'Hangi renk?', ['Mor', 'Yeşil'], 1), state: 'done' }] });
    await afterWrite();
    await vi.waitFor(() => expect(tg.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(1));
    // Owner 2026-11-10: a card stamped "Cevaplandı" while the Super still waited on him.
    const text = String(tg.calls.find((c) => c.method === 'editMessageText')!.params.text);
    expect(text).toContain('<b>Bu kart kapandı</b>');
    // One line once closed (telegram-sade): the question is gone, its subject stays after the dot.
    expect(text).not.toContain('\n');
    expect(text.replace(/<[^>]+>/g, '').length).toBeLessThanOrEqual(60);
    expect(text).not.toContain('Cevaplandı');
  });
});

/**
 * Owner 2026-11-11 (one question reached him three times): his card closes only when he taps an
 * option or answers that card; any other message of his is a message. What the server reads as
 * "written about the card" is `ownerAbouts(text, aboutHeads(text))` on the injected turn.
 */
describe('only a tap or a reply to the card answers it', () => {
  let injected: string[];
  beforeEach(() => {
    injected = [];
    reg.registerChat({ sessionId: SID, conversationId: null, vault, mode: 'super' });
    reg.registerChatInjector(SID, { sessionId: SID, chatRegistryId: SID, sendOwnerText: async (t) => { injected.push(t); return { ok: true }; }, interrupt: () => {} });
  });
  const answers = (t: string) => { const { body } = parseTelegramPrefix(t); return ownerAbouts(body, aboutHeads(body)).filter((a) => a.kind === 'item').map((a) => a.id); };
  async function cardSent() {
    await writeState({ queue: [superAsk('ask-1', 'Hangi renk?', ['Mor', 'Yeşil'], 1)] });
    await afterWrite();
    await vi.waitFor(() => expect(withButton('Yeşil')).toHaveLength(1));
    return withButton('Yeşil')[0];
  }

  it('an unrelated message while the card is open names no card: it reaches the Super as a message', async () => {
    await cardSent();
    tg.push(TOKEN, textUpdate(OWNER, 'Bu arada raporu da at.'));
    await vi.waitFor(() => expect(injected).toHaveLength(1));
    expect(parseTelegramPrefix(injected[0]).body).toContain('Bu arada raporu da at.');
    expect(answers(injected[0])).toEqual([]);
  });

  it('a reply to the card with free text: the card is named first, his words follow as the answer', async () => {
    const card = await cardSent();
    tg.push(TOKEN, textUpdate(OWNER, 'İkisi de olmaz, lacivert yap.', { reply_to_message: { message_id: card.result!.message_id } }));
    await vi.waitFor(() => expect(injected).toHaveLength(1));
    const { body } = parseTelegramPrefix(injected[0]);
    expect(body.startsWith('[About agenda line item=ask-1 section=waiting]\n\n')).toBe(true);
    expect(body).toContain('İkisi de olmaz, lacivert yap.');
    expect(answers(injected[0])).toEqual(['ask-1']);
  });

  it('a reply to some other bot message names no card', async () => {
    await cardSent();
    const other = await hub.send(hub.superBindingOfVault(vault)!, 'Rapor hazır.');
    tg.push(TOKEN, textUpdate(OWNER, 'Teşekkürler', { reply_to_message: { message_id: Number(other?.message_id) } }));
    await vi.waitFor(() => expect(injected).toHaveLength(1));
    expect(answers(injected[0])).toEqual([]);
  });

  it('a tap answers the card with its pick', async () => {
    const card = await cardSent();
    const kb = (card.params.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat();
    tg.push(TOKEN, { callback_query: { id: 'cb1', data: kb[1].callback_data, from: { id: OWNER }, message: { message_id: card.result!.message_id, chat: { id: OWNER, type: 'private' }, text: String(card.params.text).replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&') } } });
    await vi.waitFor(() => expect(injected).toHaveLength(1));
    expect(parseTelegramPrefix(injected[0]).body).toContain('"Hangi renk?"="Yeşil"');
    expect(answers(injected[0])).toEqual(['ask-1']);
  });
});

describe('away, a Mac banner is not him seeing it (owner 2026-11-16)', () => {
  it('Telegram refused the card and the Mac posted a banner: reached:false, the refusal named', async () => {
    setOwnerQuestionSinks({ banner: () => true });
    tg.failOnce.set('sendMessage', 400);
    await writeState({ queue: [superAsk('ask-1', 'Hangi renk?', ['Mor', 'Yeşil'], 1)] });
    await afterWrite();
    await settleOwnerReach('ask-1', 3000);
    const reach = ownerQuestionReach(await readSuperState(root), 'ask-1');
    expect(reach).toMatchObject({ reached: false, telegram: 'failed' });
    expect(reach.via).not.toContain('banner');
    expect(reach.note).toMatch(/^NOT seen/);
    expect(reach.why).toMatch(/Telegram refused/);
  });

  it('it landed on Telegram: reached, the banner still listed', async () => {
    setOwnerQuestionSinks({ banner: () => true });
    await writeState({ queue: [superAsk('ask-1', 'Hangi renk?', ['Mor', 'Yeşil'], 1)] });
    await afterWrite();
    await settleOwnerReach('ask-1', 3000);
    const reach = ownerQuestionReach(await readSuperState(root), 'ask-1');
    expect(reach).toMatchObject({ reached: true, telegram: 'sent' });
    expect(reach.via).toEqual(expect.arrayContaining(['banner', 'telegram']));
  });
});

describe('a card buried under a later turn comes back to the bottom (owner 2026-11-16)', () => {
  let injected: string[];
  /** The Super's chat, with its Telegram injector (his words from Telegram start its turns). */
  function superChat() {
    injected = [];
    const h = reg.registerChat({ sessionId: SID, conversationId: null, vault, mode: 'super' });
    reg.registerChatInjector(SID, { sessionId: SID, chatRegistryId: SID, sendOwnerText: async (t) => { injected.push(t); return { ok: true }; }, interrupt: () => {} });
    return h;
  }
  /** He writes on Telegram; the Super's turn answers with `text`, then ends. */
  async function telegramTurn(h: ReturnType<typeof reg.registerChat>, said: string, text: string, before?: () => Promise<void>) {
    const n = injected.length;
    tg.push(TOKEN, textUpdate(OWNER, said));
    await vi.waitFor(() => expect(injected).toHaveLength(n + 1), { timeout: 5000 });
    h.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: `tu${n}`, name: 'Bash', input: { command: 'dreamcontext super state' } }] } });
    if (before) await before();
    h.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } });
    h.observe({ type: 'result', subtype: 'success', is_error: false, result: text });
    await vi.waitFor(() => expect(tg.texts().some((t) => t.includes(text))).toBe(true), { timeout: 3000 });
  }
  const live = () => withButton('Yeşil').filter((c) => c.result);

  it('a later turn wrote under it: the card is sent again below, the old copy is deleted', async () => {
    const h = superChat();
    await writeState({ queue: [superAsk('ask-1', 'Hangi renk?', ['Mor', 'Yeşil'], 1)] });
    await afterWrite();
    await vi.waitFor(() => expect(live()).toHaveLength(1));
    const first = live()[0].result!.message_id;
    await quiet();
    await telegramTurn(h, 'durum ne?', 'Şu an çalışan bir iş yok. Telefonunda bir soru kartı açık.');
    await vi.waitFor(() => expect(live()).toHaveLength(2), { timeout: 3000 });
    const again = live()[1].result!.message_id;
    // The new card is the newest message the bot posted.
    expect(again).toBeGreaterThan(Math.max(...tg.sent('sendMessage').filter((c) => c.result && c !== live()[1]).map((c) => c.result!.message_id)));
    // telegram-sade (Doc C3): the old copy goes, it is not kept whole with a line under it.
    await vi.waitFor(() => expect(tg.sent('deleteMessage').some((c) => c.params.message_id === first)).toBe(true));
    expect(tg.sent('editMessageText').some((c) => c.params.message_id === first)).toBe(false);
    const log = join(home, '.dreamcontext', 'logs', 'telegram-asks.log');
    expect(readFileSync(log, 'utf8')).toMatch(/ask-1 ask resent below/);
    // The new card answers: a tap on it is his answer.
    const card = live()[1];
    const kb = (card.params.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat();
    tg.push(TOKEN, { callback_query: { id: 'cb1', data: kb[1].callback_data, from: { id: OWNER }, message: { message_id: card.result!.message_id, chat: { id: OWNER, type: 'private' }, text: String(card.params.text).replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&') } } });
    await vi.waitFor(() => expect(injected.some((t) => t.includes('"Hangi renk?"="Yeşil"'))).toBe(true), { timeout: 3000 });
  });

  it('two cards open: a turn that wrote resends both once; a quiet turn after it resends nothing (review r1)', async () => {
    const h = superChat();
    await writeState({ queue: [superAsk('ask-1', 'Hangi renk?', ['Mor', 'Yeşil'], 1), superAsk('ask-2', 'Yayınlayalım mı?', ['Evet yayınla', 'Bekle'], 2)] });
    await afterWrite();
    await vi.waitFor(() => { expect(live()).toHaveLength(1); expect(withButton('Evet yayınla').filter((c) => c.result)).toHaveLength(1); });
    await quiet();
    await telegramTurn(h, 'durum ne?', 'İki soru açık.');
    await vi.waitFor(() => { expect(live()).toHaveLength(2); expect(withButton('Evet yayınla').filter((c) => c.result)).toHaveLength(2); }, { timeout: 3000 });
    // A turn that posts nothing on Telegram (a child's event the Super notes to itself).
    h.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tq', name: 'Bash', input: { command: 'dreamcontext super state' } }] } });
    h.observe({ type: 'result', subtype: 'success', is_error: false, result: '' });
    await quiet(); await quiet();
    expect(live()).toHaveLength(2);
    expect(withButton('Evet yayınla').filter((c) => c.result)).toHaveLength(2);
  });

  it('a tap on the old card while it is sent again keeps his answer on it (review r1)', async () => {
    const h = superChat();
    await writeState({ queue: [superAsk('ask-1', 'Hangi renk?', ['Mor', 'Yeşil'], 1)] });
    await afterWrite();
    await vi.waitFor(() => expect(live()).toHaveLength(1));
    const old = live()[0];
    await quiet();
    tg.slowSends.set('Hangi renk?', 400);
    await telegramTurn(h, 'durum ne?', 'Bir soru açık.');
    await vi.waitFor(() => expect(withButton('Yeşil').length).toBe(2), { timeout: 3000 });
    const kb = (old.params.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat();
    tg.push(TOKEN, { callback_query: { id: 'cbx', data: kb[1].callback_data, from: { id: OWNER }, message: { message_id: old.result!.message_id, chat: { id: OWNER, type: 'private' }, text: String(old.params.text).replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&') } } });
    await vi.waitFor(() => expect(injected.some((t) => t.includes('"Hangi renk?"="Yeşil"'))).toBe(true), { timeout: 3000 });
    await vi.waitFor(() => expect(live()).toHaveLength(2), { timeout: 3000 });
    await quiet();
    expect(tg.sent('editMessageText').some((c) => c.params.message_id === old.result!.message_id && String(c.params.text).includes('Aşağıda yeniden soruldu'))).toBe(false);
    expect(tg.sent('deleteMessage').some((c) => c.params.message_id === old.result!.message_id)).toBe(false);
  });

  it("owner 2026-11-22: a card with its --show stage card and two drawings, buried by two later turns: the stage card and the drawings reach the chat once", async () => {
    streams = true;
    const h = superChat();
    // A git project (the outbound classifier reads git's ignore rules); the stage card the ask shows.
    execFileSync('git', ['init', '-q'], { cwd: project });
    writeFileSync(join(project, 'sol-panel.png'), PNG);
    const containers = [{ id: 'c1', kind: 'image', ref: 'sol-panel.png', title: 'Sol panel maketi', place: 'stage', createdAt: 1 }];
    const ask = { title: 'Sol panel → hangi davranış', questions: [{ question: 'Sol panelde hangisi yapılsın?', header: 'Sol panel', multiSelect: false,
      options: [{ label: 'Tek açık proje', preview: '<div class="dc-card">A</div>' }, { label: 'Birden çok proje açık', preview: '<div class="dc-card">B</div>' }] },
      // A second question keeps every copy on the rich path (one question with bare labels is a simple card).
      { question: 'Chat de aynı mı olsun?', header: 'Chat', multiSelect: false, options: [{ label: 'Evet' }, { label: 'Hayır' }] }] };
    await writeState({ queue: [{ id: 'ask-sp', kind: 'ask', sessionId: SID, state: 'escalated', createdAt: 1, ownerText: 'Sol panelde hangisi yapılsın?', ask }], containers, askShows: [{ item: 'ask-sp', cards: ['c1'], opened: [], via: 'show' }] });
    await afterWrite();
    const media = () => tg.calls.filter((c) => c.method === 'sendPhoto' || c.method === 'sendDocument' || c.method === 'sendMediaGroup');
    const cards = () => withButton('Birden çok proje açık').filter((c) => c.result);
    await vi.waitFor(() => expect(cards()).toHaveLength(1), { timeout: 5000 });
    // First copy: the stage card and both drawings went (the owner must see them once).
    const first = media().length;
    expect(first).toBe(3);
    for (let n = 1; n <= 2; n++) {
      await quiet();
      await telegramTurn(h, `durum ${n}?`, `Durum ${n}: sınav sürüyor.`);
      await vi.waitFor(() => expect(cards()).toHaveLength(n + 1), { timeout: 3000 });
      await quiet();
    }
    // Two Super turns later: not one picture or document more.
    expect(media()).toHaveLength(first);
  });

  it('buried again and again, the card has ONE live copy: drawings and body go once, an earlier resend leaves the chat (owner 2026-11-19)', async () => {
    const h = superChat();
    // The owner's card: one question, two options, each with its drawing, and a long body.
    const ask = { title: 'İlk açılış → Ekran 2 (klasör aç)', questions: [{ question: 'Ekran 2 hangisi olsun?', header: 'Ekran 2', description: 'Uzun gövde: neden bu ekran, ne değişir.', multiSelect: false,
      options: [{ label: 'Klasör aç büyük', description: 'Bugünkü öneri.', preview: '<div class="dc-card">A</div>' }, { label: 'Son klasörler listesi', description: 'Daha az tık.', preview: '<div class="dc-card">B</div>' }] }] };
    await writeState({ queue: [{ id: 'ask-e2', kind: 'ask', sessionId: SID, state: 'escalated', createdAt: 1, ownerText: 'Ekran 2 hangisi olsun?', ask }] });
    await afterWrite();
    const pictures = () => tg.calls.filter((c) => c.method === 'sendPhoto' || c.method === 'sendDocument' || c.method === 'sendMediaGroup');
    const cards = () => withButton('Son klasörler listesi').filter((c) => c.result);
    await vi.waitFor(() => expect(cards()).toHaveLength(1), { timeout: 5000 });
    expect(pictures()).toHaveLength(2);
    const first = cards()[0].result!.message_id;
    for (let n = 1; n <= 3; n++) {
      await quiet();
      await telegramTurn(h, `durum ${n}?`, `Durum ${n}: bir soru kartı açık.`);
      await vi.waitFor(() => expect(cards()).toHaveLength(n + 1), { timeout: 3000 });
      await quiet();
    }
    // The drawings went once, with the first copy; the body (description, option notes) too.
    expect(pictures()).toHaveLength(2);
    const body = tg.sent('sendMessage').filter((c) => String(c.params.text).includes('Uzun gövde'));
    expect(body).toHaveLength(1);
    // Each copy sent again is short: the question and its buttons.
    const again = cards().slice(1);
    for (const c of again) {
      expect(String(c.params.text)).toContain('Ekran 2 hangisi olsun?');
      expect(String(c.params.text)).not.toContain('Bugünkü öneri');
    }
    // The first copy lost its buttons once and points down; every earlier resend left the chat.
    const firstEdits = tg.sent('editMessageText').filter((c) => c.params.message_id === first);
    expect(firstEdits).toHaveLength(1);
    expect(String(firstEdits[0].params.text)).toMatch(/aşağıda yeniden soruldu/i);
    expect(tg.sent('deleteMessage').map((c) => c.params.message_id)).toEqual(again.slice(0, -1).map((c) => c.result!.message_id));
    // One copy answers: the newest. A tap on it is his answer.
    const card = again[again.length - 1];
    const kb = (card.params.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat();
    tg.push(TOKEN, { callback_query: { id: 'cbe', data: kb[1].callback_data, from: { id: OWNER }, message: { message_id: card.result!.message_id, chat: { id: OWNER, type: 'private' }, text: String(card.params.text).replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&') } } });
    await vi.waitFor(() => expect(injected.some((t) => t.includes('"Ekran 2 hangisi olsun?"="Son klasörler listesi"'))).toBe(true), { timeout: 3000 });
  });

  it("a child's question the Super carried, buried twice: its drawing goes once, the resend is short, the earlier resend leaves", async () => {
    const h = superChat();
    childAsks();
    await writeState({ queue: [{ ...childItem(), superAsked: true }] });
    await afterWrite();
    const pictures = () => tg.calls.filter((c) => c.method === 'sendPhoto' || c.method === 'sendDocument' || c.method === 'sendMediaGroup');
    const cards = () => withButton('Gönder').filter((c) => c.result);
    await vi.waitFor(() => expect(cards()).toHaveLength(1), { timeout: 5000 });
    expect(pictures()).toHaveLength(1);
    for (let n = 1; n <= 2; n++) {
      await quiet();
      await telegramTurn(h, `durum ${n}?`, `Durum ${n}: çocuğun sorusu açık.`);
      await vi.waitFor(() => expect(cards()).toHaveLength(n + 1), { timeout: 3000 });
      await quiet();
    }
    expect(pictures()).toHaveLength(1);
    expect(tg.sent('sendMessage').filter((c) => String(c.params.text).includes('Taslak, son hali değil.'))).toHaveLength(1);
    // The first resend (both its question messages) left the chat; the newest stays.
    const deleted = tg.sent('deleteMessage').map((c) => c.params.message_id);
    expect(deleted).toContain(cards()[1].result!.message_id);
    expect(deleted).not.toContain(cards()[2].result!.message_id);
  });

  it('a resend Telegram will not delete becomes the one line, never a second live card', async () => {
    const h = superChat();
    await writeState({ queue: [superAsk('ask-1', 'Hangi renk?', ['Mor', 'Yeşil'], 1)] });
    await afterWrite();
    await vi.waitFor(() => expect(live()).toHaveLength(1));
    tg.failing.set('deleteMessage', 400);
    for (let n = 1; n <= 2; n++) {
      await quiet();
      await telegramTurn(h, `durum ${n}?`, `Durum ${n}.`);
      await vi.waitFor(() => expect(live()).toHaveLength(n + 1), { timeout: 3000 });
      await quiet();
    }
    const middle = live()[1].result!.message_id;
    const edit = tg.sent('editMessageText').find((c) => c.params.message_id === middle);
    expect(String(edit?.params.text).replace(/<[^>]+>/g, '')).toBe('↓ Aşağıda yeniden soruldu.');
    expect(edit?.params.reply_markup).toBeUndefined();
  });

  it('the turn that asked it is not a later turn: its own line under the card sends nothing again', async () => {
    const h = superChat();
    await writeState({});
    await telegramTurn(h, 'bir şey soracak mısın?', 'Telefonunda bir soru kartı bekliyor.', async () => {
      await writeState({ queue: [superAsk('ask-1', 'Hangi renk?', ['Mor', 'Yeşil'], 1)] });
      await afterWrite();
      await vi.waitFor(() => expect(live()).toHaveLength(1));
    });
    await quiet(); await quiet();
    expect(live()).toHaveLength(1);
    expect(tg.sent('editMessageText')).toHaveLength(0);
  });
});
describe('a server restart sends no open card again: its copy is kept on disk and taken back (owner 2026-11-19)', () => {
  /** The server process ends and starts again: every in-memory map is gone, the disk stays. */
  async function restart(): Promise<void> {
    for (const u of unwire) u();
    await hub.stop();
    _resetTelegramAsks(); _resetOwnerQuestions();
    // A new process has a new pid: the old one's token lock is stale, as after a real restart.
    rmSync(join(home, '.dreamcontext', 'telegram', 'locks'), { recursive: true, force: true });
    hub = new TelegramHub({ textGraceMs: 0, sadeTickMs: 0, home, fetchImpl: tg.fetch, pollTimeoutS: 0, sleep: async () => {}, vaults: () => [{ name: vault, contextRoot: root }], injectorWaitMs: 300, handsfree: { streamsTo: () => false, isOn: () => away } });
    unwire = [wireTelegramAsks(hub), wireTelegramW5(hub, { settleMs: 5, shoot: async () => shot })];
    await hub.start();
    await vi.waitFor(() => expect(hub.active.size).toBe(1), { timeout: 5000 });
    tg.calls.length = 0;
  }
  const kb = (c: { params: Record<string, unknown> }) => (c.params.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat();
  const plainOf = (html: unknown) => String(html).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

  it('an open card is not sent again: its buttons are bound again on the same message, and a tap on it answers', async () => {
    const injected: string[] = [];
    reg.registerChat({ sessionId: SID, conversationId: null, vault, mode: 'super' });
    reg.registerChatInjector(SID, { sessionId: SID, chatRegistryId: SID, sendOwnerText: async (t) => { injected.push(t); return { ok: true }; }, interrupt: () => {} });
    await writeState({ queue: [superAsk('ask-1', 'Hangi renk?', ['Mor', 'Yeşil'], 1)] });
    await afterWrite();
    await vi.waitFor(() => expect(withButton('Yeşil').filter((c) => c.result)).toHaveLength(1));
    const first = withButton('Yeşil')[0].result!.message_id;
    expect(existsSync(join(root, 'state', '.super', 'telegram-copies.json'))).toBe(true);
    await restart();
    await afterWrite();
    hub.flushAway();
    hub.flushAway();
    await vi.waitFor(() => expect(tg.sent('editMessageText').some((c) => c.params.message_id === first && c.params.reply_markup)).toBe(true), { timeout: 3000 });
    await quiet();
    expect(tg.texts().filter((t) => t.includes('Hangi renk?'))).toHaveLength(0);
    const edit = tg.sent('editMessageText').find((c) => c.params.message_id === first)!;
    tg.push(TOKEN, { callback_query: { id: 'cbr', data: kb(edit)[1].callback_data, from: { id: OWNER }, message: { message_id: first, chat: { id: OWNER, type: 'private' }, text: plainOf(edit.params.text), edit_date: 2 } } });
    await vi.waitFor(() => expect(injected.some((t) => t.includes('"Hangi renk?"="Yeşil"'))).toBe(true), { timeout: 3000 });
    expect(readFileSync(join(home, '.dreamcontext', 'logs', 'telegram-asks.log'), 'utf8')).toMatch(/ask-1 ask kept after a restart/);
  });

  it("the owner's card with drawings: after a restart neither its pictures nor its body go again", async () => {
    const ask = { title: 'İlk açılış → Ekran 2 (klasör aç)', questions: [{ question: 'Ekran 2 hangisi olsun?', description: 'Uzun gövde.', multiSelect: false,
      options: [{ label: 'Klasör aç büyük', preview: '<div class="dc-card">A</div>' }, { label: 'Son klasörler listesi', preview: '<div class="dc-card">B</div>' }] }] };
    await writeState({ queue: [{ id: 'ask-e2', kind: 'ask', sessionId: SID, state: 'escalated', createdAt: 1, ownerText: 'Ekran 2 hangisi olsun?', ask }] });
    await afterWrite();
    await vi.waitFor(() => expect(withButton('Gönder').filter((c) => c.result)).toHaveLength(1), { timeout: 5000 });
    const msg = withButton('Gönder')[0].result!.message_id;
    await restart();
    await afterWrite();
    hub.flushAway();
    await vi.waitFor(() => expect(tg.sent('editMessageText').some((c) => c.params.message_id === msg && JSON.stringify(c.params.reply_markup ?? {}).includes('Gönder'))).toBe(true), { timeout: 3000 });
    await quiet();
    expect(tg.calls.filter((c) => c.method === 'sendPhoto' || c.method === 'sendDocument' || c.method === 'sendMediaGroup')).toHaveLength(0);
    expect(tg.texts().filter((t) => t.includes('Ekran 2 hangisi olsun?'))).toHaveLength(0);
  });

  it('a passing failure (flood limit) while taking it back sends nothing; the next pass takes it back', async () => {
    await writeState({ queue: [superAsk('ask-1', 'Hangi renk?', ['Mor', 'Yeşil'], 1)] });
    await afterWrite();
    await vi.waitFor(() => expect(withButton('Yeşil').filter((c) => c.result)).toHaveLength(1));
    const first = withButton('Yeşil')[0].result!.message_id;
    await restart();
    tg.failing.set('editMessageText', 429);
    await afterWrite();
    hub.flushAway();
    await vi.waitFor(() => expect(readFileSync(join(home, '.dreamcontext', 'logs', 'telegram-asks.log'), 'utf8')).toMatch(/ask-1 ask kept copy not taken back yet/), { timeout: 3000 });
    await quiet();
    expect(tg.texts()).toHaveLength(0);
    expect(readFileSync(join(root, 'state', '.super', 'telegram-copies.json'), 'utf8')).toContain('"ask-1"');
    tg.failing.delete('editMessageText');
    hub.flushAway();
    await vi.waitFor(() => expect(tg.sent('editMessageText').some((c) => c.params.message_id === first && c.params.reply_markup && !tg.failing.has('editMessageText'))).toBe(true), { timeout: 3000 });
    await vi.waitFor(() => expect(readFileSync(join(home, '.dreamcontext', 'logs', 'telegram-asks.log'), 'utf8')).toMatch(/ask-1 ask kept after a restart/), { timeout: 3000 });
    expect(tg.texts().filter((t) => t.includes('Hangi renk?'))).toHaveLength(0);
  });

  it('a copy Telegram no longer has (he deleted it) is replaced: the card goes once as new', async () => {
    await writeState({ queue: [superAsk('ask-1', 'Hangi renk?', ['Mor', 'Yeşil'], 1)] });
    await afterWrite();
    await vi.waitFor(() => expect(withButton('Yeşil').filter((c) => c.result)).toHaveLength(1));
    await restart();
    tg.failing.set('editMessageText', 400);
    tg.failText.set('editMessageText', 'Bad Request: message to edit not found');
    await afterWrite();
    hub.flushAway();
    await vi.waitFor(() => expect(withButton('Yeşil').filter((c) => c.result)).toHaveLength(1), { timeout: 3000 });
    await quiet(); await quiet();
    expect(withButton('Yeşil').filter((c) => c.result)).toHaveLength(1);
    expect(readFileSync(join(home, '.dreamcontext', 'logs', 'telegram-asks.log'), 'utf8')).toMatch(/ask-1 ask kept copy is gone from the chat: sent as new/);
  });

  it("a child's permission still asked is taken back, never sent again", async () => {
    const child = reg.registerChat({ sessionId: CHILD, conversationId: null, vault, mode: 'basic' });
    await writeState({ queue: [{ id: 'perm-1', kind: 'permission', sessionId: CHILD, requestId: 'req-9', state: 'pending', createdAt: 1 }] });
    child.observe({ type: 'control_request', request_id: 'req-9', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm publish' } } });
    await vi.waitFor(() => expect(withButton('İzin ver (bir kez)').filter((c) => c.result)).toHaveLength(1), { timeout: 3000 });
    const first = withButton('İzin ver (bir kez)')[0].result!.message_id;
    await restart();
    hub.flushAway();
    await vi.waitFor(() => expect(tg.sent('editMessageText').some((c) => c.params.message_id === first && JSON.stringify(c.params.reply_markup ?? {}).includes('İzin ver'))).toBe(true), { timeout: 3000 });
    await quiet();
    expect(tg.texts()).toHaveLength(0);
    expect(tg.sent('editMessageText').some((c) => String(c.params.text).includes('Bu kart kapandı'))).toBe(false);
  });

  it('a card answered while the server was down says it closed, loses its buttons, and nothing is sent', async () => {
    await writeState({ queue: [superAsk('ask-1', 'Hangi renk?', ['Mor', 'Yeşil'], 1)] });
    await afterWrite();
    await vi.waitFor(() => expect(withButton('Yeşil').filter((c) => c.result)).toHaveLength(1));
    const first = withButton('Yeşil')[0].result!.message_id;
    await restart();
    await writeState({ queue: [] });
    hub.flushAway();
    await vi.waitFor(() => expect(tg.sent('editMessageText').some((c) => c.params.message_id === first && String(c.params.text).includes('Bu kart kapandı'))).toBe(true), { timeout: 3000 });
    expect(tg.sent('editMessageText').find((c) => c.params.message_id === first)?.params.reply_markup).toBeUndefined();
    expect(tg.texts()).toHaveLength(0);
    await vi.waitFor(() => expect(existsSync(join(root, 'state', '.super', 'telegram-copies.json'))).toBe(false));
  });
});
