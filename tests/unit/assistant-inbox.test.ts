/**
 * The Assistant's inbox (delegations.ts) as agent-chat.ts attaches it: a wake message rides the
 * same switch chain as an owner message, lands as exactly one user frame, taints the Assistant
 * and never clears the taint. Driven through the REAL `startChatSession` with a mocked child.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Isolated HOME: a single-account machine, so `maybeSwitchAccount` never probes.
vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/assistant-inbox-home-`);
});

const spawned: FakeChild[] = [];

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 4244;
}

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn(() => {
      const child = new FakeChild();
      spawned.push(child);
      return child as unknown as import('node:child_process').ChildProcess;
    }),
  };
});

// Account state the switch chooser reads — empty (a single-account machine) unless a test
// stages a forced switch: two accounts, and a standing API refusal on the active one.
const accountsState = vi.hoisted(() => ({
  accounts: [] as Array<Record<string, unknown>>,
  rejections: {} as Record<string, { until: number; window: string }>,
}));

vi.mock('../../src/lib/claude-accounts.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-accounts.js')>();
  return { ...real, listClaudeAccounts: vi.fn(() => accountsState.accounts) };
});
vi.mock('../../src/lib/claude-limit-rejections.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-limit-rejections.js')>();
  return { ...real, readAccountRejections: vi.fn(() => accountsState.rejections) };
});
vi.mock('../../src/lib/claude-usage-probe.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-usage-probe.js')>();
  return { ...real, probeAccountUsage: vi.fn(async () => ({ status: 'healthy-unmeasured', reason: 'test' })) };
});

const { startChatSession } = await import('../../src/server/routes/agent-chat.js');
const delegations = await import('../../src/lib/assistant/delegations.js');
const state = await import('../../src/lib/assistant/session-state.js');
const { _resetChatRegistry } = await import('../../src/lib/assistant/chat-registry.js');

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

function start(mode: 'basic' | 'assistant' = 'assistant') {
  const ws = new FakeWs();
  startChatSession(ws as unknown as import('ws').WebSocket, '/tmp/assistant-inbox-test', {
    bypass: false, sessionId: '', resumeId: '', model: '', effort: '', initialPrompt: '', deferPrompt: false,
    account: '', mode, vault: mode === 'assistant' ? '__assistant__' : 'acme-app',
  });
  return { ws, child: spawned[spawned.length - 1] };
}

/** Every user frame the child's stdin received, as its text. */
function userFrames(child: FakeChild): string[] {
  return child.stdin.write.mock.calls
    .map(([chunk]) => { try { return JSON.parse(String(chunk)); } catch { return null; } })
    .filter((f) => f?.type === 'user')
    .map((f) => f.message.content[0].text as string);
}

