/**
 * The Super Agent in the chat bridge (agent-chat.ts), driven through the REAL
 * `startChatSession` with a mocked child (plan-r7 D3, D8, D15, D17, AC1, AC2, AC7):
 *
 *  - a child's next OWNER message carries the hand-over note exactly once, as a SECOND text
 *    block starting with `<`; its first block and `userSent` stay the owner's text; a slash
 *    command, `/effort` and an AskUserQuestion answer neither carry nor consume it; the
 *    take-back note likewise;
 *  - an owner message sent during an inbox-opened turn is written after that turn's `result`,
 *    as its own turn; an event is never written over a running turn;
 *  - the super chat spawns with the vault's permission mode like any chat, plus its own verbs
 *    pre-approved in an `auto` vault only;
 *  - exactly one super session per vault at the upgrade: a different id 409, the phone 403.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-bridge-home-`);
});

const spawned: Array<{ child: FakeChild; script: string }> = [];

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 4250;
}

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn((_shell: string, args: string[]) => {
      const child = new FakeChild();
      spawned.push({ child, script: String(args?.[1] ?? '') });
      return child as unknown as import('node:child_process').ChildProcess;
    }),
  };
});
// A single-account machine: `maybeSwitchAccount` never probes or holds.
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

const { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { startChatSession, superUpgradeRefusal, superAllowedTools } = await import('../../src/server/routes/agent-chat.js');
const { _resetChatRegistry, getChat } = await import('../../src/lib/assistant/chat-registry.js');
const { SUPER_STATE_REL, peekSuperNote, readSuperState, resetSuperIndex } = await import('../../src/lib/super/store.js');
const { SUPER_NOTE_TEXT, emptySuperState } = await import('../../src/lib/super/types.js');
const { _resetSuperInbox, _superInboxFor, isSuperEventTurn, markSuperEventTurn } = await import('../../src/lib/super/inbox.js');

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

const SUPER = '11111111-2222-4333-8444-555555555555';
const CHILD = '66666666-7777-4888-8999-aaaaaaaaaaaa';
let project: string;
let root: string;

async function record(state: Record<string, unknown>): Promise<void> {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, ...state }));
  await readSuperState(root);
}

function start(o: { sessionId: string; mode: string; bypass?: boolean }) {
  const ws = new FakeWs();
  startChatSession(ws as unknown as import('ws').WebSocket, project, {
    bypass: o.bypass ?? false, sessionId: o.sessionId, resumeId: '', model: '', effort: '', initialPrompt: '', deferPrompt: false,
    account: '', mode: o.mode as never, vault: 'acme',
  });
  return { ws, ...spawned[spawned.length - 1] };
}

/** Every user frame the child's stdin received, as its content blocks' texts. */
function userFrames(child: FakeChild): string[][] {
  return child.stdin.write.mock.calls
    .map(([chunk]) => { try { return JSON.parse(String(chunk)); } catch { return null; } })
    .filter((f) => f?.type === 'user')
    .map((f) => (f.message.content as Array<{ text: string }>).map((b) => b.text));
}
const owner = (ws: FakeWs, text: string) => ws.emit('message', JSON.stringify({ type: 'user', text }));
const result = (child: FakeChild) => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result' })}\n`));
const metas = (ws: FakeWs) => ws.send.mock.calls
  .map(([raw]) => { try { return JSON.parse(String(raw)); } catch { return null; } })
  .filter((f) => f?.type === '_meta');

beforeEach(() => {
  spawned.length = 0;
  project = mkdtempSync(join(tmpdir(), 'super-bridge-proj-'));
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
});
afterEach(() => {
  _resetSuperInbox();
  rmSync(project, { recursive: true, force: true });
});

