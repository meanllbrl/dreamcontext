import { describe, expect, it } from 'vitest';
import { formatAskCardMessages, formatAskQuestionHtml } from '../../src/lib/telegram/ask-format.js';
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
