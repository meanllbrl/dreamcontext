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
import type { RunSidecar, ThreadEntry } from '../../src/lib/automations/types.js';
import type { TaskClaim } from '../../src/lib/agents/task-jobs.js';
import { appendThreadEntry } from '../../src/lib/automations/threads.js';
import { createQuestion } from '../../src/lib/automations/hitl.js';

const TOKEN = '222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const OWNER = 777;
let home: string; let root: string; let tg: FakeTelegram; let hub: TelegramHub;
let says: Array<{ slug: string; text: string; via: string }>;
let sayResults: Array<{ ok: boolean; status: number; body?: Record<string, unknown>; code?: string; message?: string }>;
let run: ThreadEntry[];
// /dur and /durum's world: task claims and in-flight run records of every member of the project.
let claims: TaskClaim[]; let sidecars: Record<string, RunSidecar[]>;
let stoppedTasks: string[]; let killed: Array<{ slug: string; slot: string; force: boolean }>;
const SELF = 4242; // this server's pid in the tests
const NOW = Date.parse('2026-11-09T10:30:00.000Z');
const claim = (agent: string, taskId: string, phase: TaskClaim['phase'] = 'active', hostPid: number | null = null): TaskClaim => ({
  runId: `run-${taskId}`, taskId, taskSlug: `gorev-${taskId}`, step: 'work', round: 1, agent, role: 'doer', hostPid, childPid: null,
  sessionId: null, resume: false, phase, claimedAt: '', tokenHash: null, cwd: null,
} as TaskClaim);
/** A run record; its deadline is an hour after it fired unless given. */
const side = (slug: string, fireAt: string, slot?: string, o: { runnerPid?: number; timeoutAt?: string } = {}): RunSidecar => ({
  slug, runnerPid: o.runnerPid ?? SELF, childPid: 4343, childPgid: 4343, fireAt, startedAt: fireAt,
  timeoutAt: o.timeoutAt ?? new Date(Date.parse(fireAt) + 3_600_000).toISOString(), ...(slot ? { slot } : {}),
} as RunSidecar);
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
  claims = []; sidecars = {}; stoppedTasks = []; killed = [];
  hub = new TelegramHub({
    home, fetchImpl: tg.fetch, pollTimeoutS: 0, sleep: async () => {}, vaults: () => [{ name: 'acme', contextRoot: root }],
    member: memberAdapter({
      say: ((_root: string, input: { slug: string; text: string; via: string }) => { says.push(input); return (sayResults.shift() ?? { ok: true, status: 200, body: { runId: 'r1', entryId: 'ask' } }) as never; }) as never,
      readRun: (() => run) as never,
      watchEveryMs: 10, retryEveryMs: 10,
      jobs: {
        claims: () => claims,
        stopTask: (_r, id) => { stoppedTasks.push(id); claims = claims.filter((c) => c.taskId !== id); return { ok: true }; },
        sidecars: (_r, slug) => sidecars[slug] ?? [],
        kill: (_r, slug, o) => {
          const had = (sidecars[slug] ?? []).some((x) => (x.slot ?? '') === o.slot);
          if (had) { killed.push({ slug, slot: o.slot, force: o.force }); sidecars[slug] = sidecars[slug].filter((x) => (x.slot ?? '') !== o.slot); }
          return { killed: had, found: had };
        },
        isAlive: () => true,
        selfPid: SELF,
        now: () => NOW,
      },
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

  it('a Super command gets the member line naming its own two, and is not forwarded', async () => {
    tg.push(TOKEN, textUpdate(OWNER, '/handsfree'));
    await vi.waitFor(() => expect(tg.texts()).toContain("ℹ️ <i>/handsfree yalnız Super'in botunda var. Bu botun komutları: /dur /durum</i>"));
    tg.push(TOKEN, textUpdate(OWNER, '/gundem@ua_bot'));
    await vi.waitFor(() => expect(tg.texts()).toContain("ℹ️ <i>/gundem yalnız Super'in botunda var. Bu botun komutları: /dur /durum</i>"));
    tg.push(TOKEN, textUpdate(OWNER, '/nedir'));
    await vi.waitFor(() => expect(tg.texts()).toContain('ℹ️ <i>Bu komut yok. Bu botun komutları: /dur /durum</i>'));
    expect(says).toEqual([]);
  });
});

describe('a member bot: /dur and /durum (owner 2026-11-09)', () => {
  it("/dur stops only this member's jobs: its running task through the task Stop, each of its runs through the kill path", async () => {
    claims = [claim('ua-manager', 't1'), claim('ua-manager', 't2', 'waiting_owner'), claim('copy-writer', 't3')];
    sidecars = {
      'ua-manager': [side('ua-manager', '2026-11-09T10:00:00.000Z', 'a1b2c3d4e5f60718'), side('ua-manager', '2026-11-09T09:45:00.000Z')],
      'copy-writer': [side('copy-writer', '2026-11-09T10:00:00.000Z')],
    };
    tg.push(TOKEN, textUpdate(OWNER, '/dur'));
    await vi.waitFor(() => expect(tg.texts()).toContain('ℹ️ <i>3 iş durduruldu.</i>'));
    expect(stoppedTasks).toEqual(['t1']); // its waiting task and the other member's are left alone
    expect(killed).toEqual([{ slug: 'ua-manager', slot: 'a1b2c3d4e5f60718', force: true }, { slug: 'ua-manager', slot: '', force: true }]);
    expect(sidecars['copy-writer']).toHaveLength(1);
    expect(says).toEqual([]);
  });

  it('/dur never trusts a pid probe alone: a record past its deadline is left, another runner keeps the age guard, a task run is not counted twice', async () => {
    claims = [claim('ua-manager', 't1', 'active', 9001)];
    sidecars = {
      'ua-manager': [
        // The task step's own run (its host wrote it): the task Stop ends it, no second kill.
        side('ua-manager', '2026-11-09T10:10:00.000Z', undefined, { runnerPid: 9001 }),
        // Left by a runner that died before a reboot: its pids "live" again, but it is past its deadline.
        side('ua-manager', '2026-11-09T07:00:00.000Z', 'aaaaaaaaaaaaaaaa', { runnerPid: 777, timeoutAt: '2026-11-09T08:00:00.000Z' }),
        // A scheduled run of another process, inside its deadline: killed, but with the 60-minute guard on.
        side('ua-manager', '2026-11-09T10:20:00.000Z', 'bbbbbbbbbbbbbbbb', { runnerPid: 5555 }),
      ],
    };
    tg.push(TOKEN, textUpdate(OWNER, '/dur'));
    await vi.waitFor(() => expect(tg.texts()).toContain('ℹ️ <i>2 iş durduruldu.</i>'));
    expect(stoppedTasks).toEqual(['t1']);
    expect(killed).toEqual([{ slug: 'ua-manager', slot: 'bbbbbbbbbbbbbbbb', force: false }]);
  });

  it('/dur with nothing running says so', async () => {
    sidecars = { 'copy-writer': [side('copy-writer', '2026-11-09T10:00:00.000Z')] };
    claims = [claim('copy-writer', 't3')];
    tg.push(TOKEN, textUpdate(OWNER, '/dur'));
    await vi.waitFor(() => expect(tg.texts()).toContain('ℹ️ <i>Şu an çalışan bir iş yok.</i>'));
    expect(killed).toEqual([]);
    expect(stoppedTasks).toEqual([]);
  });

  it("/durum lists only this member's jobs: running, waiting on the owner, the last done", async () => {
    const t = (iso: string) => new Date(iso);
    appendThreadEntry(root, 'ua-manager', { runId: '2026-11-09T08:00:00.000Z', kind: 'user', text: 'dünkü raporu çıkar', via: 'telegram', now: t('2026-11-09T08:00:00.000Z') });
    appendThreadEntry(root, 'ua-manager', { runId: '2026-11-09T08:00:00.000Z', kind: 'system', event: 'ok', text: '', via: 'runner', now: t('2026-11-09T08:05:00.000Z') });
    appendThreadEntry(root, 'ua-manager', { runId: '2026-11-09T10:00:00.000Z', kind: 'user', text: 'bütçeyi kontrol et', via: 'telegram', now: t('2026-11-09T10:00:00.000Z') });
    appendThreadEntry(root, 'copy-writer', { runId: '2026-11-09T10:00:00.000Z', kind: 'user', text: 'başka üyenin işi', via: 'dashboard', now: t('2026-11-09T10:00:00.000Z') });
    createQuestion(root, { slug: 'ua-manager', kind: 'flow-hitl', runFiredAt: '2026-11-09T10:00:00.000Z', sessionId: null, channel: 'chat', question: 'Hangi hafta?' });
    createQuestion(root, { slug: 'copy-writer', kind: 'flow-hitl', runFiredAt: '2026-11-09T10:00:00.000Z', sessionId: null, channel: 'chat', question: 'Başkasının sorusu' });
    sidecars = { 'ua-manager': [side('ua-manager', '2026-11-09T10:00:00.000Z', 'a1b2c3d4e5f60718')], 'copy-writer': [side('copy-writer', '2026-11-09T10:00:00.000Z')] };
    claims = [claim('ua-manager', 't1'), claim('copy-writer', 't3')];
    tg.push(TOKEN, textUpdate(OWNER, '/durum'));
    await vi.waitFor(() => expect(tg.texts().some((x) => x.startsWith('<b>İşler</b>'))).toBe(true));
    const text = tg.texts().find((x) => x.startsWith('<b>İşler</b>'))!;
    expect(text).toBe([
      '<b>İşler</b>',
      '⏳ <i>Görev: gorev-t1</i> · çalışıyor',
      '⏳ <i>bütçeyi kontrol et</i> · çalışıyor',
      '',
      '<b>Seni bekleyenler</b>',
      '❓ Hangi hafta?',
      '',
      '<b>Son bitenler</b>',
      '✅ <i>dünkü raporu çıkar</i> · bitti',
    ].join('\n'));
    expect(text).not.toContain('başka');
    expect(says).toEqual([]);
  });

  it('/durum with nothing at all: "Çalışan iş yok."', async () => {
    tg.push(TOKEN, textUpdate(OWNER, '/durum'));
    await vi.waitFor(() => expect(tg.texts()).toContain('<b>İşler</b>\nÇalışan iş yok.'));
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
