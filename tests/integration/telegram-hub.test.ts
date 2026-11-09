/**
 * The Telegram hub against a fake Telegram (W2 lane A; plan B4, A1, C3, D1, A3, B1, M1, plan
 * "Button integrity", "Auth on every update"):
 *  pairing → native-confirm shape → active binding (0600, device-only); Super off; a text reaches
 *  the Super's injector with a store-honoured ref; the answer under `re:<ref>` reaches Telegram,
 *  a Mac answer does not; strangers get nothing; a closed Super is reopened through its link;
 *  forged and stale buttons are refused, a permission tap answers through `hub_command`;
 *  unbind and tamper send their last message first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTelegram, textUpdate } from '../helpers/fake-telegram.js';
import { TelegramHub, keyOf } from '../../src/server/telegram/hub.js';
import * as reg from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { bindingDir, scopeOfContextRoot } from '../../src/lib/telegram/config.js';
import { parseTelegramPrefix } from '../../src/lib/telegram/contract.js';
import { _openEventTurnForTests, markSuperEventTurn } from '../../src/lib/super/inbox.js';
import { noteSuperSend } from '../../src/lib/super/owner-wait.js';
import { noteOwnerAtMac } from '../../src/lib/telegram/back-at-mac.js';
import { deliverHubResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

const TOKEN = '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OWNER = 777;
const SID = '11111111-2222-4333-8444-555555555555';

let home: string;
let project: string;
let root: string;
let tg: FakeTelegram;
let hub: TelegramHub;
let opened: string[];
/** Added to the hub's clock (the 24 h expiry test). */
let skew = 0;

async function superOn(on = true): Promise<void> {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SID, enabled: on }));
  resetSuperIndex();
  await readSuperState(root);
}

async function bound(): Promise<void> {
  const start = await hub.beginPairing({ scope: scopeOfContextRoot(root), target: 'super', token: TOKEN, projectName: 'acme', contextRoot: root });
  const payload = new URL(start.deepLink).searchParams.get('start')!;
  await drained();
  tg.push(TOKEN, textUpdate(OWNER, `/start ${payload}`));
  await vi.waitFor(() => expect(hub.pairingPreview(start.pairingId)).not.toBeNull(), { timeout: 5000 });
  expect(await hub.confirmPairing(start.pairingId, { botId: 123456, userId: OWNER })).toBe('ok');
  await drained();
}

/** A poller drains what is queued at its start (H10): tests push only after that. */
const drained = () => new Promise((r) => setTimeout(r, 40));

function fakeInjector(onText: (text: string) => void = () => {}) {
  const sent: string[] = [];
  const inj = {
    sessionId: SID, chatRegistryId: SID,
    sendOwnerText: vi.fn(async (text: string) => { sent.push(text); onText(text); return { ok: true as const }; }),
    interrupt: vi.fn(),
  };
  return { inj, sent };
}

