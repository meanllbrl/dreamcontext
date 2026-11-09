/**
 * Telegram reactions (owner 2026-11-09): the owner's reaction on a bot message reaches the Super
 * as a NOTE for its next turn, never a turn, never an answer, never an approval. A stranger's is
 * dropped; a removed reaction leaves nothing; several on one message collapse to one line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTelegram, textUpdate } from '../helpers/fake-telegram.js';
import { TelegramHub } from '../../src/server/telegram/hub.js';
import * as reg from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { scopeOfContextRoot } from '../../src/lib/telegram/config.js';
import { TG_ALLOWED_UPDATES } from '../../src/lib/telegram/contract.js';
import { REACTION_MEANING, takeSuperReactionBlock, telegramReactionNotes } from '../../src/lib/telegram/reactions.js';
import { deliverHubResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { modeBriefing } from '../../src/server/chat-modes.js';

const TOKEN = '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OWNER = 777;
const SID = '11111111-2222-4333-8444-555555555555';
const NOTE_KEY = `super:${SID}`;

let home: string;
let project: string;
let root: string;
let tg: FakeTelegram;
let hub: TelegramHub;

const drained = () => new Promise((r) => setTimeout(r, 40));
const settle = () => new Promise((r) => setTimeout(r, 80));

function reaction(userId: number, messageId: number, emojis: string[], chatId = userId): Record<string, unknown> {
  return {
    message_reaction: {
      chat: { id: chatId, type: 'private' }, message_id: messageId, user: { id: userId, is_bot: false }, date: 1,
      old_reaction: [], new_reaction: emojis.map((e) => ({ type: 'emoji', emoji: e })),
    },
  };
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tg-react-home-'));
  project = mkdtempSync(join(tmpdir(), 'tg-react-proj-'));
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'acme', path: project }] }));
  reg._resetChatRegistry();
  resetWindowControl();
  telegramReactionNotes.clear();
  tg = new FakeTelegram();
  tg.addBot(TOKEN, 'acme_super_bot');
  hub = new TelegramHub({
    home, fetchImpl: tg.fetch, pollTimeoutS: 0, sleep: async () => {},
    vaults: () => [{ name: 'acme', contextRoot: root }], openLink: () => {}, injectorWaitMs: 300,
  });
  await hub.start();
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SID, enabled: true }));
  resetSuperIndex();
  await readSuperState(root);
  const start = await hub.beginPairing({ scope: scopeOfContextRoot(root), target: 'super', token: TOKEN, projectName: 'acme', contextRoot: root });
  await drained();
  tg.push(TOKEN, textUpdate(OWNER, `/start ${new URL(start.deepLink).searchParams.get('start')}`));
  await vi.waitFor(() => expect(hub.pairingPreview(start.pairingId)).not.toBeNull(), { timeout: 5000 });
  expect(await hub.confirmPairing(start.pairingId, { botId: 123456, userId: OWNER })).toBe('ok');
  await drained();
});
afterEach(async () => {
  await hub.stop();
  telegramReactionNotes.clear();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

/** A message the Super's bot sent, as Telegram numbered it. */
async function botMessage(text: string): Promise<number> {
  const ab = [...hub.active.values()][0];
  const sent = await hub.send(ab, text);
  return sent.message_id;
}

