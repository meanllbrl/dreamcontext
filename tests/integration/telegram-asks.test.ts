/**
 * The Super's questions on its Telegram bot (plan A4, "Answering", P3, M6):
 *  - a `super ask` at the queue head arrives as buttons; a tap writes `[super answer] …` as an
 *    owner turn under a Telegram ref (the same text the window builds);
 *  - a child's permission arrives as İzin ver (bir kez) / Reddet; a tap goes through the window's
 *    `super allow` verb with `by: 'owner'` and closes the queue item; a second tap is refused.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { FakeTelegram, textUpdate } from '../helpers/fake-telegram.js';
import { TelegramHub } from '../../src/server/telegram/hub.js';
import { wireTelegramAsks, _resetTelegramAsks } from '../../src/server/telegram/asks.js';
import * as reg from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { announceOwnerHead, ownerQuestionReach, _resetOwnerQuestions } from '../../src/lib/super/owner-question.js';
import { scopeOfContextRoot } from '../../src/lib/telegram/config.js';
import { parseTelegramPrefix } from '../../src/lib/telegram/contract.js';
import { deliverSuperResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

const TOKEN = '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OWNER = 777;
const SID = '11111111-2222-4333-8444-555555555555';
const CHILD = '66666666-7777-4888-8999-aaaaaaaaaaaa';
let vault = 'acme'; let home: string; let project: string; let root: string; let tg: FakeTelegram; let hub: TelegramHub; let unwire: () => void;
/** A hands-free run on (owner 2026-11-09: questions go out only while he is away). */
let handsfreeOn = true;
const drained = () => new Promise((r) => setTimeout(r, 40));

async function writeState(extra: Record<string, unknown>): Promise<void> {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SID, enabled: true, ...extra }));
  resetSuperIndex();
  await readSuperState(root);
}
function buttonMsg(label: string) {
  return tg.sent().find((c) => JSON.stringify(c.params.reply_markup ?? {}).includes(label))!;
}
function tap(msg: ReturnType<typeof buttonMsg>, idx: number) {
  const kb = (msg.params.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat();
  tg.push(TOKEN, { callback_query: { id: `cb${idx}`, data: kb[idx].callback_data, from: { id: OWNER }, message: { message_id: msg.result!.message_id, chat: { id: OWNER, type: 'private' }, text: String(msg.params.text).replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&') } } });
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tg-asks-home-'));
  project = mkdtempSync(join(tmpdir(), 'tg-asks-proj-'));
  root = join(project, '_dream_context');
  // The registry names a project by its folder when the real vault list does not know it.
  vault = basename(project);
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: vault, path: project }] }));
  reg._resetChatRegistry(); resetWindowControl(); _resetTelegramAsks(); _resetOwnerQuestions();
  tg = new FakeTelegram(); tg.addBot(TOKEN, 'acme_super_bot');
  handsfreeOn = true;
  hub = new TelegramHub({ home, fetchImpl: tg.fetch, pollTimeoutS: 0, sleep: async () => {}, vaults: () => [{ name: vault, contextRoot: root }], injectorWaitMs: 300, handsfree: { streamsTo: () => false, isOn: () => handsfreeOn } });
  unwire = wireTelegramAsks(hub);
  await hub.start();
  const start = await hub.beginPairing({ scope: scopeOfContextRoot(root), target: 'super', token: TOKEN, projectName: vault, contextRoot: root });
  await drained();
  tg.push(TOKEN, textUpdate(OWNER, `/start ${new URL(start.deepLink).searchParams.get('start')}`));
  await vi.waitFor(() => expect(hub.pairingPreview(start.pairingId)).not.toBeNull(), { timeout: 5000 });
  await hub.confirmPairing(start.pairingId, { botId: 123456, userId: OWNER });
  await drained();
});
afterEach(async () => {
  unwire(); await hub.stop();
  rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true });
});

describe('the Super\'s own ask', () => {
  it('arrives as buttons; a tap writes the window\'s [super answer] text as an owner turn', async () => {
    const item = { id: 'ask-1', kind: 'ask', sessionId: SID, state: 'escalated', createdAt: 1, ownerText: 'Hangi renk?', ask: { questions: [{ question: 'Hangi renk?', options: [{ label: 'Mor' }, { label: 'Yeşil' }] }] } };
    await writeState({ queue: [item] });
    const sent: string[] = [];
    reg.registerChat({ sessionId: SID, conversationId: null, vault, mode: 'super' });
    reg.registerChatInjector(SID, { sessionId: SID, chatRegistryId: SID, sendOwnerText: async (t) => { sent.push(t); return { ok: true }; }, interrupt: () => {} });
    announceOwnerHead(() => vault, await readSuperState(root), item as never);
    await vi.waitFor(() => expect(buttonMsg('Yeşil')).toBeTruthy());
    tap(buttonMsg('Yeşil'), 1);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const { ref, body } = parseTelegramPrefix(sent[0]);
    expect(ref).toMatch(/^[0-9a-z]{6}$/);
    expect(body).toBe('[super answer] item=ask-1\nUser has answered your questions: "Hangi renk?"="Yeşil". You can now continue with the user\'s answers in mind.');
  });
});