const assistant = (h: reg.ChatHandle, text: string) => h.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } });

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tg-hub-home-'));
  project = mkdtempSync(join(tmpdir(), 'tg-hub-proj-'));
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'acme', path: project }] }));
  reg._resetChatRegistry();
  resetWindowControl();
  tg = new FakeTelegram();
  tg.addBot(TOKEN, 'acme_super_bot');
  opened = [];
  skew = 0;
  hub = new TelegramHub({
    home, fetchImpl: tg.fetch, pollTimeoutS: 0, sleep: async () => {}, now: () => Date.now() + skew,
    vaults: () => [{ name: 'acme', contextRoot: root }],
    openLink: (u) => opened.push(u), injectorWaitMs: 300,
  });
  await hub.start();
  await superOn();
});
afterEach(async () => {
  await hub.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('binding', () => {
  it('a pairing serves nothing until confirmed; confirm writes bot.json 0600 under ~/.dreamcontext only', async () => {
    const start = await hub.beginPairing({ scope: scopeOfContextRoot(root), target: 'super', token: TOKEN, projectName: 'acme', contextRoot: root });
    expect(start.deepLink).toMatch(/^https:\/\/t\.me\/acme_super_bot\?start=[A-Za-z0-9_-]{22}$/);
    expect(hub.status()).toEqual([]);
    await drained();
    tg.push(TOKEN, textUpdate(OWNER, '/start'));
    tg.push(TOKEN, textUpdate(OWNER, `/start ${new URL(start.deepLink).searchParams.get('start')}`));
    await vi.waitFor(() => expect(hub.pairingPreview(start.pairingId)).toMatchObject({ userId: OWNER, botId: 123456, target: 'super', projectName: 'acme' }), { timeout: 5000 });
    expect(await hub.confirmPairing(start.pairingId, { botId: 123456, userId: 999 })).toBe('mismatch');
    expect(await hub.confirmPairing(start.pairingId, { botId: 123456, userId: OWNER })).toBe('ok');
    const file = join(bindingDir(scopeOfContextRoot(root), 'super', home), 'bot.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf-8')).toContain(TOKEN);
    expect(JSON.stringify(readdirAll(project))).not.toContain(TOKEN);
    expect(hub.status()).toEqual([expect.objectContaining({ target: 'super', state: 'active', botUsername: 'acme_super_bot' })]);
    await vi.waitFor(() => expect(tg.texts().some((t) => t.startsWith('ℹ️ <i>Bağlandı'))).toBe(true));
    expect(await hub.confirmPairing(start.pairingId, { botId: 123456, userId: OWNER })).toBe('gone');
  });

  it('a webhook-set bot and a bot bound elsewhere are refused', async () => {
    tg.webhook = 'https://x.example/hook';
    await expect(hub.beginPairing({ scope: scopeOfContextRoot(root), target: 'super', token: TOKEN, projectName: 'acme', contextRoot: root })).rejects.toMatchObject({ code: 'webhook_set' });
  });
});

describe('the Super target', () => {
  beforeEach(bound);

  it('Super off → "Bu projede Super kapalı", nothing injected', async () => {
    await superOn(false);
    tg.push(TOKEN, textUpdate(OWNER, 'merhaba'));
    await vi.waitFor(() => expect(tg.texts()).toContain("ℹ️ <i>Bu projede Super kapalı; Mac'te açınca yazabilirsin.</i>"));
  });

  it('a stranger gets nothing and is counted', async () => {
    const before = tg.sent().length;
    tg.push(TOKEN, textUpdate(555, 'merhaba'));
    await vi.waitFor(() => expect(hub.strangers.total).toBe(1));
    expect(tg.sent().length).toBe(before);
  });

  it('a text reaches the injector under a store-honoured ref; its re: answer goes back; after a Mac text a Mac answer does not', async () => {
    const h = reg.registerChat({ sessionId: SID, conversationId: null, vault: 'acme', mode: 'super' });
    const { inj, sent } = fakeInjector();
    reg.registerChatInjector(SID, inj);
    tg.push(TOKEN, textUpdate(OWNER, 'durum ne?'));
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5000 });
    const { ref, body } = parseTelegramPrefix(sent[0]);
    expect(body).toBe('durum ne?');
    expect(reg.telegramRefs.has(SID, ref!)).toBe(true);
    assistant(h, `<!-- re:${ref} -->\nHer şey yolunda.`);
    await vi.waitFor(() => expect(tg.texts()).toContain('Her şey yolunda.'));
    // He writes on the Mac: he is off Telegram (told once), a Mac answer (marked or not) is not sent.
    const n = tg.texts().length;
    h.userSent('mac text');
    noteOwnerAtMac();
    assistant(h, `<!-- re:abcdef -->\nMac'e cevap`);
    assistant(h, 'Sadece Mac için.');
    await new Promise((r) => setTimeout(r, 50));
    expect(tg.texts().slice(n)).toEqual([]); // no unprompted "back" note
  });

  describe('on Telegram (presence): every owner-facing section goes, whatever ref it opens with', () => {
    async function onTelegram() {
      const h = reg.registerChat({ sessionId: SID, conversationId: null, vault: 'acme', mode: 'super' });
      const { inj, sent } = fakeInjector();
      reg.registerChatInjector(SID, inj);
      tg.push(TOKEN, textUpdate(OWNER, 'ne yapıyorsun'));
      await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5000 });
      const ref = parseTelegramPrefix(sent[0]).ref!;
      assistant(h, `<!-- re:${ref} -->\nİki işi takip ediyorum.`);
      await vi.waitFor(() => expect(tg.texts()).toContain('İki işi takip ediyorum.'));
      return { h, ref };
    }
    const quiet = () => new Promise((r) => setTimeout(r, 50));

    it('a job result under a Mac ref, written on a later event turn, reaches Telegram once', async () => {
      const { h } = await onTelegram();
      h.userSent(''); // the event turn: no words of his
      assistant(h, "<!-- re:abc123 -->\nCLI açılışı 0.35 sn'den 0.16 sn'ye indi.");
      await vi.waitFor(() => expect(tg.texts()).toContain("CLI açılışı 0.35 sn'den 0.16 sn'ye indi."));
      await quiet();
      expect(tg.texts().filter((t) => t.includes('CLI açılışı'))).toHaveLength(1);
      // An unmarked text goes too.
      assistant(h, 'Onay verdim, iş sürüyor.');
      await vi.waitFor(() => expect(tg.texts()).toContain('Onay verdim, iş sürüyor.'));
    });

    describe('a server-opened event turn goes out only when it is for him (the Mac fold rule)', () => {
      async function ownerBatches(...batches: string[]) {
        writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SID, enabled: true, ownerBatches: batches }));
        resetSuperIndex();
        await readSuperState(root);
      }
      afterEach(() => markSuperEventTurn(SID, false));

      it('a permission-only event turn sends nothing, marked or not', async () => {
        const { h } = await onTelegram();
        await ownerBatches();
        _openEventTurnForTests(SID, 'b-perm', root);
        const n = tg.texts().length;
        assistant(h, 'İzni verdim: kendi worktree içinde git add.');
        assistant(h, '<!-- re:abc123 -->\nBir not daha.');
        await quiet();
        expect(tg.texts().length).toBe(n);
      });

      it('an awaited=owner result (owner batch) under its ref sends', async () => {
        const { h } = await onTelegram();
        await ownerBatches('b-done');
        _openEventTurnForTests(SID, 'b-done', root);
        assistant(h, '<!-- re:abc123 -->\nİş bitti, sonuç hazır.');
        await vi.waitFor(() => expect(tg.texts()).toContain('İş bitti, sonuç hazır.'));
      });

      it('an event=owner notice (owner batch) sends', async () => {
        const { h } = await onTelegram();
        await ownerBatches('b-wait');
        _openEventTurnForTests(SID, 'b-wait', root);
        assistant(h, 'Bir iş senden bekliyor: tarayıcıda giriş yap.');
        await vi.waitFor(() => expect(tg.texts()).toContain('Bir iş senden bekliyor: tarayıcıda giriş yap.'));
      });

      it('a reply to his own Telegram message sends', async () => {
        const { h, ref } = await onTelegram();
        await ownerBatches();
        assistant(h, `<!-- re:${ref} -->\nBir de bunu ekledim.`);
        await vi.waitFor(() => expect(tg.texts()).toContain('Bir de bunu ekledim.'));
      });
    });

    it('no double send: a section under his Telegram ref and a Mac-ref section each go once', async () => {
      const { h, ref } = await onTelegram();
      const before = tg.texts().length;
      assistant(h, `<!-- re:${ref} abc123 -->\nİkisine birden cevap.\n<!-- re:abc123 -->\nSonuç hazır.`);
      await vi.waitFor(() => expect(tg.texts()).toContain('Sonuç hazır.'));
      await quiet();
      expect(tg.texts().slice(before)).toEqual(['İkisine birden cevap.', 'Sonuç hazır.']);
    });

    it('a Mac message ends it; a slash command and a server continue do not', async () => {
      const { h } = await onTelegram();
      h.userSent('/compact');
      h.userSent('The usage limit that stopped this chat has reset. Continue exactly where you stopped; do not redo finished work.', { server: true });
      assistant(h, '<!-- re:abc123 -->\nHâlâ telefondasın.');
      await vi.waitFor(() => expect(tg.texts()).toContain('Hâlâ telefondasın.'));
      h.userSent('Mac\'ten yazdım');
      noteOwnerAtMac();
      await new Promise((r) => setTimeout(r, 60));
      expect(tg.texts().some((t) => t.includes('döndün'))).toBe(false);
      const n = tg.texts().length;
      assistant(h, '<!-- re:abc123 -->\nArtık Mac.');
      await quiet();
      expect(tg.texts().length).toBe(n);
    });

    it('a post nobody typed (a run report, an agent\'s send into the Super) does not end it', async () => {
      const { h } = await onTelegram();
      h.userSent('[ran in chat] npm test: exit 0', { server: true });
      noteSuperSend(SID, 'Durumu özetle.');
      h.userSent('Durumu özetle.');
      assistant(h, '<!-- re:abc123 -->\nÖzet hazır.');
      await vi.waitFor(() => expect(tg.texts()).toContain('Özet hazır.'));
    });

    it('a run report the hub injected moves no presence', async () => {
      const onPresence = vi.fn();
      (hub.deps as { handsfree?: unknown }).handsfree = { streamsTo: () => false, onPresence };
      reg.registerChat({ sessionId: SID, conversationId: null, vault: 'acme', mode: 'super' });
      const { inj } = fakeInjector();
      reg.registerChatInjector(SID, inj);
      const ab = [...hub.active.values()][0];
      expect(await hub.injectText(ab, hub.syntheticUpdateId(), '[ran in chat] ok', SID, { kind: 'run-report', cardRef: 'r1' })).not.toBe(false);
      expect(onPresence).not.toHaveBeenCalled();
      expect(hub.onTelegram(ab)).toBe(false);
    });

    it('a Mac message in a session the hub has not mapped yet (a fresh Super session) ends it too', async () => {
      await onTelegram();
      const NEW = '99999999-2222-4333-8444-555555555555';
      writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: NEW, enabled: true }));
      resetSuperIndex();
      await readSuperState(root);
      const h2 = reg.registerChat({ sessionId: NEW, conversationId: null, vault: 'acme', mode: 'super' });
      h2.userSent('yeni oturumda Mac\'ten yazdım');
      noteOwnerAtMac();
      await new Promise((r) => setTimeout(r, 60));
      expect(tg.texts().some((t) => t.includes('döndün'))).toBe(false);
      const n = tg.texts().length;
      assistant(h2, 'Yeni oturumda Mac cevabı.');
      await quiet();
      expect(tg.texts().length).toBe(n);
    });

    it('expires after 24 h with no new Telegram message', async () => {
      const { h } = await onTelegram();
      skew = 24 * 60 * 60 * 1000 + 1;
      const n = tg.texts().length;
      assistant(h, '<!-- re:abc123 -->\nBir gün sonra.');
      await quiet();
      expect(tg.texts().length).toBe(n);
    });

    it('tells hands-free: telegram on his Telegram message, back at the Mac on his Mac words, nothing on an event turn', async () => {
      const onPresence = vi.fn();
      const onBackAtMac = vi.fn(() => null);
      (hub.deps as { handsfree?: unknown }).handsfree = { streamsTo: () => false, onPresence, onBackAtMac };
      const { h } = await onTelegram();
      expect(onPresence.mock.calls.map((c) => c[2])).toEqual(['telegram']);
      // A turn with no Mac mark (an event turn, a phone or agent send) tells nothing.
      h.userSent('');
      h.userSent('telefondan yazdım');
      expect(onBackAtMac).not.toHaveBeenCalled();
      noteOwnerAtMac();
      expect(onBackAtMac).toHaveBeenCalledTimes(1);
    });

    // Owner 2026-11-09: "back at the Mac" is a message typed on the Mac in ANY dreamcontext chat.
    it('a Mac message in ANOTHER project\'s ordinary chat ends it, with one "Mac\'e döndün" line', async () => {
      const { h } = await onTelegram();
      const other = reg.registerChat({ sessionId: '22222222-2222-4333-8444-555555555555', conversationId: null, vault: 'beta' });
      other.userSent('başka projede yazdım');
      noteOwnerAtMac(); // what the chat route calls for his composer send in ANY chat (back-at-mac.ts)
      await new Promise((r) => setTimeout(r, 60));
      expect(tg.texts().some((t) => t.includes('döndün'))).toBe(false);
      const n = tg.texts().length;
      assistant(h, '<!-- re:abc123 -->\nArtık Mac.');
      other.userSent('bir daha');
      noteOwnerAtMac();
      await quiet();
      expect(tg.texts().length).toBe(n);
    });

    it('a member chat on the Mac (the AI Team routes call noteOwnerAtMac) ends it too', async () => {
      const { h } = await onTelegram();
      noteOwnerAtMac();
      await new Promise((r) => setTimeout(r, 60));
      expect(tg.texts().some((t) => t.includes('döndün'))).toBe(false);
      const n = tg.texts().length;
      assistant(h, '<!-- re:abc123 -->\nÜye işi bitti.');
      await quiet();
      expect(tg.texts().length).toBe(n);
    });

    it('a phone-link message (no Mac mark) and a Telegram-sourced turn do not end it', async () => {
      const { h } = await onTelegram();
      const other = reg.registerChat({ sessionId: '33333333-2222-4333-8444-555555555555', conversationId: null, vault: 'beta' });
      other.userSent('telefondan yazdım');
      h.userSent('telefondan Super\'e');
      h.userSent('tg', { source: 'telegram-text' });
      assistant(h, '<!-- re:abc123 -->\nHâlâ Telegram.');
      await vi.waitFor(() => expect(tg.texts()).toContain('Hâlâ Telegram.'));
      expect(tg.texts()).not.toContain("Mac'e döndün; cevaplar artık Mac'te.");
    });

    it('a bot still streaming a run he started by hand gets no "back" line (its answers keep coming)', async () => {
      (hub.deps as { handsfree?: unknown }).handsfree = { streamsTo: () => true, onPresence: () => {}, onBackAtMac: () => null };
      await onTelegram();
      noteOwnerAtMac();
      await quiet();
      expect(tg.texts()).not.toContain("Mac'e döndün; cevaplar artık Mac'te.");
    });

    it('the bot whose automatic keep-awake ends is told once, by hands-free, not twice', async () => {
      (hub.deps as { handsfree?: unknown }).handsfree = { streamsTo: () => false, onPresence: () => {}, onBackAtMac: () => [...hub.active.keys()][0] };
      await onTelegram();
      noteOwnerAtMac();
      await quiet();
      expect(tg.texts()).not.toContain("Mac'e döndün; cevaplar artık Mac'te.");
    });

    it('nothing outside the hub sets it: no injected Telegram message, no wide send', async () => {
      const h = reg.registerChat({ sessionId: SID, conversationId: null, vault: 'acme', mode: 'super' });
      // A Telegram-looking source on a chat turn and a text that claims via="telegram" are not presence.
      h.userSent('<owner-msg ref="abc123" via="telegram"/>', { source: 'telegram-text' });
      assistant(h, '<!-- re:abc123 -->\nMac işi bitti.');
      await quiet();
      expect(tg.texts()).not.toContain('Mac işi bitti.');
    });
  });

  it('no live Super: the window is reopened through its session link and the text waits for the injector', async () => {
    tg.push(TOKEN, textUpdate(OWNER, 'aç'));
    await vi.waitFor(() => expect(opened).toHaveLength(1), { timeout: 5000 });
    expect(opened[0]).toContain(SID);
    const { inj, sent } = fakeInjector();
    reg.registerChatInjector(SID, inj);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
  });

  it('the window never opens → "Super\'i Mac\'te açamadım"', async () => {
    tg.push(TOKEN, textUpdate(OWNER, 'aç'));
    await vi.waitFor(() => expect(tg.texts().some((t) => t.startsWith("⚠️ <i>Super Mac'te açılamadı"))).toBe(true), { timeout: 5000 });
  });

  it('a permission prompt becomes buttons; a forged tap is refused; the real tap answers through hub_command', async () => {
    const h = reg.registerChat({ sessionId: SID, conversationId: null, vault: 'acme', mode: 'super' });
    const { inj } = fakeInjector();
    reg.registerChatInjector(SID, inj);
    tg.push(TOKEN, textUpdate(OWNER, 'başla'));
    await vi.waitFor(() => expect(inj.sendOwnerText).toHaveBeenCalled());
    const frames: Record<string, unknown>[] = [];
    const { token } = mintWindowToken({ send: (f) => { frames.push(f); setImmediate(() => deliverHubResult(token, f.id, { ok: true })); return true; }, sessionId: SID, mode: 'super', vault: 'acme', contextRoot: root });
    h.observe({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf build' } } });
    await vi.waitFor(() => expect(tg.sent().some((c) => JSON.stringify(c.params).includes('İzin ver (bir kez)'))).toBe(true));
    const msg = tg.sent().find((c) => JSON.stringify(c.params).includes('İzin ver (bir kez)'))!;
    const kb = (msg.params.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
    const allow = kb[0][0].callback_data;
    const sentText = String(msg.params.text).replace(/<[^>]+>/g, '');
    const cb = (data: string, extra: Record<string, unknown> = {}) => ({ callback_query: { id: 'cb', data, from: { id: OWNER }, message: { message_id: 999, chat: { id: OWNER, type: 'private' }, text: sentText, ...extra } } });
    tg.push(TOKEN, cb('a:0000000000000000:0'));
    await vi.waitFor(() => expect(tg.sent('answerCallbackQuery').at(-1)?.params.text).toBe('Bu soru artık geçerli değil.'));
    expect(frames).toHaveLength(0);
    // The right id on the wrong message is refused too.
    tg.push(TOKEN, cb(allow));
    await vi.waitFor(() => expect(tg.sent('answerCallbackQuery')).toHaveLength(2));
    expect(frames).toHaveLength(0);
    // An edited message is refused.
    tg.push(TOKEN, cb(allow, { message_id: msg.result!.message_id, edit_date: 5 }));
    await vi.waitFor(() => expect(tg.sent('answerCallbackQuery')).toHaveLength(3));
    expect(frames).toHaveLength(0);
    // The real tap: one answer_pending down the Super's socket, allow once.
    tg.push(TOKEN, cb(allow, { message_id: msg.result!.message_id }));
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]).toMatchObject({ subtype: 'hub_command', verb: 'answer_pending', args: { kind: 'permission', requestId: 'req-1', choice: 'allow_once' } });
    await vi.waitFor(() => expect(tg.sent('answerCallbackQuery').at(-1)?.params.text).toBe('✓ İzin verildi (bir kez)'));
    // A second tap on the same button: consumed.
    tg.push(TOKEN, cb(allow, { message_id: msg.result!.message_id }));
    await vi.waitFor(() => expect(tg.sent('answerCallbackQuery').at(-1)?.params.text).toBe('Bu soru artık geçerli değil.'));
    expect(frames).toHaveLength(1);
  });

  it('a photo lands in agent-drops and its path joins the turn; >20 MB is refused; a voice note is transcribed and echoed', async () => {
    reg.registerChat({ sessionId: SID, conversationId: null, vault: 'acme', mode: 'super' });
    const { inj, sent } = fakeInjector();
    reg.registerChatInjector(SID, inj);
    (hub as unknown as { deps: { transcribeVoice: (p: string) => Promise<string> } }).deps.transcribeVoice = async () => 'merhaba dünya';
    tg.files.set('ph1', Buffer.from('jpegbytes'));
    tg.push(TOKEN, textUpdate(OWNER, '', { text: undefined, photo: [{ file_id: 'ph1', file_size: 9, width: 10, height: 10 }], caption: 'bak' }));
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5000 });
    const body = parseTelegramPrefix(sent[0]).body;
    expect(body).toMatch(/Dosya açıklaması: "bak"/);
    expect(body).toMatch(/_dream_context\/tmp\/agent-drops\/tg-\d+-[0-9a-f]{8}\.jpg/);
    tg.push(TOKEN, textUpdate(OWNER, '', { text: undefined, video: { file_id: 'big', file_size: 21 * 1024 * 1024 } }));
    await vi.waitFor(() => expect(tg.texts().some((t) => t.includes('20 MB'))).toBe(true));
    tg.files.set('v1', Buffer.from('OggS'));
    tg.push(TOKEN, textUpdate(OWNER, '', { text: undefined, voice: { file_id: 'v1', file_size: 4 } }));
    await vi.waitFor(() => expect(sent).toHaveLength(2), { timeout: 5000 });
    expect(parseTelegramPrefix(sent[1]).body).toBe('🎙 merhaba dünya');
    expect(tg.texts()).toContain('🎙 <i>Duyduğum</i>\n<blockquote expandable><i>merhaba dünya</i></blockquote>');
  });

  it('unbind sends the last message first, then removes the folder; an unkeyed one (his own page click) stays quiet about it', async () => {
    await hub.unbind(scopeOfContextRoot(root), 'super', { keyed: false });
    expect(tg.texts().at(-1)).toBe("ℹ️ <i>Telegram bağlantısı Mac'te kaldırıldı.</i>");
    expect(existsSync(bindingDir(scopeOfContextRoot(root), 'super', home))).toBe(false);
    expect(hub.status()).toEqual([]);
  });

  it('a crash with accepted messages in the journal: one notice each kind at the next start (E2, F5)', async () => {
    const dir = bindingDir(scopeOfContextRoot(root), 'super', home);
    const pollFile = join(dir, 'poll.json');
    const p = JSON.parse(readFileSync(pollFile, 'utf-8'));
    writeFileSync(pollFile, JSON.stringify({ ...p, pending: [{ updateId: 5, kind: 'text', written: false, at: 1 }, { updateId: 6, kind: 'text', written: true, at: 1, ref: 'abc123' }] }), { mode: 0o600 });
    await hub.stop();
    hub = new TelegramHub({ home, fetchImpl: tg.fetch, pollTimeoutS: 0, sleep: async () => {}, vaults: () => [{ name: 'acme', contextRoot: root }] });
    await hub.start();
    await vi.waitFor(() => expect(tg.texts()).toEqual(expect.arrayContaining(["⚠️ <i>Mesajın Mac'e yazılamadı; tekrar gönder.</i>", "⚠️ <i>Mesajın Mac'e yazıldı ama iş bitmedi; tekrar göndermeden önce Mac'e bak.</i>"])));
    expect(JSON.parse(readFileSync(pollFile, 'utf-8')).pending).toEqual([]);
  });

  it('a written turn lost in a crash is told as "yazıldı ama tamamlanamadı", not "tekrar gönder" (F5)', async () => {
    reg.registerChat({ sessionId: SID, conversationId: null, vault: 'acme', mode: 'super' });
    const { inj, sent } = fakeInjector();
    reg.registerChatInjector(SID, inj);
    tg.push(TOKEN, textUpdate(OWNER, 'deploy et'));
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5000 });
    // The bridge's writeOwnerTurn honours the ref: the journal follows.
    expect(reg.telegramRefs.take(SID, sent[0]).ref).not.toBeNull();
    const pollFile = join(bindingDir(scopeOfContextRoot(root), 'super', home), 'poll.json');
    await vi.waitFor(() => expect(JSON.parse(readFileSync(pollFile, 'utf-8')).pending).toEqual([expect.objectContaining({ written: true })]));
    await hub.stop();
    const before = tg.texts().length;
    hub = new TelegramHub({ home, fetchImpl: tg.fetch, pollTimeoutS: 0, sleep: async () => {}, vaults: () => [{ name: 'acme', contextRoot: root }] });
    await hub.start();
    await vi.waitFor(() => expect(tg.texts().slice(before)).toEqual(["⚠️ <i>Mesajın Mac'e yazıldı ama iş bitmedi; tekrar göndermeden önce Mac'e bak.</i>"]));
  });

  describe('a turn\'s texts and its end (owner report 2026-11-09)', () => {
    const SILENT = "⚠️ <i>Bu tur cevap yazmadan bitti; tekrar yaz ya da Mac'e bak.</i>";
    const toolCall = (h: reg.ChatHandle) => h.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'dreamcontext super ask --json {}' } }] } });
    const result = (h: reg.ChatHandle) => h.observe({ type: 'result', subtype: 'success', is_error: false, result: '' });
    async function telegramTurn() {
      const h = reg.registerChat({ sessionId: SID, conversationId: null, vault: 'acme', mode: 'super' });
      const { inj, sent } = fakeInjector();
      reg.registerChatInjector(SID, inj);
      tg.push(TOKEN, textUpdate(OWNER, 'normal mi?'));
      await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5000 });
      return { h, ref: parseTelegramPrefix(sent[0]).ref! };
    }

    it('text, tool call, text: both reach Telegram in the order written, and the turn is not called silent', async () => {
      const { h, ref } = await telegramTurn();
      tg.slowSends.set('Evet, bu normal.', 120);
      assistant(h, `<!-- re:${ref} -->\nEvet, bu normal.`);
      toolCall(h);
      assistant(h, "Seçim kartı Telegram'a da düştü.");
      result(h);
      await vi.waitFor(() => expect(tg.delivered).toContain("Seçim kartı Telegram'a da düştü."), { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 150));
      const tail = tg.delivered.filter((t) => t === 'Evet, bu normal.' || t.startsWith('Seçim kartı') || t.includes('cevap yazmadan bitti'));
      expect(tail).toEqual(['Evet, bu normal.', "Seçim kartı Telegram'a da düştü."]);
    });

    it('an unmarked text sent while the turn ends is not followed by the silent line', async () => {
      const { h } = await telegramTurn();
      tg.slowSends.set('Kart düştü.', 100);
      assistant(h, 'Kart düştü.');
      result(h);
      await vi.waitFor(() => expect(tg.delivered).toContain('Kart düştü.'), { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 150));
      expect(tg.texts()).not.toContain(SILENT);
    });

    it('a text whose send fails does not count: the turn still says the silent line', async () => {
      const { h } = await telegramTurn();
      tg.failOnce.set('sendMessage', 400);
      assistant(h, 'Bu metin gitmeyecek.');
      result(h);
      await vi.waitFor(() => expect(tg.delivered).toContain(SILENT.replace(/<[^>]+>/g, '')), { timeout: 3000 });
      expect(tg.delivered).not.toContain('Bu metin gitmeyecek.');
    });

    it('a turn that truly wrote him nothing still gets the silent line, once', async () => {
      const { h } = await telegramTurn();
      toolCall(h);
      result(h);
      await vi.waitFor(() => expect(tg.texts()).toContain(SILENT), { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 100));
      expect(tg.texts().filter((t) => t === SILENT)).toHaveLength(1);
    });
  });

  it('a photo then a text reach the Super in that order, even when the photo downloads slowly', async () => {
    reg.registerChat({ sessionId: SID, conversationId: null, vault: 'acme', mode: 'super' });
    const { inj, sent } = fakeInjector();
    reg.registerChatInjector(SID, inj);
    tg.files.set('slow1', Buffer.from('jpeg'));
    tg.slowFiles.set('slow1', 150);
    tg.push(TOKEN, textUpdate(OWNER, '', { text: undefined, photo: [{ file_id: 'slow1', file_size: 4 }] }));
    tg.push(TOKEN, textUpdate(OWNER, 'bunu düzelt'));
    await vi.waitFor(() => expect(sent).toHaveLength(2), { timeout: 5000 });
    expect(parseTelegramPrefix(sent[0]).body).toMatch(/agent-drops/);
    expect(parseTelegramPrefix(sent[1]).body).toBe('bunu düzelt');
  });

  it('typing stops when the Super dies mid-turn', async () => {
    const h = reg.registerChat({ sessionId: SID, conversationId: null, vault: 'acme', mode: 'super' });
    const { inj } = fakeInjector();
    reg.registerChatInjector(SID, inj);
    tg.push(TOKEN, textUpdate(OWNER, 'uzun iş'));
    await vi.waitFor(() => expect(tg.sent('sendChatAction').length).toBeGreaterThan(0), { timeout: 5000 });
    h.exited();
    const n = tg.sent('sendChatAction').length;
    await new Promise((r) => setTimeout(r, 4500));
    expect(tg.sent('sendChatAction').length).toBe(n);
  }, 10_000);

  it('a bot.json the hub did not write disables the binding after a last message', async () => {
    const file = join(bindingDir(scopeOfContextRoot(root), 'super', home), 'bot.json');
    const b = JSON.parse(readFileSync(file, 'utf-8'));
    writeFileSync(file, JSON.stringify({ ...b, chatId: 1 }), { mode: 0o600 });
    tg.push(TOKEN, textUpdate(OWNER, 'merhaba'));
    await vi.waitFor(() => expect(hub.status()[0]).toMatchObject({ state: 'disabled', disabledReason: 'tamper' }), { timeout: 5000 });
    expect(hub.active.get(keyOf(scopeOfContextRoot(root), 'super'))?.disabled).toBe('tamper');
  });
});

