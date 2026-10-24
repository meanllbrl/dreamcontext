// AC8: exactly three events push — a question, a permission, a finished turn — driven through the
// REAL chat registry (frames in, ChatChange out), with a fake push service.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onChatChange, registerChat, type ChatHandle } from '../../src/lib/assistant/chat-registry.js';
import { MAC_HEAT_SESSION, PushNotifier, pushFor, pushUrl, type PushPayload } from '../../src/lib/handsfree/mac/push-notifier.js';
import { PushStore } from '../../src/lib/handsfree/mac/push-store.js';
import { parseAppLink } from '../../dashboard/src/lib/appLink.js';

const KEYS = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
const PHONE = 'a'.repeat(64);
const IPAD = 'b'.repeat(64);
const CONV = '11111111-2222-4333-8444-555555555555';

let dir: string;
let store: PushStore;
let sent: Array<{ endpoint: string; payload: PushPayload }>;
let project: string | null;
let showing: string | null;
let valid: Set<string>;
let stop: () => void;
let pending: Promise<unknown>[];

function chat(sessionId: string, vault = 'proj'): ChatHandle {
  const h = registerChat({ sessionId, conversationId: CONV, vault, mode: 'basic' });
  return h;
}
const ask = (h: ChatHandle, requestId: string, question = 'Which file?') => h.observe({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question, options: [{ label: 'a' }] }] } } });
const permit = (h: ChatHandle, requestId: string) => h.observe({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf /secret/path' } } });
const result = (h: ChatHandle) => h.observe({ type: 'result', subtype: 'success' });
const settle = async () => { await Promise.all(pending); pending = []; };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'push-notifier-'));
  store = new PushStore({ dir });
  store.put(PHONE, { endpoint: 'https://web.push.apple.com/phone', keys: KEYS });
  store.put(IPAD, { endpoint: 'https://web.push.apple.com/ipad', keys: KEYS });
  sent = [];
  project = 'proj';
  showing = null;
  valid = new Set([PHONE, IPAD]);
  pending = [];
  const n = new PushNotifier({
    exposed: () => (project ? [project] : []),
    store: () => store,
    deviceValid: (h) => valid.has(h),
    showingDevice: () => showing,
    send: async (sub, payload) => { sent.push({ endpoint: sub.endpoint, payload }); return { ok: true, status: 201, gone: false }; },
  });
  stop = onChatChange((c) => { pending.push(n.onChange(c)); });
});
afterEach(() => { stop(); rmSync(dir, { recursive: true, force: true }); });

describe('the three pushes', () => {
  it('a question pushes once per device, with vault, conversation id and the D10 link', async () => {
    const h = chat('s-question');
    h.userSent('go');
    ask(h, 'r1');
    await settle();
    expect(sent.map((s) => s.endpoint).sort()).toEqual(['https://web.push.apple.com/ipad', 'https://web.push.apple.com/phone']);
    const p = sent[0].payload;
    expect(p).toMatchObject({ kind: 'question', vault: 'proj', conversationId: CONV, title: 'Claude is asking', body: 'Which file?' });
    expect(p.url).toBe(pushUrl('proj', CONV));
    // The link is the app's own session link, opening that conversation.
    const open = new URL(p.url, 'https://x').searchParams.get('open')!;
    expect(parseAppLink(open)).toEqual({ kind: 'session', vault: 'proj', claudeId: CONV });
  });

  it('a second, different question while still asking pushes again; the same one never twice', async () => {
    const h = chat('s-two');
    h.userSent('go');
    ask(h, 'r1');
    ask(h, 'r1');
    await settle();
    expect(sent).toHaveLength(2);
    ask(h, 'r2', 'And this one?');
    await settle();
    expect(sent).toHaveLength(4);
    expect(sent[3].payload.body).toBe('And this one?');
  });

  it('a permission pushes the tool name and never the command or a path', async () => {
    const h = chat('s-perm');
    h.userSent('go');
    permit(h, 'p1');
    await settle();
    expect(sent).toHaveLength(2);
    const p = sent[0].payload;
    expect(p.kind).toBe('permission');
    expect(p.title).toBe('Permission needed');
    expect(p.body).toContain('Bash');
    expect(JSON.stringify(p)).not.toMatch(/rm -rf|secret\/path/);
  });

  it('a top-level turn result pushes "turn finished" once', async () => {
    const h = chat('s-turn');
    h.userSent('build it');
    result(h);
    await settle();
    expect(sent).toHaveLength(2);
    expect(sent[0].payload).toMatchObject({ kind: 'turn', body: 'Turn finished', title: 'build it' });
    // An answered question that ends the turn is a turn end too (asking -> idle on a result).
    ask(h, 'r9');
    await settle();
    result(h);
    await settle();
    expect(sent.filter((s) => s.payload.kind === 'turn')).toHaveLength(4);
  });
});

