/**
 * One path for every bot (owner 2026-11-14, B2): a member's bot talks to that member's OWN Super
 * exactly as the Super's bot talks to main. A message births the member's Super and reaches its
 * injector under a Telegram ref; its answer comes back whole (no fold); a refused member is told
 * why in Turkish; /dur and /durum read the member's own Super, /gundem and /handsfree name the
 * bot's two; a reaction is a note for the member's Super; an answer to an older owner message is
 * a native Telegram reply; the member Super's own prompt is never sent on its bot (main's bot
 * carries it, one place closes it).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTelegram, textUpdate } from '../helpers/fake-telegram.js';
import { TelegramHub } from '../../src/server/telegram/hub.js';
import { wireTelegramW5 } from '../../src/server/telegram/w5.js';
import * as reg from '../../src/lib/assistant/chat-registry.js';
import { readSuperState, resetSuperIndex, superIdOfMember } from '../../src/lib/super/store.js';
import { writeSuper } from '../../src/lib/super/inbox.js';
import type { MemberBirth } from '../../src/lib/super/member-birth.js';
import { scopeOfContextRoot } from '../../src/lib/telegram/config.js';
import { parseTelegramPrefix } from '../../src/lib/telegram/contract.js';
import { takeSuperReactionBlock, telegramReactionNotes } from '../../src/lib/telegram/reactions.js';
import { resetWindowControl } from '../../src/lib/window-control.js';
import { noteStageVerb } from '../../src/lib/super/stage-events.js';

const TOKEN = '222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const OWNER = 777;
const SLUG = 'ua-manager';
const MSID = '99999999-2222-4333-8444-555555555555';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(80, 7)]);

let home: string; let project: string; let root: string; let tg: FakeTelegram; let hub: TelegramHub;
let births: string[];
/** The next refusal `memberSuper` answers (null: born). */
let refuse: (MemberBirth & { ok: false }) | null;
const drained = () => new Promise((r) => setTimeout(r, 40));
const quiet = () => new Promise((r) => setTimeout(r, 60));

