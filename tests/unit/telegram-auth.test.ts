/**
 * Only the paired private chat and user are served; pairing is single-use, 10 min, locked per
 * sender after 5 wrong payloads, and stays pending until the Mac confirms (plan AC3, AC4, A1, B4, C4).
 */
import { describe, it, expect } from 'vitest';
import { isAuthorized, PairingBook, StrangerCounter, startPayloadOf, cleanLabel, type TgUpdateLike } from '../../src/lib/telegram/auth.js';
import { PAIRING_ID_RE, PAIRING_TTL_MS } from '../../src/lib/telegram/contract.js';

const BINDING = { chatId: 42, userId: 42 };
const msg = (over: { from?: Partial<{ id: number; is_bot: boolean; username: string; first_name: string }>; chat?: Partial<{ id: number; type: string }>; text?: string } = {}): TgUpdateLike => ({
  update_id: 1,
  message: { message_id: 1, text: over.text ?? 'merhaba', from: { id: 42, ...over.from }, chat: { id: 42, type: 'private', ...over.chat } },
});

describe('isAuthorized: the one gate hub and tick share', () => {
  it('serves the paired private chat and user', () => {
    expect(isAuthorized(msg(), BINDING)).toBe(true);
  });
  it('refuses a stranger, a group, a bot, a mismatched chat, a callback from someone else', () => {
    expect(isAuthorized(msg({ from: { id: 7 } }), BINDING)).toBe(false);
    expect(isAuthorized(msg({ chat: { id: 7 } }), BINDING)).toBe(false);
    expect(isAuthorized(msg({ chat: { type: 'group' } }), BINDING)).toBe(false);
    expect(isAuthorized(msg({ chat: { type: 'supergroup' } }), BINDING)).toBe(false);
    expect(isAuthorized(msg({ from: { is_bot: true } }), BINDING)).toBe(false);
    expect(isAuthorized({ update_id: 1, callback_query: { id: 'x', from: { id: 7 }, message: { chat: { id: 42, type: 'private' } } } }, BINDING)).toBe(false);
    expect(isAuthorized({ update_id: 1, callback_query: { id: 'x', from: { id: 42 }, message: { chat: { id: 42, type: 'private' } } } }, BINDING)).toBe(true);
    expect(isAuthorized({ update_id: 1 }, BINDING)).toBe(false);
    expect(isAuthorized(msg(), { chatId: NaN, userId: NaN })).toBe(false);
  });
  it('strangers are counted', () => {
    const c = new StrangerCounter();
    c.note(msg({ from: { id: 7 } }));
    c.note(msg({ from: { id: 7 } }));
    c.note(msg({ from: { id: 8 } }));
    expect(c.total).toBe(3);
    expect(c.of(7)).toBe(2);
  });
});

describe('pairing', () => {
  const setup = () => {
    let t = 1_000_000;
    const book = new PairingBook(() => t);
    const p = book.mint({ scope: 'abcdef0123456789', target: 'super', botId: 99, botUsername: 'super_bot' });
    return { book, p, advance: (ms: number) => { t += ms; } };
  };

  it('mints 128-bit base64url payload and pairingId, distinct', () => {
    const { p } = setup();
    expect(p.payload).toMatch(PAIRING_ID_RE);
    expect(p.pairingId).toMatch(PAIRING_ID_RE);
    expect(p.payload).not.toBe(p.pairingId);
  });

  it('the payload makes the sender PENDING, never active; confirm activates with the shown ids', () => {
    const { book, p } = setup();
    const r = book.onStart(msg({ text: `/start ${p.payload}`, from: { id: 42, username: 'mehmet' } }));
    expect(r.result).toBe('pending');
    expect(book.preview(p.pairingId)?.pendingUser).toEqual({ userId: 42, chatId: 42, label: '@mehmet' });
    expect(book.confirm(p.pairingId, { botId: 99, userId: 7 })).toEqual({ result: 'mismatch' });
    expect(book.confirm(p.pairingId, { botId: 98, userId: 42 })).toEqual({ result: 'mismatch' });
    expect(book.confirm(p.pairingId, { botId: 99, userId: 42 }).result).toBe('ok');
    expect(book.confirm(p.pairingId, { botId: 99, userId: 42 })).toEqual({ result: 'gone' });
  });

  it('single use: the same payload again changes nothing', () => {
    const { book, p } = setup();
    expect(book.onStart(msg({ text: `/start ${p.payload}` })).result).toBe('pending');
    expect(book.onStart(msg({ text: `/start ${p.payload}`, from: { id: 7 } })).result).toBe('wrong');
    expect(book.preview(p.pairingId)?.pendingUser?.userId).toBe(42);
  });

  it('expires after 10 minutes', () => {
    const { book, p, advance } = setup();
    advance(PAIRING_TTL_MS + 1);
    expect(book.onStart(msg({ text: `/start ${p.payload}` })).result).toBe('ignored');
    expect(book.preview(p.pairingId)).toBeNull();
  });

  it('a new mint voids the previous pairing (its confirm is gone)', () => {
    const { book, p } = setup();
    book.onStart(msg({ text: `/start ${p.payload}` }));
    book.mint({ scope: 'abcdef0123456789', target: 'super', botId: 99, botUsername: 'super_bot' });
    expect(book.confirm(p.pairingId, { botId: 99, userId: 42 })).toEqual({ result: 'gone' });
  });

  it('5 wrong payloads lock THAT sender for the TTL; another sender is unaffected', () => {
    const { book, p, advance } = setup();
    for (let i = 0; i < 4; i++) expect(book.onStart(msg({ text: `/start ${'A'.repeat(22)}`, from: { id: 7 } })).result).toBe('wrong');
    expect(book.onStart(msg({ text: `/start ${'B'.repeat(22)}`, from: { id: 7 } })).result).toBe('locked');
    // Locked: even the right payload is refused for this sender.
    expect(book.onStart(msg({ text: `/start ${p.payload}`, from: { id: 7 } })).result).toBe('locked');
    // The owner is a different sender: still pairs.
    expect(book.onStart(msg({ text: `/start ${p.payload}`, from: { id: 42 } })).result).toBe('pending');
    advance(PAIRING_TTL_MS + 1);
    expect(book.onStart(msg({ text: '/start x', from: { id: 7 } })).result).not.toBe('locked');
  });

  it('a bare /start, a group, a bot sender change nothing and count nothing', () => {
    const { book, p } = setup();
    expect(book.onStart(msg({ text: '/start' })).result).toBe('ignored');
    expect(book.onStart(msg({ text: `/start ${p.payload}`, chat: { type: 'group' } })).result).toBe('ignored');
    expect(book.onStart(msg({ text: `/start ${p.payload}`, from: { is_bot: true } })).result).toBe('ignored');
    expect(book.preview(p.pairingId)).toBeNull();
    expect(book.onStart(msg({ text: `/start ${p.payload}` })).result).toBe('pending');
  });

  it('a pairingId of the wrong shape never previews', () => {
    const { book, p } = setup();
    book.onStart(msg({ text: `/start ${p.payload}` }));
    expect(book.preview('short')).toBeNull();
    expect(book.preview(`${p.pairingId}x`)).toBeNull();
  });

  it('payload parsing and label cleaning', () => {
    expect(startPayloadOf('/start abc')).toBe('abc');
    expect(startPayloadOf('/start@super_bot abc')).toBe('abc');
    expect(startPayloadOf('/start')).toBe('');
    expect(startPayloadOf('merhaba')).toBeNull();
    expect(cleanLabel('Mehmet‮​gnp.exe\u0007')).toBe('Mehmetgnp.exe');
  });
});