function readdirAll(dir: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readdirSync, lstatSync } = require('node:fs') as typeof import('node:fs');
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    out.push(p);
    if (lstatSync(p).isDirectory()) out.push(...readdirAll(p));
    else out.push(readFileSync(p, 'utf-8'));
  }
  return out;
}

describe('a held token lock (the tick, a crash inside the stale window)', () => {
  it('the binding retries until the lock frees, then serves; it is never silently deaf', async () => {
    await bound();
    const { lockPathFor } = await import('../../src/lib/telegram/poller.js');
    const { writeFileSync: w, rmSync: rm } = await import('node:fs');
    const ab = hub.active.get(keyOf(scopeOfContextRoot(root), 'super'))!;
    hub.halt(ab);
    await ab.done;
    // Someone else (a live pid: ours, so the stale check never reclaims it) holds the lock.
    w(lockPathFor(TOKEN, home), JSON.stringify({ pid: process.pid, at: Date.now(), what: 'other' }));
    const again = hub.activate(ab.scope, ab.target, ab.binding);
    await new Promise((r) => setTimeout(r, 300));
    rm(lockPathFor(TOKEN, home), { force: true });
    await superOn(false);
    // The retry (2 s) takes the freed lock and drains what was queued before it: push after that.
    await new Promise((r) => setTimeout(r, 2_600));
    tg.push(TOKEN, textUpdate(OWNER, 'merhaba'));
    await vi.waitFor(() => expect(tg.texts()).toContain("ℹ️ <i>Bu projede Super kapalı; Mac'te açınca yazabilirsin.</i>"), { timeout: 8000 });
    expect(hub.active.get(again.key)?.disabled).toBeUndefined();
  }, 12_000);
});
