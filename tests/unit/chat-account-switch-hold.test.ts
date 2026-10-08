/**
 * An owed account switch, from the server's side: what happens to the messages typed while it
 * is owed, when the client is told it may restart, and what happens if it never does.
 *
 * ── What broke (2026-10-04) ──────────────────────────────────────────────────────────────
 * A weekly limit landed on the preferred account while four panes were open. For thirteen
 * minutes every "devam" / "alo" / "bitir şunu" on those panes earned the same "You've hit your
 * weekly limit", while three other accounts sat at 3–14%. Three defects lined up:
 *   1. The client's restart watcher disarmed itself for good on the first "stayed put" / "every
 *      account is full" notice, so a later genuine switch was announced and never performed.
 *   2. While a switch was owed, the server sent every NEW message on the account being left —
 *      after a refusal, that is the account that just refused.
 *   3. Nothing ever said the switch again: not at the turn boundary, not on a reattach.
 * (1) is pinned against the source in chat-account-switch-restart.test.ts; this file drives the
 * REAL `startChatSession` with a scripted child for (2), (3) and the stall valve.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/switch-hold-home-`);
  // Read once at module load, so it has to be set before agent-chat.ts is imported.
  process.env.DREAMCONTEXT_SWITCH_STALL_MS = '150';
});

const spawned: FakeChild[] = [];

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 4245;
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
  return {
    ...real,
    readAccountRejections: vi.fn(() => accountsState.rejections),
    recordAccountRejection: vi.fn((id: string) => {
      const r = { until: Date.now() + 3_600_000, window: 'weekly' };
      accountsState.rejections = { ...accountsState.rejections, [id]: r };
      return { ...r, at: Date.now(), estimated: false };
    }),
  };
});
vi.mock('../../src/lib/claude-usage-probe.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-usage-probe.js')>();
  const probe = vi.fn(async () => ({ status: 'healthy-unmeasured', reason: 'test' }));
  return { ...real, probeAccountUsage: probe, probeAccountForDecision: probe };
});

const { startChatSession, LIMIT_CONTINUE_TEXT } = await import('../../src/server/routes/agent-chat.js');
const { _resetChatRegistry } = await import('../../src/lib/assistant/chat-registry.js');

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

function start() {
  const ws = new FakeWs();
  startChatSession(ws as unknown as import('ws').WebSocket, '/tmp/switch-hold-test', {
    bypass: false, sessionId: '', resumeId: '', model: '', effort: '', initialPrompt: '', deferPrompt: false,
    account: '', mode: 'basic', vault: 'acme-app',
  });
  return { ws, child: spawned[spawned.length - 1] };
}

const account = (id: string, configDir: string | null, preferred: boolean) => ({
  id, accountUuid: `uuid-${id}`, email: `${id}@example.test`, organizationUuid: 'org', organizationName: 'Acme',
  tier: 'max', configDir, preferred,
});

function userFrames(child: FakeChild): string[] {
  return child.stdin.write.mock.calls
    .map(([chunk]) => { try { return JSON.parse(String(chunk)); } catch { return null; } })
    .filter((f) => f?.type === 'user')
    .map((f) => f.message.content[0].text as string);
}

const switchMetas = (ws: FakeWs) => ws.send.mock.calls
  .map(([raw]) => JSON.parse(String(raw)))
  .filter((f) => f.type === '_meta' && f.subtype === 'account_switch');

const say = (ws: FakeWs, text: string) => ws.emit('message', JSON.stringify({ type: 'user', text }));
const emit = (child: FakeChild, frame: unknown) => child.stdout.emit('data', Buffer.from(`${JSON.stringify(frame)}\n`));

/** The API's refusal as the CLI streams it (claude-limit-signal.ts). */
const refusal = {
  type: 'assistant',
  message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: "You've hit your weekly limit · resets Oct 6 at 7am" }] },
  error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429,
  quotaLimits: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'seven_day' },
};
const result = { type: 'result', subtype: 'success', is_error: false, result: '', session_id: 'conv-1' };

