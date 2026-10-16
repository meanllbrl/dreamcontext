/**
 * A chat changes account where it is CHEAP, and keeps every turn's usage reading — from the
 * server's side, driving the REAL `startChatSession` with a scripted child.
 *
 * ── What was asked (owner, 2026-10-16) ──────────────────────────────────────────────────
 * "This part is almost always wrong, always stale. The accounts' state must be up to date so
 * switching can be economic. A switch should not be made with a full session, or an uncached
 * read happens; it should happen after a handoff or in a new session."
 *
 * Measured the same day on the owner's own sessions: a 120k-token chat moved between two
 * accounts of ONE organization read all 120k from cache on the new account — the prompt cache
 * is the organization's. Across organizations the same move re-reads everything uncached.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/come-home-`);
});

const spawned: FakeChild[] = [];

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 4246;
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

const state = vi.hoisted(() => ({
  accounts: [] as Array<Record<string, unknown>>,
  rejections: {} as Record<string, { until: number; window: string }>,
  /** What `chatSpawnAccount` answers: where a NEW chat would open right now. */
  spawnHome: null as string | null,
  cleared: [] as string[],
}));

vi.mock('../../src/lib/claude-accounts.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-accounts.js')>();
  return {
    ...real,
    listClaudeAccounts: vi.fn(() => state.accounts),
    // The register lives in `state`, so ids resolve there; account #0 is the real HOME.
    resolveConfigDir: vi.fn((id: string | null) => {
      const acc = state.accounts.find((a) => a.id === id);
      return (acc?.configDir as string | null) ?? homedir();
    }),
  };
});
// The fixture accounts' folders live in /tmp, outside the sandbox root; nothing here needs one built.
vi.mock('../../src/lib/claude-account-sandbox.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-account-sandbox.js')>();
  return { ...real, ensureSandbox: vi.fn() };
});
vi.mock('../../src/lib/claude-limit-rejections.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-limit-rejections.js')>();
  return {
    ...real,
    readAccountRejections: vi.fn(() => state.rejections),
    recordAccountRejection: vi.fn((id: string) => {
      const r = { until: Date.now() + 3_600_000, window: 'session' };
      state.rejections = { ...state.rejections, [id]: r };
      return { ...r, at: Date.now(), estimated: false };
    }),
    clearAccountRejection: vi.fn((id: string) => {
      const { [id]: _gone, ...rest } = state.rejections;
      state.rejections = rest;
      state.cleared.push(id);
    }),
  };
});
vi.mock('../../src/lib/claude-usage-probe.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-usage-probe.js')>();
  const probe = vi.fn(async () => ({
    status: 'ok',
    limits: {
      limits: [
        { key: 'session', percent: 10, resetsAt: Date.now() + 3_600_000 },
        { key: 'weekly', percent: 10, resetsAt: Date.now() + 86_400_000 },
      ],
      fetchedAtMs: Date.now(),
    },
  }));
  return { ...real, probeAccountUsage: probe, probeAccountForDecision: probe };
});
vi.mock('../../src/lib/automations/account.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/automations/account.js')>();
  return {
    ...real,
    chatSpawnAccount: vi.fn(() => {
      const acc = state.accounts.find((a) => a.id === state.spawnHome);
      return acc
        ? { id: acc.id, configDir: (acc.configDir as string | null) ?? homedir(), label: null }
        : { id: null, configDir: homedir(), label: null };
    }),
  };
});

const { startChatSession, CHEAP_MOVE_MAX_CONTEXT_TOKENS } = await import('../../src/server/routes/agent-chat.js');
const { _resetChatRegistry } = await import('../../src/lib/assistant/chat-registry.js');
const { readUsageMeter, recordUsageMeter } = await import('../../src/lib/claude-usage-meter.js');

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

let paneSeq = 0;
function start(account = '', pin?: string) {
  const ws = new FakeWs();
  paneSeq += 1;
  startChatSession(ws as unknown as import('ws').WebSocket, '/tmp/come-home-test', {
    bypass: false, sessionId: pin ?? `00000000-0000-4000-8000-${String(paneSeq).padStart(12, '0')}`, resumeId: '', model: '', effort: '',
    initialPrompt: '', deferPrompt: false, account, mode: 'basic', vault: 'acme-app',
  });
  return { ws, child: spawned[spawned.length - 1]! };
}

