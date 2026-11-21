/**
 * Telegram'da Super sade konuşur (owner 2026-11-21, "Hepsini uygula" on Doc's diagnosis): the
 * converter keeps an answer short on his phone whatever the agent wrote, a link he cannot open is
 * its words, and a job's status is one message drawn from a `dream-status` block.
 */
import { describe, it, expect } from 'vitest';
import { ANSWER_OPEN_MAX, foldAnswer, markdownToTelegramHtml, telegramHtmlToPlain, toTelegramMessages } from '../../src/lib/telegram/format.js';
import { jobStatusHtml, JOB_STATUS_MAX } from '../../src/lib/telegram/system-lines.js';
import { TELEGRAM_WRITING_RULE } from '../../src/lib/telegram/writing.js';
import { SUPER_TELEGRAM_LINE } from '../../src/server/chat-modes.js';

/** What shows with every folded quote closed. */
const openText = (html: string): string => telegramHtmlToPlain(html.replace(/<blockquote expandable>[\s\S]*?<\/blockquote>/g, ''));

/** A 1,400-character report with four bold heads, the shape the old rule asked for. */
const REPORT = [
  '**Canlıdaki sürüm doğru çalışıyor.**',
  '',
  '**Canlıda**',
  '- Hoca paneli açılıyor, ödemeler listeleniyor ve dün akşamki 14 kayıt eksiksiz göründü.',
  '- Velilere giden hatırlatmalar saat dokuzda çıktı, hiçbiri geri dönmedi.',
  '',
  '**Bekleyen**',
  '- Ali Rıza Hoca\'nın iki dersi takvimde çakışıyor; sen karar verince düzelteceğim.',
  '- Haftalık rapor sayfasında bir yazım hatası var, küçük.',
  '',
  '**Kontrol ne yapıyor**',
  '- Her sabah yedide giriş, ödeme ve takvim sayfalarını açıp ekran görüntüsü alıyor.',
  '- Bir sayfa açılmazsa sana tek satır yazıyor, açılırsa hiçbir şey yazmıyor.',
  '',
  '**Dikkat**',
  '- Ödeme sağlayıcısının test anahtarı ay sonunda bitiyor; yenisi gelmeden canlı ödemeye geçmeyelim.',
  '- Çağrı şöyle dedi: ılık İğdır üzümü, Göçük ve Şişli; Türkçe harfler her yerde doğru çıkıyor.',
  '- Bir de eski sürümden kalan iki boş tablo var, silinebilir ama acelesi yok, önce yedek alırız.',
].join('\n');

describe('an answer stays short on his phone (AC1)', () => {
  it('a long, four-head report: at most ~450 open characters, no head open, the rest folded', () => {
    expect(REPORT.length).toBeGreaterThan(800);
    const html = markdownToTelegramHtml(REPORT, { fold: 'answer' });
    expect(openText(html).length).toBeLessThanOrEqual(ANSWER_OPEN_MAX);
    expect(html.startsWith('<b>Canlıdaki sürüm doğru çalışıyor.</b>')).toBe(true);
    // No head line stays open: every one sits behind the fold.
    const open = html.replace(/<blockquote expandable>[\s\S]*?<\/blockquote>/g, '');
    expect(open.match(/^<b>[^<]*<\/b>$/gm)?.length ?? 0).toBe(1);
    expect(html).toContain('<blockquote expandable>');
    // Nothing is lost: every word is still there, folded.
    expect(telegramHtmlToPlain(html).replace(/\s+/g, ' ')).toContain('Türkçe harfler her yerde doğru çıkıyor');
    for (const h of ['Canlıda', 'Bekleyen', 'Kontrol ne yapıyor', 'Dikkat']) expect(telegramHtmlToPlain(html)).toContain(h);
  });

  it('a short answer is never folded', () => {
    const md = '**Hazır.**\n\nTestler geçti.\n\nYarın sabah bakarsın.';
    expect(markdownToTelegramHtml(md, { fold: 'answer' })).toBe(markdownToTelegramHtml(md));
    expect(markdownToTelegramHtml(md, { fold: 'answer' })).not.toContain('blockquote');
  });

  it('an Ayrıntı quote already there joins the fold; a code block stays outside every fold', () => {
    const long = 'Uzun bir açıklama cümlesi burada duruyor ve devam ediyor. '.repeat(6);
    const md = `**Bitti.**\n\n${long}\n\n\`\`\`bash\nnpm test\n\`\`\`\n\n> **Ayrıntı**\n> iç ayrıntı`;
    const html = markdownToTelegramHtml(md, { fold: 'answer' });
    expect(html).toContain('<pre><code class="language-bash">npm test</code></pre>');
    // Telegram never gets a code block or a quote inside a quote.
    for (const q of html.match(/<blockquote expandable>[\s\S]*?<\/blockquote>/g) ?? []) {
      expect(q.slice(1)).not.toMatch(/<blockquote|<pre/);
    }
    expect(telegramHtmlToPlain(html)).toContain('iç ayrıntı');
    expect(openText(html).length).toBeLessThanOrEqual(ANSWER_OPEN_MAX);
  });

  it('one long first block folds after its first lines; tags stay balanced', () => {
    const lines = Array.from({ length: 14 }, (_, i) => `Satır ${i + 1}: ılık İğdır üzümü **önemli** bir not burada.`);
    const html = foldAnswer(markdownToTelegramHtml(lines.join('\n')));
    expect(openText(html).length).toBeLessThanOrEqual(ANSWER_OPEN_MAX);
    expect((html.match(/<b>/g) ?? []).length).toBe((html.match(/<\/b>/g) ?? []).length);
    expect(telegramHtmlToPlain(html)).toContain('Satır 14');
  });

  it('a very long answer still splits into valid messages under 4096 with Turkish intact', () => {
    const md = `**Özet.**\n\n${'Çağrı şöyle dedi: ılık İğdır üzümü, Göçük ve Şişli. '.repeat(160)}`;
    const parts = toTelegramMessages(md, { fold: 'answer' });
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    expect(parts.join('')).toContain('İğdır');
    expect(parts.join('')).not.toContain('�');
  });
});

