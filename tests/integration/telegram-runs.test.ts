/**
 * Run and secret cards over Telegram (plan G2, G3, H3, H5, H6, I3, J1):
 *  - a run card posted during a Telegram turn arrives with its exact command and three buttons;
 *  - a tap runs the RECORD's command once, output is edited in place, a reply goes to stdin only
 *    through the fail-closed rule, Ctrl-C works, and the report goes back as a `run-report` turn;
 *  - a changed card, a hidden character, a secret card (URL button, never a field).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { FakeTelegram, textUpdate } from '../helpers/fake-telegram.js';
import { TelegramHub } from '../../src/server/telegram/hub.js';
import { commandShowable, wireRunCards, RUN_LINES } from '../../src/server/telegram/runs.js';
import * as reg from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { scopeOfContextRoot } from '../../src/lib/telegram/config.js';
import { parseTelegramPrefix } from '../../src/lib/telegram/contract.js';
import { resetWindowControl } from '../../src/lib/window-control.js';
import { _resetCardsForTests, getCard, listCards, noteAssistantCards, setCardsHomeForTests } from '../../src/lib/cards/records.js';
import { _resetRunsForTests, configureRuns, runOfSession, setEchoReaderForTests, type RunPty } from '../../src/server/runs/registry.js';
import { runDelivery, setHeldHomeForTests } from '../../src/server/runs/delivery.js';

const TOKEN = '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OWNER = 777;
const SID = '11111111-2222-4333-8444-555555555555';
let vault = 'acme'; let home: string; let project: string; let root: string; let tg: FakeTelegram; let hub: TelegramHub; let unwire: () => void;
let ptys: FakePty[]; let injected: Array<{ text: string; source: string }>; let origin: string | null;
const drained = () => new Promise((r) => setTimeout(r, 40));
const card = (id: string, command: string) => `\`\`\`dream-view\n${JSON.stringify({ type: 'run', id, command, why: 'Giriş için' })}\n\`\`\``;

class FakePty implements RunPty {
  pid = 1; ptsName = '/dev/ttys900'; written: string[] = [];
  private d: Array<(s: string) => void> = []; private x: Array<(e: { exitCode: number }) => void> = [];
  onData(cb: (s: string) => void) { this.d.push(cb); }
  onExit(cb: (e: { exitCode: number }) => void) { this.x.push(cb); }
  write(s: string) { this.written.push(s); }
  resize() {}
  kill() { this.end(130); }
  emit(s: string) { for (const f of this.d) f(s); }
  end(code: number) { for (const f of this.x) f({ exitCode: code }); }
}

function buttonMsg(label: string) {
  return [...tg.sent()].reverse().find((c) => JSON.stringify(c.params.reply_markup ?? {}).includes(label))!;
}
function tap(msg: ReturnType<typeof buttonMsg>, idx: number) {
  const kb = (msg.params.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat();
  tg.push(TOKEN, { callback_query: { id: `cb${Math.random()}`, data: kb[idx].callback_data, from: { id: OWNER }, message: { message_id: msg.result!.message_id, chat: { id: OWNER, type: 'private' }, text: msg.result!.text } } });
}
async function telegramTurn(): Promise<void> {
  tg.push(TOKEN, textUpdate(OWNER, 'giriş yap'));
  await vi.waitFor(() => expect(injected).toHaveLength(1));
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tg-runs-home-'));
  project = mkdtempSync(join(tmpdir(), 'tg-runs-proj-'));
  root = join(project, '_dream_context');
  vault = basename(project);
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: vault, path: project }] }));
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SID, enabled: true }));
  resetSuperIndex(); await readSuperState(root);
  reg._resetChatRegistry(); resetWindowControl(); _resetCardsForTests(); _resetRunsForTests();
  setCardsHomeForTests(home); setHeldHomeForTests(home);
  ptys = []; injected = []; origin = 'https://abc.trycloudflare.com';
  configureRuns({
    spawner: () => { const p = new FakePty(); ptys.push(p); return p; },
    projectRootOf: () => project, resolveCwd: (r) => r, delivery: runDelivery, trackChild: () => () => {},
  });
  tg = new FakeTelegram(); tg.addBot(TOKEN, 'acme_super_bot');
  hub = new TelegramHub({ home, fetchImpl: tg.fetch, pollTimeoutS: 0, sleep: async () => {}, vaults: () => [{ name: vault, contextRoot: root }], injectorWaitMs: 300 });
  unwire = wireRunCards(hub, { phoneOrigin: () => origin, streams: () => false });
  await hub.start();
  const start = await hub.beginPairing({ scope: scopeOfContextRoot(root), target: 'super', token: TOKEN, projectName: vault, contextRoot: root });
  await drained();
  tg.push(TOKEN, textUpdate(OWNER, `/start ${new URL(start.deepLink).searchParams.get('start')}`));
  await vi.waitFor(() => expect(hub.pairingPreview(start.pairingId)).not.toBeNull(), { timeout: 5000 });
  await hub.confirmPairing(start.pairingId, { botId: 123456, userId: OWNER });
  await drained();
  reg.registerChat({ sessionId: SID, conversationId: null, vault, mode: 'super' });
  reg.registerChatInjector(SID, {
    sessionId: SID, chatRegistryId: SID,
    sendOwnerText: async (t, meta) => { injected.push({ text: t, source: meta.source }); return { ok: true }; },
    interrupt: () => {},
  });
});
afterEach(async () => {
  unwire(); await hub.stop(); _resetRunsForTests(); setEchoReaderForTests(null);
  setCardsHomeForTests(null); setHeldHomeForTests(null);
  rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true });
});

describe('a run card from Telegram', () => {
  it('shows the exact command; Çalıştır runs it once; output is edited; a reply reaches stdin; the report returns as run-report', async () => {
    await telegramTurn();
    noteAssistantCards(SID, vault, 'm1', card('gh', 'gh auth status'));
    await vi.waitFor(() => expect(buttonMsg('Çalıştır')).toBeTruthy());
    const msg = buttonMsg('Çalıştır');
    expect(String(msg.params.text)).toContain('<pre>gh auth status</pre>');
    expect(String(msg.params.text)).toContain('Ajanın notu: Giriş için');
    tap(msg, 0);
    await vi.waitFor(() => expect(ptys).toHaveLength(1));
    // A second tap on the same (single-use) message is refused; nothing runs twice.
    tap(msg, 0);
    await drained();
    expect(ptys).toHaveLength(1);

    const out = tg.sent().find((c) => String(c.params.text).includes('Çalışıyor'))!;
    ptys[0].emit('Devam? (y/n) ');
    await vi.waitFor(() => expect(tg.sent('editMessageText').some((c) => c.params.message_id === out.result!.message_id && String(c.params.text).includes('Devam?'))).toBe(true), { timeout: 4000 });
    setEchoReaderForTests(async () => true);
    tg.push(TOKEN, textUpdate(OWNER, 'y', { reply_to_message: { message_id: out.result!.message_id } }));
    await vi.waitFor(() => expect(ptys[0].written).toEqual(['y\r']));
    // The reply went to stdin, not to the Super.
    expect(injected).toHaveLength(1);

    ptys[0].emit('\r\nLogged in\r\n');
    ptys[0].end(0);
    await vi.waitFor(() => expect(injected).toHaveLength(2));
    expect(injected[1].source).toBe('run-report');
    const { body } = parseTelegramPrefix(injected[1].text);
    expect(body).toMatch(/^\[ran in chat\]\n\$ gh auth status\nexit 0/);
    expect(listCards(SID)[0].state).toBe('closed');
  }, 15000);

  it('a reply with ECHO off is refused with the phone link, never written', async () => {
    await telegramTurn();
    noteAssistantCards(SID, vault, 'm1', card('su', 'sudo -k; sudo true'));
    await vi.waitFor(() => expect(buttonMsg('Çalıştır')).toBeTruthy());
    tap(buttonMsg('Çalıştır'), 0);
    await vi.waitFor(() => expect(ptys).toHaveLength(1));
    const out = tg.sent().find((c) => String(c.params.text).includes('Çalışıyor'))!;
    setEchoReaderForTests(async () => false);
    tg.push(TOKEN, textUpdate(OWNER, 'hunter2', { reply_to_message: { message_id: out.result!.message_id } }));
    await vi.waitFor(() => expect(tg.texts().some((t) => t.includes('Bu yanıtı komuta yazamam'))).toBe(true));
    const link = buttonMsg('Telefonda gir');
    const url = (link.params.reply_markup as { inline_keyboard: { url: string }[][] }).inline_keyboard[0][0].url;
    expect(url.startsWith('https://abc.trycloudflare.com/?vault=')).toBe(true);
    expect(new URL(url).searchParams.has('t')).toBe(false);
    expect(ptys[0].written).toEqual([]);
  });

  it('Ctrl-C interrupts; İptal starts nothing; withheld output never reaches Telegram', async () => {
    await telegramTurn();
    noteAssistantCards(SID, vault, 'm1', card('tok', 'gh auth token'));
    await vi.waitFor(() => expect(buttonMsg('Çalıştır')).toBeTruthy());
    tap(buttonMsg('Çalıştır'), 1);
    await vi.waitFor(() => expect(ptys).toHaveLength(1));
    ptys[0].emit('gho_SECRETVALUE\r\n');
    await new Promise((r) => setTimeout(r, 2300));
    expect(JSON.stringify(tg.calls)).not.toContain('gho_SECRETVALUE');
    tap(buttonMsg('Ctrl-C'), 0);
    await vi.waitFor(() => expect(ptys[0].written).toContain('\x03'));
    ptys[0].end(130);
    await vi.waitFor(() => expect(injected).toHaveLength(2));
    expect(injected[1].text).not.toContain('gho_SECRETVALUE');
  }, 10000);

  it('İptal runs nothing and leaves the card open', async () => {
    await telegramTurn();
    noteAssistantCards(SID, vault, 'm1', card('x', 'ls'));
    await vi.waitFor(() => expect(buttonMsg('İptal')).toBeTruthy());
    tap(buttonMsg('İptal'), 2);
    await drained(); await drained();
    expect(ptys).toHaveLength(0);
    expect(listCards(SID)[0].state).toBe('open');
  });

  it('a card re-posted with a new command: the old button says Kart değişti and the new card is sent', async () => {
    await telegramTurn();
    noteAssistantCards(SID, vault, 'm1', card('dep', 'npm run a'));
    await vi.waitFor(() => expect(buttonMsg('Çalıştır')).toBeTruthy());
    const old = buttonMsg('Çalıştır');
    noteAssistantCards(SID, vault, 'm2', card('dep', 'npm run b'));
    await vi.waitFor(() => expect(tg.texts().filter((t) => t.includes('npm run b'))).toHaveLength(1));
    tap(old, 0);
    await drained(); await drained();
    expect(ptys).toHaveLength(0);
    expect(tg.calls.some((c) => c.method === 'answerCallbackQuery' && String(c.params.text) === RUN_LINES.changed)).toBe(true);
  });

  it('a command with a hidden character gets no Çalıştır button, only the phone link', async () => {
    await telegramTurn();
    noteAssistantCards(SID, vault, 'm1', card('bidi', 'echo safe‮; rm -rf x'));
    await vi.waitFor(() => expect(buttonMsg('Telefonda çalıştır')).toBeTruthy());
    expect(tg.sent().some((c) => JSON.stringify(c.params.reply_markup ?? {}).includes('"Çalıştır"'))).toBe(false);
    expect(commandShowable('ls        -la')).toBe(false);
    expect(commandShowable('gh auth status')).toBe(true);
  });

  it('a card outside any Telegram turn is not sent', async () => {
    noteAssistantCards(SID, vault, 'm1', card('mac', 'ls'));
    await drained(); await drained();
    expect(tg.texts().some((t) => t.includes('Komut'))).toBe(false);
  });
});

describe('a secret card from Telegram', () => {
  const secret = '```dream-view\n{"type":"secret","id":"k","title":"Stripe key","file":".env.local","fields":[{"key":"STRIPE_KEY"}]}\n```';

  it('arrives as a Şifreyi gir URL button to the phone page; a plain text after it is a normal turn plus a reminder', async () => {
    await telegramTurn();
    noteAssistantCards(SID, vault, 'm1', secret);
    await vi.waitFor(() => expect(buttonMsg('Şifreyi gir')).toBeTruthy());
    const b = buttonMsg('Şifreyi gir');
    expect(String(b.params.text)).toContain('Stripe key → .env.local');
    const url = (b.params.reply_markup as { inline_keyboard: { url: string }[][] }).inline_keyboard[0][0].url;
    expect(new URL(url).searchParams.get('open')).toContain(`/session/${SID}`);
    tg.push(TOKEN, textUpdate(OWNER, 'sk_live_123'));
    await vi.waitFor(() => expect(tg.texts().some((t) => t.includes(RUN_LINES.secretHere))).toBe(true));
    await vi.waitFor(() => expect(injected).toHaveLength(2));
    // A Telegram text never closes the card.
    expect(listCards(SID)[0].state).toBe('open');
    expect(getCard(SID, listCards(SID)[0].cardRef)?.kind).toBe('secret');
  });

  it('with the phone link off, says how to open it', async () => {
    origin = null;
    await telegramTurn();
    noteAssistantCards(SID, vault, 'm1', secret);
    await vi.waitFor(() => expect(tg.texts().some((t) => t.includes('Telefon linki kapalı'))).toBe(true));
    expect(runOfSession(SID)).toBeNull();
  });
});