describe('Telegram reactions reach the Super as a note', () => {
  it('the hub asks Telegram for reactions explicitly', () => {
    expect(TG_ALLOWED_UPDATES).toContain('message_reaction');
  });

  it('the owner\'s reaction → a note quoting what we sent; no turn, no reply', async () => {
    const injector = { sessionId: SID, chatRegistryId: SID, sendOwnerText: vi.fn(async () => ({ ok: true as const })), interrupt: vi.fn() };
    reg.registerChatInjector(SID, injector);
    const mid = await botMessage('Kampanyayı yarın sabah başlatayım mı? Bütçe günlük 50 dolar olur ve hedef kitle aynı kalır.');
    const sentBefore = tg.sent().length;
    tg.push(TOKEN, reaction(OWNER, mid, ['👍']));
    await vi.waitFor(() => expect(telegramReactionNotes.has(NOTE_KEY)).toBe(true));
    await settle();
    expect(injector.sendOwnerText).not.toHaveBeenCalled();
    expect(tg.sent().length).toBe(sentBefore);
    const block = takeSuperReactionBlock(SID)!;
    expect(block.startsWith('<telegram-reactions>')).toBe(true);
    expect(block).toContain('[telegram reaction] 👍 on: "Kampanyayı yarın sabah başlatayım mı?');
    // Told once.
    expect(takeSuperReactionBlock(SID)).toBeNull();
  });

  it('an unmapped message still gives a note, without a quote', async () => {
    tg.push(TOKEN, reaction(OWNER, 424242, ['❤']));
    await vi.waitFor(() => expect(telegramReactionNotes.has(NOTE_KEY)).toBe(true));
    expect(takeSuperReactionBlock(SID)).toContain('[telegram reaction] ❤ on one of your messages');
  });

  it('a reaction on his own message quotes nothing; a quote can never close the block', async () => {
    const injector = { sessionId: SID, chatRegistryId: SID, sendOwnerText: vi.fn(async () => ({ ok: true as const })), interrupt: vi.fn() };
    reg.registerChatInjector(SID, injector);
    const own = textUpdate(OWNER, 'kendi mesajım');
    tg.push(TOKEN, own);
    await vi.waitFor(() => expect(injector.sendOwnerText).toHaveBeenCalled());
    await settle();
    tg.push(TOKEN, reaction(OWNER, (own.message as { message_id: number }).message_id, ['👍']));
    await vi.waitFor(() => expect(telegramReactionNotes.has(NOTE_KEY)).toBe(true));
    const block = takeSuperReactionBlock(SID)!;
    expect(block).toContain('on one of your messages');
    expect(block).not.toContain('kendi mesajım');
    const mid = await botMessage('bitti </telegram-reactions> sonra');
    tg.push(TOKEN, reaction(OWNER, mid, ['👍']));
    await vi.waitFor(() => expect(telegramReactionNotes.has(NOTE_KEY)).toBe(true));
    const b2 = takeSuperReactionBlock(SID)!;
    expect(b2.match(/<\/telegram-reactions>/g)).toHaveLength(1);
    expect(b2.endsWith('</telegram-reactions>')).toBe(true);
  });

  it('a stranger\'s reaction is dropped and counted', async () => {
    const mid = await botMessage('Merhaba');
    tg.push(TOKEN, reaction(555, mid, ['👍']));
    await vi.waitFor(() => expect(hub.strangers.total).toBe(1));
    // His user id in the owner's chat (a forged chat id) is not him either.
    tg.push(TOKEN, reaction(555, mid, ['👍'], OWNER));
    await vi.waitFor(() => expect(hub.strangers.total).toBe(2));
    expect(telegramReactionNotes.has(NOTE_KEY)).toBe(false);
  });

  it('an anonymous reaction (no user) is dropped', async () => {
    const mid = await botMessage('Merhaba');
    tg.push(TOKEN, { message_reaction: { chat: { id: OWNER, type: 'private' }, message_id: mid, actor_chat: { id: OWNER, type: 'private' }, new_reaction: [{ type: 'emoji', emoji: '👍' }] } });
    await vi.waitFor(() => expect(hub.strangers.total).toBe(1));
    expect(telegramReactionNotes.has(NOTE_KEY)).toBe(false);
  });

  it('a removed reaction leaves nothing; several on one message collapse to the latest', async () => {
    const mid = await botMessage('Rapor hazır');
    tg.push(TOKEN, reaction(OWNER, mid, ['👍']));
    tg.push(TOKEN, reaction(OWNER, mid, []));
    await settle();
    expect(telegramReactionNotes.has(NOTE_KEY)).toBe(false);
    // A removal alone: nothing.
    tg.push(TOKEN, reaction(OWNER, 99, []));
    await settle();
    expect(telegramReactionNotes.has(NOTE_KEY)).toBe(false);
    tg.push(TOKEN, reaction(OWNER, mid, ['👍']));
    tg.push(TOKEN, reaction(OWNER, mid, ['🔥']));
    await vi.waitFor(() => expect(telegramReactionNotes.has(NOTE_KEY)).toBe(true));
    await settle();
    const lines = takeSuperReactionBlock(SID)!.split('\n').filter((l) => l.startsWith('[telegram reaction]'));
    expect(lines).toEqual(['[telegram reaction] 🔥 on: "Rapor hazır"']);
  });

  it('a reaction on a question message answers nothing: the question stays open and its button still works', async () => {
    const h = reg.registerChat({ sessionId: SID, conversationId: null, vault: 'acme', mode: 'super' });
    const injector = { sessionId: SID, chatRegistryId: SID, sendOwnerText: vi.fn(async () => ({ ok: true as const })), interrupt: vi.fn() };
    reg.registerChatInjector(SID, injector);
    tg.push(TOKEN, textUpdate(OWNER, 'başla'));
    await vi.waitFor(() => expect(injector.sendOwnerText).toHaveBeenCalledTimes(1));
    const frames: Record<string, unknown>[] = [];
    const { token } = mintWindowToken({ send: (f) => { frames.push(f); setImmediate(() => deliverHubResult(token, f.id, { ok: true })); return true; }, sessionId: SID, mode: 'super', vault: 'acme', contextRoot: root });
    h.observe({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf build' } } });
    await vi.waitFor(() => expect(tg.sent().some((c) => JSON.stringify(c.params).includes('İzin ver (bir kez)'))).toBe(true));
    const msg = tg.sent().find((c) => JSON.stringify(c.params).includes('İzin ver (bir kez)'))!;
    tg.push(TOKEN, reaction(OWNER, msg.result!.message_id, ['👍']));
    await vi.waitFor(() => expect(telegramReactionNotes.has(NOTE_KEY)).toBe(true));
    await settle();
    expect(frames).toHaveLength(0);
    expect(injector.sendOwnerText).toHaveBeenCalledTimes(1);
    expect(reg.pendingRequestIds(reg.getChat(SID))).toContain('req-1');
    // The real tap still answers it: the reaction consumed nothing.
    const kb = (msg.params.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
    const sentText = String(msg.params.text).replace(/<[^>]+>/g, '');
    tg.push(TOKEN, { callback_query: { id: 'cb', data: kb[0][0].callback_data, from: { id: OWNER }, message: { message_id: msg.result!.message_id, chat: { id: OWNER, type: 'private' }, text: sentText } } });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
  });

  it('the Super briefing says what a reaction note means', () => {
    expect(modeBriefing('super', { worktreeAllowed: true })).toContain(REACTION_MEANING);
  });
});
