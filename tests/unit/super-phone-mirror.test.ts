/**
 * The phone's view of a handed-over Super Agent (task hands-free-de-super-agent-aciksa…):
 *
 *  - the live list (AC1): a handed-over project lists ONE super row and none of its chats; with
 *    nothing handed over the answer is exactly today's;
 *  - the open (AC2): the phone MIRRORS the live super child, beside the window that holds it; any
 *    other phone open naming that session, and `mode=super`, is refused;
 *  - the mirror (AC3-AC5), through the REAL `startChatSession` with a mocked child: only the
 *    owner's text goes up, and it steers into the running turn at once, as the desktop's does
 *    (plan r4 D4: no hold), keeping its origin on that path; the window's
 *    verbs, state and the CLI's prompts never come down; the owner's words show on the other
 *    surface; a signed-out device and the child's end close it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-mirror-home-`);
});

const spawned: Array<{ child: FakeChild }> = [];
const signedIn = new Set<string>();

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 4251;
}

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn(() => {
      const child = new FakeChild();
      spawned.push({ child });
      return child as unknown as import('node:child_process').ChildProcess;
    }),
  };
});
vi.mock('../../src/lib/claude-accounts.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-accounts.js')>();
  return { ...real, listClaudeAccounts: vi.fn(() => []) };
});
vi.mock('../../src/lib/claude-limit-rejections.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-limit-rejections.js')>();
  return { ...real, readAccountRejections: vi.fn(() => ({})) };
});
vi.mock('../../src/lib/claude-usage-probe.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-usage-probe.js')>();
  const probe = vi.fn(async () => ({ status: 'healthy-unmeasured', reason: 'test' }));
  return { ...real, probeAccountUsage: probe, probeAccountForDecision: probe };
});
vi.mock('../../src/server/handsfree-auth.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/server/handsfree-auth.js')>();
  return { ...real, macHandsfreeAuth: () => ({ store: { isValidDeviceHash: (h: string) => signedIn.has(h) } }) };
});

const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { startChatSession, revokeStaleDeviceSessions, releasePhoneSessions } = await import('../../src/server/routes/agent-chat.js');
const { findLiveChat } = await import('../../src/server/routes/agent-chat-live.js');
const { _resetChatRegistry } = await import('../../src/lib/assistant/chat-registry.js');
const { SUPER_STATE_REL, readSuperState, resetSuperIndex } = await import('../../src/lib/super/store.js');
const { emptySuperState } = await import('../../src/lib/super/types.js');
const { _resetSuperInbox, _superInboxFor, isSuperEventTurn, markSuperEventTurn } = await import('../../src/lib/super/inbox.js');
const {
  MAX_MIRRORS, MIRROR_CLOSE_ENDED, MIRROR_CLOSE_REPLACED, MIRROR_CLOSE_REVOKED, MirrorSet, mirrorCarriesLine, mirrorOwnerText, phoneLiveChats, phoneSuperOpen,
} = await import('../../src/lib/super/phone-mirror.js');

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

const SUPER = '11111111-2222-4333-8444-555555555555';
const OTHER = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const DEVICE = { store: 'mac' as const, idHash: 'device-a' };
let project: string;
let root: string;

async function record(state: Record<string, unknown>): Promise<void> {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, ...state }));
  await readSuperState(root);
}

function startSuper() {
  const ws = new FakeWs();
  startChatSession(ws as unknown as import('ws').WebSocket, project, {
    bypass: false, sessionId: SUPER, resumeId: '', model: '', effort: '', initialPrompt: '', deferPrompt: false,
    account: '', mode: 'super' as never, vault: 'acme',
  });
  return { ws, child: spawned[spawned.length - 1].child };
}

function mirror(device = DEVICE): FakeWs {
  const phone = new FakeWs();
  expect(findLiveChat(SUPER)?.mirror?.(phone as unknown as import('ws').WebSocket, device)).toBe(true);
  return phone;
}

const sent = (ws: FakeWs) => ws.send.mock.calls
  .map(([raw]) => { try { return JSON.parse(String(raw)); } catch { return null; } })
  .filter(Boolean) as Array<Record<string, unknown>>;
const userTexts = (child: FakeChild): string[] => child.stdin.write.mock.calls
  .map(([chunk]) => { try { return JSON.parse(String(chunk)); } catch { return null; } })
  .filter((f) => f?.type === 'user')
  .map((f) => (f.message.content as Array<{ text: string }>)[0].text);
const line = (child: FakeChild, obj: Record<string, unknown>) => child.stdout.emit('data', Buffer.from(`${JSON.stringify(obj)}\n`));

beforeEach(() => {
  spawned.length = 0;
  signedIn.clear();
  signedIn.add(DEVICE.idHash);
  project = mkdtempSync(join(tmpdir(), 'super-mirror-proj-'));
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
});
afterEach(() => {
  // Every child of the test ends, so its window token and live entry go with it.
  for (const { child } of spawned) { child.emit('exit', 0, null); child.emit('close', 0, null); }
  _resetSuperInbox();
  rmSync(project, { recursive: true, force: true });
});

describe('the phone\'s live list (AC1)', () => {
  const row = (conversationId: string, vault: string | null) => ({
    conversationId, vault, title: 't', busy: false, state: 'idle' as const, lastLine: 'l', updatedAt: 5,
  });

  it('nothing handed over: today\'s rows, untouched, and no super row', () => {
    const chats = [row(SUPER, 'acme'), row(OTHER, 'acme')];
    expect(phoneLiveChats(chats, new Map())).toEqual({ chats, supers: [] });
  });

  it('a handed-over project: one super row, none of its chats; another project keeps its own', () => {
    const chats = [row(SUPER, 'acme'), row(OTHER, 'acme'), row('x', 'beta'), row('y', null)];
    const v = phoneLiveChats(chats, new Map([['acme', SUPER]]));
    expect(v.chats.map((c) => c.conversationId)).toEqual(['x', 'y']);
    expect(v.supers).toEqual([{ conversationId: SUPER, vault: 'acme', title: null, busy: false, state: 'idle', lastLine: 'l', updatedAt: 5, live: true }]);
  });

  it('handed over but no super child running: the row says so (live false)', () => {
    const v = phoneLiveChats([row(OTHER, 'acme')], new Map([['acme', SUPER]]));
    expect(v.chats).toEqual([]);
    expect(v.supers).toEqual([{ conversationId: SUPER, vault: 'acme', title: null, busy: false, state: 'idle', lastLine: null, updatedAt: null, live: false }]);
  });
});

describe('what a phone open does about the Super Agent (AC2)', () => {
  const on = { session: SUPER, enabled: true };
  const off = { session: SUPER, enabled: false };
  const ask = (o: Partial<Parameters<typeof phoneSuperOpen>[0]>) =>
    phoneSuperOpen({ mode: 'develop', resumeId: '', sessionId: '', index: on, liveSuper: true, ...o });

  it('the handed-over session, live: a mirror, whatever mode the tab asked for', () => {
    expect(ask({ resumeId: SUPER })).toBe('mirror');
    expect(ask({ sessionId: SUPER, mode: 'super' })).toBe('mirror');
  });

  it('an upper-case copy of the session id is the same session (review r2)', () => {
    expect(ask({ resumeId: SUPER.toUpperCase(), mode: 'basic' })).toBe('mirror');
    expect(ask({ resumeId: SUPER.toUpperCase(), index: off })).toBe('refuse');
  });

  it('the handed-over session, not live: refused (never a resume that would race the window)', () => {
    expect(ask({ resumeId: SUPER, liveSuper: false })).toBe('refuse');
  });

  it('mode=super for anything else is refused, as before', () => {
    expect(ask({ mode: 'super', resumeId: OTHER })).toBe('refuse');
    expect(ask({ mode: 'super', resumeId: SUPER, index: off })).toBe('refuse');
  });

  it('the parked session after a take-back is refused too: a phone never adopts, resumes or respawns it', () => {
    expect(ask({ resumeId: SUPER, index: off })).toBe('refuse');
    expect(ask({ sessionId: SUPER, index: off, liveSuper: false })).toBe('refuse');
  });

  it('any other chat, and a vault with no recorded session: today\'s path', () => {
    expect(ask({ resumeId: OTHER })).toBe('pass');
    expect(ask({ resumeId: OTHER, index: off })).toBe('pass');
    expect(ask({ index: { session: null, enabled: false } })).toBe('pass');
  });

  it('the upgrade decides it before the open decision and any spawn', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/server/routes/agent-chat.ts', import.meta.url), 'utf-8');
    const handler = src.slice(src.indexOf('export function attachAgentChat'), src.indexOf('export function chatOpenDecision'));
    const at = handler.indexOf('phoneSuperOpen(');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(handler.indexOf('chatOpenDecision('));
    expect(at).toBeLessThan(handler.indexOf('startChatSession('));
    expect(handler).toMatch(/if \(phoneSuper === 'refuse'\) \{ rejectUpgrade\(socket, 403\); return; \}/);
  });
});

describe('the mirror\'s frame rules (AC3)', () => {
  it('only a user text frame goes up, and never a slash command', () => {
    expect(mirrorOwnerText(JSON.stringify({ type: 'user', text: 'hi' }))).toBe('hi');
    for (const t of ['/effort low', '  /model haiku', '/compact']) expect(mirrorOwnerText(JSON.stringify({ type: 'user', text: t }))).toBeNull();
    expect(mirrorOwnerText(JSON.stringify({ type: 'user', text: 'run tests in a/b' }))).toBe('run tests in a/b');
    for (const f of [
      { type: 'user', text: '   ' }, { type: 'answer', requestId: 'r', behavior: 'allow' }, { type: 'interrupt' },
      { type: 'setModel', model: 'opus' }, { type: 'setPermissionMode', mode: 'bypass' }, { type: 'rewind', targetUuid: SUPER },
      { type: 'super_command_result', id: 'x', ok: true }, { type: 'window_command_result', id: 'x', ok: true }, { type: 'end' },
    ]) expect(mirrorOwnerText(JSON.stringify(f))).toBeNull();
    expect(mirrorOwnerText('not json')).toBeNull();
  });

  it('the CLI\'s prompts never come down; everything else does', () => {
    expect(mirrorCarriesLine(JSON.stringify({ type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool' } }))).toBe(false);
    expect(mirrorCarriesLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'control_request' }] } }))).toBe(true);
    expect(mirrorCarriesLine(JSON.stringify({ type: 'result' }))).toBe(true);
  });
});

describe('a phone mirror on the live super chat (AC2-AC5)', () => {
  it('joins beside the window: the window keeps its socket, nothing respawns', { timeout: 30_000 }, async () => {
    await record({ enabled: true });
    const { ws } = startSuper();
    const phone = mirror();
    expect(spawned).toHaveLength(1);
    expect(ws.close).not.toHaveBeenCalled();
    expect(findLiveChat(SUPER)?.holder?.()).toBe(ws);
    expect(sent(phone)).toContainEqual({ type: '_meta', subtype: 'reattached', adopted: true, busy: false });
  });

  it('the phone\'s text reaches the chat; its other frames act on nothing', async () => {
    await record({ enabled: true });
    const { child } = startSuper();
    const phone = mirror();
    const writes = () => child.stdin.write.mock.calls.length;
    const before = writes();
    for (const f of [
      { type: 'answer', requestId: 'r1', behavior: 'allow' }, { type: 'interrupt' }, { type: 'setModel', model: 'opus' },
      { type: 'setPermissionMode', mode: 'bypass' }, { type: 'setEffort', effort: 'high' }, { type: 'rewind', targetUuid: SUPER },
      { type: 'stopTask', taskId: 'b1' },
    ]) phone.emit('message', JSON.stringify(f));
    expect(writes()).toBe(before);
    phone.emit('message', JSON.stringify({ type: 'user', text: 'what is running?' }));
    await vi.waitFor(() => expect(userTexts(child)).toEqual(['what is running?']), { timeout: 10_000 });
  });

  it('the phone\'s words steer into a running inbox turn at once, as the desktop\'s do: no hold, no replay (plan r4 D4)', async () => {
    await record({ enabled: true });
    const { ws, child } = startSuper();
    const phone = mirror();
    const ev = { kind: 'batch' as const, child: 'c1', batch: 'b-1', items: [{ item: 'q-1', child: 'c1', kind: 'done' as const }] };
    // As the pump does: the turn it writes is an event turn until the owner speaks into it.
    markSuperEventTurn(SUPER, true);
    await expect(_superInboxFor(SUPER)!.deliver('[super events] batch=b-1 items=1', ev)).resolves.toBe(true);
    expect(isSuperEventTurn(SUPER)).toBe(true);
    phone.emit('message', JSON.stringify({ type: 'user', text: 'two (phone)' }));
    // Written before the event turn's result: folded into it, and the turn is the owner's now.
    await vi.waitFor(() => expect(userTexts(child)).toEqual(['[super events] batch=b-1 items=1', 'two (phone)']), { timeout: 10_000 });
    expect(isSuperEventTurn(SUPER)).toBe(false);
    ws.emit('message', JSON.stringify({ type: 'user', text: 'one (desktop)' }));
    await vi.waitFor(() => expect(userTexts(child)).toHaveLength(3), { timeout: 10_000 });
    expect(userTexts(child)[2]).toBe('one (desktop)');
    line(child, { type: 'result' });
    await new Promise((r) => setTimeout(r, 30));
    expect(userTexts(child)).toHaveLength(3);
  });

  it('the window\'s verbs and state and the CLI\'s prompts stay on the window; the stream and event chips come down', async () => {
    await record({ enabled: true });
    const { ws, child } = startSuper();
    const phone = mirror();
    line(child, { type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } });
    line(child, { type: 'assistant', message: { content: [{ type: 'text', text: 'two agents running' }] } });
    const { pushFrame, tokenOfSession } = await import('../../src/lib/window-control.js');
    const token = tokenOfSession(SUPER)!;
    expect(token).toBeTruthy();
    pushFrame(token, { subtype: 'super_state', state: { enabled: true } });
    await _superInboxFor(SUPER)!.deliver('[super events] batch=b-2 items=1', { kind: 'batch', child: 'c1', batch: 'b-2', items: [{ item: 'q-2', child: 'c1', kind: 'done' }] });
    pushFrame(token, { subtype: 'super_command', id: 'c1', verb: 'delegate', args: {} });
    const phoneTypes = sent(phone).map((f) => (f.type === '_meta' ? `_meta:${f.subtype}` : f.type));
    expect(phoneTypes).toContain('assistant');
    expect(phoneTypes).toContain('_meta:super_event');
    expect(phoneTypes).not.toContain('control_request');
    expect(phoneTypes).not.toContain('_meta:super_state');
    expect(phoneTypes).not.toContain('_meta:super_command');
    const windowTypes = sent(ws).map((f) => (f.type === '_meta' ? `_meta:${f.subtype}` : f.type));
    expect(windowTypes).toEqual(expect.arrayContaining(['control_request', 'assistant', '_meta:super_state', '_meta:super_event', '_meta:super_command']));
  });

  it('the owner\'s words show on the surface that did not type them (AC4)', async () => {
    await record({ enabled: true });
    const { ws } = startSuper();
    const phone = mirror();
    phone.emit('message', JSON.stringify({ type: 'user', text: 'from the phone' }));
    ws.emit('message', JSON.stringify({ type: 'user', text: 'from the desk' }));
    const echoes = (s: FakeWs) => sent(s).filter((f) => f.subtype === 'owner_echo').map((f) => f.text);
    expect(echoes(ws)).toEqual(['from the phone']);
    expect(echoes(phone)).toEqual(['from the desk']);
  });

  it('a signed-out device, Mac mode\'s return and the child\'s end close the mirror (AC5)', async () => {
    await record({ enabled: true });
    const { ws, child } = startSuper();
    const a = mirror();
    signedIn.delete(DEVICE.idHash);
    revokeStaleDeviceSessions();
    expect(a.close).toHaveBeenCalledWith(MIRROR_CLOSE_REVOKED, expect.any(String));
    expect(ws.close).not.toHaveBeenCalled();

    signedIn.add('device-b');
    const b = mirror({ store: 'mac', idHash: 'device-b' });
    releasePhoneSessions();
    expect(b.close).toHaveBeenCalledWith(MIRROR_CLOSE_REVOKED, expect.any(String));

    const c = mirror({ store: 'mac', idHash: 'device-b' });
    // A frame from a device signed out meanwhile closes it too, and acts on nothing.
    signedIn.delete('device-b');
    c.emit('message', JSON.stringify({ type: 'user', text: 'late' }));
    expect(c.close).toHaveBeenCalledWith(MIRROR_CLOSE_REVOKED, expect.any(String));
    expect(userTexts(child)).toEqual([]);

    signedIn.add('device-b');
    const d = mirror({ store: 'mac', idHash: 'device-b' });
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await vi.waitFor(() => expect(d.close).toHaveBeenCalledWith(MIRROR_CLOSE_ENDED, expect.any(String)), { timeout: 10_000 });
  });

  it('one mirror per device: the same phone again replaces its half-open one', async () => {
    await record({ enabled: true });
    startSuper();
    const first = mirror();
    const second = mirror();
    expect(first.close).toHaveBeenCalledWith(MIRROR_CLOSE_REPLACED, expect.any(String));
    expect(second.close).not.toHaveBeenCalled();
  });

  it('a draining or respawning child closes its mirrors first (their words never go into an ended stdin)', async () => {
    await record({ enabled: true });
    const { ws, child } = startSuper();
    const phone = mirror();
    ws.emit('message', JSON.stringify({ type: 'end' }));
    ws.emit('close');
    expect(phone.close).toHaveBeenCalledWith(MIRROR_CLOSE_ENDED, expect.any(String));
    const before = child.stdin.write.mock.calls.length;
    phone.emit('message', JSON.stringify({ type: 'user', text: 'too late' }));
    expect(child.stdin.write.mock.calls.length).toBe(before);
    expect(findLiveChat(SUPER)?.mirror?.(new FakeWs() as unknown as import('ws').WebSocket, DEVICE) ?? false).toBe(false);
  });

  it('closeMirrors (the take-back) closes every mirror with 4410 and leaves the window', async () => {
    await record({ enabled: true });
    const { ws } = startSuper();
    const phone = mirror();
    findLiveChat(SUPER)?.closeMirrors?.();
    expect(phone.close).toHaveBeenCalledWith(MIRROR_CLOSE_ENDED, expect.any(String));
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('a non-super chat takes no mirror; a super chat at most a few devices, refused before the handshake', async () => {
    await record({ enabled: true });
    startSuper();
    for (let i = 0; i < MAX_MIRRORS; i++) { signedIn.add(`dev-${i}`); mirror({ store: 'mac', idHash: `dev-${i}` }); }
    const extra = new FakeWs();
    const other = { store: 'mac' as const, idHash: 'dev-extra' };
    expect(findLiveChat(SUPER)?.mirrorRoom?.(other)).toBe(false);
    expect(findLiveChat(SUPER)?.mirrorRoom?.({ store: 'mac', idHash: 'dev-0' })).toBe(true);
    expect(findLiveChat(SUPER)?.mirror?.(extra as unknown as import('ws').WebSocket, other)).toBe(false);
    const ws = new FakeWs();
    startChatSession(ws as unknown as import('ws').WebSocket, project, {
      bypass: false, sessionId: OTHER, resumeId: '', model: '', effort: '', initialPrompt: '', deferPrompt: false,
      account: '', mode: 'basic' as never, vault: 'acme',
    });
    expect(findLiveChat(OTHER)?.mirror).toBeUndefined();
  });
});

describe('a mirror\'s lifetime (review r1)', () => {
  it('a mirror that misses a pong is terminated, and the ping stops with the last mirror', async () => {
    const set = new MirrorSet<string>({ valid: () => true, onOwnerFrame: () => {}, holder: () => null, key: (d) => d, pingMs: 20 });
    const alive = Object.assign(new FakeWs(), { ping: vi.fn(function (this: FakeWs) { this.emit('pong'); }), terminate: vi.fn() });
    const dead = Object.assign(new FakeWs(), { ping: vi.fn(), terminate: vi.fn() });
    set.add(alive as never, 'a');
    set.add(dead as never, 'b');
    await vi.waitFor(() => expect(dead.terminate).toHaveBeenCalled(), { timeout: 2000 });
    expect(alive.terminate).not.toHaveBeenCalled();
    expect(set.size).toBe(1);
    set.closeAll(MIRROR_CLOSE_ENDED, 'end');
    expect(set.size).toBe(0);
  });

  it('the upgrade gives a refused mirror an error sink before anything can refuse it, and checks room first', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/server/routes/agent-chat.ts', import.meta.url), 'utf-8');
    const branch = src.slice(src.indexOf("if (phoneSuper === 'mirror') {"), src.indexOf('const superRefused = superUpgradeRefusal('));
    expect(branch.indexOf("ws.on('error'")).toBeGreaterThan(0);
    expect(branch.indexOf("ws.on('error'")).toBeLessThan(branch.indexOf('liveSuper.mirror?.('));
    expect(branch.indexOf('mirrorRoom?.(')).toBeLessThan(branch.indexOf('handleUpgrade('));
    expect(branch).toMatch(/rejectUpgrade\(socket, 503\)/);
  });

  it('a phone frame keeps its origin on the steered write path: with no window attached it is never held for an account switch', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/server/routes/agent-chat.ts', import.meta.url), 'utf-8');
    // The mark rides on the frame (it survives the switch gate and a successor's replay) and
    // `detached` is read when the gate reaches the frame. The owner-frame hold is gone (plan r4
    // D4) and must not come back to carry it.
    expect(src).toMatch(/const frame = Buffer\.from\(raw, 'utf-8'\);\s*mirrorFrames\.add\(frame\);\s*onWsMessage\(frame\);/);
    expect(src).toMatch(/const fromMirror = typeof raw !== 'string' && mirrorFrames\.has\(raw\);\s*switchGate = switchGate\.then\(\(\) => \(fromMirror && detached \? Promise\.resolve\(false\) : maybeSwitchAccount\(text\)\)/);
    expect(src).not.toMatch(/mirrorFrameUnheld/);
    expect(src).not.toMatch(/heldOwnerFrames|releaseOneHeldOwnerFrame|stashHeldOwnerTexts|takeHeldOwnerTexts/);
  });

  it('the take-back closes the phone mirrors even if the window keeps the parked child', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/server/routes/super.ts', import.meta.url), 'utf-8');
    const disable = src.slice(src.indexOf('disable: async'), src.indexOf('layout: async'));
    expect(disable).toMatch(/findLiveChat\(state\.session\)\?\.closeMirrors\?\.\(\)/);
  });
});
