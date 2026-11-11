/** The Super's Telegram rule rides its briefing and the briefing update (plan B1, W2 docs). */
import { describe, it, expect } from 'vitest';
import { SUPER_BRIEF_TEXT, SUPER_TELEGRAM_LINE, superBriefing } from '../../src/server/chat-modes.js';

describe('Telegram briefing line', () => {
  it('is in the briefing and in the update a running session gets', () => {
    expect(superBriefing()).toContain(SUPER_TELEGRAM_LINE);
    expect(SUPER_BRIEF_TEXT).toContain(SUPER_TELEGRAM_LINE);
    expect(SUPER_TELEGRAM_LINE).toContain('via="telegram"');
    expect(SUPER_TELEGRAM_LINE).toContain('super ask');
  });

  it('allows bold on Telegram and only forbids interactive blocks (owner, 2026-11-09)', () => {
    expect(SUPER_TELEGRAM_LINE).toContain('no interactive blocks');
    expect(SUPER_TELEGRAM_LINE).toContain('bold is fine');
    expect(SUPER_TELEGRAM_LINE).not.toContain('plain text');
    for (const t of [superBriefing(), SUPER_BRIEF_TEXT]) expect(t).toContain('Bold (`**…**`) the few words his eye must land on');
  });
});

describe('the Telegram line keeps one question in one place (owner 2026-11-10)', () => {
  it('tells the Super the card is the question: no repeat, no waiting line, a new card when not answered', async () => {
    const { SUPER_TELEGRAM_LINE: line } = await import('../../src/server/chat-modes.js');
    expect(line).toContain('that card IS the question');
    expect(line).toContain('never repeat its question or options');
    expect(line).toContain('ask again with a new `super ask` card, never in prose');
    expect(line).toContain('lists at most one level deep');
  });
});
