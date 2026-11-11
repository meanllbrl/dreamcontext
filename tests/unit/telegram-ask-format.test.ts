import { describe, expect, it } from 'vitest';
import { drawingCaption, drawingTag, formatAskCardMessages, formatAskQuestionHtml, withDrawingNotes } from '../../src/lib/telegram/ask-format.js';
import { TG_TEXT_MAX } from '../../src/lib/telegram/contract.js';
import { richQuestionsOf } from '../../src/server/telegram/rich-asks.js';
import { registryQuestions, readPendingQuestion } from '../../src/lib/assistant/chat-registry.js';

const card = {
  question: 'Bozuk iki ödeme testini düzelteyim mi?',
  description: 'Ürün sağlam, test eski kalmış: önceden ödenmiş parayı saymıyor.',
  options: [
    { label: 'Evet, testi düzelt', description: 'Küçük iş, yerel commit, push yok' },
    { label: 'Şimdilik bırak', description: 'Testler kırmızı kalır' },
  ],
};

describe('formatAskQuestionHtml', () => {
  it('draws title, question, description, then one line per described option', () => {
    const html = formatAskQuestionHtml(card, { title: 'Ödeme testi → düzeltme' });
    expect(html).toBe([
      '❓ <b>Ödeme testi → düzeltme</b>',
      'Bozuk iki ödeme testini düzelteyim mi?',
      '',
      'Ürün sağlam, test eski kalmış: önceden ödenmiş parayı saymıyor.',
      '',
      '• <b>Evet, testi düzelt</b>: Küçük iş, yerel commit, push yok',
      '• <b>Şimdilik bırak</b>: Testler kırmızı kalır',
    ].join('\n'));
  });

  it('adds no empty lines for missing descriptions, and skips undescribed options', () => {
    expect(formatAskQuestionHtml({ question: 'Q?', options: [{ label: 'A' }, { label: 'B', description: '  ' }] })).toBe('❓ Q?');
    expect(formatAskQuestionHtml({ question: 'Q?', options: [{ label: 'A' }, { label: 'B', description: 'why' }] })).toBe('❓ Q?\n\n• <b>B</b>: why');
    expect(formatAskQuestionHtml({ question: 'Q?', description: 'd' })).toBe('❓ Q?\n\nd');
  });

  it('escapes HTML and redacts secrets in every part', () => {
    const html = formatAskQuestionHtml({
      question: 'a <b> & c?',
      description: 'key sk-ant-abcdefghijklmnopqrstuvwxyz0123',
      options: [{ label: '<x>', description: '"q" & <i>' }],
    }, { title: '<t>', lead: 'iş & <l>' });
    expect(html).toContain('<b>&lt;t&gt;</b>');
    expect(html).toContain('iş &amp; &lt;l&gt;');
    expect(html).toContain('a &lt;b&gt; &amp; c?');
    expect(html).toContain('• <b>&lt;x&gt;</b>: &quot;q&quot; &amp; &lt;i&gt;');
    expect(html).not.toContain('sk-ant-');
    expect(html).toContain('[gizli]');
  });

  it('trims the descriptions under the limit, never the question or labels', () => {
    const long = 'ç'.repeat(5000);
    const q = { question: 'Uzun mu?', description: long, options: Array.from({ length: 8 }, (_, i) => ({ label: `Seçenek ${i}`, description: long })) };
    const html = formatAskQuestionHtml(q, { title: 'Başlık' });
    expect(html.length).toBeLessThanOrEqual(TG_TEXT_MAX);
    expect(html).toContain('Uzun mu?');
    expect(html).toContain('…');
    for (let i = 0; i < 8; i++) expect(html).toContain(`• <b>Seçenek ${i}</b>: `);
    const tight = formatAskQuestionHtml(q, { title: 'Başlık', max: 300 });
    expect(tight.length).toBeLessThanOrEqual(300);
    expect(tight.startsWith('❓ <b>Başlık</b>\nUzun mu?')).toBe(true);
  });

  it('keeps prefix, suffix and footer in place', () => {
    expect(formatAskQuestionHtml({ question: 'Q?', description: 'd' }, { prefix: 'P ', suffix: ' (1/2)', footer: '<i>f</i>' }))
      .toBe('P ❓ Q? (1/2)\n\nd\n<i>f</i>');
  });

  it('a no-button card: one message per question, title first, footer last', () => {
    const msgs = formatAskCardMessages([card, { question: 'İkinci?' }], { title: 'T', footer: 'F' });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].startsWith('❓ <b>T</b>\nBozuk iki ödeme testini düzelteyim mi? (1/2)')).toBe(true);
    expect(msgs[0]).not.toContain('\nF');
    expect(msgs[1]).toBe('❓ İkinci? (2/2)\nF');
  });
});