describe('the hand-over note rides on a child\'s next owner message (D17)', () => {
  const child = { [CHILD]: { sessionId: CHILD, brief: '', adopted: true, startedAt: 1 } };

  // The file's first spawn pays the bridge's cold start; nothing is held for a non-super chat
  // (the D8/M2 hold is the super chat's only), so a loaded machine is the only wait here.
  it('exactly once, as a second `<`-block; the owner\'s own text stays the first block and the title', { timeout: 30_000 }, async () => {
    await record({ enabled: true, children: child, notes: { [CHILD]: 'handover' } });
    const { ws, child: proc } = start({ sessionId: CHILD, mode: 'basic' });
    owner(ws, 'fix the login page');
    await vi.waitFor(() => expect(userFrames(proc)).toHaveLength(1), { timeout: 10_000 });
    expect(userFrames(proc)[0]).toEqual(['fix the login page', SUPER_NOTE_TEXT.handover]);
    expect(SUPER_NOTE_TEXT.handover.startsWith('<')).toBe(true);
    expect(getChat(CHILD)?.title).toBe('fix the login page');
    expect(peekSuperNote(CHILD)).toBeNull();
    result(proc);
    owner(ws, 'and the signup page');
    await vi.waitFor(() => expect(userFrames(proc)).toHaveLength(2), { timeout: 10_000 });
    expect(userFrames(proc)[1]).toEqual(['and the signup page']);
    await vi.waitFor(async () => expect((await readSuperState(root)).notes).toEqual({}), { timeout: 10_000 });
  });

  it('a slash command, /effort and an AskUserQuestion answer neither carry nor consume it', async () => {
    await record({ enabled: true, children: child, notes: { [CHILD]: 'handover' } });
    const { ws, child: proc } = start({ sessionId: CHILD, mode: 'basic' });
    owner(ws, '/compact');
    ws.emit('message', JSON.stringify({ type: 'setEffort', effort: 'high' }));
    ws.emit('message', JSON.stringify({ type: 'answer', requestId: 'req-1', behavior: 'allow', updatedInput: { answers: { q: 'a' } } }));
    await vi.waitFor(() => expect(userFrames(proc)).toHaveLength(2));
    // `/effort` is written at once, the owner's text after the switch chain: order aside, two
    // frames, neither with a note.
    expect(userFrames(proc).map((f) => f.join('|')).sort()).toEqual(['/compact', '/effort high']);
    const answer = proc.stdin.write.mock.calls.map(([c]) => JSON.parse(String(c))).find((f) => f.type === 'control_response');
    expect(JSON.stringify(answer)).not.toContain('super-agent-note');
    expect(peekSuperNote(CHILD)).toBe('handover');
    owner(ws, 'now a real message');
    await vi.waitFor(() => expect(userFrames(proc)).toHaveLength(3));
    expect(userFrames(proc)[2]).toEqual(['now a real message', SUPER_NOTE_TEXT.handover]);
  });

  it('the take-back note rides the same way', async () => {
    await record({ enabled: false, children: child, notes: { [CHILD]: 'takeback' } });
    const { ws, child: proc } = start({ sessionId: CHILD, mode: 'basic' });
    owner(ws, 'back to you');
    await vi.waitFor(() => expect(userFrames(proc)).toHaveLength(1));
    expect(userFrames(proc)[0]).toEqual(['back to you', SUPER_NOTE_TEXT.takeback]);
  });

  it('no chat runs a turn just to receive it: nothing is written before the owner speaks', async () => {
    await record({ enabled: true, children: child, notes: { [CHILD]: 'handover' } });
    const { child: proc } = start({ sessionId: CHILD, mode: 'basic' });
    await new Promise((r) => setTimeout(r, 20));
    expect(userFrames(proc)).toEqual([]);
  });

  it('the notes are fixed text: nothing is interpolated', () => {
    expect(SUPER_NOTE_TEXT).toEqual({
      handover: '<super-agent-note> From now on the owner talks to you through the Super Agent; it relays your questions and answers. </super-agent-note>',
      takeback: '<super-agent-note> The Super Agent mode is over; you talk directly with the owner again. </super-agent-note>',
    });
  });
});

