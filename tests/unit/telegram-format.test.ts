/**
 * Super text → Telegram: 4096 split with Turkish (and emoji) intact, reply sections, dream fences
 * as "Mac'te" lines, secrets and the hands-free login token never leave (plan AC9, A6, B1, M5, W6).
 */
import { describe, it, expect } from 'vitest';
import {
  markdownToTelegramHtml, redactSecrets, scrubLoginToken, splitReplySections, splitTelegramHtml,
  stripReplyMarks, toTelegramMessages, wouldRedact, REDACTED,
} from '../../src/lib/telegram/format.js';

const TR = 'Çağrı şöyle dedi: ılık İğdır üzümü, Göçük ve Şişli. ';

/** Every part is balanced HTML: each opened tag closed in the same part. */
function balanced(part: string): boolean {
  const stack: string[] = [];
  for (const m of part.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
    if (m[1]) { if (stack.pop() !== m[2]) return false; } else stack.push(m[2]);
  }
  return stack.length === 0;
}
const visible = (html: string): string => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

describe('4096 split', () => {
  it('Turkish survives every split, nothing lost, every part ≤ 4096', () => {
    const text = TR.repeat(400); // ~ 22 000 chars
    const parts = splitTelegramHtml(text);
    expect(parts.length).toBeGreaterThan(4);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    expect(parts.join(' ').replace(/\s+/g, ' ').trim()).toBe(text.replace(/\s+/g, ' ').trim());
    expect(parts.join('')).not.toContain('�');
  });

  it('never cuts a surrogate pair, an entity or a tag; open tags close and reopen', () => {
    const emoji = '🦊'.repeat(3000);
    for (const p of splitTelegramHtml(emoji)) {
      expect(p.length).toBeLessThanOrEqual(4096);
      expect(/[\ud800-\udbff]$/.test(p)).toBe(false);
      expect(/^[\udc00-\udfff]/.test(p)).toBe(false);
    }
    expect(splitTelegramHtml(emoji).join('')).toBe(emoji);
    const ents = '&amp;&lt;'.repeat(1200);
    for (const p of splitTelegramHtml(ents)) expect(/&[a-z]*$/.test(p)).toBe(false);
    const bold = `<b>${TR.repeat(200)}</b>`;
    const parts = splitTelegramHtml(bold);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) { expect(balanced(p)).toBe(true); expect(p.startsWith('<b>')).toBe(true); expect(p.length).toBeLessThanOrEqual(4096); }
    const pre = `<pre><code class="language-ts">${'const ğ = 1;\n'.repeat(600)}</code></pre>`;
    for (const p of splitTelegramHtml(pre)) { expect(balanced(p)).toBe(true); expect(p.length).toBeLessThanOrEqual(4096); }
  });

  it('prefers a paragraph break', () => {
    const a = 'a'.repeat(3000);
    const b = 'b'.repeat(3000);
    expect(splitTelegramHtml(`${a}\n\n${b}`)).toEqual([a, b]);
  });

  it('a short text is one part; empty is none', () => {
    expect(splitTelegramHtml('merhaba')).toEqual(['merhaba']);
    expect(splitTelegramHtml('')).toEqual([]);
  });

  it('the whole pipeline keeps Turkish and stays within the limit', () => {
    const md = `## Özet\n\n${`- ${TR}\n`.repeat(150)}`;
    const msgs = toTelegramMessages(md);
    for (const m of msgs) { expect(m.length).toBeLessThanOrEqual(4096); expect(balanced(m)).toBe(true); }
    expect(visible(msgs.join(''))).toContain('İğdır');
  });
});

