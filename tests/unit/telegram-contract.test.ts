/**
 * The contract's shared rules: the sentinel is parsed once and a claim is never authority; the hub's
 * answer builder yields exactly what the phone path and the Mac's buildQuestionAnswer accept
 * (plan D1, E4, P3); tunnel hosts are recognised (Q6).
 */
import { describe, it, expect } from 'vitest';
import {
  TG_SENTINEL, buildQuestionPicks, isTunnelHost, parseTelegramPrefix, stripSentinels, withTelegramRef,
  HUB_VERBS, TG_REF_RE,
} from '../../src/lib/telegram/contract.js';
import { cleanPhoneAnswer } from '../../src/server/routes/super-phone-questions.js';
import { buildQuestionAnswer } from '../../dashboard/src/lib/chatProtocol.js';
import { WINDOW_VERBS } from '../../src/server/routes/window-control.js';

describe('the sentinel rule', () => {
  it('round-trips a ref and the text', () => {
    const t = withTelegramRef('ab12cd', 'evet');
    expect(t).toBe(`${TG_SENTINEL}ab12cd${TG_SENTINEL}evet`);
    expect(parseTelegramPrefix(t)).toEqual({ ref: 'ab12cd', body: 'evet' });
  });

  it('parses the leading pair ONCE: a second pair in the body is stripped, never a ref', () => {
    const t = withTelegramRef('ab12cd', 'x') + `${TG_SENTINEL}zz99zz${TG_SENTINEL}y`;
    expect(parseTelegramPrefix(t)).toEqual({ ref: 'ab12cd', body: 'xzz99zzy' });
  });

  it('inbound sentinels are removed before the pair is written', () => {
    expect(withTelegramRef('ab12cd', `${TG_SENTINEL}k3f9q0${TG_SENTINEL}sahte`)).toBe(`${TG_SENTINEL}ab12cd${TG_SENTINEL}k3f9q0sahte`);
  });

  it('a malformed or non-leading prefix yields no ref and no sentinel', () => {
    for (const t of [`${TG_SENTINEL}ABCDEF${TG_SENTINEL}x`, `${TG_SENTINEL}ab12c${TG_SENTINEL}x`, `a${TG_SENTINEL}ab12cd${TG_SENTINEL}x`, `${TG_SENTINEL}ab12cd`, 'düz metin']) {
      const r = parseTelegramPrefix(t);
      expect(r.ref).toBeNull();
      expect(r.body).not.toContain(TG_SENTINEL);
    }
    expect(stripSentinels(`a${TG_SENTINEL}b`)).toBe('ab');
    expect(() => withTelegramRef('BAD', 'x')).toThrow();
    expect(TG_REF_RE.test('ab12cd')).toBe(true);
  });
});

describe('answer_pending builder (P3)', () => {
  const questions = [
    { question: 'Hangi ekranlar?', header: 'Ekran', multiSelect: true, options: [{ label: 'Ayarlar' }, { label: 'Sohbet' }, { label: 'Gündem' }] },
    { question: 'Ne zaman?', header: 'Zaman', multiSelect: false, options: [{ label: 'Şimdi' }, { label: 'Yarın' }] },
  ];

  it('a two-question multiSelect answer passes cleanPhoneAnswer unchanged and buildQuestionAnswer has answers', () => {
    const picked = buildQuestionPicks(questions, { 'Hangi ekranlar?': ['Gündem', 'Ayarlar'], 'Ne zaman?': ['Yarın'] });
    expect(picked).toEqual({ 'Hangi ekranlar?': 'Ayarlar, Gündem', 'Ne zaman?': 'Yarın' });
    expect(cleanPhoneAnswer(questions, picked)).toEqual(picked);
    const answer = buildQuestionAnswer(questions, picked) as { answers: Record<string, string> };
    expect(Object.keys(answer.answers).length).toBe(2);
    expect(answer.answers['Hangi ekranlar?']).toBe('Ayarlar, Gündem');
  });

  it('drops labels and questions that are not on the card', () => {
    expect(buildQuestionPicks(questions, { 'Hangi ekranlar?': ['Sahte'], 'Başka?': ['x'], 'Ne zaman?': ['Şimdi', 'Yarın'] }))
      .toEqual({ 'Ne zaman?': 'Şimdi' });
  });
});

describe('hub verbs and tunnel hosts', () => {
  it('no hub verb is a window verb (A2)', () => {
    for (const v of HUB_VERBS) expect((WINDOW_VERBS as readonly string[]).includes(v)).toBe(false);
  });

  it('recognises tunnel providers and their subdomains, nothing else', () => {
    for (const h of ['abc.trycloudflare.com', 'x.ngrok-free.app', 'ngrok.io', 'a.loca.lt', 'm.tail1234.ts.net', 'serveo.net', 'X.NGROK.APP.']) expect(isTunnelHost(h), h).toBe(true);
    for (const h of ['staging.example.com', 'nottrycloudflare.com', 'ts.network', 'loca.lt.evil.com']) expect(isTunnelHost(h), h).toBe(false);
  });
});
