/**
 * Telegram groups (tg-grup C1-C5, D1-D10) against a fake Telegram and a fake room agent.
 *
 * The owner binds a group with `/bagla` and the Mac's confirm; a member's @mention runs one room
 * turn and its answer lands in the group; a change becomes a private card; Onayla writes one turn
 * into the bot's own Super; `room say` posts once. A group message never reaches the Super's
 * session, a run's stdin, a capture slot or presence; a press by anyone but the owner reaches no
 * handler. Fictional people and project only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTelegram, textUpdate } from '../helpers/fake-telegram.js';
import { TelegramHub, keyOf, msgKey } from '../../src/server/telegram/hub.js';
import { wireTelegramRooms, type RoomRunner } from '../../src/server/telegram/room-agent.js';
import * as reg from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { readBinding, readRoom, scopeOfContextRoot } from '../../src/lib/telegram/config.js';
import { parseTelegramPrefix, type ButtonRecord } from '../../src/lib/telegram/contract.js';
import { resetWindowControl } from '../../src/lib/window-control.js';
import type { ClaudeExecOptions, ClaudeExecution } from '../../src/lib/automations/runner.js';

const TOKEN = '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const BOT = 'acme_super_bot';
const OWNER = 777;
const CAN = 4242;
const GROUP = -1001234567;
const SID = '11111111-2222-4333-8444-555555555555';
const ROOM_SID = '33333333-2222-4333-8444-555555555555';

let home: string; let project: string; let root: string; let tg: FakeTelegram; let hub: TelegramHub; let rooms: RoomRunner;
/** What the fake room agent answers next (in order); each call is recorded. */
let answers: unknown[];
let calls: { args: string[]; opts: ClaudeExecOptions }[];
let gate: Promise<void> | null;

const drained = () => new Promise((r) => setTimeout(r, 40));
const quiet = () => new Promise((r) => setTimeout(r, 80));
const ab = () => hub.active.get(keyOf(scopeOfContextRoot(root), 'super'))!;

function fakeExec(args: string[], opts: ClaudeExecOptions): Promise<ClaudeExecution> {
  calls.push({ args, opts });
  const a = answers.shift() ?? { say: 'Bilmiyorum.' };
  const out = a === 'garbage' ? 'not json at all' : JSON.stringify({ type: 'result', is_error: false, session_id: ROOM_SID, structured_output: a });
  const done = async (): Promise<ClaudeExecution> => {
    if (gate) await gate;
    return { spawned: true, timedOut: false, exitCode: 0, stdout: out, stderrTail: '', startedAt: new Date(), finishedAt: new Date(), result: null };
  };
  return done();
}

/** A group message. `at` adds a real @mention entity. */
function groupMsg(fromId: number, text: string, o: { at?: boolean; chatId?: number; extra?: Record<string, unknown> } = {}): Record<string, unknown> {
  const body = o.at ? `@${BOT} ${text}` : text;
  return {
    message: {
      message_id: Math.floor(Math.random() * 1e6), date: 1,
      chat: { id: o.chatId ?? GROUP, type: 'supergroup', title: 'Ürün ekibi' },
      from: { id: fromId, is_bot: false, first_name: fromId === OWNER ? 'Deniz' : 'Can' },
      text: body,
      ...(o.at ? { entities: [{ type: 'mention', offset: 0, length: BOT.length + 1 }] } : {}),
      ...o.extra,
    },
  };
}
const groupsOf = () => { const r = readBinding(scopeOfContextRoot(root), 'super', home); return r.ok ? r.binding.groups : null; };
const groupSends = () => tg.calls.filter((c) => Number(c.params.chat_id) === GROUP);
const groupTexts = () => groupSends().filter((c) => c.method === 'sendMessage').map((c) => String(c.params.text));
const privateTexts = () => tg.calls.filter((c) => c.method === 'sendMessage' && Number(c.params.chat_id) === OWNER).map((c) => String(c.params.text));

async function superOn(): Promise<void> {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SID, enabled: true }));
  resetSuperIndex();
  await readSuperState(root);
}

