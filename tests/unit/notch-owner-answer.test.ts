/**
 * The owner's Allow / Deny from the notch reaches the chat that asked, even when that chat is a
 * Super Agent's child (owner, 2026-10-22: the notch's Allow on a handed-over child's permission
 * said "Couldn't reach dreamcontext." and the child kept waiting).
 *
 * Root: the owner's answer rode the Assistant's `answer` relay, and the project window refuses
 * every Assistant verb aimed at the Super Agent or its children (`claudeIdIsSuperGuarded`). The
 * owner is not the Assistant: his answer now carries `by: 'owner'`, set only by the owner-gated
 * route, and the window looks the chat up without the guard for it.
 *
 * Pinned: the route relays `by: 'owner'`; the Assistant's verb args cannot carry it; the window
 * answers an owner Allow on a chat the Assistant may not reach and still refuses the Assistant;
 * "allow" / "deny" said in the notch are matched as whole words only; a chat session hands those
 * words to the host's hook instead of the agent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

process.env.HOME = mkdtempSync(`${tmpdir()}/notch-owner-answer-home-`);

const routes = await import('../../src/server/routes/assistant.js');
const registry = await import('../../src/lib/assistant/chat-registry.js');
const stateMod = await import('../../src/lib/assistant/session-state.js');
const relay = await import('../../src/lib/assistant/relay.js');
const { runVerb } = await import('../../dashboard/src/components/assistant/useAssistantDoorbell');
const { permissionWord } = await import('../../dashboard/src/components/assistant/notchModel');

function makeRes() {
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    writeHead(code: number) { status = code; },
    setHeader() {},
    end(data?: string) { try { body = JSON.parse(String(data)); } catch { body = {}; } },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body };
}

function req(url: string, body: unknown): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: 'POST', url,
    headers: { host: '127.0.0.1:4173', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1', setTimeout() {} },
    setTimeout() {},
  }) as unknown as IncomingMessage;
}

describe('POST /api/assistant/answer relays the OWNER\'s answer as his', () => {
  beforeEach(() => { registry._resetChatRegistry(); stateMod._resetAssistantState(); });
  afterEach(() => stateMod._resetAssistantState());

  it('the command the window claims says by: owner', async () => {
    const c = registry.registerChat({ sessionId: 'child-1', conversationId: null, vault: 'acme', mode: 'basic' });
    c.observe({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'python3 capture.py' } } });
    const frames: Array<Record<string, unknown>> = [];
    stateMod.setAssistantSurface({
      id: 'notch',
      send(frame) {
        frames.push(frame);
        queueMicrotask(() => relay.deliverResult(String(frame.id), { ok: true, result: { answered: 'allow' } }));
        return true;
      },
    });
    const r = makeRes();
    await routes.handleAssistantOwnerAnswer(req('/api/assistant/answer', { sessionId: 'child-1', question: 'r1', choice: 'allow' }), r.res);
    expect(r.body()).toMatchObject({ ok: true });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ verb: 'answer', args: { sessionId: 'child-1', question: 'r1', choice: 'allow', vault: 'acme', by: 'owner' } });
  });
});

describe('the project window answers by conversation id (runVerb answer)', () => {
  function fakeChat(pending: unknown[]) {
    return { answer: vi.fn(), answerQuestion: vi.fn(), getModel: () => ({ pending }) };
  }
  let chat: ReturnType<typeof fakeChat>;
  let deps: Parameters<typeof runVerb>[0];
  beforeEach(() => {
    chat = fakeChat([{ kind: 'permission', requestId: 'p1', input: { command: 'ls' } }]);
    deps = {
      vault: 'acme',
      // A Super Agent child: the Assistant's lookup refuses it, the owner's finds it.
      findChat: vi.fn(() => null),
      findOwnerChat: vi.fn((id: string) => (id === 'child-1' ? chat as never : null)),
      openChat: vi.fn(() => ({ claudeId: 'new-1' }) as never),
      reveal: vi.fn(),
      openPage: vi.fn(),
      closeChat: vi.fn(() => true),
    };
  });

  it('the owner\'s Allow reaches a chat the Assistant may not touch', async () => {
    const out = await runVerb(deps, 'answer', { sessionId: 'child-1', question: 'p1', choice: 'allow', by: 'owner' });
    expect(out).toEqual({ ok: true, result: { answered: 'allow' } });
    expect(chat.answer).toHaveBeenCalledWith('p1', { behavior: 'allow', updatedInput: { command: 'ls' } });
    expect(deps.findChat).not.toHaveBeenCalled();
  });

  it('the owner\'s Deny says it was his', async () => {
    await runVerb(deps, 'answer', { sessionId: 'child-1', question: 'p1', choice: 'deny', by: 'owner' });
    expect(chat.answer).toHaveBeenCalledWith('p1', { behavior: 'deny', message: 'Declined by the owner.' });
  });

  it('the Assistant\'s answer (no by) still cannot reach it', async () => {
    const out = await runVerb(deps, 'answer', { sessionId: 'child-1', question: 'p1', choice: 'allow' });
    expect(out).toMatchObject({ ok: false });
    expect(chat.answer).not.toHaveBeenCalled();
    expect(deps.findOwnerChat).not.toHaveBeenCalled();
  });

  it('any other value of by is not the owner', async () => {
    const out = await runVerb(deps, 'answer', { sessionId: 'child-1', question: 'p1', choice: 'allow', by: 'assistant' });
    expect(out).toMatchObject({ ok: false });
    expect(chat.answer).not.toHaveBeenCalled();
  });
});

describe('the window wires the owner lookup without the Super guard', () => {
  it('findOwnerChat is the plain lookup; findChat keeps the guard', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../dashboard/src/components/sleepy/AgentSurface.tsx', import.meta.url), 'utf-8');
    expect(src).toMatch(/findChat: \(claudeId\) => \{[\s\S]{0,300}if \(claudeIdIsSuperGuarded\(claudeId\)\) return null;[\s\S]{0,80}return liveChatByClaudeId\(claudeId\);/);
    expect(src).toMatch(/findOwnerChat: liveChatByClaudeId,/);
  });
});

describe('"allow" said in the notch (permissionWord)', () => {
  it('matches the whole message, in English and Turkish, as dictated', () => {
    for (const w of ['allow', 'Allow.', 'ALLOW!', ' allow it ', 'approve', 'Elov', 'İzin ver.', 'izin veriyorum', 'Onayla', 'onaylıyorum']) {
      expect(permissionWord(w), w).toBe('allow');
    }
    for (const w of ['deny', 'Deny.', 'reject', 'Reddet', 'izin verme', 'onaylama']) {
      expect(permissionWord(w), w).toBe('deny');
    }
  });

  it('leaves everything else to the Assistant, a bare yes / evet included', () => {
    for (const w of ['yes', 'evet', 'tamam', 'no', 'hayır', 'allow the tilki one', 'please allow', 'should I allow it?', '', 'izin']) {
      expect(permissionWord(w), w).toBeNull();
    }
  });
});

describe('a chat session hands the owner\'s words to its host first (setOwnerWordsHook)', () => {
  class FakeWebSocket {
    static OPEN = 1;
    static all: FakeWebSocket[] = [];
    readonly OPEN = 1;
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: ((e: { code: number }) => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    sent: string[] = [];
    constructor(public url: string) { FakeWebSocket.all.push(this); }
    send(d: string) { this.sent.push(d); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen?.(); }
  }
  beforeEach(() => {
    FakeWebSocket.all = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:4173', assign: vi.fn() });
    vi.stubGlobal('document', {
      createElement: () => ({ className: '', remove() {}, style: {}, appendChild() {} }),
      addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', querySelector: () => null,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ messages: [], items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  const userFrames = (ws: FakeWebSocket) => ws.sent.map((d) => JSON.parse(d) as Record<string, unknown>).filter((f) => f.type === 'user');

  it('a word the hook takes is never sent, drawn or queued; anything else goes as before', async () => {
    const { createChatSession } = await import('../../dashboard/src/components/sleepy/chatSession');
    const s = createChatSession('__assistant__', false, () => {}, '6f1c2e9a-a001-4a5b-8c9d-0123456789ac', false, '', '', '', '', false, 'assistant');
    const ws = FakeWebSocket.all[0];
    ws.open();
    const heard: string[] = [];
    s.setOwnerWordsHook((text) => { heard.push(text); return text === 'allow'; });

    expect(s.send(' allow ')).toBe(true);
    expect(s.steer('allow')).toBe(true);
    s.enqueue('allow');
    expect(heard).toEqual(['allow', 'allow', 'allow']);
    expect(userFrames(ws)).toEqual([]);
    expect(s.getModel().items.filter((i) => i.kind === 'user')).toEqual([]);
    expect(s.getModel().queued).toHaveLength(0);

    s.send('what is Tilki doing?');
    expect(userFrames(ws).map((f) => f.text)).toEqual(['what is Tilki doing?']);

    // Withdrawn: the word is the agent's again.
    s.setOwnerWordsHook(null);
    s.send('allow');
    expect(userFrames(ws).map((f) => f.text)).toEqual(['what is Tilki doing?', 'allow']);
    s.dispose();
  });

  it('a hook that throws takes nothing', async () => {
    const { createChatSession } = await import('../../dashboard/src/components/sleepy/chatSession');
    const s = createChatSession('__assistant__', false, () => {}, '6f1c2e9a-a001-4a5b-8c9d-0123456789ad', false, '', '', '', '', false, 'assistant');
    const ws = FakeWebSocket.all[0];
    ws.open();
    s.setOwnerWordsHook(() => { throw new Error('boom'); });
    s.send('allow');
    expect(userFrames(ws).map((f) => f.text)).toEqual(['allow']);
    s.dispose();
  });
});
