/** The Super's Telegram rule rides its briefing and the briefing update (plan B1, W2 docs). */
import { describe, it, expect } from 'vitest';
import { SUPER_BRIEF_TEXT, SUPER_TELEGRAM_LINE, superBriefing } from '../../src/server/chat-modes.js';
import { TELEGRAM_WRITING_RULE } from '../../src/lib/telegram/writing.js';

describe('Telegram briefing line', () => {
  it('is in the briefing and in the update a running session gets', () => {
    expect(superBriefing()).toContain(SUPER_TELEGRAM_LINE);
    expect(SUPER_BRIEF_TEXT).toContain(SUPER_TELEGRAM_LINE);
    expect(SUPER_TELEGRAM_LINE).toContain('A question, result or job-status list of a child never reaches his Telegram by itself');
    expect(SUPER_TELEGRAM_LINE).toContain('via="telegram"');
    expect(SUPER_TELEGRAM_LINE).toContain('super ask');
  });

  it('allows bold on Telegram and only forbids interactive blocks (owner, 2026-11-09)', () => {
    expect(SUPER_TELEGRAM_LINE).toContain('no interactive blocks');
    expect(SUPER_TELEGRAM_LINE).toContain('ONE bold line');
    expect(SUPER_TELEGRAM_LINE).not.toContain('plain text');
    for (const t of [superBriefing(), SUPER_BRIEF_TEXT]) expect(t).toContain('Bold (`**…**`) the few words his eye must land on');
  });
});

describe('the Telegram line keeps one question in one place (owner 2026-11-10)', () => {
  it('tells the Super the card is the question: no repeat, no waiting line, never asked again when not answered (owner 2026-11-18)', async () => {
    const { SUPER_TELEGRAM_LINE: line } = await import('../../src/server/chat-modes.js');
    expect(line).toContain('that card IS the question');
    expect(line).toContain('never repeat its question or options');
    expect(line).toContain('When his message left the card open (`<super-ask-still-open>`): answer his message and never ask the open card again, in a card or in prose');
    expect(line).toContain('When his message closed it without deciding');
    expect(line).toContain('when his words settle it, `super queue done <ask id>`');
    expect(line).not.toContain('ask again with a new `super ask` card');
    expect(line).toContain('A choice only he can make still goes in a `super ask` card');
    expect(line).toContain('lists one level deep');
    expect(line).toContain('One turn is ONE message on his phone');
  });
});

describe('one Telegram writing rule for every surface (owner 2026-11-14, B2; short since 2026-11-21)', () => {
  it('the Super briefing (main and every member) carries the shared rule word for word', () => {
    expect(SUPER_TELEGRAM_LINE).toContain(TELEGRAM_WRITING_RULE);
    expect(superBriefing()).toContain(TELEGRAM_WRITING_RULE);
  });

  it('names each element with its one job', () => {
    for (const piece of ['ONE bold line', 'at most three short sentences', 'ONE blank line between them', 'No heads, no bullet groups', '`inline code`', '`>` quote', 'fenced code block', '`**Ayrıntı**`', 'never dropped', 'No tables']) {
      expect(TELEGRAM_WRITING_RULE).toContain(piece);
    }
    // Doc 2026-11-21 (K1): the report shape the old rule asked for is gone.
    expect(TELEGRAM_WRITING_RULE).not.toContain('bold head');
    expect(TELEGRAM_WRITING_RULE).not.toContain('bullets under it');
  });
});
