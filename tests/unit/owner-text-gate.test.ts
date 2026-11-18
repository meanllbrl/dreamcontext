/**
 * The owner-text gate (Doc's 7-day friction report, 2026-11-18): a text not in his language never
 * reaches his phone and is asked for again. The cases are the report's real ones. Pointer-back and
 * "nothing changed" lines are NOT held (owner 2026-11-19), and the tests prove it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inWrongLanguage, telegramHold, ownerTextFeedback } from '../../src/lib/super/owner-text-gate.js';
import { detectOwnerLanguage } from '../../src/lib/super/owner-language.js';
import { CardFeedbackTracker } from '../../src/server/card-feedback.js';
import { isOwnerProse } from '../../src/lib/super/inbox.js';
import { HELD_RETELL_GRACE_MS, TelegramHub, type ActiveBinding } from '../../src/server/telegram/hub.js';
import { groupSuperEventTurns } from '../../dashboard/src/components/sleepy/super/superHandover.js';

type Sent = { method: string; text?: string };

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'owner-gate-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function onTelegramHub(lang: 'Turkish' | 'English' | null = 'Turkish', sleep?: (ms: number) => Promise<void>) {
  const log: Sent[] = [];
  let mid = 100;
  const hub = new TelegramHub({ home, ownerLanguage: () => lang, ...(sleep ? { sleep } : {}) });
  const ab = {
    key: '0123456789abcdef/super', scope: '0123456789abcdef', target: 'super',
    binding: { v: 1, token: 't', botId: 1, botUsername: 'b', chatId: 777, userId: 777, boundAt: '' },
    transport: {
      sendMessage: async (_c: number, html: string) => { log.push({ method: 'sendMessage', text: html }); return { message_id: ++mid, text: html }; },
      sendChatAction: async () => true,
    },
    poller: null, done: Promise.resolve(), chain: Promise.resolve(), contextRoot: null, projectName: 'X',
  } as unknown as ActiveBinding;
  hub.active.set(ab.key, ab);
  (hub as unknown as { superSessions: Map<string, string> }).superSessions.set('s', ab.key);
  (hub as unknown as { presence: Map<string, unknown> }).presence.set(ab.key, { via: 'telegram', at: Date.now() });
  return { hub, log };
}

const OWNER_TURN = { event: false, batch: null };
const EVENT_TURN = { event: true, batch: 'b1' };

describe('a reply that points back or says nothing changed is never held (owner 2026-11-19: "bu kuralı tamamen çıkar")', () => {
  // Four review rounds: no detector told these from a short result in two languages. Each goes.
  const goes = [
    'Durumu bir önceki mesajda yazdım.',
    'Bitti, az önce yazdım.',
    'I told you the build failed before.',
    'Kart hâlâ bekliyor.',
    'Hâlâ bekliyor, kart reddedildi.',
    'Still running. Build FAILED.',
  ];

  it('the gate passes each, in an event turn and in his own', async () => {
    for (const t of goes) expect(telegramHold(t, { lang: 'Turkish' }), t).toBeNull();
    const { hub, log } = onTelegramHub();
    for (const t of goes.slice(0, 2)) {
      expect(await hub.onAssistantText('s', `<!-- re:abc123 -->\n${t}`, { turns: [], inputs: undefined, mark: EVENT_TURN }), t).toBe(true);
    }
    expect(log.map((l) => l.text).join('\n')).toContain('az önce yazdım');
  });

  it('the turn end never asks for it again, and the Mac draws it', () => {
    const said = (text: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { model: 'opus', content: [{ type: 'text', text }] } });
    const t = new CardFeedbackTracker({ lang: () => 'Turkish', isOwnerProse, undelivered: () => [] });
    t.noteFrame(said('<!-- re:abc123 -->\nDurumu bir önceki mesajda yazdım.'));
    expect(t.atResult(true)).toBeNull();
    const items = [
      { kind: 'user', id: 'u1', text: '[super events] batch=b1\n- item=q1 child=c1 event=done' },
      { kind: 'text', id: 't1', text: '<!-- re:abc123 -->\nDurumu bir önceki mesajda yazdım.', replyTo: ['abc123'] },
      { kind: 'text', id: 't2', text: '<!-- re:abc123 -->\nKart hâlâ bekliyor.', replyTo: ['abc123'] },
    ];
    const { kept } = groupSuperEventTurns(items, { ownerBatches: [], expanded: new Set() });
    expect(kept.map((i) => i.id)).toEqual(['u1', 't1', 't2']);
  });

  it('a plain chat has no gate', () => {
    expect(ownerTextFeedback(['<!-- re:abc123 -->\nDeğişen bir şey yok.'], { lang: 'Turkish', isOwnerProse })).toBeNull();
  });
});

describe('his language, enforced (finding 2)', () => {
  const EN = 'The Revenue Administration has sent you one e-notice a month since June, and all of them are routine.';
  const TR = 'Gelir İdaresi haziran ayından beri ayda bir e-tebligat gönderiyor; hepsi olağan bildirimler.';

  it('English to a Turkish owner is the wrong language; Turkish with a few English terms is not', () => {
    expect(inWrongLanguage(EN, 'Turkish')).toBe(true);
    expect(inWrongLanguage(TR, 'Turkish')).toBe(false);
    expect(inWrongLanguage('PR\'ı merge ettim, build yeşil; worktree temizlendi ve branch silindi.', 'Turkish')).toBe(false);
    expect(inWrongLanguage("That's on me, sorry.", 'Turkish')).toBe(false); // too short to judge: two words
    expect(inWrongLanguage(EN, null)).toBe(false); // his language not known yet: nothing is held
    expect(inWrongLanguage(TR, 'English')).toBe(true);
    // A Turkish answer quoting an English error verbatim is Turkish (review r1).
    expect(inWrongLanguage('Hata şu: "The file is not in the repository and it cannot be read by the tool".', 'Turkish')).toBe(false);
    expect(inWrongLanguage('Hata şu: “The file is not in the repository and it cannot be read by the tool”.', 'Turkish')).toBe(false);
  });

  it('the turn end judges each reply section, as the phone holds it (review r1)', () => {
    const said = (text: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { model: 'opus', content: [{ type: 'text', text }] } });
    const t = new CardFeedbackTracker({ lang: () => 'Turkish', isOwnerProse, undelivered: () => [] });
    t.noteFrame(said(`<!-- re:aaa111 -->\n${TR} Ayrıca bugün iki yeni bildirim daha geldi, onlar da olağan.\n<!-- re:bbb222 -->\n${EN}`));
    expect(t.atResult(true)).toMatch(/not in Turkish/);
  });

  it('his own message is still read the same way (detectOwnerLanguage unchanged)', () => {
    expect(detectOwnerLanguage('bana çok e tebligat geliyor son zamanlarda bakar mısın')).toBe('Turkish');
    expect(detectOwnerLanguage('can you check why this is slow')).toBe('English');
    expect(detectOwnerLanguage('ok')).toBeNull();
  });

  it('the phone never gets the English answer; the turn waits for the Turkish one', async () => {
    const { hub, log } = onTelegramHub('Turkish');
    const turn = { ref: 'abc123', answered: false } as { held?: boolean };
    expect(await hub.onAssistantText('s', `<!-- re:abc123 -->\n${EN}`, { turns: [turn as never], inputs: undefined, mark: OWNER_TURN })).toBe(false);
    expect(log.filter((l) => l.method === 'sendMessage')).toEqual([]);
    expect(turn.held).toBe(true);
    expect(await hub.onAssistantText('s', `<!-- re:abc123 -->\n${TR}`, { turns: [], inputs: undefined, mark: OWNER_TURN })).toBe(true);
    expect(log.map((l) => l.text).join('\n')).toContain('e-tebligat');
  });

  it('with his language not known yet, nothing is held', async () => {
    const { hub } = onTelegramHub(null);
    expect(await hub.onAssistantText('s', `<!-- re:abc123 -->\n${EN}`, { turns: [], inputs: undefined, mark: OWNER_TURN })).toBe(true);
  });

  it('the turn end asks for the same answer again, in Turkish; once', () => {
    const said = (text: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { model: 'opus', content: [{ type: 'text', text }] } });
    const t = new CardFeedbackTracker({ lang: () => 'Turkish', isOwnerProse, undelivered: () => [] });
    t.noteFrame(said(`<!-- re:abc123 -->\n${EN}`));
    const note = t.atResult(true)!;
    expect(note).toMatch(/not in Turkish/);
    expect(note).toMatch(/in Turkish only/);
    t.noteFrame(said(`<!-- re:abc123 -->\n${EN}`));
    expect(t.atResult(true)).toBeNull();
    // A Turkish answer passes.
    t.noteFrame(said(`<!-- re:abc123 -->\n${TR}`));
    expect(t.atResult(true)).toBeNull();
  });
});

describe('a held turn still hears something (review r1, held-without-retell)', () => {
  type HubInternals = { onChatChange(entry: { sessionId: string; status: string }, from: string): void; turns: Map<string, unknown> };
  function heldTurn(hub: TelegramHub) {
    const t = { ref: 'abc123', key: '0123456789abcdef/super', chatId: 777, sessionId: 's', startedAt: 0, typing: null, answered: false, held: true };
    (hub as unknown as HubInternals).turns.set(t.ref, t);
  }
  const silent = (log: Sent[]) => log.filter((l) => (l.text ?? '').includes('cevap yazmadan bitti'));
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it('no corrected answer within the grace: "ended silent" after all', async () => {
    let wake!: () => void;
    const slept: number[] = [];
    const { hub, log } = onTelegramHub('Turkish', (ms) => { slept.push(ms); return new Promise<void>((r) => { wake = r; }); });
    heldTurn(hub);
    (hub as unknown as HubInternals).onChatChange({ sessionId: 's', status: 'idle' }, 'working');
    await tick();
    expect(slept).toEqual([HELD_RETELL_GRACE_MS]);
    expect(silent(log)).toEqual([]);
    wake();
    await tick();
    expect(silent(log)).toHaveLength(1);
  });

  it('the corrected answer lands within the grace: no "ended silent"', async () => {
    let wake!: () => void;
    const { hub, log } = onTelegramHub('Turkish', () => new Promise<void>((r) => { wake = r; }));
    heldTurn(hub);
    (hub as unknown as HubInternals).onChatChange({ sessionId: 's', status: 'idle' }, 'working');
    await tick();
    hub.queueSend('s', (turns) => hub.onAssistantText('s', '<!-- re:abc123 -->\nSürüm 2.4 yayında.', { turns, inputs: undefined, mark: OWNER_TURN }));
    await tick();
    wake();
    await tick();
    expect(log.map((l) => l.text).join('\n')).toContain('Sürüm 2.4');
    expect(silent(log)).toEqual([]);
  });
});

describe('a step between tools never reaches his phone (finding 5)', () => {
  type HubInternals = { onChatChange(entry: { sessionId: string; status: string }, from: string): void; textChains: Map<string, Promise<void>> };
  const idle = async (hub: TelegramHub) => {
    const h = hub as unknown as HubInternals;
    h.onChatChange({ sessionId: 's', status: 'idle' }, 'working');
    await h.textChains.get('s');
  };

  it('the permission note of 11 Nov, written between tools: never sent, only the reply after it', async () => {
    const { hub, log } = onTelegramHub('English');
    expect(await hub.onAssistantText('s', 'No rm in the command; it only writes review packets in its worktree. Allowing.', { turns: [], inputs: undefined, mark: OWNER_TURN })).toBe(false);
    expect(await hub.onAssistantText('s', '<!-- re:abc123 -->\nThe review passed; the branch is ready to merge.', { turns: [], inputs: undefined, mark: OWNER_TURN })).toBe(true);
    await idle(hub);
    const sent = log.filter((l) => l.method === 'sendMessage').map((l) => l.text ?? '');
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain('Allowing');
  });

  it('in his Telegram turn, short texts between tools are dropped; the last one is his answer, sent at the end', async () => {
    const { hub, log } = onTelegramHub('Turkish');
    const turn = { ref: 'abc123', answered: false, sessionId: 's' } as unknown as { answered: boolean };
    const at = { turns: [turn as never], inputs: undefined, mark: OWNER_TURN };
    expect(await hub.onAssistantText('s', 'Şimdi kayıtlara bakıyorum.', at)).toBe(false);
    expect(await hub.onAssistantText('s', 'Testleri çalıştırıyorum.', at)).toBe(false);
    expect(await hub.onAssistantText('s', 'Tamam, sürüm yayında.', at)).toBe(false);
    expect(log.filter((l) => l.method === 'sendMessage')).toEqual([]);
    await idle(hub);
    const sent = log.filter((l) => l.method === 'sendMessage').map((l) => l.text ?? '');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('sürüm yayında');
  });

  it('a marked reply after a step goes at once, and the step is gone', async () => {
    const { hub, log } = onTelegramHub('Turkish');
    const at = { turns: [{ ref: 'abc123', answered: false, sessionId: 's' } as never], inputs: undefined, mark: OWNER_TURN };
    await hub.onAssistantText('s', 'Bakıyorum.', at);
    expect(await hub.onAssistantText('s', '<!-- re:abc123 -->\nSürüm 2.4 yayında.', at)).toBe(true);
    await idle(hub);
    const sent = log.filter((l) => l.method === 'sendMessage').map((l) => l.text ?? '');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Sürüm 2.4');
  });
});
