/**
 * One answer reaches a Telegram chat once per Super turn (owner 2026-11-17: "aynı mesajı iki kere
 * attın bak yine bunu fixle"). The Super wrote its answer under a `re:` mark, ran `super ask`, then
 * wrote the same answer again in other words: text, card, text, both texts on his phone. The texts
 * below are the two from his screenshot.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SAME_TEXT, TextLedger, newTurn, sameText, textMarks, textWords } from '../../src/server/telegram/sent-once.js';
import { TelegramHub, type ActiveBinding } from '../../src/server/telegram/hub.js';

const FIRST = `**Evet, daha mantıklı. A'nın özü zaten bu; sürükleme kısmı gerekmiyor.**

**Senin dediğinle sonuç**
• Ekran genişken kart bugünkü gibi sohbetin yanında duruyor.
• Yer yetmeyince kart kendiliğinden ince bir sekmeye kapanıyor, sohbet tam boy kalıyor. Ekran hiç bölünmüyor.
• Sekmeye basınca kart sohbetin üstünde büyük açılıyor, bir daha basınca ya da çarpıya basınca kapanıyor. Telefonda da aynısı oluyor.
• Sürüklenecek bir çizgi olmadığı için iş daha da küçülüyor.

Bu haliyle yapımı başlatmak için **bir soru bekliyor**.`;

const REWORDED = `**Evet, daha mantıklı. Önerdiğim A yolunun özü zaten bu, sürükleme kısmına gerek kalmıyor.**

**Senin dediğinle sonuç**
• Ekran genişken kart bugünkü gibi sohbetin yanında duruyor.
• Yer yetmeyince kart kendiliğinden ince bir sekmeye kapanıyor ve sohbet tam boy kalıyor. Ekran hiç bölünmüyor.
• Sekmeye basınca kart sohbetin üstünde büyük açılıyor, tekrar basınca ya da çarpıya basınca kapanıyor. Telefonda da aynısı oluyor.
• Sürüklenen çizgi olmadığı için iş daha da küçülüyor.

Bu haliyle yapımı başlatmak için **bir soru bekliyor**. Önceki A/B sorusunu kapattım.`;

const OTHER = 'Kart kapandı. Yapım başladı, bitince GitHub\'da onayına açılır; ayrı bir kopyada çalışıyor ve ekranın sağında görünüyor.';

describe('the measure', () => {
  it('the re-worded repeat is the same text; a different reply is not', () => {
    expect(sameText(textWords(FIRST), textWords(REWORDED))).toBe(true);
    expect(sameText(textWords(FIRST), textWords(OTHER))).toBe(false);
    expect(SAME_TEXT).toBe(0.6);
  });

  it('short texts are a repeat only word for word', () => {
    expect(sameText(textWords('Tamam, başlıyorum.'), textWords('tamam başlıyorum'))).toBe(true);
    expect(sameText(textWords('Tamam, başlıyorum.'), textWords('Tamam, bitti.'))).toBe(false);
    expect(sameText(textWords(''), textWords(''))).toBe(false);
  });

  it('a short line inside a long report is not a repeat of it', () => {
    expect(sameText(textWords(FIRST), textWords('Ekran hiç bölünmüyor, sohbet tam boy kalıyor.'))).toBe(false);
  });
});

describe('the text ledger: a re-said answer after a question card', () => {
  const ledger = new TextLedger();
  const claim = ledger.claim.bind(ledger);

  it('after the card, the re-worded answer is dropped; a different text is not; a new turn may say it again', () => {
    const sid = 'c-1';
    expect(claim('chat', sid, FIRST, ['gy910q'], 1, 0)).not.toBeNull();
    ledger.noteCard(sid, 1);
    expect(ledger.cardsOf(sid, 1)).toBe(1);
    expect(claim('chat', sid, REWORDED, [], 1, 1)).toBeNull();
    expect(claim('chat', sid, OTHER, [], 1, 1)).not.toBeNull();
    expect(ledger.cardsOf(sid, 2)).toBe(0);
    expect(claim('chat', sid, REWORDED, [], 2, 0)).not.toBeNull();
  });

  it('with no card between them, two texts of one shape both go (two job reports)', () => {
    const sid = 'c-2';
    expect(claim('chat', sid, FIRST, [], 1, 0)).not.toBeNull();
    expect(claim('chat', sid, REWORDED, [], 1, 0)).not.toBeNull();
  });

  it('two answers to different refs never collapse, whatever their words', () => {
    const sid = 'c-3';
    expect(claim('chat', sid, FIRST, ['aaa111'], 1, 0)).not.toBeNull();
    expect(claim('chat', sid, REWORDED, ['bbb222'], 1, 1)).not.toBeNull();
    // Under the same ref, after the card, it is the repeat.
    expect(claim('chat', sid, REWORDED, ['aaa111'], 1, 1)).toBeNull();
  });

  // The reviewer's two cases (both score 0.65-0.71 on words alone).
  it('another job\'s report of the same template goes, even after a card', () => {
    const sid = 'c-4';
    const report = (job: string, pr: number, wt: string) => `**${job} işi bitti.** PR #${pr} açıldı, testler geçti, onayına hazır. Çalıştığı kopya: \`${wt}\`. Bir şey eksikse söyle, aynı kopyada düzeltirim; yoksa birleştirme senin onayınla olur.`;
    expect(claim('chat', sid, report('Giriş ekranı', 41, 'wt/giris'), [], 1, 0)).not.toBeNull();
    expect(claim('chat', sid, report('Ödeme ekranı', 42, 'wt/odeme'), [], 1, 1)).not.toBeNull();
  });

  it('a correction goes, even after a card', () => {
    const sid = 'c-5';
    expect(claim('chat', sid, 'Giriş ekranı işi bitti, testler geçti, 12/12 yeşil; onayına hazır, kart seni bekliyor ve bir soru açık.', [], 1, 0)).not.toBeNull();
    expect(claim('chat', sid, "Düzeltme: giriş ekranı işi bitti ama testler geçmedi, 3'ü kırmızı; onayına hazır değil, kart seni bekliyor ve bir soru açık.", [], 1, 1)).not.toBeNull();
    expect([...textMarks('PR #42, `wt/odeme`, 3 kırmızı')]).toEqual(['#42', '`wt/odeme`', '3']);
  });

  it('another chat or another session is not this one', () => {
    expect(claim('chat', 'c-6', FIRST, [], 1, 0)).not.toBeNull();
    expect(claim('other', 'c-6', REWORDED, [], 1, 1)).not.toBeNull();
    expect(claim('chat', 'c-7', REWORDED, [], 1, 1)).not.toBeNull();
  });

  it('a send that failed gives its claim back', () => {
    const sid = 'c-8';
    ledger.release('chat', sid, claim('chat', sid, FIRST, [], 1, 0));
    expect(claim('chat', sid, REWORDED, [], 1, 1)).not.toBeNull();
  });
});

describe('the hub sends the re-worded repeat once (text, card, text)', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tg-cift-metin-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  function setup(sid: string) {
    const sent: string[] = [];
    let mid = 100;
    const transport = {
      sendMessage: async (_c: number, html: string) => { sent.push(html); return { message_id: ++mid, text: html }; },
      sendChatAction: async () => true,
    };
    const hub = new TelegramHub({ home });
    const ab = {
      key: '0123456789abcdef/super', scope: '0123456789abcdef', target: 'super',
      binding: { v: 1, token: 't', botId: 1, botUsername: 'b', chatId: 777, userId: 777, boundAt: '' },
      transport, poller: null, done: Promise.resolve(), chain: Promise.resolve(), contextRoot: null, projectName: 'X',
    } as unknown as ActiveBinding;
    hub.active.set(ab.key, ab);
    (hub as unknown as { superSessions: Map<string, string> }).superSessions.set(sid, ab.key);
    (hub as unknown as { presence: Map<string, unknown> }).presence.set(ab.key, { via: 'telegram', at: Date.now() });
    return { hub, sent };
  }

  it('text, card, the same answer re-worded: not sent; a different text is', async () => {
    const sid = 'h-1';
    const { hub, sent } = setup(sid);
    newTurn(sid);
    expect(await hub.onAssistantText(sid, `<!-- re:gy910q -->\n${FIRST}`, { turns: [], inputs: undefined })).toBe(true);
    // Without a card between them, the second text goes (it may be another subject).
    // The `super ask` card is queued (asks.ts offerItem), then the re-worded answer: dropped.
    hub.noteQuestionCard(sid);
    expect(await hub.onAssistantText(sid, REWORDED, { turns: [], inputs: undefined })).toBe(false);
    expect(await hub.onAssistantText(sid, `<!-- re:gy910q -->\n${OTHER}`, { turns: [], inputs: undefined })).toBe(true);
    expect(sent.join('\n')).toContain('sürükleme kısmı gerekmiyor');
    expect(sent.join('\n')).not.toContain('Önerdiğim A yolunun');
    expect(sent.join('\n')).toContain('Yapım başladı');
    // The next turn, the owner asks again: it goes.
    newTurn(sid);
    expect(await hub.onAssistantText(sid, REWORDED, { turns: [], inputs: undefined })).toBe(true);
  });

  it('two sections of one text under different refs both go', async () => {
    const sid = 'h-2';
    const { hub, sent } = setup(sid);
    newTurn(sid);
    hub.noteQuestionCard(sid);
    expect(await hub.onAssistantText(sid, `<!-- re:aaa111 -->\n${FIRST}\n\n<!-- re:bbb222 -->\n${REWORDED}`, { turns: [], inputs: undefined })).toBe(true);
    expect(sent.join('\n')).toContain('sürükleme kısmı gerekmiyor');
    expect(sent.join('\n')).toContain('Önerdiğim A yolunun');
  });
});
