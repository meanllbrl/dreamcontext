/**
 * `deliverToChat`: how an agent's message (`dreamcontext window send`, `super send`) reaches
 * another chat. Busy -> steered into the running turn (never held until it ends); asking ->
 * queued behind the open card; idle -> a new turn.
 */
import { describe, it, expect, vi } from 'vitest';
import { deliverToChat } from '../../dashboard/src/components/sleepy/chat/postToSession';
import type { ChatSession } from '../../dashboard/src/components/sleepy/chatSession';

function fake(state: { busy?: boolean; asking?: boolean; steers?: boolean }) {
  const s = {
    busy: !!state.busy,
    asking: !!state.asking,
    send: vi.fn(),
    steer: vi.fn(() => state.steers ?? true),
    enqueue: vi.fn(),
  };
  return s as typeof s & ChatSession;
}

describe('deliverToChat', () => {
  it('steers into a busy chat\'s running turn instead of queueing it', () => {
    const s = fake({ busy: true });
    expect(deliverToChat(s, 'hi')).toBe('steered');
    expect(s.steer).toHaveBeenCalledWith('hi');
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
  });

  it('a refused steer falls back to the first opening, never the end of the turn', () => {
    const s = fake({ busy: true, steers: false });
    expect(deliverToChat(s, 'hi')).toBe('queued');
    expect(s.enqueue).toHaveBeenCalledWith('hi', { steerWhenPossible: true });
  });

  it('a chat asking a question or permission queues the message behind the card', () => {
    const s = fake({ busy: true, asking: true });
    expect(deliverToChat(s, 'hi')).toBe('queued');
    expect(s.steer).not.toHaveBeenCalled();
    expect(s.enqueue).toHaveBeenCalledWith('hi');
  });

  it('an idle chat gets a plain new turn', () => {
    const s = fake({});
    expect(deliverToChat(s, 'hi')).toBe('sent');
    expect(s.send).toHaveBeenCalledWith('hi');
  });
});
