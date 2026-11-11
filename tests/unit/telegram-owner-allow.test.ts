/**
 * Telegram's Allow card (uye-bildirim K4, G2): the same choices as the Mac, two rows of two
 * ("İzin ver (bir kez)", "Bu iş için hep", "<üye> için hep", "Reddet" / "Gerek yok"), and a size
 * only when the message shows the WHOLE command as it is: one too long for the message, one with a
 * secret the redactor would hide, or one with hidden characters gets no Allow on Telegram at all.
 */
import { describe, it, expect } from 'vitest';
import { allowRows, shownWhole } from '../../src/server/telegram/asks.js';
import { pickLine, sizeLine } from '../../src/server/telegram/member-picks.js';
import { visibleCommand } from '../../src/server/telegram/hub.js';

describe('shownWhole: consent matches display', () => {
  it('a plain command that fits is shown whole', () => {
    expect(shownWhole('node scripts/report.mjs --week 45')).toBe(true);
  });
  it('a command longer than the message is not', () => {
    expect(shownWhole(`node scripts/report.mjs ${'x'.repeat(1600)}`)).toBe(false);
  });
  it('a command with a secret the redactor hides is not', () => {
    expect(shownWhole('curl -H "Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" https://example.test')).toBe(false);
  });
  it('a command with a hidden or direction-changing character is not', () => {
    expect(shownWhole('node scripts/re\u202eport.mjs')).toBe(false);
    expect(shownWhole('node scripts/report.mjs\u200b')).toBe(false);
  });
});

describe('allowRows: two rows of two, in the order a tap reads them', () => {
  it('a member\'s job: once, this job, the member, then deny', () => {
    const { rows, choices } = allowRows(['once', 'job', 'member'], 'Rota Planner', 'deny');
    expect(rows).toEqual([['İzin ver (bir kez)', 'Bu iş için hep'], ['Rota Planner için hep', 'Reddet']]);
    expect(choices).toEqual(['once', 'job', 'member', 'deny']);
  });
  it('a refusal ends with "Gerek yok"; main\'s crew has no member size', () => {
    const { rows, choices } = allowRows(['once', 'job', 'member'], null, 'not_needed');
    expect(rows).toEqual([['İzin ver (bir kez)', 'Bu iş için hep'], ['Gerek yok']]);
    expect(choices).toEqual(['once', 'job', 'not_needed']);
  });
  it('a once-only command: Allow once and the closing choice, one row', () => {
    expect(allowRows(['once'], 'Rota Planner', 'deny')).toEqual({ rows: [['İzin ver (bir kez)', 'Reddet']], choices: ['once', 'deny'] });
  });
  it('a cut command: only the closing choice', () => {
    expect(allowRows([], 'Rota Planner', 'not_needed')).toEqual({ rows: [['Gerek yok']], choices: ['not_needed'] });
  });
});

describe('what a tap says back', () => {
  it('names the size given, and the second surface is told it was answered', () => {
    expect(sizeLine('once')).toBe('✓ İzin verildi (bir kez)');
    expect(sizeLine('job')).toBe('✓ Bu iş için hep izinli');
    expect(pickLine({ ok: true, outcome: 'allowed' }, sizeLine('once'))).toBe('✓ İzin verildi (bir kez)');
    expect(pickLine({ ok: true, outcome: 'allowed_waiting' }, sizeLine('once'))).toContain('sohbeti açılınca');
    expect(pickLine({ ok: false, error: 'already_answered', message: '' }, 'x')).toBe('Zaten cevaplandı');
  });
});

describe('visibleCommand: what any Telegram card draws of a command', () => {
  it('draws a hidden or direction-changing character as a visible escape, and a secret redacted', () => {
    expect(visibleCommand('node a\u202eb.mjs')).toBe('node a\\u{202e}b.mjs');
    expect(visibleCommand('ls\u200b')).toBe('ls\\u{200b}');
    expect(visibleCommand('curl -H "Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" x')).not.toContain('sk-ant-api03');
  });
});
