/**
 * A permission card the CLI no longer waits on leaves the window (owner 2026-11-02: a Super child
 * sat "asking" behind a dead card, and the Super's sends queued behind it). Dead = the CLI sent
 * `control_cancel_request`, or the card's tool call already got its tool_result (Claude Code
 * rejects a request with "AbortError: Stream closed" once its stdin closed). Also: the window's
 * `allow` verb (`super allow`, and the owner's Allow/Deny from the phone) answers only a permission.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseChatLine, settledToolUseIds, toolResultIds } from '../../dashboard/src/lib/chatProtocol';
import { superAllow, type AllowTarget } from '../../dashboard/src/components/sleepy/super/superAllow';
import type { PendingItem } from '../../dashboard/src/components/sleepy/chatSession';
import { needsOwner, queueHead } from '../../dashboard/src/components/sleepy/super/superHandover';
import { phoneQuestionItems } from '../../dashboard/src/components/sleepy/super/usePhoneSuperQuestions';

class FakeWebSocket {
  static all: FakeWebSocket[] = [];
  readonly OPEN = 1;
  readyState = 0;
  url: string;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(url: string) { this.url = url; FakeWebSocket.all.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  frame(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }); }
}

const permission = (requestId: string, toolUseId: string) => ({
  type: 'control_request', request_id: requestId,
  request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf /tmp/x' }, tool_use_id: toolUseId },
});
const toolResults = (...ids: string[]) => ({
  type: 'user', message: { role: 'user', content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, is_error: true, content: 'Tool permission request failed: AbortError: Stream closed' })) },
});
const CID = '6f1c2e9a-a001-4a5b-8c9d-0123456789ac';

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.all = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:4000', assign: vi.fn() });
  vi.stubGlobal('document', {
    createElement: () => ({ className: '', remove() {}, style: {}, appendChild() {} }),
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', querySelector: () => null,
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ messages: [], items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function open() {
  const { createChatSession } = await import('../../dashboard/src/components/sleepy/chatSession');
  return createChatSession('demo', true, () => {}, CID, false, '', '', '', '', false, 'basic', '', '', null, '');
}
const last = () => FakeWebSocket.all[FakeWebSocket.all.length - 1];
const pendingIds = (s: Awaited<ReturnType<typeof open>>) => s.getModel().pending.map((p) => p.requestId);

describe('the protocol reads a dead request', () => {
  it('control_cancel_request is an event, not ignored', () => {
    expect(parseChatLine(JSON.stringify({ type: 'control_cancel_request', request_id: 'r1' }))).toEqual({ kind: 'request-cancelled', requestId: 'r1' });
  });

  it('every tool_result id of a user frame counts (parallel tools share one frame)', () => {
    const frame = toolResults('tu-1', 'tu-2', 'tu-1');
    expect(toolResultIds(frame.message.content)).toEqual(['tu-1', 'tu-2']);
    expect(settledToolUseIds(parseChatLine(JSON.stringify(frame)))).toEqual(['tu-1', 'tu-2']);
  });
});

describe('the window drops a ghost permission card', () => {
  it('on control_cancel_request', async () => {
    const s = await open();
    last().open();
    last().frame(permission('r1', 'tu-1'));
    expect(pendingIds(s)).toEqual(['r1']);
    last().frame({ type: 'control_cancel_request', request_id: 'r1' });
    expect(pendingIds(s)).toEqual([]);
  });

  it('when its tool call already got a result, keeping an unrelated card', async () => {
    const s = await open();
    last().open();
    last().frame(permission('r1', 'tu-1'));
    last().frame(permission('r2', 'tu-2'));
    last().frame(toolResults('tu-9', 'tu-1'));
    expect(pendingIds(s)).toEqual(['r2']);
  });
});

describe('the window `allow` verb', () => {
  const target = (pending: PendingItem[], written = true) => {
    const calls: unknown[] = [];
    const t: AllowTarget = { getModel: () => ({ pending }), answer: (id, opts) => { calls.push([id, opts]); return written; } };
    return { t, calls };
  };
  const perm = { kind: 'permission', requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } } as PendingItem;
  const question = { kind: 'question', requestId: 'q1', toolName: 'AskUserQuestion', questions: [] } as unknown as PendingItem;

  it('allows a permission with its own input, denies with the reason', () => {
    const { t, calls } = target([perm]);
    expect(superAllow({ child: 'c1', requestId: 'r1', behavior: 'allow' }, () => true, () => t)).toEqual({ ok: true });
    expect(calls[0]).toEqual(['r1', { behavior: 'allow', updatedInput: { command: 'ls' } }]);
    superAllow({ child: 'c1', requestId: 'r1', behavior: 'deny', message: 'Denied by the Super Agent: outside' }, () => true, () => t);
    expect(calls[1]).toEqual(['r1', { behavior: 'deny', message: 'Denied by the Super Agent: outside' }]);
    superAllow({ child: 'c1', requestId: 'r1', behavior: 'deny', by: 'owner' }, () => true, () => t);
    expect(calls[2]).toEqual(['r1', { behavior: 'deny', message: 'Declined by the owner.' }]);
  });

  it('refuses a question, a non-child, a closed tab and an unwritten answer', () => {
    const { t, calls } = target([question]);
    expect(superAllow({ child: 'c1', requestId: 'q1', behavior: 'allow' }, () => true, () => t)).toEqual({ ok: false, error: 'no_such_permission' });
    expect(superAllow({ child: 'x', requestId: 'r1', behavior: 'allow' }, () => false, () => t)).toEqual({ ok: false, error: 'not_a_child' });
    expect(superAllow({ child: 'c1', requestId: 'r1', behavior: 'allow' }, () => true, () => null)).toEqual({ ok: false, error: 'child_not_open' });
    expect(calls).toEqual([]);
    expect(superAllow({ child: 'c1', requestId: 'r1', behavior: 'allow' }, () => true, () => target([perm], false).t)).toEqual({ ok: false, error: 'not_connected' });
  });
});

describe('the owner bar and the phone', () => {
  const base = { sessionId: 'c1', state: 'pending' as const, createdAt: 1 };
  it('a permission its Super decides first is no owner head', () => {
    const routed = { ...base, id: 'p1', kind: 'permission' as const, requestId: 'r1', toSuper: true as const };
    const his = { ...base, id: 'p2', kind: 'permission' as const, requestId: 'r2', createdAt: 2 };
    expect(needsOwner(routed)).toBe(false);
    expect(queueHead({ queue: [routed, his] })?.id).toBe('p2');
  });

  it('the phone reads a permission with its tool and command', () => {
    const out = phoneQuestionItems({ session: 'sup', questions: [
      { id: 'p2', kind: 'permission', sessionId: 'c1', requestId: 'r2', createdAt: 2, card: null, permission: { tool: 'Bash', text: 'rm -rf build' } },
      { id: 'p3', kind: 'permission', sessionId: 'c1', createdAt: 3, card: null, permission: { tool: 'Bash', text: 'x' } },
    ] });
    expect(out.open.map((q) => [q.id, q.kind, q.requestId])).toEqual([['p2', 'permission', 'r2']]);
    expect(out.permissions.get('p2')).toEqual({ tool: 'Bash', text: 'rm -rf build' });
  });
});
