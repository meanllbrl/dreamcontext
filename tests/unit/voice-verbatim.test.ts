/**
 * The guard that stands between a speech model that did not do its job and the owner.
 * (Its twin, the transcription echo guard, retired with cloud dictation on 2026-09-27.)
 *
 * Every string in here is REAL — measured against `openai/gpt-audio-mini` on the owner's key
 * on 2026-09-07, when the mode spoke a conversation of its own over a transcript that said
 * something else, and submitted its own prompt to a tool-enabled agent as if the owner had
 * spoken it. They are kept verbatim so a future prompt change is graded against what actually
 * went wrong rather than against what we imagine the failure looks like.
 */

import { describe, it, expect } from 'vitest';
import { verbatimRatio, readVerbatim, VERBATIM_FLOOR, speechTokens } from '../../src/lib/voice/verbatim.js';

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
