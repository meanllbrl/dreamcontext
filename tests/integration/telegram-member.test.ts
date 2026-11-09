/**
 * A member's bot (plan "Members", A6): a message becomes a job in the member's thread with
 * `via: 'telegram'`; the member's posts in that run come back; at the live limit the bot says
 * "şu an meşgul" and delivers once a slot frees; a command is not forwarded.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noteOwnerAtMac } from '../../src/lib/telegram/back-at-mac.js';
import { FakeTelegram, textUpdate } from '../helpers/fake-telegram.js';
import { TelegramHub } from '../../src/server/telegram/hub.js';
import { memberAdapter } from '../../src/server/telegram/member.js';
import { scopeOfContextRoot } from '../../src/lib/telegram/config.js';
import { telegramReactionNotes } from '../../src/lib/telegram/reactions.js';
import type { ThreadEntry } from '../../src/lib/automations/types.js';

const TOKEN = '222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const OWNER = 777;
let home: string; let root: string; let tg: FakeTelegram; let hub: TelegramHub;
let says: Array<{ slug: string; text: string; via: string }>;
let sayResults: Array<{ ok: boolean; status: number; body?: Record<string, unknown>; code?: string; message?: string }>;
let run: ThreadEntry[];
const drained = () => new Promise((r) => setTimeout(r, 40));
const entry = (id: string, kind: ThreadEntry['kind'], text: string, event?: string): ThreadEntry => ({ id, runId: 'r1', kind, text, at: '', via: 'runner', ...(event ? { event } : {}) } as ThreadEntry);

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tg-member-home-'));
  const project = mkdtempSync(join(tmpdir(), 'tg-member-proj-'));
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'agents'), { recursive: true });
  writeFileSync(join(root, 'agents', 'ua-manager.md'), '---\nname: UA\n---\n');
  tg = new FakeTelegram(); tg.addBot(TOKEN, 'ua_bot');
  says = []; run = []; sayResults = [];
  hub = new TelegramHub({
    home, fetchImpl: tg.fetch, pollTimeoutS: 0, sleep: async () => {}, vaults: () => [{ name: 'acme', contextRoot: root }],
    member: memberAdapter({
      say: ((_root: string, input: { slug: string; text: string; via: string }) => { says.push(input); return (sayResults.shift() ?? { ok: true, status: 200, body: { runId: 'r1', entryId: 'ask' } }) as never; }) as never,
      readRun: (() => run) as never,
      watchEveryMs: 10, retryEveryMs: 10,
    }),
  });
  await hub.start();
  const start = await hub.beginPairing({ scope: scopeOfContextRoot(root), target: 'ua-manager', token: TOKEN, projectName: 'acme', contextRoot: root });
  await drained();
  tg.push(TOKEN, textUpdate(OWNER, `/start ${new URL(start.deepLink).searchParams.get('start')}`));
  await vi.waitFor(() => expect(hub.pairingPreview(start.pairingId)).not.toBeNull(), { timeout: 5000 });
  await hub.confirmPairing(start.pairingId, { botId: 222222, userId: OWNER });
  await drained();
});
afterEach(async () => { await hub.stop(); telegramReactionNotes.clear(); rmSync(home, { recursive: true, force: true }); });

describe('a member bot', () => {
  it('a message is a job in the member\'s thread via telegram; its posts come back until the run ends', async () => {
    tg.push(TOKEN, textUpdate(OWNER, 'bütçeyi kontrol et'));
    await vi.waitFor(() => expect(says).toEqual([{ slug: 'ua-manager', text: 'bütçeyi kontrol et', via: 'telegram' }]));
    run = [entry('ask', 'user', 'bütçeyi kontrol et'), entry('a1', 'agent', 'Bütçe **iyi** görünüyor.')];
    await vi.waitFor(() => expect(tg.texts()).toContain('Bütçe <b>iyi</b> görünüyor.'));
    run = [...run, entry('s1', 'system', '', 'ok'), entry('a2', 'agent', 'sonradan')];
    await new Promise((r) => setTimeout(r, 80));
    expect(tg.texts()).toContain('sonradan'); // same pass as the end marker
    const n = tg.texts().length;
    run = [...run, entry('a3', 'agent', 'çok geç')];
    await new Promise((r) => setTimeout(r, 80));
    expect(tg.texts().length).toBe(n);
  });

  it('at the live limit: "şu an meşgul", then one delivery when a slot frees', async () => {
    sayResults = [{ ok: false, status: 429, code: 'say_at_limit', message: 'full' }, { ok: false, status: 429, code: 'say_at_limit', message: 'full' }];
    tg.push(TOKEN, textUpdate(OWNER, 'rapor'));
    await vi.waitFor(() => expect(tg.texts()).toContain('⏳ <i>ua-manager şu an meşgul; boşalınca mesajını iletirim.</i>'));
    await vi.waitFor(() => expect(says).toHaveLength(3));
    expect(tg.texts().filter((t) => t.includes('meşgul'))).toHaveLength(1);
  });

  it('a reaction on its message is a note in front of his next message, never a job of its own', async () => {
    tg.push(TOKEN, textUpdate(OWNER, 'rapor ver'));
    await vi.waitFor(() => expect(says).toHaveLength(1));
    run = [entry('ask', 'user', 'rapor ver'), entry('a1', 'agent', 'ROAS 1.4, bütçe yerinde.'), entry('s1', 'system', '', 'ok')];
    await vi.waitFor(() => expect(tg.texts()).toContain('ROAS 1.4, bütçe yerinde.'));
    const mid = tg.sent().find((c) => String(c.params.text).includes('ROAS 1.4'))!.result!.message_id;
    tg.push(TOKEN, { message_reaction: { chat: { id: OWNER, type: 'private' }, message_id: mid, user: { id: OWNER }, new_reaction: [{ type: 'emoji', emoji: '👍' }] } });
    tg.push(TOKEN, { message_reaction: { chat: { id: 555, type: 'private' }, message_id: mid, user: { id: 555 }, new_reaction: [{ type: 'emoji', emoji: '👎' }] } });
    await vi.waitFor(() => expect(hub.strangers.total).toBe(1));
    await new Promise((r) => setTimeout(r, 60));
    expect(says).toHaveLength(1);
    tg.push(TOKEN, textUpdate(OWNER, 'yarın da bak'));
    await vi.waitFor(() => expect(says).toHaveLength(2));
    expect(says[1].text).toMatch(/^\[telegram reaction\] 👍 on: "ROAS 1\.4, bütçe yerinde\."\n\(A `\[telegram reaction\]` line/);
    expect(says[1].text.endsWith('\n\nyarın da bak')).toBe(true);
    expect(says[1].text).not.toContain('👎');
  });

  it('a command is not forwarded', async () => {
    tg.push(TOKEN, textUpdate(OWNER, '/handsfree'));
    await vi.waitFor(() => expect(tg.texts()).toContain('ℹ️ <i>Bu botta komut yok; yazman yeterli.</i>'));
    expect(says).toEqual([]);
  });
});

describe('a member bot keeps its own rule (owner 2026-11-09)', () => {
  it('its question and failure reach it while the owner is at the Mac (the Super-only "away" gate never applies)', async () => {
    noteOwnerAtMac();
    expect(hub.ownerAway()).toBe(false);
    tg.push(TOKEN, textUpdate(OWNER, 'rapor çıkar'));
    await vi.waitFor(() => expect(says).toHaveLength(1));
    run = [entry('ask', 'user', 'rapor çıkar'), entry('q1', 'system', 'Hangi hafta?', 'asked'), entry('f1', 'system', 'kota doldu', 'failed')];
    await vi.waitFor(() => expect(tg.texts()).toContain('❓ Hangi hafta?'));
    await vi.waitFor(() => expect(tg.texts()).toContain('⚠️ <i>Çalışamadı: kota doldu</i>'));
  });
});
