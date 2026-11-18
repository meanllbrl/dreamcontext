/**
 * The owner-text gate (Doc's 7-day friction report, 2026-11-18): what of the Super's text may
 * reach the owner. The cases are the report's real ones (Tilki 16 Nov: seven "durumu bir önceki
 * mesajda yazdım" in one morning, even as the answer to "ne durumdayız").
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inWrongLanguage, pointsBack, saysNothingNew, telegramHold, ownerTextFeedback } from '../../src/lib/super/owner-text-gate.js';
import { detectOwnerLanguage } from '../../src/lib/super/owner-language.js';
import { CardFeedbackTracker, CARD_FEEDBACK_TAG } from '../../src/server/card-feedback.js';
import { isOwnerProse } from '../../src/lib/super/inbox.js';
import { TelegramHub, type ActiveBinding } from '../../src/server/telegram/hub.js';
import { groupSuperEventTurns } from '../../dashboard/src/components/sleepy/super/superHandover.js';

type Sent = { method: string; text?: string };

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'owner-gate-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function onTelegramHub(lang: 'Turkish' | 'English' | null = 'Turkish') {
  const log: Sent[] = [];
  let mid = 100;
  const hub = new TelegramHub({ home, ownerLanguage: () => lang });
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

describe('pointer back and no news (finding 1)', () => {
  it.each([
    'Durumu bir önceki mesajda yazdım.',
    'Bunu yukarıda yazdım, değişen bir şey yok.',
    'Sonucu önceki mesajımda paylaştım.',
    'I already told you this result in my previous message.',
    'As I said above, nothing changed.',
  ])('a short "%s" points back', (t) => {
    expect(pointsBack(t)).toBe(true);
    expect(saysNothingNew(t)).toBe(true);
  });

  it('a real answer that also says "as I wrote above" is an answer, not a pointer', () => {
    const long = `Yukarıda yazdığım gibi canlıya bugün çıkıyoruz. ${'Testler geçti, mağaza incelemesi bitti, sürüm notu hazır. '.repeat(6)}`;
    expect(pointsBack(long)).toBe(false);
    expect(pointsBack('Canlıya bugün 17:00\'de çıkıyoruz; mağaza onayı geldi.')).toBe(false);
  });

  it('"still waiting" is news only when he asked: held in an event turn, sent in his own', () => {
    expect(telegramHold('Kart hâlâ bekliyor.', { eventTurn: true })).toBe('no-news');
    expect(telegramHold('Kart hâlâ bekliyor.', { eventTurn: false })).toBeNull();
    expect(telegramHold('Durumu bir önceki mesajda yazdım.', { eventTurn: false })).toBe('points-back');
  });

  it('the reply mark is not part of the text it judges', () => {
    expect(pointsBack('<!-- re:abc123 -->\nDurumu bir önceki mesajda yazdım.')).toBe(true);
  });
});

describe('the phone never gets it (hub.onAssistantText)', () => {
  it('a pointer back in his own turn is held, and the turn is not "ended silent"', async () => {
    const { hub, log } = onTelegramHub();
    const turn = { ref: 'abc123', answered: false } as unknown as { held?: boolean };
    const landed = await hub.onAssistantText('s', '<!-- re:abc123 -->\nDurumu bir önceki mesajda yazdım.', { turns: [turn as never], inputs: undefined, mark: OWNER_TURN });
    expect(landed).toBe(false);
    expect(log.filter((l) => l.method === 'sendMessage')).toEqual([]);
    expect(turn.held).toBe(true);
  });

  it('a "nothing changed" result line of an event turn is held; a real result goes', async () => {
    const { hub, log } = onTelegramHub();
    expect(await hub.onAssistantText('s', '<!-- re:abc123 -->\nDeğişen bir şey yok, kart hâlâ bekliyor.', { turns: [], inputs: undefined, mark: EVENT_TURN })).toBe(false);
    expect(log.filter((l) => l.method === 'sendMessage')).toEqual([]);
    expect(await hub.onAssistantText('s', '<!-- re:abc123 -->\nSürüm 2.4 yayında; mağaza onayı geldi.', { turns: [], inputs: undefined, mark: { event: false, batch: null } })).toBe(true);
    expect(log.map((l) => l.text).join('\n')).toContain('Sürüm 2.4 yayında');
  });
});

describe('the Super is asked for the answer itself (turn end)', () => {
  const said = (text: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { model: 'opus', content: [{ type: 'text', text }] } });

  it('his turn ending on a pointer back gets one hidden note; the answer to it gets none', () => {
    const t = new CardFeedbackTracker({ eventTurn: () => false, lang: () => 'Turkish', isOwnerProse, undelivered: () => [] });
    t.noteFrame(said('<!-- re:abc123 -->\nDurumu bir önceki mesajda yazdım.'));
    const note = t.atResult(true)!;
    expect(note.startsWith(`<${CARD_FEEDBACK_TAG}>`)).toBe(true);
    expect(note).toMatch(/write the answer itself/);
    t.noteFrame(said('<!-- re:abc123 -->\nDurumu bir önceki mesajda yazdım.'));
    expect(t.atResult(true)).toBeNull();
  });

  it('an event turn is never re-asked (silence was right), and a plain chat has no gate', () => {
    expect(ownerTextFeedback(['<!-- re:abc123 -->\nDeğişen bir şey yok.'], { eventTurn: true, isOwnerProse })).toBeNull();
    const plain = new CardFeedbackTracker();
    plain.noteFrame(said('Durumu bir önceki mesajda yazdım.'));
    expect(plain.atResult(true)).toBeNull();
  });
});

describe('the Mac folds it with the event turn', () => {
  it('a marked no-news line folds; a marked real result stays drawn', () => {
    const items = [
      { kind: 'user', id: 'u1', text: '[super events] batch=b1\n- item=q1 child=c1 event=done' },
      { kind: 'text', id: 't1', text: '<!-- re:abc123 -->\nDeğişen bir şey yok, kart hâlâ bekliyor.', replyTo: ['abc123'] },
      { kind: 'text', id: 't2', text: '<!-- re:abc123 -->\nSürüm 2.4 yayında.', replyTo: ['abc123'] },
    ];
    const { kept, groups } = groupSuperEventTurns(items, { ownerBatches: [], expanded: new Set() });
    expect(kept.map((i) => i.id)).toEqual(['u1', 't2']);
    expect(groups.get('u1')!.folded).toEqual(['t1']);
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
    const t = new CardFeedbackTracker({ eventTurn: () => true, lang: () => 'Turkish', isOwnerProse, undelivered: () => [] });
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
