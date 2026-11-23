/**
 * The open question's line above the Super chat's composer (owner 2026-11-17, option C): what it
 * says and when its card counts as on screen (the line leaves then).
 */
import { describe, it, expect } from 'vitest';
import { cardInView, lineTextOf } from '../../dashboard/src/components/sleepy/super/questionLineModel';

describe('the question line', () => {
  it('reads the card title first, then the first question, then the record text, on one line', () => {
    expect(lineTextOf({ ask: { title: 'Invoice export → date format', questions: [{ question: 'Which format?', options: [] }] } })).toBe('Invoice export → date format');
    expect(lineTextOf({ ask: { questions: [{ question: 'Ship the cancel flow\n to staging?', options: [] }] } })).toBe('Ship the cancel flow to staging?');
    expect(lineTextOf({ ownerText: '  Deploy now?  ' })).toBe('Deploy now?');
  });

  it('counts a card as seen once 40px of it shows, or all of a shorter one', () => {
    const view = { top: 0, bottom: 500 };
    expect(cardInView({ top: -400, bottom: -10 }, view)).toBe(false);
    expect(cardInView({ top: 480, bottom: 800 }, view)).toBe(false);
    expect(cardInView({ top: 460, bottom: 800 }, view)).toBe(true);
    expect(cardInView({ top: 100, bottom: 120 }, view)).toBe(true);
    expect(cardInView({ top: 490, bottom: 510 }, view)).toBe(false);
  });
});