describe('an owed account switch', () => {
  beforeEach(() => {
    spawned.length = 0;
    _resetChatRegistry();
    // `main` is the real HOME (the session's own account); `spare` is the way out.
    accountsState.accounts = [account('main', null, true), account('spare', '/tmp/switch-hold-spare', false)];
    accountsState.rejections = {};
  });
  afterEach(() => { accountsState.accounts = []; accountsState.rejections = {}; });

  it('holds EVERY message typed while it is owed, in order, and sends none to the account being left', async () => {
    accountsState.rejections = { main: { until: Date.now() + 3_600_000, window: 'weekly' } };
    const { ws, child } = start();
    say(ws, 'devam');
    await vi.waitFor(() => expect(switchMetas(ws)).toHaveLength(1));
    say(ws, 'alo');
    say(ws, 'bitir şunu');
    await vi.waitFor(() => expect(switchMetas(ws)).toHaveLength(3));
    const last = switchMetas(ws)[2];
    expect(last).toMatchObject({ switched: true, accountId: 'spare', pendingText: 'devam' });
    expect(last.pendingTexts).toEqual(['devam', 'alo', 'bitir şunu']);
    expect(userFrames(child)).toEqual([]);
  });

  it('a refusal mid-turn is said again at the turn boundary with turnInFlight: false', async () => {
    const { ws, child } = start();
    say(ws, 'npm run build');
    await vi.waitFor(() => expect(userFrames(child)).toEqual(['npm run build']));
    emit(child, refusal);
    await vi.waitFor(() => expect(switchMetas(ws)).toHaveLength(1));
    expect(switchMetas(ws)[0]).toMatchObject({ switched: true, reason: 'limit_hit', accountId: 'spare', turnInFlight: true });
    emit(child, result);
    await vi.waitFor(() => expect(switchMetas(ws)).toHaveLength(2));
    expect(switchMetas(ws)[1]).toMatchObject({ switched: true, accountId: 'spare', turnInFlight: false, pendingTexts: ['npm run build'] });
  });

  it('a refusal read twice (the reply AND its result) announces one switch, not two decisions', async () => {
    const { ws, child } = start();
    say(ws, 'go');
    await vi.waitFor(() => expect(userFrames(child)).toEqual(['go']));
    emit(child, refusal);
    emit(child, { ...result, is_error: true, subtype: 'error_during_execution', result: refusal.message.content[0].text });
    await vi.waitFor(() => expect(switchMetas(ws).some((m) => m.turnInFlight === false)).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    // Every frame names the same move and the same single held text.
    for (const m of switchMetas(ws)) expect(m).toMatchObject({ switched: true, accountId: 'spare', pendingTexts: ['go'] });
  });

  it('a refusal of a turn WE did not send moves the pane and tells it to continue, never the old message (2026-10-08)', async () => {
    const { ws, child } = start();
    say(ws, 'an hour-old message');
    await vi.waitFor(() => expect(userFrames(child)).toEqual(['an hour-old message']));
    emit(child, result);
    // A background task finishing starts a turn inside the CLI, and THAT turn is refused.
    emit(child, refusal);
    await vi.waitFor(() => expect(switchMetas(ws)).toHaveLength(1));
    const [meta] = switchMetas(ws);
    expect(meta).toMatchObject({ switched: true, reason: 'limit_hit', accountId: 'spare' });
    // Without a turn to resubmit, the restarted pane sat idle under the refusal until the owner
    // typed "devam et" (six panes on 2026-10-08, one for 46 minutes).
    expect(meta.pendingTexts).toEqual([LIMIT_CONTINUE_TEXT]);
    expect(meta.pendingTexts).not.toContain('an hour-old message');
  });

  it('a refusal after the turn already did work resubmits a continue, not the request from the top', async () => {
    const { ws, child } = start();
    say(ws, '/goal-skill build the whole thing');
    await vi.waitFor(() => expect(userFrames(child)).toEqual(['/goal-skill build the whole thing']));
    // Forty minutes of tool calls, then the wall lands right after a tool result.
    emit(child, { type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } });
    emit(child, refusal);
    emit(child, result);
    await vi.waitFor(() => expect(switchMetas(ws).some((m) => m.turnInFlight === false)).toBe(true));
    for (const m of switchMetas(ws)) expect(m.pendingTexts).toEqual([LIMIT_CONTINUE_TEXT]);
  });

  it('progress is per turn: a second message refused before any answer is replayed, not continued', async () => {
    const { ws, child } = start();
    say(ws, 'first');
    await vi.waitFor(() => expect(userFrames(child)).toEqual(['first']));
    emit(child, { type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'done' }] } });
    emit(child, result);
    say(ws, 'second');
    await vi.waitFor(() => expect(userFrames(child)).toEqual(['first', 'second']));
    emit(child, refusal);
    await vi.waitFor(() => expect(switchMetas(ws)).toHaveLength(1));
    expect(switchMetas(ws)[0].pendingTexts).toEqual(['second']);
  });

  it('a sub-agent answering does not count as the turn having progressed', async () => {
    const { ws, child } = start();
    say(ws, 'go');
    await vi.waitFor(() => expect(userFrames(child)).toEqual(['go']));
    emit(child, { type: 'assistant', parent_tool_use_id: 'toolu_sub', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'sub' }] } });
    emit(child, refusal);
    await vi.waitFor(() => expect(switchMetas(ws)).toHaveLength(1));
    expect(switchMetas(ws)[0].pendingTexts).toEqual(['go']);
  });

  it('a restart that never comes releases the held messages to this account, once, and stops moving', async () => {
    accountsState.rejections = { main: { until: Date.now() + 3_600_000, window: 'weekly' } };
    const { ws, child } = start();
    say(ws, 'first');
    say(ws, 'second');
    await vi.waitFor(() => expect(switchMetas(ws)).toHaveLength(2));
    // Nobody restarts. Past the stall the messages go out here rather than nowhere.
    await vi.waitFor(() => expect(userFrames(child)).toEqual(['first', 'second']), { timeout: 2_000 });
    // …and the notice the client holds is retracted, so it cannot perform the stale move later
    // and resubmit the same two messages a second time.
    expect(switchMetas(ws).at(-1)).toMatchObject({ switched: false, reason: 'switch_stalled', accountId: 'main' });
    const announced = switchMetas(ws).filter((m) => m.switched).length;
    emit(child, refusal);
    emit(child, result);
    emit(child, result);
    say(ws, 'third');
    await vi.waitFor(() => expect(userFrames(child)).toEqual(['first', 'second', 'third']));
    await new Promise((r) => setTimeout(r, 300));
    // No second restart is announced to a client that could not perform the first.
    expect(switchMetas(ws).filter((m) => m.switched)).toHaveLength(announced);
  });

  it('a pane that restarts in time never releases anything — even while the old child lingers', async () => {
    accountsState.rejections = { main: { until: Date.now() + 3_600_000, window: 'weekly' } };
    const { ws, child } = start();
    say(ws, 'devam');
    await vi.waitFor(() => expect(switchMetas(ws)).toHaveLength(1));
    // The client restarts: its socket closes on purpose and the child is DRAINED (stdin ended).
    // It does not exit: background sub-agents can keep it alive for minutes, well past the stall.
    ws.emit('message', JSON.stringify({ type: 'end' }));
    ws.emit('close');
    expect(child.stdin.end).toHaveBeenCalled();
    const writesAtEnd = child.stdin.write.mock.calls.length;
    // A turn ending on the lingering child must not re-arm the stall either.
    emit(child, result);
    await new Promise((r) => setTimeout(r, 400));
    // Writing after stdin.end() is an async 'error' event that would crash the server.
    expect(child.stdin.write.mock.calls.length).toBe(writesAtEnd);
    expect(userFrames(child)).toEqual([]);
    child.emit('close', 0);
  });
});
