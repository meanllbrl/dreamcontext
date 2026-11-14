/**
 * The row above the Super chat no longer holds an owner-only card (owner 2026-11-14, twice: "şu
 * üstteki kart kalksın"). The card stays where he acts on it: in the Super chat transcript (drawn
 * from the chat's own message, not the queue) and in the agenda's Waiting on you.
 */
import { describe, it, expect } from 'vitest';
import {
  bandCount, bandHead, needsOwner, queueHead, superNotepad,
} from '../../dashboard/src/components/sleepy/super/superHandover.js';
import { SUPER_STATE_VERSION, type SuperQueueItem, type SuperState } from '../../dashboard/src/lib/superTypes.js';

const card = (type: 'run' | 'secret' | 'checklist') => ({
  cardRef: 'r1', postingSession: 'c1', vault: 'v', postingConversationId: 'k1', childRecordId: 'c1', childId: 'c1', deliverTo: 'c1',
  spec: type === 'run' ? { type, command: 'npm login', why: 'it opens a browser' }
    : type === 'secret' ? { type, title: 'Key', file: '.env' } : { type, title: 'Steps' },
}) as unknown as NonNullable<SuperQueueItem['card']>;
const item = (id: string, over: Partial<SuperQueueItem>): SuperQueueItem =>
  ({ id, sessionId: 'c1', kind: 'owner', state: 'pending', createdAt: 1, ...over });
const state = (queue: SuperQueueItem[]): SuperState => ({
  v: SUPER_STATE_VERSION, session: 'super-0001', enabled: true, containers: [], children: { c1: { sessionId: 'c1', brief: '', adopted: true, startedAt: 1 } },
  queue, notes: {}, away: { since: null, events: 0 },
}) as SuperState;

describe('the top row skips owner cards', () => {
  for (const type of ['run', 'secret', 'checklist'] as const) {
    it(`a ${type} card: no head, no count above the chat; the notch head and Waiting on you keep it`, () => {
      const s = state([item('o1', { card: card(type) })]);
      expect(bandHead(s)).toBeNull();
      expect(bandCount(s)).toBe(0);
      expect(needsOwner(s.queue[0])).toBe(true);
      expect(queueHead(s)?.id).toBe('o1');
      const waiting = superNotepad(s, { superTitle: 'Super', titleFor: () => 'Job' } as never).waiting;
      expect(waiting.map((r) => r.item)).toContain('o1');
    });
  }

  it("a member's card is skipped too; a plain wait still shows", () => {
    const s = state([
      item('m1', { kind: 'member', of: 'owner', member: 'x', card: card('run') }),
      item('o2', { ownerText: 'sign in' }),
    ]);
    expect(bandHead(s)?.id).toBe('o2');
    expect(bandCount(s)).toBe(1);
  });
});