describe('a Telegram turn that only asked (owner report 2026-11-09)', () => {
  it('the card reaching Telegram is the turn speaking: no "göndermeden bitti" line after it', async () => {
    const item = { id: 'ask-2', kind: 'ask', sessionId: SID, state: 'escalated', createdAt: 1, ownerText: 'Ne zaman?', ask: { questions: [{ question: 'Ne zaman?', options: [{ label: 'Uzaktayken' }, { label: 'Her zaman' }] }] } };
    await writeState({});
    const sent: string[] = [];
    const h = reg.registerChat({ sessionId: SID, conversationId: null, vault, mode: 'super' });
    reg.registerChatInjector(SID, { sessionId: SID, chatRegistryId: SID, sendOwnerText: async (t) => { sent.push(t); return { ok: true }; }, interrupt: () => {} });
    tg.push(TOKEN, textUpdate(OWNER, 'normal mi?'));
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5000 });
    h.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'dreamcontext super ask' } }] } });
    await writeState({ queue: [item] });
    announceOwnerHead(() => vault, await readSuperState(root), item as never);
    await vi.waitFor(() => expect(buttonMsg('Uzaktayken')).toBeTruthy());
    h.observe({ type: 'result', subtype: 'success', is_error: false, result: '' });
    await new Promise((r) => setTimeout(r, 150));
    expect(tg.texts().some((t) => t.startsWith('Bu tur sana yazı göndermeden bitti'))).toBe(false);
  });

  it('an ask card whose send fails is not the turn speaking: the silent line still comes', async () => {
    const item = { id: 'ask-3', kind: 'ask', sessionId: SID, state: 'escalated', createdAt: 1, ownerText: 'Ne düşünüyorsun?', ask: { questions: [{ question: 'Ne düşünüyorsun?', options: [] }] } };
    await writeState({});
    const sent: string[] = [];
    const h = reg.registerChat({ sessionId: SID, conversationId: null, vault, mode: 'super' });
    reg.registerChatInjector(SID, { sessionId: SID, chatRegistryId: SID, sendOwnerText: async (t) => { sent.push(t); return { ok: true }; }, interrupt: () => {} });
    tg.push(TOKEN, textUpdate(OWNER, 'ne dersin?'));
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5000 });
    h.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'dreamcontext super ask' } }] } });
    await writeState({ queue: [item] });
    tg.failOnce.set('sendMessage', 400);
    announceOwnerHead(() => vault, await readSuperState(root), item as never);
    h.observe({ type: 'result', subtype: 'success', is_error: false, result: '' });
    await vi.waitFor(() => expect(tg.delivered.some((t) => t.startsWith('Bu tur sana yazı göndermeden bitti'))).toBe(true), { timeout: 3000 });
    expect(tg.delivered.some((t) => t.includes('Ne düşünüyorsun?'))).toBe(false);
  });
});

describe('a child\'s permission (A4)', () => {
  it('İzin ver (bir kez) goes through the window\'s super allow, by the owner; the item closes', async () => {
    await writeState({
      children: { [CHILD]: { sessionId: CHILD, brief: 'deploy', adopted: false, startedAt: 1 } },
      queue: [{ id: 'perm-1', kind: 'permission', sessionId: CHILD, requestId: 'req-9', state: 'pending', createdAt: 1 }],
    });
    const frames: Record<string, unknown>[] = [];
    const { token } = mintWindowToken({ send: (f) => { if (f.subtype !== 'super_command') return true; frames.push(f); setImmediate(() => deliverSuperResult(token, f.id, { ok: true, result: {} })); return true; }, sessionId: SID, mode: 'super', vault, contextRoot: root });
    const child = reg.registerChat({ sessionId: CHILD, conversationId: null, vault, mode: 'basic' });
    child.observe({ type: 'control_request', request_id: 'req-9', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm publish' } } });
    await vi.waitFor(() => expect(buttonMsg('İzin ver (bir kez)')).toBeTruthy());
    const msg = buttonMsg('İzin ver (bir kez)');
    expect(String(msg.params.text)).toContain('deploy');
    tap(msg, 0);
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]).toMatchObject({ subtype: 'super_command', verb: 'allow', args: { child: CHILD, requestId: 'req-9', behavior: 'allow', by: 'owner' } });
    await vi.waitFor(async () => expect((await readSuperState(root)).queue[0].state).toBe('done'));
    tap(msg, 1);
    await vi.waitFor(() => expect(tg.sent('answerCallbackQuery').at(-1)?.params.text).toBe('Bu soru artık geçerli değil.'));
    expect(frames).toHaveLength(1);
  });
});