describe('an option\'s drawing is named by its letter (owner 2026-11-11: "hangisi sade hangisi?")', () => {
  const q = { question: 'Sade hâline mi geçsin?', options: [
    { label: 'Sade hâline geçsin', description: 'Tek başlık', preview: '<div>a</div>' },
    { label: 'Şu anki gibi kalsın', preview: '<div>b</div>' },
    { label: 'Başka', description: 'Notuna yaz' },
  ] };

  it('the letter follows the option\'s place, and the caption is "A · label"', () => {
    expect([0, 1, 2].map(drawingTag)).toEqual(['A', 'B', 'C']);
    expect(drawingCaption(1, '  Şu anki\n gibi kalsın ')).toBe('B · Şu anki gibi kalsın');
  });

  it('a drawn option\'s line carries the same letter as its picture, even with no note', () => {
    const html = formatAskQuestionHtml(withDrawingNotes(q, 0, new Set(['0:0', '0:1'])));
    expect(html).toContain('• <b>A · Sade hâline geçsin</b> (çizim A): Tek başlık');
    expect(html).toContain('• <b>B · Şu anki gibi kalsın</b> (çizim B)');
    expect(html).toContain('• <b>Başka</b>: Notuna yaz');
    expect(html).not.toContain('yukarıda');
  });

  it('a drawing that did not go has no letter and says it is on the Mac', () => {
    const html = formatAskQuestionHtml(withDrawingNotes(q, 0, new Set(['0:0'])));
    expect(html).toContain('• <b>A · Sade hâline geçsin</b> (çizim A)');
    expect(html).toContain("• <b>Şu anki gibi kalsın</b>: Çizimi Mac'te (Telegram'a çizilemedi).");
  });

  it('a long message trims the notes but never a drawn option\'s letter line', () => {
    const long = { ...q, description: 'x'.repeat(3000), options: q.options.map((o) => ({ ...o, description: 'y'.repeat(900) })) };
    const html = formatAskQuestionHtml(withDrawingNotes(long, 0, new Set(['0:0', '0:1'])), { max: 400 });
    expect(html.length).toBeLessThanOrEqual(400);
    expect(html).toContain('<b>A · Sade hâline geçsin</b> (çizim A)');
    expect(html).toContain('<b>B · Şu anki gibi kalsın</b> (çizim B)');
  });
});

describe('descriptions reach the senders', () => {
  it('a child AskUserQuestion keeps its title, description and option descriptions', () => {
    const pq = readPendingQuestion({
      type: 'control_request', request_id: 'r1',
      request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { title: 'Ödeme testi', questions: [card] } },
    });
    expect(pq?.title).toBe('Ödeme testi');
    expect(pq?.questions?.[0].description).toBe(card.description);
    expect(pq?.questions?.[0].options[1].description).toBe('Testler kırmızı kalır');
    expect(registryQuestions([{ question: 'Q', options: [] }])?.[0]).not.toHaveProperty('description');
  });

  it('rich questions carry the descriptions', () => {
    const [q] = richQuestionsOf([card]);
    expect(q.description).toBe(card.description);
    expect(q.options[0].description).toBe('Küçük iş, yerel commit, push yok');
  });
});

describe('two options with one label', () => {
  it('the letter follows the option that was drawn, by its place, never by its label', () => {
    const q = { question: 'Hangisi?', options: [{ label: 'Kart', preview: '<p>1</p>' }, { label: 'Kart', preview: '<p>2</p>' }] };
    // The first did not draw, the second did: the line and the picture both say B.
    const html = formatAskQuestionHtml(withDrawingNotes(q, 0, new Set(['0:1'])));
    expect(html).toContain('• <b>B · Kart</b> (çizim B)');
    expect(html).not.toContain('çizim A');
    expect(html).toContain("• <b>Kart</b>: Çizimi Mac'te");
  });
});