describe('a link his phone cannot open is its words (AC6)', () => {
  it('a project-relative link shows its name, never the raw markdown', () => {
    const html = markdownToTelegramHtml('Rapor: [İlk açılış: değişenler](_dream_context/tmp/super/ilk-acilis.pdf) hazır.');
    expect(html).toBe('Rapor: İlk açılış: değişenler hazır.');
    expect(html).not.toContain('](');
    expect(markdownToTelegramHtml('[site](https://ornek.com)')).toBe('<a href="https://ornek.com/">site</a>');
  });
});

describe('a job status message (AC5)', () => {
  it('running: the name in bold, what is happening now, the finished steps', () => {
    expect(jobStatusHtml(['Telegram sade konuşma', 'Testler çalışıyor, 2. dalga', '- Yazma kuralı yeni', '✓ Katlama kapısı'], false))
      .toBe('⏳ <b>Telegram sade konuşma</b>\n<i>Testler çalışıyor, 2. dalga</i>\n✓ Yazma kuralı yeni\n✓ Katlama kapısı');
  });

  it('done: the name and its result line only', () => {
    expect(jobStatusHtml(['Telegram sade konuşma', 'Bitti: 3 dalga, testler geçti', '- adım'], true)).toBe('✅ <b>Telegram sade konuşma</b>\nBitti: 3 dalga, testler geçti');
  });

  it('escapes markup, redacts secrets and keeps the newest steps when long', () => {
    const steps = Array.from({ length: 40 }, (_, i) => `adım ${i + 1} ${'ş'.repeat(40)}`);
    const html = jobStatusHtml(['<x> & y', 'token=sk-ant-abcdefghijklmnopqrstuvwxyz0123', ...steps], false);
    expect(html).toContain('&lt;x&gt; &amp; y');
    expect(html).not.toContain('sk-ant-abc');
    expect(Array.from(telegramHtmlToPlain(html)).length).toBeLessThanOrEqual(JOB_STATUS_MAX + 10);
    expect(html).toContain('adım 40');
    expect(html).not.toContain('adım 1 ');
  });
});

describe('the rule says the same (AC1, AC8)', () => {
  it('short answer, no report shape, nothing dropped, one message per turn, a status block, a voice day', () => {
    expect(TELEGRAM_WRITING_RULE).toContain('at most three short sentences');
    expect(TELEGRAM_WRITING_RULE).not.toContain('bold head');
    expect(SUPER_TELEGRAM_LINE).toContain(TELEGRAM_WRITING_RULE);
    expect(SUPER_TELEGRAM_LINE).toContain('One turn is ONE message on his phone');
    expect(SUPER_TELEGRAM_LINE).toContain('dream-status <job-id>');
    expect(SUPER_TELEGRAM_LINE).toContain('every answer that day is a voice block');
  });
});

describe('what counts as a line between tool calls (AC2)', () => {
  it('only a line about the work going on is chatter; a short answer is news', async () => {
    const { isChatter, mergeHeld } = await import('../../src/server/telegram/sade.js');
    for (const t of ['Bakıyorum.', 'Kontrol ediyorum, bitince yazacağım.', 'Hâlâ sürüyor.', "Let me check."]) expect(isChatter(t)).toBe(true);
    // The golden set (Doc's dc-b): clauses joined by a comma and "sonra" are still only work.
    for (const t of ["Önceki oturumda ne istediğini buluyorum, sonra doğru PDF'i hazırlayacağım.", "Onayladığın değişikliklerin PDF'ini hazırlıyorum."]) expect(isChatter(t)).toBe(true);
    for (const t of ['Evet, raporu yarın hazırlayacağım çünkü veri eksik.', 'Hayır, bunu yapmayacağım.']) expect(isChatter(t)).toBe(false);
    for (const t of ['Evet, bu normal.', 'Bunu öneriyorum.', 'Hazır: testler geçti.', '![a](x.png) Bakıyorum.']) expect(isChatter(t)).toBe(false);
    // Dropped only when a tool call came after it; its reply mark rides on the answer.
    expect(mergeHeld('<!-- re:abc123 -->\nBakıyorum.', 'Bitti.', true)).toBe('<!-- re:abc123 -->\nBitti.');
    expect(mergeHeld('Bakıyorum.', 'Bitti.', false)).toBe('Bakıyorum.\n\nBitti.');
    expect(mergeHeld('Evet, bu normal.', 'Kart düştü.', true)).toBe('Evet, bu normal.\n\nKart düştü.');
  });
});
