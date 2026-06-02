import { describe, it, expect } from 'vitest';
import type { DistilledSection } from '../../src/cli/commands/transcript.js';
import { detectSalience } from '../../src/lib/salience.js';

function empty(): DistilledSection {
  return {
    userMessages: [],
    agentDecisions: [],
    codeChanges: [],
    errors: [],
    bookmarks: [],
  };
}

describe('detectSalience', () => {
  it('detects a user correction at salience 2 (EN)', () => {
    const d = empty();
    d.userMessages = ['No, actually use yarn instead of npm here.'];
    const moments = detectSalience(d);
    expect(moments.some(m => m.salience === 2 && m.message.includes('User correction'))).toBe(true);
  });

  it('detects a user correction in Turkish', () => {
    const d = empty();
    d.userMessages = ['Hayır, bu yanlış, başka bir yaklaşım kullan.'];
    const moments = detectSalience(d);
    expect(moments.some(m => m.salience === 2)).toBe(true);
  });

  it('detects error → fix at salience 1 when an error and a code change coexist', () => {
    const d = empty();
    d.errors = ['Error: undefined is not a function in handler.ts'];
    d.codeChanges = ['EDIT src/handler.ts\n--- OLD ---\nx()\n--- NEW ---\nx?.()'];
    const moments = detectSalience(d);
    expect(moments.some(m => m.salience === 1 && m.message.includes('Error resolved'))).toBe(true);
  });

  it('does NOT fire error→fix when there is an error but no code change', () => {
    const d = empty();
    d.errors = ['Error: transient network blip'];
    const moments = detectSalience(d);
    expect(moments.some(m => m.message.includes('Error resolved'))).toBe(false);
  });

  it('detects a decision keyword at salience 2 (EN)', () => {
    const d = empty();
    d.agentDecisions = ['We switched to a queue-based architecture for resilience.'];
    const moments = detectSalience(d);
    expect(moments.some(m => m.salience === 2 && m.message.includes('Decision'))).toBe(true);
  });

  it('detects a decision keyword in Turkish', () => {
    const d = empty();
    d.agentDecisions = ['Sonunda Redis kullanmaya karar verdik.'];
    const moments = detectSalience(d);
    expect(moments.some(m => m.salience === 2)).toBe(true);
  });

  it('ignores [thinking] blocks for decision detection', () => {
    const d = empty();
    d.agentDecisions = ['[thinking] I decided internally to maybe chose Redis but it is just reasoning.'];
    const moments = detectSalience(d);
    expect(moments).toEqual([]);
  });

  it('yields ZERO bookmarks on a clean session (no false positives)', () => {
    const d = empty();
    d.userMessages = ['Please add a health-check endpoint to the API.'];
    d.agentDecisions = ['Added GET /health returning 200 with uptime.'];
    d.codeChanges = ['WRITE src/health.ts (12 lines)'];
    const moments = detectSalience(d);
    expect(moments).toEqual([]);
  });

  it('dedupes and caps at 5 moments', () => {
    const d = empty();
    d.userMessages = Array.from({ length: 10 }, () => 'No, actually wrong instead.');
    d.agentDecisions = Array.from({ length: 10 }, (_, i) => `We decided option ${i}.`);
    const moments = detectSalience(d);
    expect(moments.length).toBeLessThanOrEqual(5);
    // the 10 identical correction messages collapse to one
    const corrections = moments.filter(m => m.message.includes('User correction'));
    expect(corrections.length).toBe(1);
  });
});
