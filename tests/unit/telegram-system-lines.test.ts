import { describe, it, expect } from 'vitest';
import { voiceEchoHtml, statusLineHtml, noticeHtml, NOTICE_EMOJI, SILENT, STATUS_NAME_MAX, VOICE_ECHO_MAX } from '../../src/lib/telegram/system-lines.js';
import { telegramHtmlToPlain } from '../../src/lib/telegram/format.js';
import { LINES } from '../../src/server/telegram/hub.js';
import { HF_LINES } from '../../src/server/telegram/handsfree.js';
import { CMD_LINES } from '../../src/server/telegram/commands.js';
import { RUN_LINES } from '../../src/server/telegram/runs.js';
import { PHONE_LINES } from '../../src/server/telegram/present.js';
import { TOO_LARGE_LINE } from '../../src/lib/telegram/inbound.js';

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

  describe('notice: meaning emoji first, one italic sentence', () => {
    const kinds = [['info', 'ℹ️'], ['warn', '⚠️'], ['file', '📎'], ['phone', '📱'], ['access', '🔒'], ['wait', '⏳']] as const;
    for (const [kind, emoji] of kinds) {
      it(`${kind} → ${emoji}`, () => {
        expect(NOTICE_EMOJI[kind]).toBe(emoji);
        expect(noticeHtml(kind, 'Bir şey oldu.')).toBe(`${emoji} <i>Bir şey oldu.</i>`);
        expect(telegramHtmlToPlain(noticeHtml(kind, 'A & B'))).toBe(`${emoji} A & B`);
      });
    }
    it('escapes markup and keeps it on one line', () => {
      expect(noticeHtml('info', 'a <b>\n  c')).toBe('ℹ️ <i>a &lt;b&gt; c</i>');
    });
  });

  describe('every fixed line is one plain sentence with no emoji of its own and no old "back" note', () => {
    const fixed: string[] = [
      LINES.superOff, LINES.cannotOpen, LINES.notWritten, LINES.writtenNotDone, LINES.unknownCommand, LINES.conflict, LINES.tamper, LINES.endedSilent,
      LINES.bound('Ali'), LINES.unbound(true),
      HF_LINES.macOn, HF_LINES.notSetup, HF_LINES.telegramOn, HF_LINES.linkOn('https://a.trycloudflare.com'), HF_LINES.newLink('https://a.trycloudflare.com'),
      HF_LINES.notOn, HF_LINES.ended('telefon bağlantısı koptu', true), HF_LINES.battery, HF_LINES.heat, HF_LINES.noGrant,
      ...Object.values(CMD_LINES).map((v) => (typeof v === 'function' ? v('x') : v)),
      RUN_LINES.noPhone, RUN_LINES.refused, RUN_LINES.secretHere, PHONE_LINES.starting, PHONE_LINES.offer, TOO_LARGE_LINE,
    ];
    it('no embedded emoji (the helper adds it) and no newline', () => {
      for (const l of fixed) {
        expect(l, l).not.toMatch(/\n/);
        expect(l, l).not.toMatch(/\p{Extended_Pictographic}/u);
      }
    });
    it('the unprompted "back at the Mac" notes are gone', () => {
      expect('back' in LINES).toBe(false);
      expect('back' in HF_LINES).toBe(false);
    });
    it('the old "başka yerden açık; telefon linki Mac\'te" wording is gone', () => {
      for (const l of fixed) expect(l).not.toMatch(/başka yerden/);
    });
  });
});
