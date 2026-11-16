import { describe, expect, it } from 'vitest';
import type { CardOut } from '../../src/server/telegram/cards.js';
import type { MediaItem } from '../../src/server/telegram/pictures.js';
import { cardItemKey, claimThisTurn, freshCardOuts, newTurn, release, turnOf } from '../../src/server/telegram/sent-once.js';

// A page card printed to PDF twice in one turn: the bytes differ (the PDF's creation date).
const pdf = (stamp: string, page = '<h1>Yol haritası</h1>'): MediaItem => ({ kind: 'document', title: 'Yol haritası', source: page, file: { name: 'Yol haritası.pdf', data: Buffer.from(`%PDF-1.4 ${stamp}`), contentType: 'application/pdf' } });
const png = (bytes: string): MediaItem => ({ kind: 'photo', title: 'Insight', file: { name: 'insight-with-a-very-long-ref-name-cut-at-40.png', data: Buffer.from(bytes), contentType: 'image/png' } });
const report = { id: 'web-1', ref: 'reports/roadmap.html' };
const other = { id: 'web-2', ref: 'reports/other.html' };
const media = (m: MediaItem): CardOut => ({ kind: 'media', items: [m], title: m.title });
const reportKey = (m: MediaItem) => cardItemKey(report.id, report.ref, m, 0);

describe('one card file reaches a Telegram chat once per Super turn', () => {
  it("an ask's --show PDF is not sent again by the turn-end presentation of the same card", () => {
    const sid = 's-dup';
    // The ask's --show door claims the report before its upload.
    expect(claimThisTurn('chat', sid, [pdf('a')], reportKey)).toHaveLength(1);
    // The turn ends: the same card, open on the stage, is printed again (new bytes).
    expect(freshCardOuts('chat', sid, [{ card: report, out: media(pdf('b')) }]).outs).toEqual([]);
  });

  it('the other way round: the presentation claimed it first, the ask does not send it again', () => {
    const sid = 's-rev';
    expect(freshCardOuts('chat', sid, [{ card: report, out: media(pdf('a')) }]).outs).toHaveLength(1);
    // While that upload is still running, the ask's --show door checks: already claimed.
    expect(claimThisTurn('chat', sid, [pdf('b')], reportKey)).toEqual([]);
  });

  it('a failed send gives its claim back, so the other door still delivers it', () => {
    const sid = 's-fail';
    const a = pdf('a');
    claimThisTurn('chat', sid, [a], reportKey);
    release('chat', sid, [a], reportKey);
    expect(freshCardOuts('chat', sid, [{ card: report, out: media(pdf('b')) }]).outs).toHaveLength(1);
  });

  it('a different card in the same turn still goes, and text cards are never held back', () => {
    const sid = 's-other';
    claimThisTurn('chat', sid, [pdf('a')], reportKey);
    const text: CardOut = { kind: 'text', line: 'Görev: X', title: 'X' };
    const { outs, claimed } = freshCardOuts('chat', sid, [{ card: other, out: media(pdf('c')) }, { card: report, out: text }]);
    expect(outs).toHaveLength(2);
    expect(claimed).toHaveLength(1);
  });

  it('the next turn sends the same file again (the owner asked for it anew)', () => {
    const sid = 's-next';
    claimThisTurn('chat', sid, [pdf('a')], reportKey);
    newTurn(sid);
    expect(freshCardOuts('chat', sid, [{ card: report, out: media(pdf('b')) }]).outs).toHaveLength(1);
  });

  it("the presentation settling after a new turn began still keeps its own turn's record", () => {
    const sid = 's-settle';
    claimThisTurn('chat', sid, [pdf('a')], reportKey);
    const ended = turnOf(sid);
    newTurn(sid);
    expect(freshCardOuts('chat', sid, [{ card: report, out: media(pdf('b')) }], ended).outs).toEqual([]);
  });

  it('another chat (another bot) is its own record', () => {
    const sid = 's-chat';
    claimThisTurn('chat-a', sid, [pdf('a')], reportKey);
    expect(freshCardOuts('chat-b', sid, [{ card: report, out: media(pdf('b')) }]).outs).toHaveLength(1);
  });

  it('the same card edited after the owner answered (same turn) goes again', () => {
    const sid = 's-edit';
    claimThisTurn('chat', sid, [pdf('a')], reportKey);
    expect(freshCardOuts('chat', sid, [{ card: report, out: media(pdf('b', '<h1>Yol haritası v2</h1>')) }]).outs).toHaveLength(1);
  });

  it('every slice of one card goes, even when their file names are cut to the same name', () => {
    const sid = 's-slices';
    const out: CardOut = { kind: 'media', items: [png('1'), png('2'), png('3')], title: 'Insight' };
    const { outs, claimed } = freshCardOuts('chat', sid, [{ card: other, out }]);
    expect(claimed).toHaveLength(3);
    expect((outs[0] as Extract<CardOut, { kind: 'media' }>).items).toHaveLength(3);
  });
});