function fakeInjector() {
  const sent: string[] = [];
  const inj = {
    sessionId: MSID, chatRegistryId: MSID,
    sendOwnerText: vi.fn(async (text: string) => { sent.push(text); return { ok: true as const }; }),
    interrupt: vi.fn(),
  };
  return { inj, sent };
}
const assistant = (h: reg.ChatHandle, text: string) => h.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } });

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tg-hubm-home-'));
  project = mkdtempSync(join(tmpdir(), 'tg-hubm-proj-'));
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(root, 'agents'), { recursive: true });
  writeFileSync(join(root, 'agents', `${SLUG}.md`), '---\nname: UA\n---\n');
  writeFileSync(join(project, 'a.png'), PNG);
  writeFileSync(join(project, '.gitignore'), '');
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'acme', path: project }] }));
  reg._resetChatRegistry();
  resetWindowControl();
  resetSuperIndex();
  tg = new FakeTelegram(); tg.addBot(TOKEN, 'ua_bot');
  births = []; refuse = null;
  hub = new TelegramHub({
    home, fetchImpl: tg.fetch, pollTimeoutS: 0, sleep: async () => {}, vaults: () => [{ name: 'acme', contextRoot: root }],
    openLink: () => {}, injectorWaitMs: 300,
    memberSuper: async (r, slug) => {
      births.push(slug);
      if (refuse) return refuse;
      const state = await writeSuper(r, superIdOfMember(slug), (s) => { if (!s.session) s.session = MSID; s.enabled = true; });
      return { ok: true, superId: superIdOfMember(slug), session: state.session!, state, born: true };
    },
  });
  wireTelegramW5(hub, { settleMs: 5, isGitIgnored: () => false });
  await hub.start();
  const start = await hub.beginPairing({ scope: scopeOfContextRoot(root), target: SLUG, token: TOKEN, projectName: 'acme', contextRoot: root });
  await drained();
  tg.push(TOKEN, textUpdate(OWNER, `/start ${new URL(start.deepLink).searchParams.get('start')}`));
  await vi.waitFor(() => expect(hub.pairingPreview(start.pairingId)).not.toBeNull(), { timeout: 5000 });
  await hub.confirmPairing(start.pairingId, { botId: 222222, userId: OWNER });
  await drained();
});
afterEach(async () => {
  await hub.stop();
  telegramReactionNotes.clear();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe("a slept member Super wakes from its own bot with no window (owner 2026-11-16, Ege)", () => {
  it("its Super is started by the server as the MEMBER's (its slug), the message delivered once, the answer back on the member's bot", async () => {
    const h = reg.registerChat({ sessionId: MSID, conversationId: null, vault: 'acme', mode: 'super' });
    const { inj, sent } = fakeInjector();
    const wakes: Array<{ sessionId: string; member: string | null; contextRoot: string }> = [];
    const opened: string[] = [];
    Object.assign((hub as unknown as { deps: Record<string, unknown> }).deps, {
      openLink: (u: string) => opened.push(u),
      wakeHeadless: async (o: { sessionId: string; member: string | null; contextRoot: string }) => {
        wakes.push(o);
        setTimeout(() => reg.registerChatInjector(o.sessionId, inj), 20);
        return 'started' as const;
      },
    });
    tg.push(TOKEN, textUpdate(OWNER, 'Selam'));
    tg.push(TOKEN, textUpdate(OWNER, 'hey'));
    await vi.waitFor(() => expect(sent).toHaveLength(2), { timeout: 5000 });
    expect(wakes).toEqual([expect.objectContaining({ sessionId: MSID, member: SLUG, contextRoot: root })]);
    expect(sent.map((t) => parseTelegramPrefix(t).body)).toEqual(['Selam', 'hey']);
    expect(opened).toEqual([]);
    const { ref } = parseTelegramPrefix(sent[1]);
    assistant(h, `<!-- re:${ref} -->\nBuradayım, Ege.`);
    await vi.waitFor(() => expect(tg.texts()).toContain('Buradayım, Ege.'));
    expect(tg.texts().some((t) => t.includes('bekliyor'))).toBe(false);
  });
});

describe("a member's bot talks to the member's own Super", () => {
  it('a message births its Super, reaches its injector under a ref; the answer comes back whole', async () => {
    const h = reg.registerChat({ sessionId: MSID, conversationId: null, vault: 'acme', mode: 'super' });
    const { inj, sent } = fakeInjector();
    reg.registerChatInjector(MSID, inj);
    tg.push(TOKEN, textUpdate(OWNER, 'bütçeyi kontrol et'));
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5000 });
    expect(births).toEqual([SLUG]);
    const { ref, body } = parseTelegramPrefix(sent[0]);
    expect(body).toBe('bütçeyi kontrol et');
    expect((await readSuperState(root, superIdOfMember(SLUG))).session).toBe(MSID);
    // A long answer: past FOLD_AT, it would have folded on the old member path.
    const long = Array.from({ length: 8 }, (_, i) => `Kampanya ${i + 1}: harcama yerinde, ROAS hedefin üstünde, bütçe aynı kalsın; yarın tekrar bakarım.`).join('\n\n');
    assistant(h, `<!-- re:${ref} -->\n${long}`);
    await vi.waitFor(() => expect(tg.texts().some((t) => t.includes('Kampanya 8'))).toBe(true));
    const answer = tg.texts().filter((t) => t.includes('Kampanya'));
    expect(answer.join('\n')).not.toContain('expandable');
  });

  it('a refused member is told why in Turkish and nothing is injected', async () => {
    refuse = { ok: false, status: 409, error: 'member_off', message: 'off' };
    tg.push(TOKEN, textUpdate(OWNER, 'merhaba'));
    await vi.waitFor(() => expect(tg.texts()).toContain("ℹ️ <i>ua-manager Mac'te kapalı; açınca buradan yazabilirsin.</i>"));
    refuse = { ok: false, status: 409, error: 'member_unapproved', message: 'wait' };
    tg.push(TOKEN, textUpdate(OWNER, 'merhaba'));
    await vi.waitFor(() => expect(tg.texts()).toContain("ℹ️ <i>ua-manager Mac'te onayını bekliyor; onaylayınca buradan yazabilirsin.</i>"));
  });

  it("/gundem and /handsfree name the bot's own two; an unknown command too; nothing reaches a Super", async () => {
    tg.push(TOKEN, textUpdate(OWNER, '/handsfree'));
    await vi.waitFor(() => expect(tg.texts()).toContain("ℹ️ <i>/handsfree yalnız Super'in botunda var. Bu botun komutları: /dur /durum</i>"));
    tg.push(TOKEN, textUpdate(OWNER, '/gundem@ua_bot'));
    await vi.waitFor(() => expect(tg.texts()).toContain("ℹ️ <i>/gundem yalnız Super'in botunda var. Bu botun komutları: /dur /durum</i>"));
    tg.push(TOKEN, textUpdate(OWNER, '/nedir'));
    await vi.waitFor(() => expect(tg.texts()).toContain('ℹ️ <i>Bu komut yok. Bu botun komutları: /dur /durum</i>'));
    expect(births).toEqual([]);
  });

  it("/dur and /durum read the member's own Super: unborn = nothing runs; born = its job rows", async () => {
    tg.push(TOKEN, textUpdate(OWNER, '/dur'));
    await vi.waitFor(() => expect(tg.texts()).toContain('ℹ️ <i>Şu an çalışan bir iş yok.</i>'));
    await writeSuper(root, superIdOfMember(SLUG), (s) => { s.session = MSID; s.enabled = true; });
    tg.push(TOKEN, textUpdate(OWNER, '/durum'));
    await vi.waitFor(() => expect(tg.texts().some((t) => t.startsWith('<b>İşler</b>'))).toBe(true));
    expect(births).toEqual([]);
  });

  it("a reaction on its message is a note for the member's own Super", async () => {
    const h = reg.registerChat({ sessionId: MSID, conversationId: null, vault: 'acme', mode: 'super' });
    const { inj, sent } = fakeInjector();
    reg.registerChatInjector(MSID, inj);
    tg.push(TOKEN, textUpdate(OWNER, 'rapor ver'));
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5000 });
    assistant(h, `<!-- re:${parseTelegramPrefix(sent[0]).ref} -->\nROAS 1.4, bütçe yerinde.`);
    await vi.waitFor(() => expect(tg.texts()).toContain('ROAS 1.4, bütçe yerinde.'));
    const mid = tg.sent().find((c) => String(c.params.text).includes('ROAS 1.4'))!.result!.message_id;
    tg.push(TOKEN, { message_reaction: { chat: { id: OWNER, type: 'private' }, message_id: mid, user: { id: OWNER }, new_reaction: [{ type: 'emoji', emoji: '👍' }] } });
    await vi.waitFor(() => expect(takeSuperReactionBlock(MSID)).toContain('👍 on: "ROAS 1.4, bütçe yerinde."'));
  });

  it('an answer to an older owner message is a native reply to it; one to his latest is not', async () => {
    const h = reg.registerChat({ sessionId: MSID, conversationId: null, vault: 'acme', mode: 'super' });
    const { inj, sent } = fakeInjector();
    reg.registerChatInjector(MSID, inj);
    const first = textUpdate(OWNER, 'birinci soru');
    const second = textUpdate(OWNER, 'ikinci soru');
    tg.push(TOKEN, first);
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5000 });
    tg.push(TOKEN, second);
    await vi.waitFor(() => expect(sent).toHaveLength(2), { timeout: 5000 });
    const [refA, refB] = sent.map((t) => parseTelegramPrefix(t).ref);
    assistant(h, `<!-- re:${refB} -->\nİkinciye cevap.`);
    assistant(h, `<!-- re:${refA} -->\nBirinciye cevap.`);
    await vi.waitFor(() => expect(tg.texts()).toContain('Birinciye cevap.'));
    const sentOf = (t: string) => tg.sent().find((c) => String(c.params.text) === t)!;
    expect(sentOf('İkinciye cevap.').params.reply_parameters).toBeUndefined();
    expect(sentOf('Birinciye cevap.').params.reply_parameters).toEqual({ message_id: (first.message as { message_id: number }).message_id, allow_sending_without_reply: true });
  });

  it("the member Super's own prompt is not sent on its bot (the main Super's bot carries it)", async () => {
    const h = reg.registerChat({ sessionId: MSID, conversationId: null, vault: 'acme', mode: 'super' });
    const { inj, sent } = fakeInjector();
    reg.registerChatInjector(MSID, inj);
    tg.push(TOKEN, textUpdate(OWNER, 'bir şey sor'));
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5000 });
    const n = tg.texts().length;
    // He is on Telegram (his latest message came through a bot): main's own prompt would go now.
    expect(hub.ownerAway()).toBe(true);
    h.observe({ type: 'control_request', request_id: 'q1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Hangisi?', header: 'Seç', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] } } });
    await vi.waitFor(() => expect(reg.getChat(MSID)?.status).toBe('asking'));
    await quiet();
    expect(tg.texts().slice(n).filter((t) => t.includes('Hangisi'))).toEqual([]);
  });

  it("a picture the member's own Super opens on its stage reaches its bot (end review r1)", async () => {
    const h = reg.registerChat({ sessionId: MSID, conversationId: null, vault: 'acme', mode: 'super' });
    const { inj, sent } = fakeInjector();
    reg.registerChatInjector(MSID, inj);
    tg.push(TOKEN, textUpdate(OWNER, 'resmi göster'));
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5000 });
    await writeSuper(root, superIdOfMember(SLUG), (s) => {
      s.containers = [{ id: 'image-a', kind: 'image', ref: 'a.png', shape: 'square', place: 'main', title: 'Resim A' }] as never;
    });
    noteStageVerb({ vault: 'acme', contextRoot: root, sessionId: MSID, superId: superIdOfMember(SLUG), verb: 'open', ids: ['image-a'] });
    h.observe({ type: 'result', subtype: 'success', is_error: false, parent_tool_use_id: null });
    await vi.waitFor(() => expect(tg.calls.some((c) => c.method === 'sendPhoto')).toBe(true), { timeout: 5000 });
  });
});