describe('the super chat\'s event turns (D8)', () => {
  it('an owner message held during an event turn survives the process dying: the next process writes it once (M2)', async () => {
    await record({ enabled: true });
    const first = start({ sessionId: SUPER, mode: 'super' });
    await expect(_superInboxFor(SUPER)!.deliver('[super event] item=q-9 child=c1 status=idle', 'idle', 'c1')).resolves.toBe(true);
    owner(first.ws, 'do not lose me');
    await new Promise((r) => setTimeout(r, 20));
    expect(userFrames(first.child)).toEqual([['[super event] item=q-9 child=c1 status=idle']]);
    // The process dies mid-turn (no `result` ever comes).
    first.child.emit('close', 1);
    const second = start({ sessionId: SUPER, mode: 'super' });
    await vi.waitFor(() => expect(userFrames(second.child)).toEqual([['do not lose me']]));
    await new Promise((r) => setTimeout(r, 20));
    expect(userFrames(second.child)).toEqual([['do not lose me']]);
    expect(userFrames(first.child)).toEqual([['[super event] item=q-9 child=c1 status=idle']]);
  });

  it('two held messages run as two turns, in order', async () => {
    await record({ enabled: true });
    const { ws, child: proc } = start({ sessionId: SUPER, mode: 'super' });
    await _superInboxFor(SUPER)!.deliver('[super event] e', 'idle', 'c1');
    owner(ws, 'first');
    owner(ws, 'second');
    result(proc);
    await vi.waitFor(() => expect(userFrames(proc)).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(userFrames(proc)[1]).toEqual(['first']);
    expect(userFrames(proc)).toHaveLength(2);
    result(proc);
    await vi.waitFor(() => expect(userFrames(proc)).toHaveLength(3));
    expect(userFrames(proc)[2]).toEqual(['second']);
  });

  it('after a delivered item, the end of the super\'s own turn delivers the next with no other event', async () => {
    // Regression (lead's verify): the registry's `idle` fires on the `result` frame BEFORE the
    // bridge closes its turn, so only the bridge's own turn end can let the next item go.
    await record({
      enabled: true,
      children: {
        c1: { sessionId: 'c1', brief: '', adopted: true, startedAt: 1 },
        c2: { sessionId: 'c2', brief: '', adopted: true, startedAt: 1 },
      },
      queue: [
        { id: 'q-a', sessionId: 'c1', kind: 'idle', state: 'pending', createdAt: 1 },
        { id: 'q-b', sessionId: 'c2', kind: 'idle', state: 'pending', createdAt: 2 },
      ],
    });
    const { child: proc } = start({ sessionId: SUPER, mode: 'super' });
    // The super chat settles (its registry entry leaves `starting`): the first item goes.
    result(proc);
    await vi.waitFor(() => expect(userFrames(proc)).toHaveLength(1));
    expect(userFrames(proc)[0][0]).toMatch(/^\[super event\] item=q-a child=c1 status=idle/);
    await vi.waitFor(async () => expect((await readSuperState(root)).queue.find((q) => q.id === 'q-a')?.state).toBe('done'));
    // The super agent finishes the event turn; nothing else happens. The second item goes.
    result(proc);
    await vi.waitFor(() => expect(userFrames(proc)).toHaveLength(2));
    expect(userFrames(proc)[1][0]).toMatch(/^\[super event\] item=q-b child=c2 status=idle/);
  });

  it('an owner message during an event turn is written after its result, as its own turn', async () => {
    await record({ enabled: true });
    const { ws, child: proc } = start({ sessionId: SUPER, mode: 'super' });
    const inbox = _superInboxFor(SUPER);
    expect(inbox).not.toBeNull();
    await expect(inbox!.deliver('[super event] item=q-1 child=c1 status=idle', 'idle', 'c1')).resolves.toBe(true);
    expect(metas(ws).some((m) => m.subtype === 'super_event' && m.kind === 'idle' && m.child === 'c1')).toBe(true);
    owner(ws, 'what is going on?');
    await new Promise((r) => setTimeout(r, 20));
    expect(userFrames(proc)).toEqual([['[super event] item=q-1 child=c1 status=idle']]);
    result(proc);
    await vi.waitFor(() => expect(userFrames(proc)).toHaveLength(2));
    expect(userFrames(proc)[1]).toEqual(['what is going on?']);
  });

  it('an event is never written over a running turn, nor while owner frames wait', async () => {
    await record({ enabled: true });
    const { ws, child: proc } = start({ sessionId: SUPER, mode: 'super' });
    owner(ws, 'owner first');
    await vi.waitFor(() => expect(userFrames(proc)).toHaveLength(1));
    expect(_superInboxFor(SUPER)!.idle()).toBe(false);
    await expect(_superInboxFor(SUPER)!.deliver('[super event] x', 'question', 'c1')).resolves.toBe(false);
    expect(userFrames(proc)).toHaveLength(1);
  });

  it('a deliver the inbox gave up on (cancelled while the account switch ran) never writes its turn (w5 Minor 2)', async () => {
    await record({ enabled: true });
    const { child: proc } = start({ sessionId: SUPER, mode: 'super' });
    let gaveUp = false;
    const late = _superInboxFor(SUPER)!.deliver('[super event] item=q-late child=c1 status=idle', 'idle', 'c1', () => gaveUp);
    // The inbox's 30 s bound fires while `maybeSwitchAccount` is still on the chain.
    gaveUp = true;
    await expect(late).resolves.toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(userFrames(proc)).toEqual([]);
    expect(_superInboxFor(SUPER)!.idle()).toBe(true);
    // The item is still pending in the inbox: the next delivery writes it, once.
    await expect(_superInboxFor(SUPER)!.deliver('[super event] item=q-late child=c1 status=idle', 'idle', 'c1', () => false)).resolves.toBe(true);
    expect(userFrames(proc)).toEqual([['[super event] item=q-late child=c1 status=idle']]);
  });

  it('the owner speaking clears the event-turn mark (the notch may announce his own turn)', async () => {
    await record({ enabled: true });
    const { ws, child: proc } = start({ sessionId: SUPER, mode: 'super' });
    await _superInboxFor(SUPER)!.deliver('[super event] y', 'idle', 'c1');
    // The pump marks the turn; the bridge clears it on the owner's next message.
    markSuperEventTurn(SUPER, true);
    result(proc);
    owner(ws, 'thanks');
    await vi.waitFor(() => expect(userFrames(proc)).toHaveLength(2));
    expect(isSuperEventTurn(SUPER)).toBe(false);
  });

  it('a non-super chat attaches no super inbox', async () => {
    await record({ enabled: true });
    start({ sessionId: CHILD, mode: 'basic' });
    expect(_superInboxFor(CHILD)).toBeNull();
  });
});

describe('the super chat follows the vault\'s permission switch (D15)', () => {
  it('auto vault: --permission-mode auto plus ONLY its own verbs pre-approved', async () => {
    await record({ enabled: true });
    const { script } = start({ sessionId: SUPER, mode: 'super', bypass: false });
    expect(script).toContain('"--permission-mode" "auto"');
    expect(script).toContain('"--allowedTools" "Bash(dreamcontext super:*)"');
    expect(script).not.toContain('PreToolUse');
  });

  it('bypass vault: bypassPermissions like any chat, nothing extra', async () => {
    await record({ enabled: true });
    const { script } = start({ sessionId: SUPER, mode: 'super', bypass: true });
    expect(script).toContain('"--permission-mode" "bypassPermissions"');
    expect(script).not.toContain('dreamcontext super:*');
  });

  it('no other chat gets the super pre-approval', () => {
    expect(superAllowedTools(false, false)).toEqual([]);
    expect(superAllowedTools(true, true)).toEqual([]);
    expect(superAllowedTools(true, false)).toEqual(['--allowedTools', 'Bash(dreamcontext super:*)']);
  });
});

describe('one super session per vault at the upgrade (D3)', () => {
  const ask = (o: Partial<{ mode: string; phone: boolean; resumeId: string; sessionId: string }>) =>
    superUpgradeRefusal({ mode: 'super', phone: false, contextRoot: root, resumeId: '', sessionId: '', ...o });

  it('the recorded session (fresh or resumed) passes; a different id is 409; no record yet is 409', async () => {
    expect(ask({ sessionId: SUPER })).toBe(409);
    await record({ enabled: true });
    expect(ask({ sessionId: SUPER })).toBeNull();
    expect(ask({ resumeId: SUPER })).toBeNull();
    expect(ask({ sessionId: CHILD })).toBe(409);
    expect(ask({ resumeId: CHILD })).toBe(409);
  });

  it('the phone never opens a super chat; other modes are not this rule\'s', async () => {
    await record({ enabled: true });
    expect(ask({ sessionId: SUPER, phone: true })).toBe(403);
    expect(ask({ mode: 'basic', sessionId: CHILD })).toBeNull();
  });

  it('the upgrade handler applies it before anything spawns', () => {
    const src = readFileSync(new URL('../../src/server/routes/agent-chat.ts', import.meta.url), 'utf-8');
    const handler = src.slice(src.indexOf('export function attachAgentChat'), src.indexOf('export function chatOpenDecision'));
    expect(handler).toMatch(/superUpgradeRefusal\(\{ mode, phone,[^}]*\}\);\s*if \(superRefused\) \{ rejectUpgrade\(socket, superRefused\); return; \}/);
    expect(handler.indexOf('superUpgradeRefusal')).toBeLessThan(handler.indexOf('startChatSession('));
  });
});
