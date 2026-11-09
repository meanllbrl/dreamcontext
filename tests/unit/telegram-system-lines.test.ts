import { describe, it, expect } from 'vitest';
import { voiceEchoHtml, statusLineHtml, SILENT, STATUS_NAME_MAX, VOICE_ECHO_MAX } from '../../src/lib/telegram/system-lines.js';
import { telegramHtmlToPlain } from '../../src/lib/telegram/format.js';

describe('telegram system lines', () => {
  it('voice echo is a label plus one expandable italic quote', () => {
    expect(voiceEchoHtml('merhaba dünya')).toBe('🎙 <i>Duyduğum</i>\n<blockquote expandable><i>merhaba dünya</i></blockquote>');
  });
  it('voice echo escapes markup and cuts a very long transcript', () => {
    expect(voiceEchoHtml('a <b> & c')).toContain('a &lt;b&gt; &amp; c');
    const long = voiceEchoHtml('x'.repeat(VOICE_ECHO_MAX + 500));
    expect(long.length).toBeLessThan(VOICE_ECHO_MAX + 100);
  });
  it('voice echo plain fallback keeps order, no tags', () => {
    expect(telegramHtmlToPlain(voiceEchoHtml('a <b> & c'))).toBe('🎙 Duyduğum\na <b> & c');
  });
  it('status row: icon, italic name, status word, no bold', () => {
    const h = statusLineHtml('running', 'UA Testler: manuel testler');
    expect(h).toBe('⏳ <i>UA Testler: manuel testler</i> · çalışıyor');
    expect(h).not.toContain('<b>');
  });
  it('status row covers done and stuck, with a note', () => {
    expect(statusLineHtml('done', 'Paywall')).toBe('✅ <i>Paywall</i> · bitti');
    expect(statusLineHtml('waiting', 'Paywall', 'izin bekliyor')).toBe('✋ <i>Paywall</i> · seni bekliyor · izin bekliyor');
  });
  it('status row truncates a long name to one line with an ellipsis and escapes it', () => {
    const h = statusLineHtml('running', `${'ç'.repeat(80)}\n<x>`);
    expect(h).toContain('…</i>');
    expect(h).not.toContain('\n');
    expect(Array.from(h.match(/<i>(.*)<\/i>/)![1]).length).toBeLessThanOrEqual(STATUS_NAME_MAX);
    expect(statusLineHtml('running', '<x> & y')).toContain('&lt;x&gt; &amp; y');
  });
  it('status row plain fallback is readable', () => {
    expect(telegramHtmlToPlain(statusLineHtml('stuck', 'A & B'))).toBe('⚠ A & B · takıldı');
  });
  it('status rows are sent silently', () => {
    expect(SILENT).toEqual({ disable_notification: true });
  });
});