async function bindBot(): Promise<void> {
  const start = await hub.beginPairing({ scope: scopeOfContextRoot(root), target: 'super', token: TOKEN, projectName: 'acme', contextRoot: root });
  await drained();
  tg.push(TOKEN, textUpdate(OWNER, `/start ${new URL(start.deepLink).searchParams.get('start')}`));
  await vi.waitFor(() => expect(hub.pairingPreview(start.pairingId)).not.toBeNull(), { timeout: 5000 });
  expect(await hub.confirmPairing(start.pairingId, { botId: 123456, userId: OWNER })).toBe('ok');
  await drained();
}

/** The owner's /bagla in the group, then his Bağla on the Mac's confirm. */
async function bindGroup(chatId = GROUP): Promise<void> {
  tg.push(TOKEN, groupMsg(OWNER, `/bagla@${BOT}`, { chatId }));
  await vi.waitFor(() => expect(hub.status()[0]?.groupAsks?.length).toBe(1), { timeout: 5000 });
  const ask = hub.status()[0].groupAsks![0];
  expect(hub.groupBindPreview(ask.id)).toMatchObject({ chatId, title: 'Ürün ekibi', botUsername: BOT });
  expect(await hub.confirmGroupBind(ask.id, { botId: 123456, chatId })).toBe('ok');
}

