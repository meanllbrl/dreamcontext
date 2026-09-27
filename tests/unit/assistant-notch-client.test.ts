/**
 * The dreamcontext Assistant's client half (W2): the relay frame parse, the pill glance, the
 * tile geometry, and what a project does when its doorbell rings (`runVerb`). The native
 * window and the Tauri event transport are covered by scripts/verify/assistant.mjs and the
 * owner's manual checklist; these pin the pure logic every one of those paths runs through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseChatLine } from '../../dashboard/src/lib/chatProtocol';
import { EMPTY_ROLLUP, pillBubbles, pillLabel, readRollup, type Rollup } from '../../dashboard/src/components/assistant/notchModel';
import { tileRects } from '../../dashboard/src/components/assistant/tile';

vi.mock('../../dashboard/src/lib/agentPrompt', () => ({
  preparePrompt: vi.fn(async (_vault: string, prompt: string) => ({ inline: prompt, token: '' })),
}));
vi.mock('../../dashboard/src/lib/assistantBridge', () => ({ listenForAssistantCommands: vi.fn(() => () => {}) }));

const { runVerb } = await import('../../dashboard/src/components/assistant/useAssistantDoorbell');

describe('relay frame parse', () => {
  it('turns a _meta assistant_command into an assistant-command event', () => {
    const ev = parseChatLine(JSON.stringify({ type: '_meta', subtype: 'assistant_command', id: 'a'.repeat(32), verb: 'chat', args: { vault: 'acme', prompt: 'hi' } }));
    expect(ev).toEqual({ kind: 'assistant-command', id: 'a'.repeat(32), verb: 'chat', args: { vault: 'acme', prompt: 'hi' } });
  });
  it('ignores one without an id or verb, and never passes non-object args through', () => {
    expect(parseChatLine(JSON.stringify({ type: '_meta', subtype: 'assistant_command', verb: 'chat' }))?.kind).toBe('ignored');
    const ev = parseChatLine(JSON.stringify({ type: '_meta', subtype: 'assistant_command', id: 'x', verb: 'focus', args: ['nope'] }));
    expect(ev).toEqual({ kind: 'assistant-command', id: 'x', verb: 'focus', args: {} });
  });
});

describe('pill glance (the tab strip\'s bubbles)', () => {
  const r = (o: Partial<Rollup>): Rollup => ({ ...EMPTY_ROLLUP, ...o });
  it('reads the rollup forward-compatibly: a missing stale (or any junk count) is 0', () => {
    expect(readRollup({ starting: 0, working: 2, asking: 1, idle: 3, proposals: 0 })).toEqual(r({ working: 2, asking: 1, idle: 3 }));
    expect(readRollup({ working: 1, stale: 5, idle: 'x', asking: -2, proposals: NaN })).toEqual(r({ working: 1, stale: 5 }));
    expect(readRollup(null)).toEqual(EMPTY_ROLLUP);
  });
  it('one bubble per status in the strip\'s order; starting is working, stale is grey with idle', () => {
    expect(pillBubbles(r({ working: 1, idle: 4, stale: 5 }))).toEqual([{ state: 'working', count: 1 }, { state: 'idle', count: 9 }]);
    expect(pillBubbles(r({ starting: 1, working: 2, asking: 1 }))).toEqual([{ state: 'asking', count: 1 }, { state: 'working', count: 3 }]);
  });
  it('a stale chat never lights the green ring, and an empty status draws no "0" bubble', () => {
    expect(pillBubbles(r({ stale: 10 }))).toEqual([{ state: 'idle', count: 10 }]);
    expect(pillBubbles(r({ proposals: 2 }))).toEqual([]);
  });
  it('says the counts in words, stale apart from idle', () => {
    expect(pillLabel(r({ working: 1, idle: 4, stale: 5 }))).toBe('1 working, 4 idle, 5 stale');
    expect(pillLabel(r({ starting: 1, asking: 2, proposals: 1 }))).toBe('2 asking, 1 working, 1 waiting for your approval');
    expect(pillLabel(EMPTY_ROLLUP)).toBe('no chats');
  });
});

describe('tile geometry', () => {
  const area = { x: 0, y: 25, width: 1800, height: 1100 };
  it('columns: side by side, full height, gaps between, inside the work area', () => {
    const r = tileRects(3, 'columns', area, 8);
    expect(r).toHaveLength(3);
    expect(r.every((x) => x.y === 25 && x.height === 1100)).toBe(true);
    expect(r[1].x).toBeGreaterThan(r[0].x + r[0].width);
    expect(r[2].x + r[2].width).toBeLessThanOrEqual(1800);
  });
  it('rows: stacked, full width', () => {
    const r = tileRects(2, 'rows', area, 8);
    expect(r.map((x) => x.width)).toEqual([1800, 1800]);
    expect(r[1].y).toBeGreaterThanOrEqual(r[0].y + r[0].height);
  });
  it('grid: squarest fit, last row stretched, nothing overlaps', () => {
    const r = tileRects(5, 'grid', area, 8);
    expect(r).toHaveLength(5);
    expect(r.slice(3).every((x) => x.width > r[0].width)).toBe(true); // 3 + 2
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
      const a = r[i], b = r[j];
      const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      expect(overlap).toBe(false);
    }
  });
  it('zero windows → nothing', () => {
    expect(tileRects(0, 'grid', area)).toEqual([]);
  });
});

describe('a project answering its doorbell (runVerb)', () => {
  type Pending = Record<string, unknown>;
  function fakeChat(pending: Pending[] = [], busy = false) {
    return {
      claudeId: 'c-1',
      busy,
      send: vi.fn(),
      steer: vi.fn(() => true),
      enqueue: vi.fn(),
      answer: vi.fn(),
      answerQuestion: vi.fn(),
      getModel: () => ({ pending }),
    };
  }
  let chat: ReturnType<typeof fakeChat>;
  let deps: Parameters<typeof runVerb>[0];
  beforeEach(() => {
    chat = fakeChat();
    deps = {
      vault: 'acme',
      findChat: vi.fn((id: string) => (id === 'c-1' ? chat as never : null)),
      openChat: vi.fn(() => ({ claudeId: 'new-1' }) as never),
      reveal: vi.fn(),
      openPage: vi.fn(),
    };
  });

  it('chat: opens a chat in the named mode and returns its conversation id', async () => {
    const out = await runVerb(deps, 'chat', { prompt: 'fix the build', mode: 'plan' });
    expect(deps.openChat).toHaveBeenCalledWith('fix the build', '', 'plan');
    expect(out).toEqual({ ok: true, result: { vault: 'acme', sessionId: 'new-1' } });
  });
  it('chat: an unknown mode is basic, never assistant', async () => {
    await runVerb(deps, 'chat', { prompt: 'x', mode: 'assistant' });
    expect(deps.openChat).toHaveBeenCalledWith('x', '', 'basic');
  });
  it('send: posts into the chat by conversation id; idle → a plain send, busy → a steer', async () => {
    expect(await runVerb(deps, 'send', { sessionId: 'c-1', text: 'and the tests' })).toMatchObject({ ok: true });
    expect(chat.send).toHaveBeenCalledWith('and the tests');
    chat = fakeChat([], true);
    await runVerb(deps, 'send', { sessionId: 'c-1', text: 'stop' });
    expect(chat.steer).toHaveBeenCalledWith('stop');
  });
  it('send: an unknown chat is refused, nothing is sent', async () => {
    expect(await runVerb(deps, 'send', { sessionId: 'nope', text: 'x' })).toMatchObject({ ok: false });
  });
  it('answer: a question card gets the pick on the question that offers it', async () => {
    const questions = [
      { question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
      { question: 'Which host?', options: [{ label: 'Fly' }, { label: 'Render' }] },
    ];
    chat = fakeChat([{ kind: 'question', requestId: 'q1', questions }]);
    expect(await runVerb(deps, 'answer', { sessionId: 'c-1', question: 'q1', choice: 'Render' })).toMatchObject({ ok: true });
    expect(chat.answerQuestion).toHaveBeenCalledWith('q1', questions, { 'Which host?': 'Render' });
  });
  it('answer: a permission prompt takes allow/deny (Turkish too) and refuses anything else', async () => {
    chat = fakeChat([{ kind: 'permission', requestId: 'p1', input: { command: 'ls' } }]);
    await runVerb(deps, 'answer', { sessionId: 'c-1', question: 'p1', text: 'evet' });
    expect(chat.answer).toHaveBeenCalledWith('p1', { behavior: 'allow', updatedInput: { command: 'ls' } });
    chat = fakeChat([{ kind: 'permission', requestId: 'p1', input: {} }]);
    await runVerb(deps, 'answer', { sessionId: 'c-1', question: 'p1', choice: 'deny' });
    expect(chat.answer.mock.calls[0][1]).toMatchObject({ behavior: 'deny' });
    chat = fakeChat([{ kind: 'permission', requestId: 'p1', input: {} }]);
    expect(await runVerb(deps, 'answer', { sessionId: 'c-1', question: 'p1', text: 'maybe later' })).toMatchObject({ ok: false });
    expect(chat.answer).not.toHaveBeenCalled();
  });
  it('answer: a question that is no longer waiting is refused', async () => {
    expect(await runVerb(deps, 'answer', { sessionId: 'c-1', question: 'gone', text: 'yes' })).toMatchObject({ ok: false });
  });
  it('focus and open reveal the project', async () => {
    expect(await runVerb(deps, 'focus', {})).toMatchObject({ ok: true });
    expect(await runVerb(deps, 'open', {})).toMatchObject({ ok: true });
    expect(deps.reveal).toHaveBeenCalledTimes(2);
  });
  it('open with a page lands on that page (a notch detail button, open --page)', async () => {
    const out = await runVerb(deps, 'open', { vault: 'acme', page: 'tasks/fix-login' });
    expect(deps.openPage).toHaveBeenCalledWith('tasks', 'fix-login');
    expect(deps.reveal).not.toHaveBeenCalled();
    expect(out).toEqual({ ok: true, result: { vault: 'acme', page: 'tasks/fix-login' } });
  });
  it('a malformed page is never navigated to — open falls back to revealing the project', async () => {
    for (const page of ['../etc', 'settings/x', 'tasks/', 'tasks/a/b', 42]) {
      await runVerb(deps, 'open', { vault: 'acme', page });
    }
    expect(deps.openPage).not.toHaveBeenCalled();
    expect(deps.reveal).toHaveBeenCalledTimes(5);
  });
  it('focus never navigates, even when handed a page', async () => {
    await runVerb(deps, 'focus', { page: 'tasks/fix-login' });
    expect(deps.openPage).not.toHaveBeenCalled();
  });
  it('a verb a project does not run is refused by name', async () => {
    expect(await runVerb(deps, 'tile', {})).toEqual({ ok: false, error: 'this project cannot run "tile"' });
  });
});
