/**
 * The owner is not pinged about Super Agent children (plan-r7 D16, AC6 server half):
 *  - a handed-over child's finished turn is no notch inbox row; an ordinary chat's still is;
 *  - the Super Agent's own reply is news (owner, 2026-10-21): every turn of it, the ones its
 *    inbox opened too, is a row AND a routable banner unless he is looking at it; with the
 *    mode off nothing gets a banner;
 *  - the glance leaves children out and carries at most ONE super row per project (its queue
 *    head when that is a permission or an escalation); the rollup counts only that head;
 *  - the Assistant's send/answer/close refuse the super session and its children while handed
 *    over.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/notch-super-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, registerChat, type ChatHandle } from '../../src/lib/assistant/chat-registry.js';
import { FINISH_DEBOUNCE_MS, _resetNotchInbox, listNotchEvents, setPresence, setSuperFinishBanner, wireNotchInbox } from '../../src/lib/assistant/notch-inbox.js';
import { SUPER_STATE_REL, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox, markSuperEventTurn, noteSuperEscalation, startSuperInbox } from '../../src/lib/super/inbox.js';
import { handleAssistantGlance, handleAssistantRollup, handleAssistantUi } from '../../src/server/routes/assistant.js';
import { assistantToken, _resetAssistantState } from '../../src/lib/assistant/session-state.js';

let dir: string;
let root: string;
const SUPER = 'super-0001';
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

async function makeVault(state: Partial<SuperState> = {}): Promise<void> {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
    ...emptySuperState(), session: SUPER, enabled: true,
    children: { c1: { sessionId: 'c1', brief: '', adopted: true, startedAt: 1 } },
    ...state,
  }));
  await startSuperInbox([root]);
}

const handles = new Map<string, ChatHandle>();
const reg = (sid: string, mode = 'basic'): ChatHandle => { const h = registerChat({ sessionId: sid, conversationId: null, vault: 'acme', mode }); handles.set(sid, h); return h; };
const getHandle = (sid: string): ChatHandle => handles.get(sid)!;
const finishTurn = (h: ChatHandle) => { h.userSent('go'); h.observe({ type: 'result' }); };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'notch-super-'));
  _resetChatRegistry();
  _resetNotchInbox();
  resetSuperIndex();
  _resetSuperInbox();
  _resetAssistantState();
  process.env.DREAMCONTEXT_DESKTOP = '1';
});
afterEach(() => {
  vi.useRealTimers();
  _resetSuperInbox();
  if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
  rmSync(dir, { recursive: true, force: true });
});

function req(body?: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', ...headers }, socket: { remoteAddress: '127.0.0.1', setTimeout: () => undefined }, method: body === undefined ? 'GET' : 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(body === undefined ? '' : JSON.stringify(body)); });
  return r;
}
function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown>, once: () => out, off: () => out } as unknown as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}

describe('the notch inbox', () => {
  it('a handed-over child\'s finished turn is no row; an ordinary chat\'s is', async () => {
    await makeVault();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    wireNotchInbox();
    finishTurn(reg('c1'));
    finishTurn(reg('ordinary'));
    vi.advanceTimersByTime(FINISH_DEBOUNCE_MS + 10);
    const ids = listNotchEvents().filter((e) => e.kind === 'finished').map((e) => (e as { sessionId: string }).sessionId);
    expect(ids).toEqual(['ordinary']);
  });

  it('the super agent\'s reply is a row and a banner to its stage, the turn its inbox opened too', async () => {
    await makeVault();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    wireNotchInbox();
    const banners: Array<[string, string, string | null]> = [];
    setSuperFinishBanner((t, b, l) => { banners.push([t, b, l]); });
    const sup = reg(SUPER, 'super');
    markSuperEventTurn(SUPER, true);
    sup.userSent('[super event] c1 finished');
    sup.observe({ type: 'assistant', message: { content: [{ type: 'text', text: 'Login fix is done, tests pass.' }] } });
    sup.observe({ type: 'result' });
    vi.advanceTimersByTime(FINISH_DEBOUNCE_MS + 10);
    expect(listNotchEvents().filter((e) => e.kind === 'finished').map((e) => (e as { sessionId: string }).sessionId)).toEqual([SUPER]);
    expect(banners).toHaveLength(1);
    expect(banners[0][0]).toBe('Super Agent · acme');
    expect(banners[0][1]).toBe('Login fix is done, tests pass.');
    expect(banners[0][2]).toBe(`dreamcontext://project/acme/session/${SUPER}`);
    // The owner's own turn with it is news the same way.
    markSuperEventTurn(SUPER, false);
    finishTurn(sup);
    vi.advanceTimersByTime(FINISH_DEBOUNCE_MS + 10);
    expect(banners).toHaveLength(2);
  });

  it('nothing at all while the owner is looking at the super agent', async () => {
    await makeVault();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    wireNotchInbox();
    const banners: string[] = [];
    setSuperFinishBanner((t) => { banners.push(t); });
    setPresence('vault-acme', 'acme', SUPER);
    finishTurn(reg(SUPER, 'super'));
    vi.advanceTimersByTime(FINISH_DEBOUNCE_MS + 10);
    expect(listNotchEvents().filter((e) => e.kind === 'finished')).toHaveLength(0);
    expect(banners).toEqual([]);
    // Focused on the project but on another chat: he is not looking at it.
    setPresence('vault-acme', 'acme', 'ordinary');
    finishTurn(getHandle(SUPER));
    vi.advanceTimersByTime(FINISH_DEBOUNCE_MS + 10);
    expect(banners).toHaveLength(1);
  });

  it('the reply stays news when the server opens the next turn at once (no debounce to lose it)', async () => {
    await makeVault();
    wireNotchInbox();
    const banners: string[] = [];
    setSuperFinishBanner((t, b) => { banners.push(b); });
    const sup = reg(SUPER, 'super');
    sup.userSent('which branch is the fix on?');
    sup.observe({ type: 'assistant', message: { content: [{ type: 'text', text: 'On super/login-fix.' }] } });
    sup.observe({ type: 'result' });
    // The queue pump starts an event turn right away.
    markSuperEventTurn(SUPER, true);
    sup.userSent('[super event] c1 idle');
    expect(banners).toEqual(['On super/login-fix.']);
    expect(listNotchEvents().filter((e) => e.kind === 'finished')).toHaveLength(1);
  });

  it('a turn that escalated a question is no second ping: the queue head raised the one alarm', async () => {
    await makeVault();
    wireNotchInbox();
    const banners: string[] = [];
    setSuperFinishBanner((t) => { banners.push(t); });
    const sup = reg(SUPER, 'super');
    sup.userSent('[super event] c1 asks');
    noteSuperEscalation(SUPER);
    sup.observe({ type: 'result' });
    expect(banners).toEqual([]);
    expect(listNotchEvents().filter((e) => e.kind === 'finished')).toHaveLength(0);
    // Read once: the next reply is news again.
    finishTurn(sup);
    expect(banners).toHaveLength(1);
  });

  it('children never: no row and no banner, idle or after a question', async () => {
    await makeVault({ children: {
      c1: { sessionId: 'c1', brief: '', adopted: true, startedAt: 1 },
      d1: { sessionId: 'd1', brief: 'build it', adopted: false, startedAt: 1 },
    } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    wireNotchInbox();
    const banners: string[] = [];
    setSuperFinishBanner((t) => { banners.push(t); });
    finishTurn(reg('c1'));
    const d1 = reg('d1');
    d1.userSent('go');
    d1.observe({ type: 'control_request', request_id: 'q-9', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which?' }] } } });
    d1.observe({ type: 'result' });
    vi.advanceTimersByTime(FINISH_DEBOUNCE_MS + 10);
    expect(listNotchEvents().filter((e) => e.kind === 'finished')).toHaveLength(0);
    expect(banners).toEqual([]);
  });

  it('mode off: the super session and an ordinary chat are rows as today, and no banner', async () => {
    await makeVault({ enabled: false });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    wireNotchInbox();
    const banners: string[] = [];
    setSuperFinishBanner((t) => { banners.push(t); });
    finishTurn(reg(SUPER, 'super'));
    finishTurn(reg('c1'));
    finishTurn(reg('ordinary'));
    vi.advanceTimersByTime(FINISH_DEBOUNCE_MS + 10);
    expect(listNotchEvents().filter((e) => e.kind === 'finished')).toHaveLength(3);
    expect(banners).toEqual([]);
  });
});

describe('the glance and the rollup', () => {
  it('an asking child is not a row; nothing super shows while the queue head is a plain question', async () => {
    await makeVault();
    const c1 = reg('c1');
    c1.observe({ type: 'control_request', request_id: 'q-1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which?' }] } } });
    await vi.waitFor(async () => {
      const r = res();
      await handleAssistantGlance(req(), r);
      expect(r.json.chats).toEqual([]);
    });
    const roll = res();
    await handleAssistantRollup(req(), roll);
    expect(roll.json.asking).toBe(0);
  });

  it('a permission at the queue head is ONE row for the project, from the child\'s own request', async () => {
    await makeVault();
    const c1 = reg('c1');
    c1.observe({ type: 'control_request', request_id: 'p-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm publish' } } });
    await vi.waitFor(async () => {
      const r = res();
      await handleAssistantGlance(req(), r);
      const chats = r.json.chats as Array<Record<string, unknown>>;
      expect(chats).toHaveLength(1);
      expect(chats[0]).toMatchObject({ sessionId: 'c1', super: true, ask: { id: 'p-1', kind: 'permission', tool: 'Bash' } });
      expect((chats[0].ask as { text: string }).text).toContain('npm publish');
    });
    const roll = res();
    await handleAssistantRollup(req(), roll);
    expect(roll.json.asking).toBe(1);
  });

  it('an escalated question is the row, in the super agent\'s fenced words', async () => {
    // The child is still asking it: an escalation nobody asks any more closes (plan r4 D16).
    reg('c1').observe({
      type: 'control_request', request_id: 'r-1',
      request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which db?', options: [{ label: 'postgres' }] }] } },
    });
    await makeVault({ queue: [{ id: 'q-e', sessionId: 'c1', kind: 'question', requestId: 'r-1', state: 'escalated', ownerText: 'Postgres or sqlite?', createdAt: 1 }] });
    const r = res();
    await handleAssistantGlance(req(), r);
    const chats = r.json.chats as Array<Record<string, unknown>>;
    expect(chats).toHaveLength(1);
    expect((chats[0].ask as { text: string }).text).toBe('<untrusted-project-output vault="acme">Postgres or sqlite?</untrusted-project-output>');
  });

  it('the super agent\'s own ask is the row: its words fenced, its options, no child title (plan r4 D7)', async () => {
    await makeVault({ queue: [{ id: 'q-a', sessionId: SUPER, kind: 'ask', state: 'escalated', ownerText: 'Ship it today?', options: ['Yes', 'Tomorrow'], createdAt: 1 }] });
    const r = res();
    await handleAssistantGlance(req(), r);
    const chats = r.json.chats as Array<Record<string, unknown>>;
    expect(chats).toHaveLength(1);
    expect(chats[0].title).toBe('');
    expect(chats[0].ask).toEqual({
      id: 'q-a', kind: 'question', tool: 'SuperAsk', options: ['Yes', 'Tomorrow'],
      text: '<untrusted-project-output vault="acme">Ship it today?</untrusted-project-output>',
    });
  });

  it('after take-back the child is an ordinary row again', async () => {
    await makeVault({ enabled: false });
    reg('c1').userSent('working');
    const r = res();
    await handleAssistantGlance(req(), r);
    expect((r.json.chats as Array<{ sessionId: string }>).map((c) => c.sessionId)).toEqual(['c1']);
  });
});

describe('the Assistant leaves a handed-over project alone', () => {
  const ui = async (verb: string, body: Record<string, unknown>) => {
    const r = res();
    await handleAssistantUi(req(body, { 'x-dreamcontext-assistant-token': assistantToken() }), r, { verb });
    return r;
  };

  it('send, answer and close into a child or the super session are refused', async () => {
    await makeVault();
    reg('c1');
    reg(SUPER, 'super');
    expect((await ui('send', { sessionId: 'c1', text: 'hi' })).status).toBe(409);
    expect((await ui('answer', { sessionId: 'c1', question: 'q', choice: 'a' })).status).toBe(409);
    expect((await ui('send', { sessionId: SUPER, text: 'hi' })).status).toBe(409);
    expect((await ui('close', { sessionId: 'c1' })).status).toBe(409);
    expect((await ui('close', { sessionId: SUPER })).status).toBe(409);
  });
});
