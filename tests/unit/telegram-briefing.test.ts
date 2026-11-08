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
});