/** The newest private card with buttons, and a press on it. */
function lastCard() {
  const c = [...tg.calls].reverse().find((x) => x.method === 'sendMessage' && x.params.reply_markup);
  return c!;
}
function press(card: ReturnType<typeof lastCard>, idx: number, from = OWNER, chatId = OWNER): void {
  const kb = (card.params.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat();
  const text = String(card.params.text).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  tg.push(TOKEN, { callback_query: { id: `cb${Math.random()}`, data: kb[idx].callback_data, from: { id: from }, message: { message_id: card.result!.message_id, chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private' }, text } } });
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tg-grp-home-'));
  project = mkdtempSync(join(tmpdir(), 'tg-grp-proj-'));
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'acme', path: project }] }));
  reg._resetChatRegistry();
  resetWindowControl();
  tg = new FakeTelegram();
  tg.addBot(TOKEN, BOT);
  answers = []; calls = []; gate = null;
  hub = new TelegramHub({
    home, fetchImpl: tg.fetch, pollTimeoutS: 0, sleep: async () => {},
    vaults: () => [{ name: 'acme', contextRoot: root }], openLink: () => {}, injectorWaitMs: 300,
  });
  rooms = wireTelegramRooms(hub, {
    exec: fakeExec, brain: (r) => realpathSync(r), memory: async () => '', env: () => ({}),
    cli: { execPath: process.execPath, entry: join(project, 'cli.js') },
  });
  await hub.start();
  await superOn();
  await bindBot();
});
afterEach(async () => {
  await hub.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('binding a group (D3, criterion 8)', () => {
  it('a member\'s or an anonymous admin\'s /bagla binds nothing; an unbound group gets nothing else', async () => {
    tg.push(TOKEN, groupMsg(CAN, `/bagla@${BOT}`));
    tg.push(TOKEN, groupMsg(OWNER, `/bagla@${BOT}`, { extra: { sender_chat: { id: GROUP, type: 'supergroup' } } }));
    tg.push(TOKEN, groupMsg(CAN, 'ne durumda?', { at: true }));
    await quiet();
    expect(hub.status()[0].groupAsks).toBeUndefined();
    expect(groupsOf()).toBeUndefined();
    expect(groupSends()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('the owner\'s /bagla asks the Mac; only his confirm binds, with what he was shown', async () => {
    tg.push(TOKEN, groupMsg(OWNER, `/bagla@${BOT}`));
    await vi.waitFor(() => expect(hub.status()[0]?.groupAsks?.length).toBe(1), { timeout: 5000 });
    expect(groupsOf()).toBeUndefined();
    const ask = hub.status()[0].groupAsks![0];
    expect(await hub.confirmGroupBind(ask.id, { botId: 123456, chatId: -1 })).toBe('mismatch');
    expect(await hub.confirmGroupBind(ask.id, { botId: 123456, chatId: GROUP })).toBe('ok');
    expect(await hub.confirmGroupBind(ask.id, { botId: 123456, chatId: GROUP })).toBe('gone');
    expect(groupsOf()).toEqual([expect.objectContaining({ chatId: GROUP, title: 'Ürün ekibi' })]);
    expect(hub.status()[0].groups).toEqual([expect.objectContaining({ chatId: GROUP, title: 'Ürün ekibi' })]);
    await vi.waitFor(() => expect(groupTexts().some((t) => t.includes('Bu grup bağlandı'))).toBe(true));
  });

  it('a kick removes the group and its room; "Gruptan çıkar" makes the bot leave; a supergroup move keeps it', async () => {
    await bindGroup();
    tg.push(TOKEN, { my_chat_member: { chat: { id: GROUP, type: 'supergroup' }, from: { id: CAN }, new_chat_member: { status: 'kicked', user: { id: 123456 } } } });
    await vi.waitFor(() => expect(groupsOf()).toBeUndefined(), { timeout: 5000 });
    await bindGroup();
    expect(await hub.removeGroupOf(scopeOfContextRoot(root), 'super', GROUP)).toBe(true);
    expect(tg.calls.some((c) => c.method === 'leaveChat' && c.params.chat_id === GROUP)).toBe(true);
    expect(groupsOf()).toBeUndefined();
    // The old group becomes a supergroup: the binding moves with it.
    const OLD = -555;
    await bindGroup(OLD);
    tg.push(TOKEN, { message: { message_id: 9, date: 1, chat: { id: OLD, type: 'group', title: 'Ürün ekibi' }, from: { id: CAN, is_bot: false }, migrate_to_chat_id: GROUP } });
    await vi.waitFor(() => expect(groupsOf()?.[0]?.chatId).toBe(GROUP), { timeout: 5000 });
  });

  it('a join tells the owner privately; the group hears nothing about it', async () => {
    await bindGroup();
    const n = groupSends().length;
    tg.push(TOKEN, { message: { message_id: 10, date: 1, chat: { id: GROUP, type: 'supergroup', title: 'Ürün ekibi' }, from: { id: CAN, is_bot: false }, new_chat_members: [{ id: CAN, is_bot: false, first_name: 'Can' }] } });
    await vi.waitFor(() => expect(privateTexts().some((t) => t.includes('«Ürün ekibi» grubuna Can katıldı'))).toBe(true), { timeout: 5000 });
    expect(groupSends().length).toBe(n);
  });
});

describe('a room turn (D4, D5, criterion 3)', () => {
  beforeEach(() => bindGroup());

  it('a member\'s @mention runs one room turn and its answer lands in the group; an unaddressed message is never read', async () => {
    answers.push({ say: 'Yeni ekran tasarımda, bu hafta bitiyor.' });
    tg.push(TOKEN, groupMsg(CAN, 'bugün hava güzel'));
    tg.push(TOKEN, groupMsg(CAN, 'yeni ekran ne durumda?', { at: true }));
    await vi.waitFor(() => expect(groupTexts()).toContain('Yeni ekran tasarımda, bu hafta bitiyor.'), { timeout: 5000 });
    expect(calls).toHaveLength(1);
    const user = calls[0].args[calls[0].args.indexOf('-p') + 1];
    expect(user).toContain('Can: @acme_super_bot yeni ekran ne durumda?');
    expect(user).not.toContain('hava güzel');
    // The room's own conversation is kept and resumed next time.
    expect(readRoom(scopeOfContextRoot(root), 'super', GROUP, home).sessionId).toBe(ROOM_SID);
    answers.push({ say: 'Evet.' });
    tg.push(TOKEN, groupMsg(CAN, 'emin misin?', { at: true }));
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 5000 });
    expect(calls[1].args.slice(calls[1].args.indexOf('--resume'), calls[1].args.indexOf('--resume') + 2)).toEqual(['--resume', ROOM_SID]);
  });

  it('a reply to the bot is addressed; the group never gets a button, a file or a picture', async () => {
    answers.push({ say: 'Tamam.' });
    tg.push(TOKEN, groupMsg(CAN, 'peki ya bu?', { extra: { reply_to_message: { message_id: 1, from: { id: 123456, is_bot: true } } } }));
    await vi.waitFor(() => expect(groupTexts()).toContain('Tamam.'), { timeout: 5000 });
    for (const c of groupSends()) {
      expect(['sendMessage', 'sendChatAction']).toContain(c.method);
      expect(c.params.reply_markup).toBeUndefined();
    }
  });

  it('a group message never reaches the Super\'s session or presence (G1), Mac or away alike', async () => {
    reg.registerChat({ sessionId: SID, conversationId: null, vault: 'acme', mode: 'super' });
    const sent: string[] = [];
    reg.registerChatInjector(SID, { sessionId: SID, chatRegistryId: SID, sendOwnerText: vi.fn(async (t: string) => { sent.push(t); return { ok: true as const }; }), interrupt: vi.fn() });
    const commandHook = vi.fn(async () => false);
    hub.commandHook = commandHook;
    answers.push({ say: 'Cevap bir.' }, { say: 'Cevap iki.' });
    tg.push(TOKEN, groupMsg(OWNER, 'durum ne?', { at: true }));
    await vi.waitFor(() => expect(groupTexts()).toContain('Cevap bir.'), { timeout: 5000 });
    tg.push(TOKEN, groupMsg(CAN, 'durum ne?', { at: true }));
    await vi.waitFor(() => expect(groupTexts()).toContain('Cevap iki.'), { timeout: 5000 });
    expect(sent).toEqual([]);
    expect(commandHook).not.toHaveBeenCalled();
    // The owner's own @mention in the group goes to the room as well, never to his Super.
    expect(calls).toHaveLength(2);
  });

  it('two mentions during one turn become ONE next turn, in order (D9)', async () => {
    let open!: () => void;
    gate = new Promise((r) => { open = r; });
    answers.push({ say: 'Bir.' }, { say: 'İki.' });
    tg.push(TOKEN, groupMsg(CAN, 'ilk soru', { at: true }));
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 5000 });
    tg.push(TOKEN, groupMsg(CAN, 'ikinci soru', { at: true }));
    tg.push(TOKEN, groupMsg(OWNER, 'üçüncü soru', { at: true }));
    await quiet();
    expect(calls).toHaveLength(1);
    gate = null;
    open();
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 5000 });
    const user = calls[1].args[calls[1].args.indexOf('-p') + 1];
    expect(user.indexOf('ikinci soru')).toBeGreaterThan(-1);
    expect(user.indexOf('üçüncü soru')).toBeGreaterThan(user.indexOf('ikinci soru'));
  });

  it('anything but the schema answer tells the group it could not answer, and makes no request', async () => {
    answers.push('garbage');
    tg.push(TOKEN, groupMsg(CAN, 'ne?', { at: true }));
    await vi.waitFor(() => expect(groupTexts()).toContain('Şu an cevap veremedim.'), { timeout: 5000 });
    expect(readRoom(scopeOfContextRoot(root), 'super', GROUP, home).requests).toEqual([]);
  });

  it('a member\'s owner-only command gets one fixed line; the owner\'s answers in his private chat (D8)', async () => {
    const commandHook = vi.fn(async (_ab: unknown, u: Record<string, unknown>) => { expect((u.message as { chat: { id: number } }).chat.id).toBe(OWNER); return true; });
    hub.commandHook = commandHook as never;
    tg.push(TOKEN, groupMsg(CAN, `/durum@${BOT}`));
    await vi.waitFor(() => expect(groupTexts().some((t) => t.startsWith('Bu komutu yalnız'))).toBe(true), { timeout: 5000 });
    expect(commandHook).not.toHaveBeenCalled();
    tg.push(TOKEN, groupMsg(OWNER, `/durum@${BOT}`));
    await vi.waitFor(() => expect(commandHook).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(calls).toEqual([]);
  });

  it('the room runs in its own EMPTY folder, with no window key (G5)', async () => {
    answers.push({ say: 'Tamam.' });
    tg.push(TOKEN, groupMsg(CAN, 'x?', { at: true }));
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 5000 });
    const { cwd, env } = calls[0].opts as ClaudeExecOptions & { env: Record<string, string | undefined> };
    expect(cwd.endsWith(join('rooms', String(GROUP), 'cwd'))).toBe(true);
    expect(cwd.startsWith(home)).toBe(true);
    expect(readdirSync(cwd)).toEqual([]);
    expect(env.DREAMCONTEXT_WINDOW_TOKEN).toBeUndefined();
    expect(env.DREAMCONTEXT_RECALL_SCOPE).toBe('quick-edit');
    expect(String(env.PATH).split(':')[0]).toBe(join(cwd, '..', 'bin'));
  });
});