describe('only while the owner is away (owner 2026-11-09, "Yalnız uzaktayken")', () => {
  const ask = (id: string, q: string, labels: string[], createdAt: number) => ({ id, kind: 'ask', sessionId: SID, state: 'escalated', createdAt, ownerText: q, ask: { questions: [{ question: q, options: labels.map((label) => ({ label })) }] } });
  const count = (label: string) => tg.sent().filter((c) => JSON.stringify(c.params.reply_markup ?? {}).includes(label)).length;
  const quiet = () => new Promise((r) => setTimeout(r, 80));

  it('at the Mac a Super question is not sent and is not recorded as reaching Telegram', async () => {
    handsfreeOn = false;
    const item = ask('ask-1', 'Hangi renk?', ['Mor', 'Yeşil'], 1);
    await writeState({ queue: [item] });
    const state = await readSuperState(root);
    announceOwnerHead(() => vault, state, item as never);
    await quiet();
    expect(count('Yeşil')).toBe(0);
    expect(ownerQuestionReach(state, 'ask-1').via).not.toContain('telegram');
  });

  it('away: sent, and recorded as reaching Telegram', async () => {
    const item = ask('ask-1', 'Hangi renk?', ['Mor', 'Yeşil'], 1);
    await writeState({ queue: [item] });
    const state = await readSuperState(root);
    announceOwnerHead(() => vault, state, item as never);
    await vi.waitFor(() => expect(count('Yeşil')).toBe(1));
    expect(ownerQuestionReach(state, 'ask-1').via).toContain('telegram');
  });

  it('turning away from Telegram with two questions open sends both, once each; a later message re-sends nothing', async () => {
    handsfreeOn = false;
    const a = ask('ask-1', 'Hangi renk?', ['Mor', 'Yeşil'], 1);
    const b = ask('ask-2', 'Yayınlayalım mı?', ['Evet yayınla', 'Bekle'], 2);
    await writeState({ queue: [a, b] });
    announceOwnerHead(() => vault, await readSuperState(root), a as never);
    reg.registerChat({ sessionId: SID, conversationId: null, vault, mode: 'super' });
    const sent: string[] = [];
    reg.registerChatInjector(SID, { sessionId: SID, chatRegistryId: SID, sendOwnerText: async (t) => { sent.push(t); return { ok: true }; }, interrupt: () => {} });
    await quiet();
    expect(count('Yeşil') + count('Evet yayınla')).toBe(0);
    tg.push(TOKEN, textUpdate(OWNER, 'yoldayım'));
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5000 });
    await vi.waitFor(() => { expect(count('Yeşil')).toBe(1); expect(count('Evet yayınla')).toBe(1); });
    tg.push(TOKEN, textUpdate(OWNER, 'durum?'));
    await vi.waitFor(() => expect(sent).toHaveLength(2), { timeout: 5000 });
    await quiet();
    expect(count('Yeşil')).toBe(1);
    expect(count('Evet yayınla')).toBe(1);
  });

  it('a child\'s permission: nothing at the Mac; a hands-free start sends it once; buttons still answer after', async () => {
    handsfreeOn = false;
    await writeState({
      children: { [CHILD]: { sessionId: CHILD, brief: 'deploy', adopted: false, startedAt: 1 } },
      queue: [{ id: 'perm-1', kind: 'permission', sessionId: CHILD, requestId: 'req-9', state: 'pending', createdAt: 1 }],
    });
    const child = reg.registerChat({ sessionId: CHILD, conversationId: null, vault, mode: 'basic' });
    child.observe({ type: 'control_request', request_id: 'req-9', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm publish' } } });
    await quiet();
    expect(count('İzin ver (bir kez)')).toBe(0);
    handsfreeOn = true; // a run started (by hand): the adapter's `started` event calls flushAway
    hub.flushAway();
    await vi.waitFor(() => expect(count('İzin ver (bir kez)')).toBe(1));
    hub.flushAway();
    await quiet();
    expect(count('İzin ver (bir kez)')).toBe(1);
    // He comes back: nothing withdrawn, the button still answers.
    handsfreeOn = false;
    const frames: Record<string, unknown>[] = [];
    const { token } = mintWindowToken({ send: (f) => { if (f.subtype !== 'super_command') return true; frames.push(f); setImmediate(() => deliverSuperResult(token, f.id, { ok: true, result: {} })); return true; }, sessionId: SID, mode: 'super', vault, contextRoot: root });
    tap(buttonMsg('İzin ver (bir kez)'), 0);
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]).toMatchObject({ verb: 'allow', args: { child: CHILD, requestId: 'req-9', by: 'owner' } });
  });
});