describe('markdown → Telegram HTML', () => {
  it('bold, italic, code, links, headings, lists, quotes, ==mark==', () => {
    const html = markdownToTelegramHtml('# Başlık\n**kalın** ve *eğik* `kod` [site](https://ornek.com/a?b=1)\n- bir\n1. iki\n> alıntı\n==önemli== ==!kırık== ==+tamam==');
    expect(html).toContain('<b>Başlık</b>');
    expect(html).toContain('<b>kalın</b>');
    expect(html).toContain('<i>eğik</i>');
    expect(html).toContain('<code>kod</code>');
    expect(html).toContain('<a href="https://ornek.com/a?b=1">site</a>');
    expect(html).toContain('• bir');
    expect(html).toContain('1. iki');
    expect(html).toContain('<blockquote>alıntı</blockquote>');
    expect(html).toContain('<b>önemli</b> <b>kırık</b> <b>tamam</b>');
  });

  it('escapes HTML and refuses non-web links', () => {
    const html = markdownToTelegramHtml('<script>x</script> [a](javascript:alert(1)) [b](tg://x)');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('href="javascript');
    expect(html).not.toContain('href="tg:');
  });

  it('dream fences become one "Mac\'te" line; pin/title/checkout views vanish; code stays or goes per option', () => {
    const md = [
      'Önce',
      '```dream-html', '<div class="dc-card"><h2>Haftalık rapor</h2><script>1</script></div>', '```',
      '```dream-view', '{"type":"insight","id":"wau"}', '```',
      '```dream-view', '{"type":"pin","id":"dev","facts":[]}', '```',
      '```dream-actions', '[{"label":"a"},{"label":"b"}]', '```',
      '```mermaid', 'graph TD; A-->B', '```',
      '```ts', 'const a = 1 < 2;', '```',
    ].join('\n');
    const html = markdownToTelegramHtml(md);
    expect(html).toContain("<i>Mac'te: Haftalık rapor</i>");
    expect(html).toContain("<i>Mac'te: wau</i>");
    expect(html).toContain("<i>Mac'te: 2 düğme</i>");
    expect(html).toContain("<i>Mac'te: bir diyagram</i>");
    expect(html).not.toContain('dev');
    expect(html).not.toContain('<script');
    expect(html).toContain('<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>');
    expect(markdownToTelegramHtml(md, { codeFences: 'mac' })).toContain("<i>Mac'te: ts kodu</i>");
  });
});

describe('reply sections (re: marks)', () => {
  it('cuts at line-start marks outside fences and strips them', () => {
    const text = 'giriş\n<!-- re:ab12cd -->\nbirinci\n<!-- re:k3f9q0, zz99zz -->\nikinci\n```\n<!-- re:xxxxxx -->\n```';
    const s = splitReplySections(text);
    expect(s.map((x) => x.refs)).toEqual([[], ['ab12cd'], ['k3f9q0', 'zz99zz']]);
    expect(s[1].text).toBe('birinci');
    expect(s[2].text).toContain('<!-- re:xxxxxx -->');
    expect(stripReplyMarks('<!-- re:ab12cd -->\ncevap')).toBe('cevap');
    expect(markdownToTelegramHtml('<!-- re:ab12cd -->\ncevap')).toBe('cevap');
  });
});