describe('a room request (D6, D7, criterion 5)', () => {
  beforeEach(() => bindGroup());

  async function asked(words = 'bunu ajandada tamamlandı yap'): Promise<void> {
    const n = groupTexts().filter((t) => t.includes('özelden sordum')).length;
    answers.push({ say: '', request: { summary: 'Ajandadaki işi tamamlandı yapmak.' } });
    tg.push(TOKEN, groupMsg(CAN, words, { at: true }));
    await vi.waitFor(() => expect(groupTexts().filter((t) => t.includes('özelden sordum')).length).toBe(n + 1), { timeout: 5000 });
  }

  it('the owner gets a private card with every word; the group only hears it was asked', async () => {
    await asked();
    const card = lastCard();
    expect(Number(card.params.chat_id)).toBe(OWNER);
    expect(String(card.params.text)).toContain('Can · Ürün ekibi grupta istedi');
    expect(String(card.params.text)).toContain('@acme_super_bot bunu ajandada tamamlandı yap');
    expect(String(card.params.text)).toContain('Ajandadaki işi tamamlandı yapmak.');
    expect(groupTexts().some((t) => t.includes('ajandada'))).toBe(false);
  });

  it('Onayla injects ONE turn into the bot\'s own Super, then the group hears it; a second press injects nothing', async () => {
    const sent: string[] = [];
    reg.registerChat({ sessionId: SID, conversationId: null, vault: 'acme', mode: 'super' });
    reg.registerChatInjector(SID, { sessionId: SID, chatRegistryId: SID, sendOwnerText: vi.fn(async (t: string) => { sent.push(t); return { ok: true as const }; }), interrupt: vi.fn() });
    await asked();
    const card = lastCard();
    press(card, 0);
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5000 });
    const { body } = parseTelegramPrefix(sent[0]);
    const id = readRoom(scopeOfContextRoot(root), 'super', GROUP, home).requests[0].id;
    expect(body).toContain(`istek ${id}`);
    expect(body).toContain('@acme_super_bot bunu ajandada tamamlandı yap');
    expect(body).toContain(`dreamcontext super room say ${id}`);
    await vi.waitFor(() => expect(groupTexts().some((t) => t.includes('onayladı, iş başladı'))).toBe(true), { timeout: 5000 });
    expect(readRoom(scopeOfContextRoot(root), 'super', GROUP, home).requests[0].status).toBe('approved');
    press(card, 0);
    await quiet();
    expect(sent).toHaveLength(1);
  });

  it('with the bot\'s Super closed, Onayla wakes it and the turn arrives', async () => {
    const sent: string[] = [];
    const wakes: string[] = [];
    Object.assign((hub as unknown as { deps: Record<string, unknown> }).deps, {
      wakeHeadless: async (o: { sessionId: string }) => {
        wakes.push(o.sessionId);
        setTimeout(() => {
          reg.registerChat({ sessionId: SID, conversationId: null, vault: 'acme', mode: 'super' });
          reg.registerChatInjector(SID, { sessionId: SID, chatRegistryId: SID, sendOwnerText: vi.fn(async (t: string) => { sent.push(t); return { ok: true as const }; }), interrupt: vi.fn() });
        }, 20);
        return 'started' as const;
      },
    });
    await asked();
    press(lastCard(), 0);
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 8000 });
    expect(wakes).toEqual([SID]);
  });

  it('Reddet tells the group and injects nothing; an unbound group\'s card injects nothing', async () => {
    const sent: string[] = [];
    reg.registerChat({ sessionId: SID, conversationId: null, vault: 'acme', mode: 'super' });
    reg.registerChatInjector(SID, { sessionId: SID, chatRegistryId: SID, sendOwnerText: vi.fn(async (t: string) => { sent.push(t); return { ok: true as const }; }), interrupt: vi.fn() });
    await asked();
    press(lastCard(), 1);
    await vi.waitFor(() => expect(groupTexts().some((t) => t.includes('onaylamadı'))).toBe(true), { timeout: 5000 });
    await asked('dosyayı sil');
    const card = lastCard();
    expect(await hub.removeGroupOf(scopeOfContextRoot(root), 'super', GROUP)).toBe(true);
    press(card, 0);
    await quiet();
    expect(sent).toEqual([]);
  });

  it('a second request waits until the first is answered (D9)', async () => {
    await asked();
    const first = lastCard();
    answers.push({ say: '', request: { summary: 'İkinci iş.' } });
    tg.push(TOKEN, groupMsg(CAN, 'bir de şunu yap', { at: true }));
    await vi.waitFor(() => expect(groupTexts().some((t) => t.includes('Önceki istek hâlâ onay bekliyor'))).toBe(true), { timeout: 5000 });
    expect(lastCard()).toBe(first);
    press(first, 1);
    await vi.waitFor(() => expect(lastCard()).not.toBe(first), { timeout: 5000 });
    expect(String(lastCard().params.text)).toContain('İkinci iş.');
  });

  it('room say: only the approved request\'s own Super, once, echoed privately (G8)', async () => {
    reg.registerChat({ sessionId: SID, conversationId: null, vault: 'acme', mode: 'super' });
    reg.registerChatInjector(SID, { sessionId: SID, chatRegistryId: SID, sendOwnerText: vi.fn(async () => ({ ok: true as const })), interrupt: vi.fn() });
    await asked();
    const id = readRoom(scopeOfContextRoot(root), 'super', GROUP, home).requests[0].id;
    // Not approved yet.
    expect(await rooms.say({ root, superId: 'main' }, id, 'Bitti.')).toMatchObject({ ok: false, error: 'not_approved' });
    press(lastCard(), 0);
    await vi.waitFor(() => expect(readRoom(scopeOfContextRoot(root), 'super', GROUP, home).requests[0].status).toBe('approved'), { timeout: 5000 });
    expect(await rooms.say({ root, superId: 'm:ua-manager' as never }, id, 'Bitti.')).toMatchObject({ ok: false, error: 'not_your_request' });
    expect(await rooms.say({ root: join(project, 'other'), superId: 'main' }, id, 'Bitti.')).toMatchObject({ ok: false, error: 'unknown_request' });
    expect(await rooms.say({ root, superId: 'main' }, id, `Bitti, ${root}/state/x.md güncellendi.`)).toEqual({ ok: true, group: 'Ürün ekibi' });
    expect(groupTexts()).toContain('Bitti, state/x.md güncellendi.');
    expect(privateTexts().some((t) => t.includes('«Ürün ekibi» grubuna yazıldı'))).toBe(true);
    expect(await rooms.say({ root, superId: 'main' }, id, 'Bir daha.')).toMatchObject({ ok: false, error: 'already_said' });
    expect(readRoom(scopeOfContextRoot(root), 'super', GROUP, home).requests[0].words).toBe('');
  });

  it('room say to a group no longer bound is refused', async () => {
    reg.registerChat({ sessionId: SID, conversationId: null, vault: 'acme', mode: 'super' });
    reg.registerChatInjector(SID, { sessionId: SID, chatRegistryId: SID, sendOwnerText: vi.fn(async () => ({ ok: true as const })), interrupt: vi.fn() });
    await asked();
    const id = readRoom(scopeOfContextRoot(root), 'super', GROUP, home).requests[0].id;
    press(lastCard(), 0);
    await vi.waitFor(() => expect(readRoom(scopeOfContextRoot(root), 'super', GROUP, home).requests[0].status).toBe('approved'), { timeout: 5000 });
    await hub.removeGroupOf(scopeOfContextRoot(root), 'super', GROUP);
    expect(await rooms.say({ root, superId: 'main' }, id, 'Bitti.')).toMatchObject({ ok: false, error: 'unknown_request' });
  });
});