describe('what never pushes', () => {
  it('nothing while Mac mode is off, and nothing for another project', async () => {
    project = null;
    const h = chat('s-off');
    h.userSent('x');
    ask(h, 'r1');
    result(h);
    await settle();
    project = 'proj';
    const o = chat('s-other', 'other');
    o.userSent('x');
    ask(o, 'r2');
    await settle();
    expect(sent).toEqual([]);
  });

  it('not to the device whose phone shows that chat; the other device still gets it; a laptop-held chat pushes', async () => {
    showing = PHONE;
    const h = chat('s-shown');
    h.userSent('x');
    ask(h, 'r1');
    await settle();
    expect(sent.map((s) => s.endpoint)).toEqual(['https://web.push.apple.com/ipad']);
    showing = null; // the laptop holds it: nothing is suppressed
    ask(h, 'r2');
    await settle();
    expect(sent).toHaveLength(3);
  });

  it('an interrupted turn, the busy/starting/gone edges and a plain status read never push', async () => {
    const h = chat('s-int');
    h.userSent('x');
    h.interrupted();
    result(h);
    await settle();
    h.observe({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
    h.exited();
    await settle();
    expect(sent).toEqual([]);
  });

  it('a signed-out device is dropped from the store and gets nothing', async () => {
    valid.delete(IPAD);
    const h = chat('s-revoked');
    h.userSent('x');
    ask(h, 'r1');
    await settle();
    expect(sent.map((s) => s.endpoint)).toEqual(['https://web.push.apple.com/phone']);
    expect(store.get(IPAD)).toBeNull();
  });

  it('a 404/410 from the push service drops that subscription', async () => {
    const n = new PushNotifier({
      exposed: () => ['proj'], store: () => store, deviceValid: () => true, showingDevice: () => null,
      send: async (sub) => ({ ok: false, status: sub.endpoint.endsWith('/ipad') ? 410 : 201, gone: sub.endpoint.endsWith('/ipad') }),
    });
    const s2 = onChatChange((c) => { pending.push(n.onChange(c)); });
    stop();
    const h = chat('s-gone');
    h.userSent('x');
    ask(h, 'r1');
    await settle();
    s2();
    stop = () => {};
    expect(store.get(IPAD)).toBeNull();
    expect(store.get(PHONE)).not.toBeNull();
  });

  it('a push that did not land is logged with the host and a device prefix, never the endpoint path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const n = new PushNotifier({
        exposed: () => ['proj'], store: () => store, deviceValid: () => true, showingDevice: () => null,
        send: async (sub) => (sub.endpoint.endsWith('/ipad') ? { ok: false, status: null, gone: false, error: 'TimeoutError' } : { ok: false, status: 503, gone: false }),
      });
      const s2 = onChatChange((c) => { pending.push(n.onChange(c)); });
      stop();
      const h = chat('s-log');
      h.userSent('x');
      ask(h, 'r1');
      await settle();
      s2();
      stop = () => {};
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => /\[handsfree-push\] question not delivered: 503 host=web\.push\.apple\.com device=aaaaaaaa$/.test(l))).toBe(true);
      expect(lines.some((l) => /not delivered: TimeoutError .*device=bbbbbbbb$/.test(l))).toBe(true);
      expect(lines.join('\n')).not.toMatch(/\/phone|\/ipad/);
      expect(store.get(PHONE)).not.toBeNull();
    } finally { warn.mockRestore(); }
  });
});

