/**
 * Telegram'da Super sade konuşur (owner 2026-11-21, "Hepsini uygula" on Doc's diagnosis): the
 * converter keeps an answer short on his phone whatever the agent wrote, a link he cannot open is
 * its words, and a job's status is one message drawn from a `dream-status` block.
 */
import { describe, it, expect } from 'vitest';
import { ANSWER_FOLD_AT, foldAnswer, markdownToTelegramHtml, telegramHtmlToPlain, toTelegramMessages } from '../../src/lib/telegram/format.js';
import { jobStatusHtml, JOB_STATUS_MAX } from '../../src/lib/telegram/system-lines.js';
import { TELEGRAM_WRITING_RULE } from '../../src/lib/telegram/writing.js';
import { SUPER_TELEGRAM_LINE } from '../../src/server/chat-modes.js';
import { isApiErrorText, limitLine, limitTextReset, resetClock } from '../../src/server/telegram/sade.js';

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
  it('an unmarked report up to ~1,200 visible characters stays whole: the code never guesses what he asked', () => {
    const html = markdownToTelegramHtml(REPORT, { fold: 'answer' });
    expect(telegramHtmlToPlain(html).length).toBeLessThanOrEqual(ANSWER_FOLD_AT);
    expect(html).not.toContain('<blockquote');
  });

  it('a longer unmarked report: the answer group and every group with a state line stay open whole; the others fold', () => {
    const extra = ['', '**Arka plan**', ...Array.from({ length: 6 }, (_, i) => `- Eski ekranın ${i + 1}. notu burada uzun uzun anlatılıyor, bir sürü ayrıntıyla birlikte.`)].join('\n');
    const md = `${REPORT}${extra}`;
    const html = markdownToTelegramHtml(md, { fold: 'answer' });
    expect(telegramHtmlToPlain(html).length).toBeGreaterThan(ANSWER_FOLD_AT);
    const open = openText(html);
    expect(html.startsWith('<b>Canlıdaki sürüm doğru çalışıyor.</b>')).toBe(true);
    // The first group after the lead is the answer, open.
    expect(open).toContain('dün akşamki 14 kayıt eksiksiz');
    expect(open).toContain('Velilere giden hatırlatmalar');
    // A group whose head or lines say where work stands stays whole ("Bekleyen" head).
    expect(open).toContain('iki dersi takvimde çakışıyor');
    expect(open).toContain('yazım hatası var');
    // Extra detail folds; nothing is lost.
    expect(open).not.toContain('Eski ekranın 1. notu');
    expect(open).not.toContain('Her sabah yedide');
    expect(telegramHtmlToPlain(html)).toContain('Eski ekranın 6. notu');
    expect(telegramHtmlToPlain(html).replace(/\s+/g, ' ')).toContain('Türkçe harfler her yerde doğru çıkıyor');
  });

  it('a later group with one state line stays open whole, in order', () => {
    const filler = Array.from({ length: 14 }, (_, i) => `- Ek bilgi ${i + 1}: bu satır sormadığı bir ayrıntıyı uzun uzun anlatıyor, okunması gerekmez.`).join('\n');
    const md = ['**PDF hazır.**', '', '**Ne var**', '- Karşılama: tek düğme', '- Proje açma: 1 ekran', '', '**Ekler**', '- Eski ekranın notları', '- 2. dalga şu an yapılıyor', '- Henüz senin uygulamanda yok', '', '**Arka plan**', filler].join('\n');
    const html = markdownToTelegramHtml(md, { fold: 'answer' });
    const open = openText(html);
    expect(open).toContain('Proje açma: 1 ekran');
    expect(open).toMatch(/Eski ekranın notları\n• 2\. dalga şu an yapılıyor\n• Henüz senin uygulamanda yok/);
    expect(open).not.toContain('Ek bilgi 1');
    expect(telegramHtmlToPlain(html)).toContain('Ek bilgi 14');
  });

  it('an Ayrıntı quote the writer added marks the extras: nothing else folds', () => {
    const md = `**Bitti.**\n\n${'Sorduğun şeyin cevabı uzun bir cümleyle burada. '.repeat(12)}\n\n> **Ayrıntı**\n> iç ayrıntı`;
    const html = markdownToTelegramHtml(md, { fold: 'answer' });
    expect(openText(html)).toContain('Sorduğun şeyin cevabı');
    expect(openText(html)).not.toContain('iç ayrıntı');
    expect((html.match(/<blockquote expandable>/g) ?? []).length).toBe(1);
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
    expect(openText(html).length).toBeLessThanOrEqual(ANSWER_FOLD_AT);
  });

  it('one long first block is the answer: it stays whole and its tags balanced', () => {
    const lines = Array.from({ length: 14 }, (_, i) => `Satır ${i + 1}: ılık İğdır üzümü **önemli** bir not burada.`);
    const html = foldAnswer(markdownToTelegramHtml(lines.join('\n')));
    expect(html).not.toContain('<blockquote');
    expect((html.match(/<b>/g) ?? []).length).toBe((html.match(/<\/b>/g) ?? []).length);
    expect(openText(html)).toContain('Satır 14');
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
    // Review r1: only a text that OPENS with the CLI's error is one.
    const { isApiErrorText } = await import('../../src/server/telegram/sade.js');
    expect(isApiErrorText('API Error: 403 Attention Required! | Cloudflare')).toBe(true);
    expect(isApiErrorText(`API Error: 403 <!DOCTYPE html>${'x'.repeat(2000)}`)).toBe(true);
    expect(isApiErrorText("Stripe webhook'u API Error: 429 döndü, yarın tekrar denenir.")).toBe(false);
    expect(isApiErrorText('Sayfada "Attention Required! | Cloudflare" yazıyor, VPN kapatınca açıldı.')).toBe(false);
    for (const t of ['Evet, bu normal.', 'Bunu öneriyorum.', 'Hazır: testler geçti.', '![a](x.png) Bakıyorum.']) expect(isChatter(t)).toBe(false);
    // Dropped only when a tool call came after it; its reply mark rides on the answer.
    expect(mergeHeld('<!-- re:abc123 -->\nBakıyorum.', 'Bitti.', true)).toBe('<!-- re:abc123 -->\nBitti.');
    expect(mergeHeld('Bakıyorum.', 'Bitti.', false)).toBe('Bakıyorum.\n\nBitti.');
    expect(mergeHeld('Evet, bu normal.', 'Kart düştü.', true)).toBe('Evet, bu normal.\n\nKart düştü.');
  });
});