describe('the presser (G3, criterion 2)', () => {
  const KINDS: ButtonRecord['kind'][] = ['permission', 'question', 'approval', 'run', 'secret', 'handsfree', 'agenda', 'confirm', 'owner-card', 'voice-retry', 'room-request'];
  for (const kind of KINDS) {
    it(`a press on a ${kind} button by anyone but the owner reaches no handler: a toast, no edit`, async () => {
      const handler = vi.fn(async () => 'x');
      hub.extraButton = handler as never;
      await hub.sendButtons(ab(), `Kart ${kind}`, [['Evet', 'Hayır']], { kind, key: ab().key, singleUse: true } as never, { chatId: GROUP });
      const card = lastCard();
      const before = tg.calls.length;
      press(card, 0, CAN, OWNER);
      await vi.waitFor(() => expect(tg.calls.slice(before).some((c) => c.method === 'answerCallbackQuery')).toBe(true), { timeout: 5000 });
      const after = tg.calls.slice(before);
      expect(after.find((c) => c.method === 'answerCallbackQuery')!.params.text).toMatch(/^Bu düğmeye yalnız .+ basabilir\.$/);
      expect(after.some((c) => c.method === 'editMessageText' || c.method === 'editMessageReplyMarkup')).toBe(false);
      expect(handler).not.toHaveBeenCalled();
    });
  }

  it('the owner\'s own press from a group chat reaches nothing either', async () => {
    const handler = vi.fn(async () => 'x');
    hub.extraButton = handler as never;
    await bindGroup();
    await hub.sendButtons(ab(), 'Kart', [['Evet']], { kind: 'confirm', key: ab().key, singleUse: true } as never);
    const before = tg.calls.length;
    press(lastCard(), 0, OWNER, GROUP);
    await vi.waitFor(() => expect(tg.calls.slice(before).some((c) => c.method === 'answerCallbackQuery')).toBe(true), { timeout: 5000 });
    expect(handler).not.toHaveBeenCalled();
    expect(tg.calls.slice(before).some((c) => c.method.startsWith('edit'))).toBe(false);
  });
});

