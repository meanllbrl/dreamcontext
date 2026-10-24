// Owner 2026-10-24: with the Super Agent handed over, the hands-free phone got the pushes of the
// project's OTHER chats too (children's finished turns and questions). In a handed-over project
// only the Super's own chat and the questions it puts to the owner push; a project not handed
// over pushes as before. Driven through the REAL chat registry with a fake push service.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onChatChange, registerChat, type ChatHandle } from '../../src/lib/assistant/chat-registry.js';
import { PushNotifier, superAllows, type PushPayload } from '../../src/lib/handsfree/mac/push-notifier.js';
import { PushStore } from '../../src/lib/handsfree/mac/push-store.js';

const KEYS = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
const PHONE = 'a'.repeat(64);
const SUPER = '11111111-2222-4333-8444-000000000001';
const CHILD = '11111111-2222-4333-8444-000000000002';
const OTHER = '11111111-2222-4333-8444-000000000003';

let dir: string;
let sent: PushPayload[];
let supers: Map<string, string>;
let n: PushNotifier;
let stop: () => void;
let pending: Promise<unknown>[];
let showing: string | null;

const chat = (id: string, vault: string): ChatHandle => registerChat({ sessionId: id, conversationId: id, vault, mode: 'basic' });
const ask = (h: ChatHandle, requestId: string) => h.observe({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', options: [{ label: 'a' }] }] } } });
const permit = (h: ChatHandle, requestId: string) => h.observe({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
const turn = (h: ChatHandle) => { h.userSent('go'); h.observe({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] }, parent_tool_use_id: null }); h.observe({ type: 'result', subtype: 'success' }); };
const settle = async () => { await Promise.all(pending); pending = []; };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-phone-quiet-'));
  const store = new PushStore({ dir });
  store.put(PHONE, { endpoint: 'https://web.push.apple.com/phone', keys: KEYS });
  sent = [];
  pending = [];
  showing = null;
  supers = new Map([['handed', SUPER]]);
  n = new PushNotifier({
    exposed: () => ['handed', 'plain'],
    store: () => store,
    deviceValid: () => true,
    showingDevice: (sid) => (showing === sid ? PHONE : null),
    superSession: (vault) => supers.get(vault) ?? null,
    send: async (_sub, payload) => { sent.push(payload); return { ok: true, status: 201, gone: false }; },
  });
  stop = onChatChange((c) => { pending.push(n.onChange(c)); });
});
afterEach(() => { stop(); rmSync(dir, { recursive: true, force: true }); });

describe('a handed-over project pushes only its Super Agent', () => {
  it('a child\'s finished turn and question stay off the phone', async () => {
    const child = chat(`${CHILD}`, 'handed');
    turn(child);
    child.userSent('again');
    ask(child, 'c-q1');
    await settle();
    expect(sent).toEqual([]);
  });

  it('the one exception, as on the laptop: a child\'s permission pushes, and opens the Super\'s chat', async () => {
    const child = chat('11111111-2222-4333-8444-00000000000b', 'handed');
    child.userSent('go');
    permit(child, 'c-p1');
    await settle();
    expect(sent.map((p) => [p.kind, p.conversationId])).toEqual([['permission', SUPER]]);
    expect(sent[0].url).toContain(encodeURIComponent(SUPER));
    expect(sent[0].body).toMatch(/answer it on the Mac/);
  });

  it('…even while the phone shows the Super\'s chat (it draws no permission there)', async () => {
    showing = SUPER;
    const child = chat('11111111-2222-4333-8444-00000000000c', 'handed');
    child.userSent('go');
    permit(child, 'c-p2');
    await settle();
    expect(sent.map((p) => p.kind)).toEqual(['permission']);
  });

  it('another chat of the same project stays quiet too', async () => {
    const other = chat(OTHER, 'handed');
    turn(other);
    await settle();
    expect(sent).toEqual([]);
  });

  it('the Super Agent\'s own finished turn pushes', async () => {
    const sup = chat(SUPER, 'handed');
    turn(sup);
    await settle();
    expect(sent.map((p) => [p.kind, p.conversationId])).toEqual([['turn', SUPER]]);
  });

  it('a question the Super puts to the owner (an escalated child question) pushes into the super chat', async () => {
    const r = n.pushOwnerQuestion({ vault: 'handed', sessionId: SUPER, key: 'super-ask:q1', title: 'Super Agent asks · handed', body: 'Pick the layout' });
    expect(r.targeted).toBe(1);
    await r.done;
    expect(sent.map((p) => [p.kind, p.conversationId])).toEqual([['question', SUPER]]);
  });

  it('a project not handed over pushes as before', async () => {
    const plain = chat('22222222-2222-4333-8444-000000000009', 'plain');
    turn(plain);
    plain.userSent('again');
    ask(plain, 'p-q1');
    await settle();
    expect(sent.map((p) => p.kind)).toEqual(['turn', 'question']);
  });

  it('taken back: the children push again', async () => {
    supers.clear();
    const child = chat('11111111-2222-4333-8444-00000000000a', 'handed');
    turn(child);
    await settle();
    expect(sent.map((p) => p.kind)).toEqual(['turn']);
  });

  it('superAllows: only the super\'s own chat, by registry id or conversation', () => {
    expect(superAllows(null, { sessionId: CHILD, conversationId: CHILD })).toBe(true);
    expect(superAllows(SUPER, { sessionId: SUPER, conversationId: null })).toBe(true);
    expect(superAllows(SUPER, { sessionId: 'tab-1', conversationId: SUPER })).toBe(true);
    expect(superAllows(SUPER, { sessionId: CHILD, conversationId: CHILD })).toBe(false);
  });
});