/** `personal` (its own organization, top of the list) and two accounts of one team org. */
const acct = (id: string, configDir: string | null, org: string, preferred = false) => ({
  id, accountUuid: `uuid-${id}`, email: `${id}@example.test`, organizationUuid: org, organizationName: org,
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
/** One answered turn whose context is `tokens` (what `lastMainContext` reads). */
function answer(child: FakeChild, tokens: number) {
  emit(child, {
    type: 'assistant', message: { model: 'claude-opus', content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 2, cache_read_input_tokens: tokens - 2, cache_creation_input_tokens: 0, output_tokens: 10 } },
  });
  emit(child, { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'conv' });
}

describe('coming home happens only where it is cheap', () => {
  beforeEach(() => {
    spawned.length = 0;
    _resetChatRegistry();
    state.accounts = [
      acct('personal', '/tmp/come-home-personal', 'org-a', true),
      acct('team', null, 'org-b'),
    ];
    state.rejections = {};
    state.spawnHome = null;   // the pane opens on `team` (the real HOME), placed by the system
    state.cleared = [];
  });
  afterEach(() => { state.accounts = []; state.rejections = {}; });

  it('a small chat placed by the system moves back up when the top account can serve again', async () => {
    const { ws, child } = start();
    answer(child, 50_000);
    state.spawnHome = 'personal';
    say(ws, 'next');
    await vi.waitFor(() => expect(switchMetas(ws)).toHaveLength(1));
    expect(switchMetas(ws)[0]).toMatchObject({ switched: true, reason: 'come_home', accountId: 'personal', fromAccountId: 'team' });
    // Held for the restart, never written to the account being left.
    expect(userFrames(child)).not.toContain('next');
  });

  it('a LONG chat is not moved for this — its next cheap point is a handoff or a new session', async () => {
    const { ws, child } = start();
    answer(child, CHEAP_MOVE_MAX_CONTEXT_TOKENS + 40_000);
    state.spawnHome = 'personal';
    say(ws, 'next');
    await vi.waitFor(() => expect(userFrames(child)).toContain('next'));
    expect(switchMetas(ws)).toHaveLength(0);
  });

  it('a hand-picked account stays put', async () => {
    const { ws, child } = start('team');
    answer(child, 50_000);
    state.spawnHome = 'personal';
    say(ws, 'next');
    await vi.waitFor(() => expect(userFrames(child)).toContain('next'));
    expect(switchMetas(ws)).toHaveLength(0);
  });

  // Reviewer, 2026-10-16: a forced move decides from a live probe, coming home from disk. At the
  // threshold the two disagree, and a small chat bounced between two accounts every message.
  it('never straight back onto the account it was just FORCED off — until that account serves again', async () => {
    const pin = '00000000-0000-4000-8000-0000000000aa';
    state.spawnHome = 'personal';
    const first = start('', pin);
    answer(first.child, 40_000);
    state.rejections = { personal: { until: Date.now() + 3_600_000, window: 'session' } };
    say(first.ws, 'devam');
    await vi.waitFor(() => expect(switchMetas(first.ws)).toHaveLength(1));
    expect(switchMetas(first.ws)[0]).toMatchObject({ reason: 'limit_known', accountId: 'team' });
    // The client reopens the pane on `team`; on disk `personal` now looks free again.
    state.rejections = {};
    first.ws.emit('close');
    first.child.emit('exit', 0, null);
    first.child.emit('close', 0, null);
    await new Promise((r) => setTimeout(r, 20));
    const second = start('team', pin);
    answer(second.child, 45_000);
    say(second.ws, 'next');
    await vi.waitFor(() => expect(userFrames(second.child)).toContain('next'));
    expect(switchMetas(second.ws)).toHaveLength(0);
    // `personal` serves a turn somewhere after the move: its reading is fresh, home is fine.
    const resetsAt = Date.now() + 3_600_000;
    recordUsageMeter('/tmp/come-home-personal', {
      limits: [{ key: 'session', percent: 20, resetsAt }, { key: 'weekly', percent: 5, resetsAt: resetsAt + 86_400_000 }],
      fetchedAtMs: Date.now() + 1,
    });
    answer(second.child, 46_000);
    say(second.ws, 'again');
    await vi.waitFor(() => expect(switchMetas(second.ws)).toHaveLength(1));
    expect(switchMetas(second.ws)[0]).toMatchObject({ reason: 'come_home', accountId: 'personal' });
  });

  // Multi-review, 2026-10-17: a message typed while a turn runs is a steer. Coming home used to
  // hold it back from that turn and replay it on another account after a restart.
  it('never while a turn is running: a steer reaches the running turn, the move waits for the boundary', async () => {
    const { ws, child } = start();
    say(ws, 'first');
    await vi.waitFor(() => expect(userFrames(child)).toContain('first'));
    // The turn is answering (no result yet) and the conversation is small.
    emit(child, {
      type: 'assistant', message: { model: 'claude-opus', content: [{ type: 'text', text: 'working' }],
        usage: { input_tokens: 2, cache_read_input_tokens: 49_998, cache_creation_input_tokens: 0, output_tokens: 10 } },
    });
    state.spawnHome = 'personal';
    say(ws, 'steer');
    await vi.waitFor(() => expect(userFrames(child)).toContain('steer'));
    expect(switchMetas(ws)).toHaveLength(0);
    // Both turns end; the next message is at a boundary and the pane goes home.
    emit(child, { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'conv' });
    emit(child, { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'conv' });
    say(ws, 'after');
    await vi.waitFor(() => expect(switchMetas(ws)).toHaveLength(1));
    expect(switchMetas(ws)[0]).toMatchObject({ reason: 'come_home', accountId: 'personal' });
  });

  // Multi-review, 2026-10-17: any later reading used to lift the guard, so 89.6% on disk (the
  // probe that forced the move read 90%) brought the pane back only to force it off again.
  it('a reading just under the threshold is not room to go back to the account it was forced off', async () => {
    const pin = '00000000-0000-4000-8000-0000000000bb';
    state.spawnHome = 'personal';
    const first = start('', pin);
    answer(first.child, 40_000);
    state.rejections = { personal: { until: Date.now() + 3_600_000, window: 'session' } };
    say(first.ws, 'devam');
    await vi.waitFor(() => expect(switchMetas(first.ws)).toHaveLength(1));
    state.rejections = {};
    first.ws.emit('close');
    first.child.emit('exit', 0, null);
    first.child.emit('close', 0, null);
    await new Promise((r) => setTimeout(r, 20));
    const second = start('team', pin);
    const resetsAt = Date.now() + 3_600_000;
    recordUsageMeter('/tmp/come-home-personal', {
      limits: [{ key: 'session', percent: 89.6, resetsAt }], fetchedAtMs: Date.now() + 1,
    });
    answer(second.child, 45_000);
    say(second.ws, 'next');
    await vi.waitFor(() => expect(userFrames(second.child)).toContain('next'));
    expect(switchMetas(second.ws)).toHaveLength(0);
    // The window resets and the account serves with clear room: now it is home.
    recordUsageMeter('/tmp/come-home-personal', {
      limits: [{ key: 'session', percent: 3, resetsAt: resetsAt + 5 * 3_600_000 }], fetchedAtMs: Date.now() + 2,
    });
    answer(second.child, 46_000);
    say(second.ws, 'again');
    await vi.waitFor(() => expect(switchMetas(second.ws)).toHaveLength(1));
    expect(switchMetas(second.ws)[0]).toMatchObject({ reason: 'come_home', accountId: 'personal' });
  });

  // Multi-review, 2026-10-17: a hand-picked pane forced off its account was marked auto-placed,
  // and then "came home" to the top of the list — an account the owner chose not to use here.
  it('a hand-picked account forced off by a limit is where the pane goes home to', async () => {
    state.accounts = [
      acct('personal', '/tmp/come-home-personal', 'org-a', true),
      acct('team', null, 'org-b'),
      acct('team2', '/tmp/come-home-team2', 'org-b'),
    ];
    const pin = '00000000-0000-4000-8000-0000000000cc';
    const first = start('team2', pin);
    answer(first.child, 40_000);
    state.rejections = { team2: { until: Date.now() + 3_600_000, window: 'session' } };
    say(first.ws, 'devam');
    await vi.waitFor(() => expect(switchMetas(first.ws)).toHaveLength(1));
    expect(switchMetas(first.ws)[0]).toMatchObject({ reason: 'limit_known', accountId: 'personal' });
    first.ws.emit('close');
    first.child.emit('exit', 0, null);
    first.child.emit('close', 0, null);
    await new Promise((r) => setTimeout(r, 20));
    // Reopened where the system moved it; a new chat would open on `personal` too.
    state.spawnHome = 'personal';
    const second = start('personal', pin);
    state.rejections = {};
    answer(second.child, 45_000);
    say(second.ws, 'next');
    await vi.waitFor(() => expect(userFrames(second.child)).toContain('next'));
    expect(switchMetas(second.ws)).toHaveLength(0);
    // `team2` serves again with room: the pane goes back to the account the owner picked.
    recordUsageMeter('/tmp/come-home-team2', {
      limits: [{ key: 'session', percent: 15, resetsAt: Date.now() + 3_600_000 }], fetchedAtMs: Date.now() + 1,
    });
    answer(second.child, 46_000);
    say(second.ws, 'again');
    await vi.waitFor(() => expect(switchMetas(second.ws)).toHaveLength(1));
    expect(switchMetas(second.ws)[0]).toMatchObject({ reason: 'come_home', accountId: 'team2', fromAccountId: 'personal' });
  });

  it('never DOWN the list: home below the current account is not a move', async () => {
    state.accounts = [acct('team', null, 'org-b', true), acct('personal', '/tmp/come-home-personal', 'org-a')];
    const { ws, child } = start();
    answer(child, 50_000);
    state.spawnHome = 'personal';
    say(ws, 'next');
    await vi.waitFor(() => expect(userFrames(child)).toContain('next'));
    expect(switchMetas(ws)).toHaveLength(0);
  });
});

describe('a FORCED move with a large context stays in its organization', () => {
  beforeEach(() => {
    spawned.length = 0;
    _resetChatRegistry();
    state.accounts = [
      acct('personal', '/tmp/come-home-personal', 'org-a', true),
      acct('team', null, 'org-b'),
      acct('team2', '/tmp/come-home-team2', 'org-b'),
    ];
    state.rejections = {};
    state.spawnHome = null;
    state.cleared = [];
  });
  afterEach(() => { state.accounts = []; state.rejections = {}; });

  it('large context: the refused account hands over to its organization-mate, not the top row', async () => {
    const { ws, child } = start();
    answer(child, 150_000);
    state.rejections = { team: { until: Date.now() + 3_600_000, window: 'session' } };
    say(ws, 'devam');
    await vi.waitFor(() => expect(switchMetas(ws)).toHaveLength(1));
    expect(switchMetas(ws)[0]).toMatchObject({ switched: true, reason: 'limit_known', accountId: 'team2' });
  });

  it('small context: the owner\'s order decides, as before', async () => {
    const { ws, child } = start();
    answer(child, 40_000);
    state.rejections = { team: { until: Date.now() + 3_600_000, window: 'session' } };
    say(ws, 'devam');
    await vi.waitFor(() => expect(switchMetas(ws)).toHaveLength(1));
    expect(switchMetas(ws)[0]).toMatchObject({ switched: true, accountId: 'personal' });
  });
});

describe('every turn\'s usage reading is kept', () => {
  beforeEach(() => {
    spawned.length = 0;
    _resetChatRegistry();
    state.accounts = [acct('personal', '/tmp/come-home-personal', 'org-a', true), acct('team', null, 'org-b')];
    state.rejections = {};
    state.spawnHome = null;
    state.cleared = [];
  });

  it('records the frame for the account the pane runs on, and a served turn ends a remembered refusal', async () => {
    const { child } = start();
    state.rejections = { team: { until: Date.now() + 1_200_000, window: 'session', at: Date.now() - 5 * 60_000 } as never };
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    emit(child, {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed', rateLimitType: 'five_hour', resetsAt,
        unifiedWindows: { five_hour: { utilization: 0.42, resetsAt }, seven_day: { utilization: 0.07, resetsAt: resetsAt + 86_400 } },
      },
    });
    await vi.waitFor(() => expect(readUsageMeter(homedir())?.limits.map((l) => l.percent)).toEqual([42, 7]));
    expect(state.cleared).toEqual(['team']);
  });
});
