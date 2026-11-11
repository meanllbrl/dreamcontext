/**
 * Lane B of sahip-karti-yerinde, Telegram (K7, D3, K4):
 *  - a CHILD's owner card arrives as one message: the job, the card's line, the kind's sentence,
 *    "Mac'e dönünce hatırlat" and "Gerek yok", never Run;
 *  - Remind marks the item and the next owner-at-Mac raises ONE notification naming it;
 *  - Not needed closes the item; a reused button and an unbound chat do nothing;
 *  - the Run callback for a child's card is refused on the server;
 *  - the W1 class finding: a checklist card in a Telegram-bound Super chat is a plain Mac line,
 *    never "Şifre gerekiyor" and never a phone link.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { FakeTelegram, textUpdate } from '../helpers/fake-telegram.js';
import { TelegramHub } from '../../src/server/telegram/hub.js';
import { wireTelegramAsks, _resetTelegramAsks } from '../../src/server/telegram/asks.js';
import { RUN_LINES, wireRunCards } from '../../src/server/telegram/runs.js';
import * as reg from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState, OWNER_CARD_TELEGRAM_LINE } from '../../src/lib/super/types.js';
import { announceOwnerHead, _resetOwnerQuestions } from '../../src/lib/super/owner-question.js';
import { scopeOfContextRoot } from '../../src/lib/telegram/config.js';
import { OWNER_CARD_NOT_NEEDED_LABEL, OWNER_CARD_REMIND_LABEL, OWNER_CARD_REMIND_TITLE } from '../../src/lib/telegram/contract.js';
import { resetWindowControl } from '../../src/lib/window-control.js';
import { noteOwnerAtMac, setOwnerCardRemindBanner } from '../../src/lib/telegram/back-at-mac.js';
import { _resetCardsForTests, cardHandleOf, listCards, noteAssistantCards, setCardsHomeForTests } from '../../src/lib/cards/records.js';
import { _resetRunsForTests, configureRuns, type RunPty } from '../../src/server/runs/registry.js';
import { runDelivery, setHeldHomeForTests } from '../../src/server/runs/delivery.js';
import { setCardRootResolverForTests } from '../../src/server/routes/run-terminal.js';
import { _resetOwnerReceiptsForTests, registerOwnerCardLookup, registerOwnerItemCloser, setOwnerReceiptsHomeForTests, type OwnerCardLookup } from '../../src/server/owner-receipts.js';

const TOKEN = '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OWNER = 777;
const SID = '11111111-2222-4333-8444-555555555555';
const CHILD = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const fence = (o: Record<string, unknown>) => `\`\`\`dream-view\n${JSON.stringify(o)}\n\`\`\``;
const RUN = { type: 'run', id: 'login', command: 'gcloud auth login', why: 'Giriş için' };
const CHECK = { type: 'checklist', id: 'store', title: 'Store setup', items: [{ id: 'pw', text: 'Paste the password', wants: 'secret' }] };

let vault = 'acme'; let home: string; let project: string; let root: string; let tg: FakeTelegram; let hub: TelegramHub;
let unwireAsks: () => void; let unwireRuns: () => void;
let ptys: number; let closer: string[]; let banners: Array<{ title: string; body: string; link: string | null }>;
let injected: string[];
const drained = () => new Promise((r) => setTimeout(r, 40));

class FakePty implements RunPty {
  pid = 1; onData() {} onExit() {} write() {} resize() {} kill() {}
}

function msgWith(label: string) {
  return [...tg.sent()].reverse().find((c) => JSON.stringify(c.params.reply_markup ?? {}).includes(label));
}
function tap(msg: NonNullable<ReturnType<typeof msgWith>>, idx: number, chatId = OWNER) {
  const kb = (msg.params.reply_markup as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard.flat();
  tg.push(TOKEN, { callback_query: { id: `cb${Math.random()}`, data: kb[idx].callback_data, from: { id: OWNER }, message: { message_id: msg.result!.message_id, chat: { id: chatId, type: 'private' }, text: msg.result!.text } } });
}

function childItem(): { item: Record<string, unknown>; lookup: OwnerCardLookup } {
  const text = fence(RUN);
  const card = cardHandleOf({ postingSession: CHILD, vault, postingConversationId: CHILD, messageUuid: 'c1', text, kind: 'run', id: 'login', childRecordId: 'main', childId: CHILD })!;
  const item = { id: 'owner-1', kind: 'owner', sessionId: CHILD, state: 'escalated', createdAt: 1, ownerText: RUN.why, wait: { kind: 'run', id: 'login', line: RUN.why, key: RUN.command }, card };
  const lookup: OwnerCardLookup = { handle: card, target: { childRecordId: 'main', childId: CHILD }, itemId: 'owner-1', itemOpen: true, superSession: SID };
  return { item, lookup };
}

async function writeState(extra: Record<string, unknown>): Promise<void> {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SID, enabled: true, children: { [CHILD]: { sessionId: CHILD, brief: 'Deploy the API', adopted: false, startedAt: 1 } }, ...extra }));
  resetSuperIndex();
  await readSuperState(root);
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'owner-card-tg-home-'));
  project = mkdtempSync(join(tmpdir(), 'owner-card-tg-proj-'));
  root = join(project, '_dream_context');
  vault = basename(project);
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: vault, path: project }] }));
  reg._resetChatRegistry(); resetWindowControl(); _resetTelegramAsks(); _resetOwnerQuestions(); _resetCardsForTests(); _resetRunsForTests(); _resetOwnerReceiptsForTests();
  setCardsHomeForTests(home); setHeldHomeForTests(home); setOwnerReceiptsHomeForTests(home);
  ptys = 0; closer = []; banners = []; injected = [];
  configureRuns({ spawner: () => { ptys++; return new FakePty(); }, projectRootOf: () => project, resolveCwd: (r) => r, delivery: runDelivery, trackChild: () => () => {} });
  setOwnerCardRemindBanner((title, body, link) => { banners.push({ title, body, link }); return true; });
  await writeState({});
  tg = new FakeTelegram(); tg.addBot(TOKEN, 'acme_super_bot');
  hub = new TelegramHub({ home, fetchImpl: tg.fetch, pollTimeoutS: 0, sleep: async () => {}, vaults: () => [{ name: vault, contextRoot: root }], injectorWaitMs: 300, handsfree: { streamsTo: () => false, isOn: () => true } });
  unwireAsks = wireTelegramAsks(hub);
  unwireRuns = wireRunCards(hub, { phoneOrigin: () => 'https://abc.trycloudflare.com', streams: () => false });
  await hub.start();
  const start = await hub.beginPairing({ scope: scopeOfContextRoot(root), target: 'super', token: TOKEN, projectName: vault, contextRoot: root });
  await drained();
  tg.push(TOKEN, textUpdate(OWNER, `/start ${new URL(start.deepLink).searchParams.get('start')}`));
  await vi.waitFor(() => expect(hub.pairingPreview(start.pairingId)).not.toBeNull(), { timeout: 5000 });
  await hub.confirmPairing(start.pairingId, { botId: 123456, userId: OWNER });
  await drained();
  reg.registerChat({ sessionId: SID, conversationId: null, vault, mode: 'super' });
  reg.registerChatInjector(SID, { sessionId: SID, chatRegistryId: SID, sendOwnerText: async (t) => { injected.push(t); return { ok: true }; }, interrupt: () => {} });
});
afterEach(async () => {
  unwireAsks(); unwireRuns(); await hub.stop();
  setOwnerCardRemindBanner(null); _resetOwnerReceiptsForTests(); _resetRunsForTests();
  setCardsHomeForTests(null); setHeldHomeForTests(null);
  rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true });
});

async function sendChildCard(): Promise<{ lookup: OwnerCardLookup }> {
  const { item, lookup } = childItem();
  registerOwnerCardLookup((s, ref) => (s === CHILD && ref === lookup.handle.cardRef ? lookup : null));
  registerOwnerItemCloser(async (l) => { closer.push(l.itemId); return true; });
  await writeState({ queue: [item] });
  announceOwnerHead(() => vault, await readSuperState(root), item as never);
  await vi.waitFor(() => expect(msgWith(OWNER_CARD_REMIND_LABEL)).toBeTruthy());
  return { lookup };
}

describe('a child\'s owner card on Telegram', () => {
  it('one message: the job, the command, the kind sentence, Remind and Not needed; never Run', async () => {
    await sendChildCard();
    const m = msgWith(OWNER_CARD_REMIND_LABEL)!;
    const html = String(m.params.text);
    expect(html).toContain('Deploy the API');
    expect(html).toContain(`<pre>${RUN.command}</pre>`);
    expect(html).toContain(OWNER_CARD_TELEGRAM_LINE.run);
    const labels = JSON.stringify(m.params.reply_markup);
    expect(labels).toContain(OWNER_CARD_REMIND_LABEL);
    expect(labels).toContain(OWNER_CARD_NOT_NEEDED_LABEL);
    expect(labels).not.toContain('Çalıştır');
    expect(labels).not.toContain('"url"');
  });

  it('Gerek yok closes the item through the server; the reused button does nothing', async () => {
    await sendChildCard();
    const m = msgWith(OWNER_CARD_NOT_NEEDED_LABEL)!;
    tap(m, 1);
    await vi.waitFor(() => expect(closer).toEqual(['owner-1']));
    tap(m, 1);
    await drained(); await drained();
    expect(closer).toEqual(['owner-1']);
  });

  it('a button tapped from an unbound chat does nothing', async () => {
    await sendChildCard();
    tap(msgWith(OWNER_CARD_NOT_NEEDED_LABEL)!, 1, 999);
    await drained(); await drained();
    expect(closer).toEqual([]);
  });

  it('Remind marks the item; the next owner-at-Mac raises ONE notification naming the card, then none', async () => {
    await sendChildCard();
    tap(msgWith(OWNER_CARD_REMIND_LABEL)!, 0);
    await vi.waitFor(async () => {
      const s = await readSuperState(root);
      expect(s.queue.find((q) => q.id === 'owner-1')?.remindAt).toBeGreaterThan(0);
    });
    noteOwnerAtMac();
    await vi.waitFor(() => expect(banners).toHaveLength(1));
    expect(banners[0].title).toBe(OWNER_CARD_REMIND_TITLE);
    expect(banners[0].body).toContain(RUN.command);
    noteOwnerAtMac();
    await drained(); await drained();
    expect(banners).toHaveLength(1);
  });

  it('the Run callback for a child\'s card is refused on the server, whatever button record names it', async () => {
    const { lookup } = await sendChildCard();
    noteAssistantCards(CHILD, vault, 'c1', fence(RUN));
    const ab = hub.superBindingOfVault(vault)!;
    await hub.sendButtons(ab, `<pre>${RUN.command}</pre>`, [['Çalıştır'], ['Çalıştır, çıktıyı ajana verme'], ['İptal']],
      { kind: 'run', sessionId: CHILD, cardRef: lookup.handle.cardRef, singleUse: true },
      { cmdHash: createHash('sha256').update(RUN.command).digest('hex'), cardId: 'login' });
    tap(msgWith('Çalıştır, çıktıyı')!, 0);
    const answered = () => [...tg.sent('answerCallbackQuery'), ...tg.sent('editMessageText')].some((c) => String(c.params.text ?? '').includes(RUN_LINES.notHere));
    await vi.waitFor(() => expect(answered()).toBe(true));
    expect(ptys).toBe(0);
  });
});

describe('the Super\'s own run card names the folder the Mac draws', () => {
  it('Klasör is the card root\'s name, then · <cwd> when the card has one ', async () => {
    tg.push(TOKEN, textUpdate(OWNER, 'giriş?'));
    await vi.waitFor(() => expect(injected).toHaveLength(1), { timeout: 5000 });
    noteAssistantCards(SID, vault, 'm7', fence({ type: 'run', id: 'own', command: 'gh auth status', cwd: 'apps/web' }));
    noteAssistantCards(SID, vault, 'm8', fence({ type: 'run', id: 'bare', command: 'gh auth login' }));
    await vi.waitFor(() => expect(tg.texts().filter((t) => t.includes('Klasör:'))).toHaveLength(2));
    const texts = tg.texts().filter((t) => t.includes('Klasör:'));
    expect(texts.some((t) => t.includes(`Klasör: <code>${basename(project)} · apps/web</code>`))).toBe(true);
    expect(texts.some((t) => t.includes(`Klasör: <code>${basename(project)}</code>`))).toBe(true);
  });
});

describe('the folder the message drew is the folder that runs (end review r2)', () => {
  it('a Run press after the card\'s folder moved refuses and runs nothing; the matching folder runs', async () => {
    tg.push(TOKEN, textUpdate(OWNER, 'çalıştır?'));
    await vi.waitFor(() => expect(injected).toHaveLength(1), { timeout: 5000 });
    noteAssistantCards(SID, vault, 'm5', fence({ type: 'run', id: 'mv', command: 'gh auth status' }));
    await vi.waitFor(() => expect(msgWith('Çalıştır, çıktıyı')).toBeTruthy());
    const first = msgWith('Çalıştır, çıktıyı')!;
    const moved = realpathSync(mkdtempSync(join(tmpdir(), 'owner-card-tg-moved-')));
    setCardRootResolverForTests(async () => moved);
    try {
      tap(first, 0);
      const said = (line: string) => [...tg.sent('answerCallbackQuery'), ...tg.sent('editMessageText')].some((c) => String(c.params.text ?? '').includes(line));
      await vi.waitFor(() => expect(said(RUN_LINES.folderChanged)).toBe(true));
      expect(ptys).toBe(0);
    } finally {
      setCardRootResolverForTests(null);
      rmSync(moved, { recursive: true, force: true });
    }
    noteAssistantCards(SID, vault, 'm6', fence({ type: 'run', id: 'ok', command: 'gh auth login' }));
    await vi.waitFor(() => expect(tg.texts().filter((t) => t.includes('gh auth login')).length).toBeGreaterThan(0));
    const second = [...tg.sent()].reverse().find((c) => String(c.params.text).includes('gh auth login') && JSON.stringify(c.params.reply_markup ?? {}).includes('Çalıştır'))!;
    tap(second, 0);
    await vi.waitFor(() => expect(ptys).toBe(1));
  });
});

describe('a Run button from before the folder was kept', () => {
  it('answers that the button is from an older version and runs nothing (never "folder changed")', async () => {
    tg.push(TOKEN, textUpdate(OWNER, 'eski?'));
    await vi.waitFor(() => expect(injected).toHaveLength(1), { timeout: 5000 });
    noteAssistantCards(SID, vault, 'm4', fence({ type: 'run', id: 'old', command: 'gh auth status' }));
    await vi.waitFor(() => expect(msgWith('Çalıştır, çıktıyı')).toBeTruthy());
    const ref = listCards(SID).find((c) => c.id === 'old')!.cardRef;
    const ab = hub.superBindingOfVault(vault)!;
    await hub.sendButtons(ab, '<pre>gh auth status</pre>\neski', [['Çalıştır'], ['Çalıştır, çıktıyı ajana verme'], ['İptal']],
      { kind: 'run', sessionId: SID, cardRef: ref, singleUse: true },
      { cmdHash: createHash('sha256').update('gh auth status').digest('hex'), cardId: 'old' });
    const old = [...tg.sent()].reverse().find((c) => String(c.params.text).includes('eski'))!;
    tap(old, 0);
    const said = (line: string) => [...tg.sent('answerCallbackQuery'), ...tg.sent('editMessageText')].some((c) => String(c.params.text ?? '').includes(line));
    await vi.waitFor(() => expect(said(RUN_LINES.oldButton)).toBe(true));
    expect(said(RUN_LINES.folderChanged)).toBe(false);
    expect(ptys).toBe(0);
  });
});

describe('the W1 class finding: every card kind by name', () => {
  it('a checklist card in a Telegram-bound Super chat is a plain Mac line: no secret line, no phone link', async () => {
    tg.push(TOKEN, textUpdate(OWNER, 'kurulum?'));
    await vi.waitFor(() => expect(injected).toHaveLength(1), { timeout: 5000 });
    noteAssistantCards(SID, vault, 'm9', fence(CHECK));
    expect(listCards(SID)[0].kind).toBe('checklist');
    await vi.waitFor(() => expect(tg.texts().some((t) => t.includes('📋 Store setup'))).toBe(true));
    const msg = [...tg.sent()].reverse().find((c) => String(c.params.text).includes('Store setup'))!;
    expect(String(msg.params.text)).toContain("Mac'te yapılır.");
    expect(msg.params.reply_markup).toBeUndefined();
    expect(tg.texts().some((t) => t.includes('Şifre gerekiyor'))).toBe(false);
  });
});
