/**
 * The window's side of the card records (plan I1, J2, K1): a drawn card finds the server's record
 * by id AND canonical spec (the newest), never derives a cardRef, and names it in the terminal
 * URL without a command; the phone uses its own narrow path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { _resetCardRecords, applyCardsFrame, cardTerminalUrl, matchCard, type CardRecordView } from '../../dashboard/src/lib/cardRecords.js';
import { MAC_DENIED_API_ROUTES } from '../../dashboard/src/lib/phoneSurface.js';

const SID = '11111111-2222-4333-8444-555555555555';
const rec = (cardRef: string, command: string, state: 'open' | 'closed' = 'open'): CardRecordView => ({
  id: 'gh', cardRef, kind: 'run', spec: { type: 'run', id: 'gh', command }, state, run: null,
});

beforeEach(() => _resetCardRecords());

describe('matching a drawn card to its record', () => {
  it('matches id + canonical spec, the newest copy; a different command matches nothing', () => {
    const cards = [rec('a'.repeat(32), 'ls', 'closed'), rec('b'.repeat(32), 'ls -la'), rec('c'.repeat(32), 'ls')];
    expect(matchCard(cards, { type: 'run', id: 'gh', command: 'ls' })?.cardRef).toBe('c'.repeat(32));
    expect(matchCard(cards, { type: 'run', id: 'gh', command: 'pwd' })).toBeNull();
    expect(matchCard(cards, { type: 'run', id: 'other', command: 'ls' })).toBeNull();
    // Key order never matters.
    expect(matchCard(cards, { command: 'ls -la', id: 'gh', type: 'run' } as never)?.cardRef).toBe('b'.repeat(32));
  });

  it('a malformed cards frame is ignored', () => {
    expect(applyCardsFrame(SID, [{ nope: 1 }])).toBe(false);
    expect(applyCardsFrame(42, [])).toBe(false);
    expect(applyCardsFrame(SID, [rec('d'.repeat(32), 'ls')])).toBe(true);
  });
});

describe('the terminal URL names the record, never a command', () => {
  it('Mac: the chat-host mode of /api/agent/terminal', () => {
    const url = cardTerminalUrl({ sessionId: SID, cardRef: 'a'.repeat(32), start: true, withheld: true }, 'dark');
    expect(url.startsWith('/api/agent/terminal?')).toBe(true);
    const q = new URLSearchParams(url.split('?')[1]);
    expect(Object.fromEntries(q)).toEqual({ session: SID, card: 'a'.repeat(32), theme: 'dark', start: '1', withheld: '1' });
    expect(q.has('cmd')).toBe(false);
    expect(q.has('vault')).toBe(false);
  });
  it('Mac Run again carries rerun; an attach carries no start', () => {
    expect(cardTerminalUrl({ sessionId: SID, cardRef: 'a'.repeat(32), start: true, rerun: true }, 'light')).toContain('rerun=1');
    expect(cardTerminalUrl({ sessionId: SID, cardRef: 'a'.repeat(32), start: false }, 'light')).not.toContain('start=');
  });
  it('the phone: its own path', () => {
    expect(cardTerminalUrl({ sessionId: SID, cardRef: 'a'.repeat(32), start: true, phone: true }, 'dark').startsWith('/api/agent/run-terminal?')).toBe(true);
  });
});

describe('the phone surface\'s route mirror', () => {
  it('lets the phone post a secret card (the server checks the record) and read card records', () => {
    expect(MAC_DENIED_API_ROUTES).not.toContain('POST /api/agent/secret');
    expect(MAC_DENIED_API_ROUTES).not.toContain('GET /api/agent/cards');
    expect(MAC_DENIED_API_ROUTES).toContain('POST /api/agent/open-terminal');
  });
});
