/**
 * An automation's approval card through the real hub and a fake Telegram (owner 2026-11-15): the
 * Super's answer that carries the `automation` block lands on Telegram as the whole card with
 * Onayla / Reddet; a tap from any account but the paired owner's decides nothing; the owner's tap
 * approves exactly what the app's Onayla approves. Fictional project: Northwind Bakery.
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
import { _resetOwnerQuestions } from '../../src/lib/super/owner-question.js';
import { scopeOfContextRoot } from '../../src/lib/telegram/config.js';
import { parseTelegramPrefix } from '../../src/lib/telegram/contract.js';
import { resetWindowControl } from '../../src/lib/window-control.js';
import { createAutomation, getAutomation } from '../../src/lib/automations/store.js';
import { checkApproval, getApproval } from '../../src/lib/automations/registry.js';
import { AUTO_LINES } from '../../src/server/telegram/automation-approvals.js';

const TOKEN = '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OWNER = 777;
const STRANGER = 999;
const SID = '11111111-2222-4333-8444-555555555555';
const SLUG = 'new-orders-check';
const SCRIPT = 'test -s orders/new.csv';

let vault: string; let home: string; let project: string; let root: string; let tg: FakeTelegram; let hub: TelegramHub;
let unwire: Array<() => void>; let realHome: string | undefined;
const drained = (ms = 40) => new Promise((r) => setTimeout(r, ms));

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
const plain = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const card = () => [...tg.sent()].reverse().find((c) => JSON.stringify(c.params.reply_markup ?? {}).includes(AUTO_LINES.reject));
function tap(from: number, idx: number, chatId = from) {
  const msg = card()!;
  const kb = (msg.params.reply_markup as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard.flat().filter((b) => b.callback_data);
  tg.push(TOKEN, { callback_query: { id: `cb${Math.random()}`, data: kb[idx].callback_data, from: { id: from }, message: { message_id: msg.result!.message_id, chat: { id: chatId, type: 'private' }, text: plain(String(msg.params.text)) } } });
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tg-auto-home-'));
  realHome = process.env.HOME;
  // The approval registry lives under the home the server reads (`os.homedir()`).
  process.env.HOME = home;
  project = mkdtempSync(join(tmpdir(), 'tg-auto-proj-'));
  root = join(project, '_dream_context');
  vault = basename(project);
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: vault, path: project }] }));
  reg._resetChatRegistry(); resetWindowControl(); _resetTelegramAsks(); _resetOwnerQuestions();
  tg = new FakeTelegram(); tg.addBot(TOKEN, 'northwind_super_bot');
  hub = new TelegramHub({ textGraceMs: 0, sadeTickMs: 0, home, fetchImpl: tg.fetch, pollTimeoutS: 0, sleep: async () => {}, vaults: () => [{ name: vault, contextRoot: root }], injectorWaitMs: 300, openLink: () => {}, handsfree: { streamsTo: () => false, isOn: () => true } });
  unwire = [wireTelegramAsks(hub), wireTelegramW5(hub, { settleMs: 5, commands: { windowWaitMs: 200, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))) } })];
  await hub.start();
  const start = await hub.beginPairing({ scope: scopeOfContextRoot(root), target: 'super', token: TOKEN, projectName: vault, contextRoot: root });
  await drained();
  tg.push(TOKEN, textUpdate(OWNER, `/start ${new URL(start.deepLink).searchParams.get('start')}`));
  await vi.waitFor(() => expect(hub.pairingPreview(start.pairingId)).not.toBeNull(), { timeout: 5000 });
  await hub.confirmPairing(start.pairingId, { botId: 123456, userId: OWNER });
  await drained();
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SID, enabled: true }));
  resetSuperIndex();
  await readSuperState(root);
  createAutomation(root, { slug: SLUG, title: 'New orders', days: 'daily', at: '09:00', prompt: 'Summarise the new orders for the bakery.', condition: SCRIPT });
});
afterEach(async () => {
  for (const u of unwire) u();
  await hub.stop();
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true });
});

async function cardOnTelegram(): Promise<void> {
  const { h, sent } = chat();
  tg.push(TOKEN, textUpdate(OWNER, 'yeni siparişleri her sabah kontrol et'));
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  const { ref } = parseTelegramPrefix(sent[0]);
  assistant(h, `<!-- re:${ref} -->\nKurdum, onayın gerekiyor:\n\`\`\`dream-view\n{"type":"automation","slug":"${SLUG}"}\n\`\`\``);
  await vi.waitFor(() => expect(card()).toBeTruthy());
}

describe('automation approval on Telegram', () => {
  it('the Super\'s automation block arrives as the whole card with the script and Onayla / Reddet', async () => {
    await cardOnTelegram();
    const text = String(card()!.params.text);
    expect(text).toContain('New orders');
    expect(text).toContain(`<pre>${SCRIPT}</pre>`);
    expect(JSON.stringify(card()!.params.reply_markup)).toContain(AUTO_LINES.approve);
    expect(tg.texts().some((t) => t.includes('Onay bekliyor'))).toBe(false);
  });

  it('a tap from another account, or from the owner in another chat, decides nothing', async () => {
    await cardOnTelegram();
    tap(STRANGER, 0);
    tap(OWNER, 0, STRANGER);
    await drained(150);
    expect(getApproval(project, SLUG)).toBeNull();
    expect(checkApproval(project, getAutomation(root, SLUG)!).approved).toBe(false);
  });

  it("the owner's Onayla approves it, the script witnessed; the card says so", async () => {
    await cardOnTelegram();
    tap(OWNER, 0);
    await vi.waitFor(() => expect(checkApproval(project, getAutomation(root, SLUG)!).approved).toBe(true));
    expect(getApproval(project, SLUG)?.conditionWitnessed).toBeTruthy();
    await vi.waitFor(() => expect(tg.calls.some((c) => c.method === 'editMessageText' && String(c.params.text).includes(AUTO_LINES.approved))).toBe(true));
  });
});
