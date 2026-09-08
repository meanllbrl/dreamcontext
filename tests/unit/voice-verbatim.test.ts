/**
 * The two guards that stand between a model that did not do its job and the owner.
 *
 * Every string in here is REAL — measured against `openai/gpt-audio-mini` on the owner's key
 * on 2026-09-07, when the mode spoke a conversation of its own over a transcript that said
 * something else, and submitted its own prompt to a tool-enabled agent as if the owner had
 * spoken it. They are kept verbatim so a future prompt change is graded against what actually
 * went wrong rather than against what we imagine the failure looks like.
 */

import { describe, it, expect } from 'vitest';
import { verbatimRatio, readVerbatim, VERBATIM_FLOOR, speechTokens } from '../../src/lib/voice/verbatim.js';
import { usableTranscript, isPromptEcho, NO_SPEECH } from '../../src/lib/voice/echo.js';
import { TRANSCRIBE_ASK } from '../../src/server/routes/agent-voice.js';

/** Line sent → what the model actually spoke, when it answered instead of reading. */
const ANSWERED: Array<[string, string]> = [
  ['Söyle, hangi konuya girelim.',
    'Tabii, şimdi o zaman bir konu seçebiliriz. Örneğin, günlük hayat, seyahat, teknoloji veya '
    + 'sanat gibi bir kategoriden bahsedebiliriz. Seni daha çok hangi ilgi alanı çekiyor?'],
  ['Evet, duyuyorum. Net geliyor.',
    'Anladım. Şu anda sesim net bir şekilde geliyor mu? Bu konuda bana daha fazla bilgi verebilir misin?'],
  ['Hazırım.', 'Hazırım. Peki, ne yapmak istersin?'],
  ['Ben bu projenin mühendislik ortağıyım, NativeMinds bilgi bankası beyninin içinde çalışıyorum.',
    'Anladım, bu projede mühendislik ortağı olduğunuzu paylaştığınız için teşekkür ederim. Şu anda '
    + 'NativeMinds bilgi bankası beyninin içinde nasıl bir çalışma yürütüldüğünü daha detaylı '
    + 'anlatmak ister misiniz?'],
  ['Evet, duyuyorum. Net geliyor.',
    'Harika, sesim net bir şekilde ulaşıyor anladığım kadarıyla. Şimdi ne yapmak istersiniz, lütfen söyleyin.'],
];

/** Line sent → what the model spoke when it did the job. Two of these are NOT byte-identical,
 *  which is the whole reason the check is a ratio and not an equality. */
const READ: Array<[string, string]> = [
  ['Söyle, hangi konuya girelim.', 'Söyle, hangi konuya girelim.'],
  ['Yes, I can hear you. Loud and clear.', 'Yes, I can hear you — loud and clear.'],
  ['Ben bu projenin mühendislik ortağıyım, NativeMinds bilgi bankası beyninin içinde çalışıyorum.',
    'Ben bu projenin mühendislik ortağıyım, NativeMinds bilgi bankası beynin içinde çalışıyorum.'],
  ['Testler 12 saniyede bitti, 3 tanesi kırmızı.', 'Testler 12 saniyede bitti, 3 tanesi kırmızı.'],
];

describe('verbatimRatio — did it read the line, or answer it', () => {
  it('scores every measured ANSWER below the floor', () => {
    for (const [line, spoken] of ANSWERED) {
      const score = verbatimRatio(line, spoken);
      expect(score, `answered: ${line}`).toBeLessThan(VERBATIM_FLOOR);
      expect(readVerbatim(line, spoken)).toBe(false);
    }
  });

  it('scores every measured READ above the floor, punctuation and a dropped suffix included', () => {
    for (const [line, spoken] of READ) {
      const score = verbatimRatio(line, spoken);
      expect(score, `read: ${line}`).toBeGreaterThanOrEqual(VERBATIM_FLOOR);
      expect(readVerbatim(line, spoken)).toBe(true);
    }
  });

  it('counts word ORDER, so an answer that reuses the line\'s words still fails', () => {
    // Every content word of the line appears in the answer — a set-based check would pass it.
    expect(readVerbatim('Net geliyor.', 'Geliyor mu, net değil mi, onu söyle')).toBe(false);
  });

  it('FAILS OPEN when the provider sent no transcript — the check must not become a mute', () => {
    expect(readVerbatim('Bir şey söyle.', '')).toBe(true);
    expect(readVerbatim('Bir şey söyle.', '   ')).toBe(true);
  });

  it('is case-, accent- and punctuation-insensitive', () => {
    expect(speechTokens('Şu an, TAMAM mı?')).toEqual(speechTokens('şu an tamam mı'));
  });
});

describe('usableTranscript — a take the model did not hear is never submitted', () => {
  it('drops the ask recited back, which is what reached the agent as the owner\'s words', () => {
    // Measured: 1.5 s of room tone, three times, three echoes of the prompt.
    expect(usableTranscript(TRANSCRIBE_ASK, TRANSCRIBE_ASK)).toBe('');
    // And the trimmed echo — the model drops the last sentence about as often as it repeats
    // the paragraph whole.
    const trimmed = TRANSCRIBE_ASK.split('If the audio')[0].trim();
    expect(usableTranscript(trimmed, TRANSCRIBE_ASK)).toBe('');
    expect(isPromptEcho(trimmed, TRANSCRIBE_ASK)).toBe(true);
  });

  it('drops the no-speech sentinel, however the model dresses it', () => {
    expect(usableTranscript(NO_SPEECH, TRANSCRIBE_ASK)).toBe('');
    expect(usableTranscript('NO_SPEECH.', TRANSCRIBE_ASK)).toBe('');
    expect(usableTranscript(' no_speech ', TRANSCRIBE_ASK)).toBe('');
  });

  it('keeps a real transcript — including one that merely mentions the sentinel', () => {
    expect(usableTranscript('sleep başlat', TRANSCRIBE_ASK)).toBe('sleep başlat');
    expect(usableTranscript('  Şu an beni duyabiliyor musun?  ', TRANSCRIBE_ASK))
      .toBe('Şu an beni duyabiliyor musun?');
    expect(usableTranscript('the no_speech branch never runs', TRANSCRIBE_ASK))
      .toBe('the no_speech branch never runs');
  });

  it('treats a non-string, or nothing at all, as nothing heard', () => {
    expect(usableTranscript(undefined, TRANSCRIBE_ASK)).toBe('');
    expect(usableTranscript({ text: 'hi' }, TRANSCRIBE_ASK)).toBe('');
    expect(usableTranscript('   ', TRANSCRIBE_ASK)).toBe('');
  });
});