describe('secrets and the login token never leave', () => {
  const secrets = [
    '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ',
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
    'sk-proj-abcdefghijklmnopqrstuvwxyz',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'AKIAABCDEFGHIJKLMNOP',
    'AIzaSyA-abcdefghijklmnopqrstuvwxyz01234',
    'xoxb-1234567890-abcdefghij',
    'sk_live_abcdefghijklmnop',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ];
  it('each secret shape is replaced', () => {
    for (const s of secrets) {
      const out = redactSecrets(`değer: ${s} bitti`);
      expect(out, s).not.toContain(s);
      expect(out).toContain(REDACTED);
      expect(wouldRedact(`x ${s}`)).toBe(true);
    }
    expect(redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----')).toBe(REDACTED);
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop1234')).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactSecrets('https://u:pa55word@host.com/x')).toBe(`https://${REDACTED}@host.com/x`);
    expect(redactSecrets('https://x.com/cb?code=1&access_token=abc123')).toBe(`https://x.com/cb?code=1&access_token=${REDACTED}`);
    expect(redactSecrets('PASSWORD="hunter2hunter2"')).toContain(REDACTED);
  });

  it('ordinary Turkish prose is untouched', () => {
    const prose = 'Bugün 3 iş bitti; şifre sayfası hazır, token sayısı 1200. Kişi: @mehmet.';
    expect(redactSecrets(prose)).toBe(prose);
    expect(wouldRedact(prose)).toBe(false);
  });

  it('the hands-free login token is scrubbed from any URL', () => {
    const url = 'https://abc-def.trycloudflare.com/login?t=Zx81kQ_pp-0aB9';
    expect(scrubLoginToken(`Link: ${url} gir`)).toBe('Link: https://abc-def.trycloudflare.com/login gir');
    expect(scrubLoginToken('https://h.example/login?x=1&t=abc#f')).toBe('https://h.example/login#f');
    expect(redactSecrets(url)).not.toContain('Zx81kQ');
    for (const m of toTelegramMessages(`Telefon linki: ${url}`)) expect(m).not.toContain('t=Zx81kQ');
  });
});

describe('emphasis (owner, 2026-11-09: bold heads and key words reach the phone)', () => {
  const STATUS = [
    'Şu an çalışan bir iş yok. Durum şöyle:',
    '',
    'Senden beklenenler:',
    '1. Canlı funnel **senin turunu bekliyor**.',
    '2. Kurum takvimi açık.',
    '',
    'Bugün canlıya çıkanlar:',
    '- Özel Hat kopma uyarısı herkese açıldı.',
  ].join('\n');

  it('a short "Başlık:" line opening a list is bold; a sentence ending in ":" is not', () => {
    const html = markdownToTelegramHtml(STATUS);
    expect(html).toContain('<b>Senden beklenenler:</b>');
    expect(html).toContain('<b>Bugün canlıya çıkanlar:</b>');
    expect(html).toContain('Şu an çalışan bir iş yok. Durum şöyle:');
    expect(html).not.toContain('<b>Şu an');
    expect(html).toContain('1. Canlı funnel <b>senin turunu bekliyor</b>.');
    expect(html).toContain('• Özel Hat');
  });

  it('a "Başlık:" line inside a paragraph, or not followed by a list, stays plain', () => {
    expect(markdownToTelegramHtml('Bir cümle.\nNotlar:\n- bir')).not.toContain('<b>');
    expect(markdownToTelegramHtml('Notlar:\nsadece metin')).not.toContain('<b>');
  });

  it('bold, headings, code and links', () => {
    const html = markdownToTelegramHtml('## Durum\n**Sonuç:** hazır, `npm test` geçti, [rapor](https://example.com/r).');
    expect(html).toBe('<b>Durum</b>\n<b>Sonuç:</b> hazır, <code>npm test</code> geçti, <a href="https://example.com/r">rapor</a>.');
  });

  it('a <b> an agent typed is shown, never obeyed: every <, >, & escaped', () => {
    const html = markdownToTelegramHtml('Yaz <b>bunu</b> & <script>x</script>\n\nBaşlık <i>:\n- a');
    expect(html).toContain('Yaz &lt;b&gt;bunu&lt;/b&gt; &amp; &lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toMatch(/<[a-z/]/); // no real tag at all: the head with markup in it stays plain
    expect(visible(html)).toContain('Yaz <b>bunu</b> & <script>x</script>');
  });

  it('a long bold message splits outside every tag, each part balanced', () => {
    const md = `Senden beklenenler:\n- **${'Çok önemli kalın bir cümle. '.repeat(250)}**`;
    const parts = toTelegramMessages(md);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(4096);
      expect(balanced(p)).toBe(true);
      expect(p).not.toMatch(/<[^>]*$/); // never ends inside a tag
    }
    expect(parts[0].startsWith('<b>Senden beklenenler:</b>')).toBe(true);
    expect(parts[1].startsWith('<b>')).toBe(true); // the open bold is reopened
  });
});
