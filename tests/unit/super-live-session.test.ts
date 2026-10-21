/**
 * How the Super stage follows the live chats (liveSession.ts; task super-agent-ekrani-kasmaz-
 * olculen-3-sebep-duzeltilir): every subscriber runs in ONE shared frame, and a card re-renders
 * only when what it draws changed — the frame on a status change (`frameKeyOf`), the tile on a
 * change of its doing-line, background count, clock or model (`cardKeyOf`), never on a token
 * that leaves all of those as they were.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { inNextFrame, dropFromFrame, _flushFrame } from '../../dashboard/src/components/sleepy/super/liveSession.js';
import { cardKeyOf } from '../../dashboard/src/components/sleepy/super/AgentCard.js';
import { frameKeyOf } from '../../dashboard/src/components/sleepy/super/SuperContainer.js';
import type { ChatSession } from '../../dashboard/src/components/sleepy/chatSession.js';

describe('the shared frame', () => {
  let frames: Array<() => void>;
  beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { frames.push(cb); return frames.length; });
  });
  afterEach(() => { _flushFrame(); vi.unstubAllGlobals(); });

  it('asks for one animation frame however many cards are due, and runs each once', () => {
    const a = vi.fn();
    const b = vi.fn();
    for (let i = 0; i < 20; i++) { inNextFrame(a); inNextFrame(b); }
    expect(frames).toHaveLength(1);
    frames[0]();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    inNextFrame(a);
    expect(frames).toHaveLength(2);
  });

  it('a card torn down before the frame is not run; one that throws does not stop the rest', () => {
    const gone = vi.fn();
    const bad = vi.fn(() => { throw new Error('boom'); });
    const ok = vi.fn();
    inNextFrame(gone); inNextFrame(bad); inNextFrame(ok);
    dropFromFrame(gone);
    frames[0]();
    expect(gone).not.toHaveBeenCalled();
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

/** A session as the stage reads it: status flags and the model's items. */
function fakeSession(over: Partial<{ busy: boolean; status: string; asking: boolean; items: unknown[]; subAgents: unknown[]; turnStartedAt: number; model: string; liveWork: boolean }> = {}): ChatSession {
  const items = over.items ?? [];
  return {
    status: over.status ?? 'open',
    busy: over.busy ?? true,
    asking: over.asking ?? false,
    agentsWorking: false,
    model: over.model ?? 'claude-opus-5',
    effort: 'high',
    hasLiveWork: () => !!over.liveWork,
    getModel: () => ({ items, subAgents: over.subAgents ?? [], turnStartedAt: over.turnStartedAt ?? 1000 }),
  } as unknown as ChatSession;
}

describe('what a card draws', () => {
  it('a token that only grows the text past the tile line leaves the tile key alone', () => {
    const long = 'x'.repeat(200);
    const a = fakeSession({ busy: false, items: [{ kind: 'text', text: long }] });
    const b = fakeSession({ busy: false, items: [{ kind: 'text', text: `${long}yz` }] });
    expect(cardKeyOf(a, false)).toBe(cardKeyOf(b, false));
  });

  it('a new doing-line, background job, clock or model changes the tile key', () => {
    const base = fakeSession({ items: [{ kind: 'tool', status: 'running', name: 'Bash', input: { description: 'Run the tests' } }] });
    const other = fakeSession({ items: [{ kind: 'tool', status: 'running', name: 'Read', input: { file_path: '/a/b.ts' } }] });
    const bg = fakeSession({ items: [{ kind: 'tool', status: 'running', name: 'Bash', input: { description: 'Run the tests' } }], subAgents: [{ status: 'running', taskType: 'local_bash' }] });
    const clock = fakeSession({ items: [{ kind: 'tool', status: 'running', name: 'Bash', input: { description: 'Run the tests' } }], turnStartedAt: 2000 });
    const model = fakeSession({ items: [{ kind: 'tool', status: 'running', name: 'Bash', input: { description: 'Run the tests' } }], model: 'claude-sonnet-5' });
    const k = cardKeyOf(base, false);
    for (const s of [other, bg, clock, model]) expect(cardKeyOf(s, false)).not.toBe(k);
  });

  it('a tall card also follows its last lines; a tile does not', () => {
    const a = fakeSession({ busy: false, items: [{ kind: 'text', text: 'one\ntwo\nthree' }] });
    const b = fakeSession({ busy: false, items: [{ kind: 'text', text: 'zero\ntwo\nthree' }] });
    expect(cardKeyOf(a, false)).toBe(cardKeyOf(b, false));
    expect(cardKeyOf(a, true)).not.toBe(cardKeyOf(b, true));
  });

  it('the frame follows the status and the live work, not the text', () => {
    const a = fakeSession({ items: [{ kind: 'text', text: 'one' }] });
    const b = fakeSession({ items: [{ kind: 'text', text: 'one two' }] });
    expect(frameKeyOf(a)).toBe(frameKeyOf(b));
    expect(frameKeyOf(fakeSession({ asking: true }))).not.toBe(frameKeyOf(a));
    expect(frameKeyOf(fakeSession({ busy: false }))).not.toBe(frameKeyOf(a));
    expect(frameKeyOf(fakeSession({ liveWork: true }))).not.toBe(frameKeyOf(a));
  });
});