describe('message identity (G2)', () => {
  it('a group message id N never resolves a private message N', () => {
    const a = ab();
    hub.noteReply(a, 42, { ref: 'abc123', quote: 'özel', from: 'super' });
    expect(hub.replyOf(a, 42)?.quote).toBe('özel');
    expect(msgKey(a, 42, GROUP)).not.toBe(msgKey(a, 42));
  });
});

describe('member bots (D10, criterion 10)', () => {
  const MTOKEN = '222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const MBOT = 'ua_bot';
  const SLUG = 'ua-manager';
  const MSID = '99999999-2222-4333-8444-555555555555';
  let mhub: TelegramHub;
  let mcalls: { args: string[]; opts: ClaudeExecOptions }[];

  beforeEach(async () => {
    await hub.stop();
    mkdirSync(join(root, 'agents'), { recursive: true });
    writeFileSync(join(root, 'agents', `${SLUG}.md`), [
      '---', 'name: ua-manager', 'title: UA Yöneticisi · Reklam bütçeleri', 'description: Reklam bütçelerini izler', '---', '',
      '## Prompt', 'GIZLI-TALIMAT-MARKER her sabah bütçeyi kontrol et.', '', '## Soul', 'GIZLI-RUH-MARKER',
    ].join('\n'));
    tg.addBot(MTOKEN, MBOT);
    mcalls = [];
    const { superIdOfMember } = await import('../../src/lib/super/store.js');
    const { writeSuper } = await import('../../src/lib/super/inbox.js');
    mhub = new TelegramHub({
      home, fetchImpl: tg.fetch, pollTimeoutS: 0, sleep: async () => {}, vaults: () => [{ name: 'acme', contextRoot: root }],
      openLink: () => {}, injectorWaitMs: 300,
      memberSuper: async (r, slug) => {
        const state = await writeSuper(r, superIdOfMember(slug), (st) => { if (!st.session) st.session = MSID; st.enabled = true; });
        return { ok: true, superId: superIdOfMember(slug), session: state.session!, state, born: true };
      },
    });
    wireTelegramRooms(mhub, {
      exec: (args, opts) => { mcalls.push({ args, opts }); return fakeExec(args, opts); },
      brain: (r) => realpathSync(r), memory: async () => '', env: () => ({}), cli: { execPath: process.execPath, entry: join(project, 'cli.js') },
    });
    await mhub.start();
    const start = await mhub.beginPairing({ scope: scopeOfContextRoot(root), target: SLUG, token: MTOKEN, projectName: 'acme', contextRoot: root });
    await drained();
    tg.push(MTOKEN, textUpdate(OWNER, `/start ${new URL(start.deepLink).searchParams.get('start')}`));
    await vi.waitFor(() => expect(mhub.pairingPreview(start.pairingId)).not.toBeNull(), { timeout: 5000 });
    expect(await mhub.confirmPairing(start.pairingId, { botId: 222222, userId: OWNER })).toBe('ok');
    await drained();
    tg.push(MTOKEN, { message: { ...(groupMsg(OWNER, `/bagla@${MBOT}`).message as object) } });
    await vi.waitFor(() => expect(mhub.status().find((r) => r.target === SLUG)?.groupAsks?.length).toBe(1), { timeout: 5000 });
    expect(await mhub.confirmGroupBind(mhub.status().find((r) => r.target === SLUG)!.groupAsks![0].id, { botId: 222222, chatId: GROUP })).toBe('ok');
  });
  afterEach(async () => { await mhub.stop(); });

  it('answers under its public title through the same runner; its prompt and soul never reach the room; Onayla goes to the member\'s Super', async () => {
    answers.push({ say: '', request: { summary: 'Bütçeyi düşürmek.' } });
    tg.push(MTOKEN, { message: { message_id: 77, date: 1, chat: { id: GROUP, type: 'supergroup', title: 'Ürün ekibi' }, from: { id: CAN, is_bot: false, first_name: 'Can' }, text: `@${MBOT} bütçeyi düşür`, entities: [{ type: 'mention', offset: 0, length: MBOT.length + 1 }] } });
    await vi.waitFor(() => expect(mcalls).toHaveLength(1), { timeout: 5000 });
    const sys = mcalls[0].args[mcalls[0].args.indexOf('--system-prompt') + 1];
    expect(sys).toContain('UA Yöneticisi');
    expect(mcalls[0].args.join('\n')).not.toContain('GIZLI-TALIMAT-MARKER');
    expect(mcalls[0].args.join('\n')).not.toContain('GIZLI-RUH-MARKER');
    expect(mcalls[0].opts.cwd).toContain(join('ua-manager', 'rooms'));
    const sent: string[] = [];
    reg.registerChat({ sessionId: MSID, conversationId: null, vault: 'acme', mode: 'super' });
    reg.registerChatInjector(MSID, { sessionId: MSID, chatRegistryId: MSID, sendOwnerText: vi.fn(async (t: string) => { sent.push(t); return { ok: true as const }; }), interrupt: vi.fn() });
    await vi.waitFor(() => expect(tg.calls.some((c) => c.token === MTOKEN && c.params.reply_markup)).toBe(true), { timeout: 5000 });
    const card = [...tg.calls].reverse().find((c) => c.token === MTOKEN && c.method === 'sendMessage' && c.params.reply_markup)!;
    const kb = (card.params.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat();
    tg.push(MTOKEN, { callback_query: { id: 'cbm', data: kb[0].callback_data, from: { id: OWNER }, message: { message_id: card.result!.message_id, chat: { id: OWNER, type: 'private' }, text: String(card.params.text).replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&') } } });
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5000 });
    expect(parseTelegramPrefix(sent[0]).body).toContain('bütçeyi düşür');
    const id = readRoom(scopeOfContextRoot(root), SLUG, GROUP, home).requests[0].id;
    expect(readRoom(scopeOfContextRoot(root), SLUG, GROUP, home).requests[0].superId).toBe('m:ua-manager');
    await vi.waitFor(() => expect(readRoom(scopeOfContextRoot(root), SLUG, GROUP, home).requests[0].status).toBe('approved'), { timeout: 5000 });
    // Main's Super may not post a member's request.
    const mrooms = mhub.rooms!;
    expect(await mrooms.say({ root, superId: 'main' }, id, 'x')).toMatchObject({ ok: false, error: 'not_your_request' });
  });
});
