/**
 * A Bypass child's residual permission goes to its Super Agent first; every other permission stays
 * the owner's (task super-bypass-taki-cocugunun-izin-istegine-…, owner 2026-11-02).
 *
 *  - the registry knows when a process runs Bypass, and forgets it for good (fail closed);
 *  - a request the CLI dropped (its tool already got a result: "Stream closed") leaves no ghost;
 *  - a Bypass child's permission is a `toSuper` item: delivered to the Super with its request id,
 *    tool, command and Claude Code's own reason, never the owner's head; the hands-free phone
 *    still draws it (owner 2026-11-05: away from the Mac he could not answer it); a non-bypass
 *    child's is unchanged;
 *  - the Super's turn ending without a decision, `permissionToOwner` or the grace hands it to him.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-bypass-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetChatRegistry, getChat, registerChat, superDecidesPermission, type ChatHandle,
} from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { SUPER_PERMISSION_GRACE_MS, emptySuperState, type SuperState } from '../../src/lib/super/types.js';
import {
  _resetSuperInbox, _superInboxDrained, attachSuperInbox, nextBatch, permissionGoesToSuper, permissionToOwner,
  startSuperInbox, superQueueHead, superTurnEnded, type SuperEventFrame, type SuperInbox,
} from '../../src/lib/super/inbox.js';
import { superDigest } from '../../src/lib/super/phone-mirror.js';
import { phoneSuperQuestions } from '../../src/server/routes/super-phone-questions.js';
import { resetWindowControl } from '../../src/lib/window-control.js';
import { _resetOwnerQuestions, setOwnerQuestionSinks } from '../../src/lib/super/owner-question.js';

let dir: string;
let root: string;
const SUPER = 'sup-1';
const W = { timeout: 10_000 };

const child = (sid: string) => ({ sessionId: sid, brief: `brief of ${sid}`, adopted: true, startedAt: 1 });

function makeVault(state: Partial<SuperState>): void {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true, ...state }));
}

const reg = (sid: string, bypass = false, mode = 'basic'): ChatHandle =>
  registerChat({ sessionId: sid, conversationId: null, vault: 'acme', mode, bypass });
const askPermission = (h: ChatHandle, requestId: string, toolUseId = `tu-${requestId}`, tool = 'Bash') => h.observe({
  type: 'control_request', request_id: requestId,
  request: {
    subtype: 'can_use_tool', tool_name: tool, input: { command: 'rm -rf /tmp/wt-c1-copy' }, tool_use_id: toolUseId,
    description: 'Remove the temp copy',
    decision_reason: 'Dangerous rm operation not ruled out — the shell may read this command differently than it was parsed',
    decision_reason_type: 'safetyCheck',
  },
});
const settle = (h: ChatHandle) => { h.userSent(''); h.observe({ type: 'result' }); };

function fakeInbox() {
  const delivered: Array<{ text: string; event: SuperEventFrame }> = [];
  const inbox: SuperInbox = {
    id: `inbox-${Math.random()}`,
    sessionId: SUPER,
    attached: () => true,
    idle: () => true,
    deliver: async (text, event) => { delivered.push({ text, event }); return true; },
  };
  return { inbox, delivered };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-bypass-'));
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
});
afterEach(async () => {
  vi.useRealTimers();
  let cap: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([_superInboxDrained(), new Promise((r) => { cap = setTimeout(r, 8_000); })]);
  clearTimeout(cap);
  _resetSuperInbox();
  rmSync(dir, { recursive: true, force: true });
});

describe('the registry: Bypass, fail closed', () => {
  it('is set only from the launch and cleared for good by an init frame or notBypass', () => {
    const a = reg('a', true);
    expect(getChat('a')?.bypass).toBe(true);
    a.observe({ type: 'system', subtype: 'init', session_id: 'x', permissionMode: 'bypassPermissions' });
    expect(getChat('a')?.bypass).toBe(true);
    a.observe({ type: 'system', subtype: 'init', session_id: 'x', permissionMode: 'auto' });
    expect(getChat('a')?.bypass).toBeUndefined();
    a.observe({ type: 'system', subtype: 'init', session_id: 'x', permissionMode: 'bypassPermissions' });
    expect(getChat('a')?.bypass).toBeUndefined();
    const b = reg('b', true);
    b.notBypass();
    expect(getChat('b')?.bypass).toBeUndefined();
    reg('c', false);
    expect(getChat('c')?.bypass).toBeUndefined();
  });

  it('the Super decides only a tool permission of a Bypass process', () => {
    const perm = { isPermission: true, toolName: 'Bash' };
    expect(superDecidesPermission({ bypass: true }, perm)).toBe(true);
    expect(superDecidesPermission({}, perm)).toBe(false);
    expect(superDecidesPermission({ bypass: true }, { isPermission: true, toolName: 'ExitPlanMode' })).toBe(false);
    expect(superDecidesPermission({ bypass: true }, { isPermission: false, toolName: 'AskUserQuestion' })).toBe(false);
    expect(permissionGoesToSuper({ bypass: true }, perm)).toBe(true);
  });
});

describe('a request the CLI dropped leaves no ghost', () => {
  it('a tool_result for its tool call settles it (top level and inside a sub-agent)', () => {
    const h = reg('g');
    h.userSent('go');
    askPermission(h, 'r1', 'tu-1');
    expect(getChat('g')?.status).toBe('asking');
    h.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-other' }] } });
    expect(getChat('g')?.pendingQuestion?.requestId).toBe('r1');
    h.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', is_error: true, content: 'Tool permission request failed: AbortError: Stream closed' }] } });
    expect(getChat('g')?.pendingQuestion).toBeNull();
    expect(getChat('g')?.status).toBe('working');
    askPermission(h, 'r2', 'tu-2');
    h.observe({ type: 'user', parent_tool_use_id: 'agent-1', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-2' }] } });
    expect(getChat('g')?.pendingQuestion).toBeNull();
  });

  it('a control_cancel_request still settles it', () => {
    const h = reg('g2');
    h.userSent('go');
    askPermission(h, 'r1');
    h.observe({ type: 'control_cancel_request', request_id: 'r1' });
    expect(getChat('g2')?.pendingQuestion).toBeNull();
  });
});

describe('the queue: a Bypass child asks its Super, any other the owner', () => {
  it('a Bypass child\'s permission is delivered to the Super with its request, tool and command, never the owner\'s head', async () => {
    makeVault({ children: { c1: child('c1') } });
    await startSuperInbox([root]);
    settle(reg(SUPER, false, 'super'));
    const c1 = reg('c1', true);
    const { inbox, delivered } = fakeInbox();
    attachSuperInbox(inbox);
    askPermission(c1, 'perm-1');
    await vi.waitFor(() => expect(delivered).toHaveLength(1), W);
    expect(delivered[0].text).toContain('event=permission');
    expect(delivered[0].text).toContain('request=perm-1 tool=Bash');
    expect(delivered[0].text).toContain('rm -rf /tmp/wt-c1-copy');
    expect(delivered[0].text).toContain('super allow');
    expect(delivered[0].text).toContain('Why Claude Code asks: Dangerous rm operation not ruled out');
    const s = await readSuperState(root);
    expect(s.queue[0]).toMatchObject({ kind: 'permission', toSuper: true, requestId: 'perm-1' });
    expect(superQueueHead(s)).toBeNull();
    // Quiet for the owner while the Super holds it: no head, no waiting row, no push...
    expect(superDigest({ ...s, pad: s.pad ?? [] } as Parameters<typeof superDigest>[0]).waiting).toHaveLength(0);
    // ...but the hands-free phone draws it from the first second, as the child's own tab does.
    const phone = phoneSuperQuestions(s, () => 'gone', () => ({
      requestId: 'perm-1', toolName: 'Bash', isPermission: true, text: 'x', options: [],
      description: 'Remove the temp copy', reason: 'Dangerous rm operation not ruled out', reasonType: 'safetyCheck',
    })).questions;
    expect(phone).toHaveLength(1);
    expect(phone[0]).toMatchObject({
      kind: 'permission', requestId: 'perm-1',
      permission: { tool: 'Bash', text: 'x', description: 'Remove the temp copy', reason: 'Dangerous rm operation not ruled out', reasonType: 'safetyCheck' },
    });
  });

  it('a non-bypass child\'s permission is the owner\'s head and never a batch item', async () => {
    makeVault({ children: { c1: child('c1') } });
    await startSuperInbox([root]);
    settle(reg(SUPER, false, 'super'));
    const c1 = reg('c1', false);
    const { inbox, delivered } = fakeInbox();
    attachSuperInbox(inbox);
    askPermission(c1, 'perm-2');
    await vi.waitFor(async () => expect(superQueueHead(await readSuperState(root))).toMatchObject({ kind: 'permission', requestId: 'perm-2' }), W);
    const s = await readSuperState(root);
    expect(s.queue[0].toSuper).toBeUndefined();
    expect(nextBatch(s).items).toEqual([]);
    expect(delivered).toHaveLength(0);
    // The phone draws it with Allow / Deny.
    const phone = phoneSuperQuestions(s, () => 'gone', () => ({ requestId: 'perm-2', toolName: 'Bash', isPermission: true, text: 'rm -rf build', options: [] }));
    expect(phone.questions).toEqual([expect.objectContaining({ kind: 'permission', requestId: 'perm-2', permission: { tool: 'Bash', text: 'rm -rf build' } })]);
  });

  it('an ExitPlanMode approval of a Bypass child stays the owner\'s', async () => {
    makeVault({ children: { c1: child('c1') } });
    await startSuperInbox([root]);
    const c1 = reg('c1', true);
    askPermission(c1, 'plan-1', 'tu-p', 'ExitPlanMode');
    await vi.waitFor(async () => expect(superQueueHead(await readSuperState(root))).toMatchObject({ requestId: 'plan-1' }), W);
  });

  it('the Super\'s turn ending without a decision hands it to the owner', async () => {
    makeVault({ children: { c1: child('c1') } });
    await startSuperInbox([root]);
    settle(reg(SUPER, false, 'super'));
    const c1 = reg('c1', true);
    const { inbox, delivered } = fakeInbox();
    attachSuperInbox(inbox);
    askPermission(c1, 'perm-3');
    await vi.waitFor(() => expect(delivered).toHaveLength(1), W);
    await vi.waitFor(async () => expect((await readSuperState(root)).queue[0].state).toBe('delivered'), W);
    superTurnEnded(SUPER);
    await vi.waitFor(async () => {
      const s = await readSuperState(root);
      expect(s.queue[0]).toMatchObject({ kind: 'permission', state: 'escalated' });
      expect(s.queue[0].toSuper).toBeUndefined();
      expect(superQueueHead(s)?.requestId).toBe('perm-3');
    }, W);
  });

  it('permissionToOwner flips an open one, never with the Super\'s words (D7), and only once', async () => {
    makeVault({ children: { c1: child('c1') } });
    await startSuperInbox([root]);
    const c1 = reg('c1', true);
    askPermission(c1, 'perm-4');
    await vi.waitFor(async () => expect((await readSuperState(root)).queue).toHaveLength(1), W);
    const id = (await readSuperState(root)).queue[0].id;
    expect(await permissionToOwner(root, id)).toBe(true);
    const s = await readSuperState(root);
    expect(s.queue[0]).toMatchObject({ state: 'escalated' });
    expect(s.queue[0].ownerText).toBeUndefined();
    expect(superQueueHead(s)?.id).toBe(id);
    expect(await permissionToOwner(root, id)).toBe(false);
  });

  it('handed to the owner, its push names the tool only, never the command', async () => {
    const bodies: string[] = [];
    setOwnerQuestionSinks({ push: (q) => { bodies.push(`${q.title} ${q.body}`); return 1; } });
    try {
      makeVault({ children: { c1: child('c1') } });
      await startSuperInbox([root]);
      const c1 = reg('c1', true);
      askPermission(c1, 'perm-7');
      await vi.waitFor(async () => expect((await readSuperState(root)).queue).toHaveLength(1), W);
      const id = (await readSuperState(root)).queue[0].id;
      expect(await permissionToOwner(root, id)).toBe(true);
      await vi.waitFor(() => expect(bodies).toHaveLength(1), W);
      expect(bodies[0]).toContain('Bash');
      expect(bodies[0]).not.toContain('rm -rf');
    } finally { _resetOwnerQuestions(); }
  });

  it('left undecided past the grace, it is the owner\'s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    makeVault({ children: { c1: child('c1') } });
    await startSuperInbox([root]);
    const c1 = reg('c1', true);
    askPermission(c1, 'perm-5');
    await vi.waitFor(async () => expect((await readSuperState(root)).queue).toHaveLength(1), W);
    await vi.advanceTimersByTimeAsync(SUPER_PERMISSION_GRACE_MS + 10);
    vi.useRealTimers();
    await vi.waitFor(async () => expect((await readSuperState(root)).queue[0]).toMatchObject({ state: 'escalated' }), W);
  });

  it('a routed request the child no longer holds is dropped, never delivered', async () => {
    makeVault({ children: { c1: child('c1') } });
    await startSuperInbox([root]);
    const c1 = reg('c1', true);
    c1.userSent('go');
    askPermission(c1, 'perm-6', 'tu-6');
    await vi.waitFor(async () => expect((await readSuperState(root)).queue).toHaveLength(1), W);
    c1.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-6' }] } });
    const s = await readSuperState(root);
    expect(nextBatch(s).items).toEqual([]);
  });
});