describe('the registry records how a turn ended', () => {
  it('interrupt then result gives lastTurn.interrupted=true; the next turn starts clean; resultSeq only grows', () => {
    const changes: Array<{ interrupted?: boolean; seq?: number }> = [];
    const off = onChatChange((c) => { if (c.entry.sessionId === 's-reg' && c.entry.status === 'idle') changes.push({ interrupted: c.entry.lastTurn?.interrupted, seq: c.entry.lastTurn?.resultSeq }); });
    const h = chat('s-reg');
    h.userSent('a');
    h.interrupted();
    result(h);
    h.userSent('b');
    result(h);
    off();
    expect(changes.map((c) => c.interrupted)).toEqual([true, false]);
    expect(changes[1].seq!).toBeGreaterThan(changes[0].seq!);
    // pushFor reads the same thing.
    expect(pushFor({ entry: { sessionId: 'x', conversationId: null, vault: 'proj', mode: 'basic', title: '', status: 'idle', lastAssistantText: [], pendingQuestion: null, updatedAt: '', lastFrameAt: '', toolsInFlight: 0, lastTurn: { endedAt: '', interrupted: true, resultSeq: 1 } }, from: 'working' })).toBeNull();
  });
});

describe('the Mac heat push (the heat task, AC7)', () => {
  const make = (send: (sub: unknown, p: PushPayload) => Promise<{ ok: boolean; status: number | null; gone: boolean }>, now = () => 1_000) => new PushNotifier({
    exposed: () => (project ? [project, 'other'] : []),
    store: () => store,
    deviceValid: (h) => valid.has(h),
    // The phone shows some chat; the heat push's sentinel session is no chat, so never suppressed.
    showingDevice: (sid) => (sid === MAC_HEAT_SESSION ? null : PHONE),
    send: send as never,
    now,
  });
  const heat = { key: 'heat:2026-10-24T20:00:00.000Z', title: 'Mac is very hot', body: 'Heavy steps now run one at a time. If you can, take the Mac out of the bag.' };
  const ok = async (sub: unknown, p: PushPayload) => { sent.push({ endpoint: (sub as { endpoint: string }).endpoint, payload: p }); return { ok: true, status: 201, gone: false }; };

  it('nothing exposed: 0, nothing sent', async () => {
    project = null;
    const r = make(ok).pushMacHeat(heat);
    expect(r.targeted).toBe(0);
    expect(await r.done).toBe(0);
    expect(sent).toEqual([]);
  });

  it('no device: the key is NOT consumed; once a device subscribes it pushes; the same key never again', async () => {
    const n = make(ok);
    store.remove(PHONE); store.remove(IPAD);
    expect(n.pushMacHeat(heat).targeted).toBe(0);
    store.put(PHONE, { endpoint: 'https://web.push.apple.com/phone', keys: KEYS });
    const r = n.pushMacHeat(heat);
    expect(r.targeted).toBe(1);
    expect(await r.done).toBe(1);
    expect(n.pushMacHeat(heat).targeted).toBe(0);
    expect(sent).toHaveLength(1);
    const p = sent[0].payload;
    expect(p).toEqual({ kind: 'mac', vault: 'proj', conversationId: null, title: heat.title, body: heat.body, url: pushUrl('proj', null) });
    // No path, command or chat text: the project page and the two fixed lines only.
    expect(p.url).toBe('/?vault=proj');
    expect(JSON.stringify(p)).not.toMatch(/\/Users|scripts\/|tsc|vitest/);
  });

  it('an invalid device is pruned and skipped; the rate limit applies', async () => {
    valid = new Set([PHONE]);
    const r = make(ok).pushMacHeat(heat);
    expect(r.targeted).toBe(1);
    await r.done;
    expect(store.entries().map(([d]) => d)).toEqual([PHONE]);
    sent = [];
    // The phone used its whole minute already: no target, the key stays unspent.
    const n = make(ok, () => 5_000);
    for (let i = 0; i < 30; i++) (n as unknown as { allow: (d: string) => boolean }).allow(PHONE);
    expect(n.pushMacHeat({ ...heat, key: 'heat:b' }).targeted).toBe(0);
    expect(sent).toEqual([]);
  });

  it('a rejecting send resolves done with a rejection the caller catches; nothing throws synchronously', async () => {
    const r = make(async () => { throw new Error('push service down'); }).pushMacHeat(heat);
    expect(r.targeted).toBe(2);
    await expect(r.done).rejects.toThrow('push service down');
  });
});
