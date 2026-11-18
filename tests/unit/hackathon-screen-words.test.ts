import { describe, expect, it } from 'vitest';
import {
  accusative, countOf, criteria, juryWhy, modelLabel, momentText, num, teamHue, wins, type JuryView,
} from '../../dashboard/src/components/hackathon/data';

/**
 * Design B's words (approved 19 Kas): "Kanıtçı'yı seç", "2 karşılaştırmanın 2'sini kazandı",
 * "6,8 / 10" with all four criteria. The suffixes follow Turkish vowel harmony; a wrong one
 * reads as broken Turkish on the one button the owner presses.
 */
describe('hackathon screen words', () => {
  it('puts a team name in the accusative by vowel harmony', () => {
    expect(accusative('Kanıtçı')).toBe("Kanıtçı'yı");
    expect(accusative('Sade')).toBe("Sade'yi");
    expect(accusative('Kontrol')).toBe("Kontrol'u");
    expect(accusative('Hikâyeci')).toBe("Hikâyeci'yi");
    expect(accusative('Göz')).toBe("Göz'ü");
    expect(accusative('Kanat')).toBe("Kanat'ı");
    expect(accusative('Ekip')).toBe("Ekip'i");
  });

  it('says how many of them in Turkish', () => {
    expect(countOf(2)).toBe("2'sini");
    expect(countOf(1)).toBe("1'ini");
    expect(countOf(3)).toBe("3'ünü");
    expect(countOf(6)).toBe("6'sını");
    expect(countOf(10)).toBe("10'unu");
    expect(countOf(0)).toBe("0'ını");
  });

  it('writes a score with the owner\'s decimal mark', () => {
    expect(num(6.8, 'tr')).toBe('6,8');
    expect(num(7, 'tr')).toBe('7');
    expect(num(6.84, 'en')).toBe('6.8');
  });

  const jury: JuryView = {
    scores: { a: 6.8, b: 5.4 }, originality: { a: 5, b: 4 }, ranking: ['a', 'b'], sameVendor: true,
    verdicts: [
      { a: 'a', b: 'b', order: 'ab', winner: 'a', why: 'A daha net.', scores: { a: { solves: 6, evidence: 7, feasible: 8, original: 5 }, b: { solves: 6, evidence: 4, feasible: 7, original: 4 } }, judge: { tool: 'claude', model: 'sonnet' } },
      { a: 'a', b: 'b', order: 'ba', winner: 'a', why: 'Yine A.', scores: { a: { solves: 7, evidence: 7, feasible: 8, original: 5 }, b: { solves: 6, evidence: 4, feasible: 7, original: 4 } } },
    ],
  };

  it('averages the four criteria over every verdict', () => {
    expect(criteria(jury, 'a')).toEqual({ solves: 6.5, evidence: 7, feasible: 8, original: 5 });
    expect(criteria(jury, 'zz')).toBeNull();
    expect(criteria({ ...jury, verdicts: [{ a: 'a', b: 'b', order: 'ab', winner: null, why: '' }] }, 'a')).toBeNull();
  });

  it('counts wins and quotes the reason of a verdict the team won', () => {
    expect(wins(jury, 'a')).toEqual({ won: 2, of: 2 });
    expect(wins(jury, 'b')).toEqual({ won: 0, of: 2 });
    expect(juryWhy(jury, 'a')).toEqual({ why: 'A daha net.', judge: { tool: 'claude', model: 'sonnet' } });
    expect(juryWhy(jury, 'b')?.why).toBe('A daha net.');
  });

  it('names a model as a person reads it', () => {
    expect(modelLabel('claude', 'haiku')).toBe('Claude Haiku');
    expect(modelLabel('claude', 'claude-sonnet-5-5')).toBe('Claude Sonnet');
    expect(modelLabel('codex', '')).toBe('Codex');
  });

  it('gives each team a stable colour by design order, never more than the palette', () => {
    const teams = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 'f' }];
    expect(teams.map((x) => teamHue(teams, x.id))).toEqual([1, 2, 3, 4, 5, 1]);
  });

  it('says a conductor moment as a sentence', () => {
    const t = (k: string) => ({ 'hk.moment.started': 'Sen başlattın', 'hk.moment.similar': 'Benzerlik ölçüldü', 'hk.moment.similarClose': 'Benzerlik ölçüldü: çok yakın' }[k] ?? k);
    expect(momentText('sahip başlattı', t)).toBe('Sen başlattın');
    expect(momentText('yakınlık: 1 çift ölçüldü, 1 çift çok yakın', t)).toBe('Benzerlik ölçüldü: çok yakın');
    expect(momentText('yakınlık: 3 çift ölçüldü', t)).toBe('Benzerlik ölçüldü');
    expect(momentText('tur 2 başladı', t)).toBe('Tur 2 başladı');
    expect(momentText('jüri önerisi: Sade (aynı firma); seçim senin', t)).toBe('Jüri önerisi: Sade; seçim senin');
  });
});