describe('D12: the limit form, anchored (iyilesme-360)', () => {
  it('reads the whole limit text and its reset; a quote inside other words is no limit text', () => {
    expect(limitTextReset("You've hit your 5-hour limit · resets 12am (Europe/Istanbul)")).toEqual({ reset: '12am', zone: 'Europe/Istanbul' });
    expect(limitTextReset("You've hit your weekly limit · resets 3:30pm")).toMatchObject({ reset: '3:30pm' });
    expect(limitTextReset("Çocuk şunu yazdı: You've hit your 5-hour limit · resets 12am")).toBeNull();
    expect(limitTextReset('API Error: 529 overloaded')).toBeNull();
    expect(isApiErrorText("You've hit your 5-hour limit · resets 12am")).toBe(false);
  });
  it('the clock and the line', () => {
    expect(resetClock('12am')).toBe('00:00');
    expect(resetClock('12pm')).toBe('12:00');
    expect(resetClock('3:30pm')).toBe('15:30');
    expect(resetClock('Monday')).toBeNull();
    expect(limitLine('00:00', false)).toBe("Kullanım sınırına geldik; iş durdu. Sınır saat 00:00'de açılıyor.");
    expect(limitLine(null, true)).toBe('Kullanım sınırına geldik; iş durdu. Açılınca kaldığı yerden sürüyor.');
  });
});