describe('the Assistant inbox — wake messages ride the owner-message chain', () => {
  beforeEach(() => {
    spawned.length = 0;
    delegations._resetDelegations();
    state._resetAssistantState();
    _resetChatRegistry();
  });

  it('a non-Assistant chat attaches nothing', () => {
    start('basic');
    expect(delegations._currentAssistantInbox()).toBeNull();
  });

  it('one deliver writes exactly one user frame and marks the Assistant tainted', async () => {
    const { child } = start();
    const inbox = delegations._currentAssistantInbox()!;
    expect(inbox).not.toBeNull();
    expect(state.isTainted()).toBe(false);

    await expect(inbox.deliver('Tab "Fix login" finished a turn.')).resolves.toBe(true);
    expect(userFrames(child)).toEqual(['Tab "Fix login" finished a turn.']);
    expect(state.isTainted()).toBe(true);
  });

  it('a wake never clears a standing taint; only the owner message does', async () => {
    const { ws, child } = start();
    state.markTainted();
    await delegations._currentAssistantInbox()!.deliver('wake');
    expect(state.isTainted()).toBe(true);

    ws.emit('message', JSON.stringify({ type: 'user', text: 'owner speaks' }));
    expect(state.isTainted()).toBe(false);
    await vi.waitFor(() => expect(userFrames(child)).toEqual(['wake', 'owner speaks']));
  });

  it('keeps order across two delivers and an owner message in between', async () => {
    const { ws, child } = start();
    const inbox = delegations._currentAssistantInbox()!;
    const first = inbox.deliver('first wake');
    ws.emit('message', JSON.stringify({ type: 'user', text: 'owner' }));
    const second = inbox.deliver('second wake');
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    await vi.waitFor(() => expect(userFrames(child)).toEqual(['first wake', 'owner', 'second wake']));
    // The last thing written was a wake, so the Assistant is tainted again.
    expect(state.isTainted()).toBe(true);
  });

  it('resolves false once the child has exited, and the inbox is detached', async () => {
    const { child } = start();
    const inbox = delegations._currentAssistantInbox()!;
    child.emit('close', 0);
    expect(delegations._currentAssistantInbox()).toBeNull();
    await expect(inbox.deliver('too late')).resolves.toBe(false);
    expect(userFrames(child)).toEqual([]);
    expect(state.isTainted()).toBe(false);
  });

  it('a queued deliver resolves false when the child exits before its turn in the chain', async () => {
    const { child } = start();
    const pending = delegations._currentAssistantInbox()!.deliver('queued');
    child.emit('close', 0);
    await expect(pending).resolves.toBe(false);
    expect(userFrames(child)).toEqual([]);
  });

  it('an older session\'s disposer does not detach the newer Assistant inbox', () => {
    const { child: old } = start();
    start();
    const current = delegations._currentAssistantInbox();
    old.emit('close', 0);
    expect(delegations._currentAssistantInbox()).toBe(current);
  });

  describe('a forced account switch', () => {
    const account = (id: string, configDir: string | null, preferred: boolean) => ({
      id, accountUuid: `uuid-${id}`, email: `${id}@example.test`, organizationUuid: 'org', organizationName: 'Acme',
      tier: 'max', configDir, preferred,
    });
    beforeEach(() => {
      // `main` is the real HOME (account #0, the session's own); `spare` is the only way out.
      accountsState.accounts = [account('main', null, true), account('spare', '/tmp/assistant-inbox-spare', false)];
      accountsState.rejections = { main: { until: Date.now() + 3_600_000, window: 'session' } };
    });
    afterEach(() => { accountsState.accounts = []; accountsState.rejections = {}; });

    const switchMetas = (ws: FakeWs) => ws.send.mock.calls
      .map(([raw]) => JSON.parse(String(raw)))
      .filter((f) => f.type === '_meta' && f.subtype === 'account_switch');

    it('a HELD wake is announced WITHOUT pendingText, resolves false and writes nothing', async () => {
      const { ws, child } = start();
      await expect(delegations._currentAssistantInbox()!.deliver('Tab "Fix login" asks a question.')).resolves.toBe(false);
      const [meta] = switchMetas(ws);
      expect(meta).toMatchObject({ switched: true, reason: 'limit_known', accountId: 'spare', fromAccountId: 'main' });
      expect(meta).not.toHaveProperty('pendingText');
      expect(JSON.stringify(ws.send.mock.calls)).not.toContain('Fix login');
      expect(userFrames(child)).toEqual([]);
      expect(state.isTainted()).toBe(false);
    });

    it('a held OWNER message still carries pendingText', async () => {
      const { ws, child } = start();
      ws.emit('message', JSON.stringify({ type: 'user', text: 'owner speaks' }));
      await vi.waitFor(() => expect(switchMetas(ws)).toHaveLength(1));
      expect(switchMetas(ws)[0]).toMatchObject({ switched: true, accountId: 'spare', pendingText: 'owner speaks' });
      expect(userFrames(child)).toEqual([]);
    });
  });

  describe('a post-hoc limit refusal after a wake', () => {
    afterEach(() => { accountsState.accounts = []; accountsState.rejections = {}; });

    // The API's refusal of the turn just sent, as the CLI streams it (claude-limit-signal.ts).
    const refusal = {
      type: 'assistant',
      message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: "You've hit your session limit · resets 9:30pm" }] },
      error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429,
      quotaLimits: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour' },
    };
    const refuse = (child: FakeChild) => {
      // A second account appears only now, so the owner's message and the wake went out unheld.
      accountsState.accounts = [
        { id: 'main', accountUuid: 'uuid-main', email: 'main@example.test', organizationUuid: 'org', organizationName: 'Acme', tier: 'max', configDir: null, preferred: true },
        { id: 'spare', accountUuid: 'uuid-spare', email: 'spare@example.test', organizationUuid: 'org', organizationName: 'Acme', tier: 'max', configDir: '/tmp/assistant-inbox-spare', preferred: false },
      ];
      child.stdout.emit('data', Buffer.from(`${JSON.stringify(refusal)}\n`));
    };
    const pendingTexts = (ws: FakeWs) => ws.send.mock.calls
      .map(([raw]) => JSON.parse(String(raw)))
      .filter((f) => f.type === '_meta' && f.subtype === 'account_switch' && 'pendingText' in f)
      .map((f) => f.pendingText);

    it('control: a refusal of the owner\'s own turn resubmits it as pendingText', async () => {
      const { ws, child } = start();
      ws.emit('message', JSON.stringify({ type: 'user', text: 'owner speaks' }));
      await vi.waitFor(() => expect(userFrames(child)).toEqual(['owner speaks']));
      refuse(child);
      await vi.waitFor(() => expect(pendingTexts(ws)).toEqual(['owner speaks']));
    });

    it('a sent wake clears lastSentText: the refusal does not resubmit the previous owner text', async () => {
      const { ws, child } = start();
      ws.emit('message', JSON.stringify({ type: 'user', text: 'owner speaks' }));
      await vi.waitFor(() => expect(userFrames(child)).toEqual(['owner speaks']));
      await expect(delegations._currentAssistantInbox()!.deliver('wake')).resolves.toBe(true);
      refuse(child);
      await new Promise((r) => setTimeout(r, 50));
      expect(pendingTexts(ws)).toEqual([]);
    });
  });

  it('attach/detach: the disposer clears only its own inbox', async () => {
    const a = { id: 'a', deliver: async () => true };
    const b = { id: 'b', deliver: async () => true };
    const detachA = delegations.attachAssistantInbox(a);
    const detachB = delegations.attachAssistantInbox(b);
    detachA();
    expect(delegations._currentAssistantInbox()).toBe(b);
    detachB();
    expect(delegations._currentAssistantInbox()).toBeNull();
  });
});
