/**
 * The account joins for a bridge tool (Track T W2, plan r5 §4d): Codex readings feed the SAME
 * chooser and thresholds Claude's do, a synthetic limit stream moves a Codex chat to the next
 * Codex account, and the move resumes the same thread when the continuation key matches and
 * goes through the Eco handoff (fresh thread + record) when it does not.
 *
 * Part 1 is the pure path (to-wire → readings → chooser → replaceSession). Part 2 drives the REAL
 * `startChatSession` for a Codex pane with a scripted bridge child and scripted probes.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/codex-switch-home-`);
  process.env.DREAMCONTEXT_CLI = '/opt/dreamcontext/dist/index.js';
});

const spawned: FakeChild[] = [];
class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 5151;
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
vi.mock('../../src/lib/t3-bridge/node-floor.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/t3-bridge/node-floor.js')>();
  return { ...real, bridgeNode: () => '/usr/local/bin/node' };
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToWire } from '../../src/lib/t3-bridge/to-wire.js';
import {
  CODEX_PRIMARY_ID, codexAccountsFile, codexLimitsFor, readCodexUsage, recordCodexUsage, setCodexAccountDepsForTests, type CodexRunner,
} from '../../src/lib/codex-accounts.js';
import { decideCodexTarget, probeReading } from '../../src/lib/codex-switch.js';
import { readToolRejections, readToolSignedOut, recordToolRejection, shouldSwitchAway } from '../../src/lib/account-switch.js';
import { planReplacement, replaceSession } from '../../src/lib/t3-bridge/replace-session.js';
import { handoffKey, readHandoffRecord } from '../../src/lib/context-watch.js';

const { startChatSession } = await import('../../src/server/routes/agent-chat.js');
const { _resetChatRegistry } = await import('../../src/lib/assistant/chat-registry.js');

const HOME = homedir();
const SECOND = 'acct-5e5e5e';
const soon = () => new Date(Date.now() + 3_600_000).toISOString();
const week = () => new Date(Date.now() + 5 * 86_400_000).toISOString();
const windows = (session: number, weekly: number) => [
  { id: 'primary', kind: 'session', label: 'Session', usedPercent: session, resetsAt: soon(), windowDurationMins: 300 },
  { id: 'secondary', kind: 'weekly', label: 'Weekly', usedPercent: weekly, resetsAt: week(), windowDurationMins: 10080 },
];

/** Probe answers per account, as `t3-account probe` prints them. */
let probeAnswers: Record<string, { session: number; weekly: number }> = {};
const probes: string[] = [];
const runner: CodexRunner = async (_cmd, args) => {
  const id = args.includes('--account') ? args[args.indexOf('--account') + 1]! : CODEX_PRIMARY_ID;
  probes.push(id);
  const a = probeAnswers[id] ?? { session: 5, weekly: 5 };
  return { spawned: true, timedOut: false, code: 0, stdout: JSON.stringify({ ok: true, signedIn: true, email: `${id}@example.test`, checkedAt: new Date().toISOString(), windows: windows(a.session, a.weekly) }) + '\n' };
};

const PROJECT = mkdtempSync(join(tmpdir(), 'codex-switch-project-'));
afterAll(() => { setCodexAccountDepsForTests(null); rmSync(PROJECT, { recursive: true, force: true }); rmSync(HOME, { recursive: true, force: true }); });

function twoAccounts(): void {
  rmSync(join(HOME, '.dreamcontext'), { recursive: true, force: true });
  rmSync(join(HOME, '.codex'), { recursive: true, force: true });
  mkdirSync(join(HOME, '.codex', 'sessions'), { recursive: true });
  writeFileSync(join(HOME, '.codex', 'auth.json'), '{}');
  mkdirSync(join(HOME, '.dreamcontext', 'codex-accounts', SECOND), { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'codex-accounts', SECOND, 'auth.json'), '{}');
  writeFileSync(codexAccountsFile(HOME), JSON.stringify({ accounts: [
    { id: CODEX_PRIMARY_ID, email: 'owner@example.test', planType: 'plus', addedAt: 0 },
    { id: SECOND, email: 'second@example.test', planType: 'plus', addedAt: 1 },
  ] }));
}

beforeEach(() => {
  twoAccounts();
  probeAnswers = {};
  probes.length = 0;
  setCodexAccountDepsForTests(() => ({ home: HOME, node: '/usr/local/bin/node', cli: '/opt/dreamcontext/dist/index.js', run: runner }));
});

describe('part 1: the joins, pure', () => {
  it('a usage-limit turn end becomes a refusal frame the server reads (dc_limit, with T3\'s reset)', () => {
    const wire = new ToWire({ tool: 'codex', model: 'gpt-5.5', cwd: PROJECT, permissionMode: 'default' });
    const resetAt = soon();
    const frames = wire.translate({ type: 'turn.terminal', status: 'failed', failure: { class: 'usage_limit', message: 'You have hit your usage limit.', code: 'usageLimitExceeded', retryable: false, resetAt } } as never);
    const result = frames.find((f) => f.type === 'result')!;
    expect(result.is_error).toBe(true);
    expect(result.dc_limit).toEqual({ resetsAtMs: Date.parse(resetAt) });
    // Any other failure is not a limit.
    const other = new ToWire({ tool: 'codex', model: 'gpt-5.5', cwd: PROJECT, permissionMode: 'default' })
      .translate({ type: 'turn.terminal', status: 'failed', failure: { class: 'provider_error', message: 'boom', code: null, retryable: null } } as never)
      .find((f) => f.type === 'result')!;
    expect(other.dc_limit).toBeUndefined();
  });

  it('Codex readings feed the same shouldSwitchAway and chooser: past 90 % moves to the next Codex account', async () => {
    recordCodexUsage(CODEX_PRIMARY_ID, windows(95, 40), new Date().toISOString(), 'session', HOME);
    const active = codexLimitsFor(readCodexUsage(CODEX_PRIMARY_ID, HOME));
    expect(shouldSwitchAway(active)).toBe(true);
    probeAnswers[SECOND] = { session: 10, weekly: 20 };
    const choice = await decideCodexTarget({ activeId: CODEX_PRIMARY_ID, active: { id: CODEX_PRIMARY_ID, limits: active }, home: HOME, probe: (id) => probeReading(id, { home: HOME, node: '/n', cli: '/c', run: runner }) });
    expect(choice.target).toEqual({ tool: 'codex', accountId: SECOND });
    expect(choice.sessionPercent).toBe(10);
  });

  it('a refused Codex account is out until its reset, in Codex\'s own store (never Claude\'s)', async () => {
    recordToolRejection('codex', SECOND, { window: 'unknown', resetsAtMs: Date.now() + 600_000, via: 'rateLimitEvent' }, HOME);
    expect(Object.keys(readToolRejections('codex', HOME))).toEqual([SECOND]);
    expect(readToolRejections('claude', HOME)).toEqual({});
    const choice = await decideCodexTarget({ activeId: CODEX_PRIMARY_ID, active: { id: CODEX_PRIMARY_ID, problem: 'unknown' }, home: HOME, probe: (id) => probeReading(id, { home: HOME, node: '/n', cli: '/c', run: runner }) });
    expect(choice.target).toBeNull();
  });

  it('replaceSession resumes the SAME thread when the continuation key matches (every Codex account shares ~/.codex)', async () => {
    const opened: unknown[] = [];
    const out = await replaceSession({ tool: 'codex', accountId: CODEX_PRIMARY_ID, threadId: '019a0000-0000-7000-8000-000000000001' }, { tool: 'codex', accountId: SECOND }, {
      contextRoot: join(PROJECT, '_dream_context'), pane: 'pane-1', close: () => { opened.push('closed'); }, open: (plan) => { opened.push(plan); },
    });
    expect(out.handoff).toBe(false);
    expect(out.resume).toBe('019a0000-0000-7000-8000-000000000001');
    expect(opened[0]).toBe('closed');
    expect(out.record).toBeNull();
  });

  it('and rotates through Eco when it does not: fresh thread, handoff record for the pane, its continue prompt', async () => {
    const ctx = join(PROJECT, '_dream_context');
    mkdirSync(join(ctx, 'state'), { recursive: true });
    writeFileSync(join(ctx, 'state', 'ship-the-thing.md'), '---\nname: Ship the thing\nstatus: in_progress\nupdated_at: "2026-10-31"\n---\n\n## Why\nx\n');
    const pane = '5b5b5b5b-0000-4000-8000-000000000002';
    const out = await replaceSession({ tool: 'codex', accountId: CODEX_PRIMARY_ID, threadId: 'old-thread' }, { tool: 'codex', accountId: SECOND }, {
      contextRoot: ctx, pane, close: () => {}, open: () => {},
      keyOf: (tool, id) => `${tool}:${id}`,   // two homes that do NOT share sessions
    });
    expect(out.handoff).toBe(true);
    expect(out.resume).toBe('');
    expect(readHandoffRecord(ctx, pane)?.task).toBe('ship-the-thing');
    expect(out.continuePrompt).toContain('ship-the-thing');
    // Keyed the way the pane's own agent would key it (DREAMCONTEXT_TAB_SESSION = the pane).
    expect(handoffKey({ DREAMCONTEXT_TAB_SESSION: pane })).toBe(pane);
  });

  it('planReplacement never resumes with no thread in hand', () => {
    expect(planReplacement({ tool: 'codex', accountId: CODEX_PRIMARY_ID, threadId: '' }, { tool: 'codex', accountId: SECOND }).handoff).toBe(true);
  });
});

// ── part 2: a Codex pane on the real chat server ──────────────────────────────────────

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}
const PANE = '7c7c7c7c-0000-4000-8000-000000000003';
function startCodexPane(account = '') {
  const ws = new FakeWs();
  startChatSession(ws as unknown as import('ws').WebSocket, PROJECT, {
    bypass: false, sessionId: PANE, resumeId: '', model: 'gpt-5.5', effort: '', initialPrompt: '', deferPrompt: false,
    account, mode: 'basic', vault: 'acme-app', tool: 'codex',
  });
  return { ws, child: spawned[spawned.length - 1]! };
}
const metas = (ws: FakeWs, subtype: string) => ws.send.mock.calls
  .map(([raw]) => { try { return JSON.parse(String(raw)); } catch { return null; } })
  .filter((f) => f?.type === '_meta' && f.subtype === subtype);
const emit = (child: FakeChild, frame: unknown) => child.stdout.emit('data', Buffer.from(`${JSON.stringify(frame)}\n`));
const say = (ws: FakeWs, text: string) => ws.emit('message', JSON.stringify({ type: 'user', text }));

describe('part 2: a Codex pane switches accounts through the chat server', () => {
  beforeEach(() => {
    spawned.length = 0;
    _resetChatRegistry();
  });

  it('opens on the account it was given, tells the chip which Codex account it runs on, and passes it to the bridge child', async () => {
    const { ws } = startCodexPane(SECOND);
    const { spawn } = await import('node:child_process');
    const script = String((vi.mocked(spawn).mock.calls.at(-1)![1] as string[]).join(' '));
    expect(script).toContain(`"--account" "${SECOND}"`);
    expect(metas(ws, 'account_active').at(-1)).toMatchObject({ accountId: SECOND, tool: 'codex' });
  });

  it('a synthetic limit stream: live readings are kept, the refusal is recorded, and the pane is told to move to the next account on the same thread', async () => {
    const { ws, child } = startCodexPane(CODEX_PRIMARY_ID);
    emit(child, { type: 'system', subtype: 'dc_thread', session_id: '019a0000-0000-7000-8000-0000000000aa', dc_tool: 'codex', dc_ready: true });
    say(ws, 'keep going');
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalled());
    emit(child, { type: 'system', subtype: 'init', session_id: '019a0000-0000-7000-8000-0000000000aa', dc_tool: 'codex' });
    // The account's live windows climb past the switch line…
    emit(child, { type: 'system', subtype: 'dc_usage', dc_tool: 'codex', windows: windows(97, 50), checked_at: new Date().toISOString() });
    expect(codexLimitsFor(readCodexUsage(CODEX_PRIMARY_ID, HOME)).limits.find((l) => l.key === 'session')?.percent).toBe(97);
    // …and Codex refuses the turn for its usage limit.
    probeAnswers[SECOND] = { session: 8, weekly: 12 };
    emit(child, { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'usage limit', dc_tool: 'codex', session_id: '019a0000-0000-7000-8000-0000000000aa', dc_limit: { resetsAtMs: Date.now() + 1_800_000 } });
    await vi.waitFor(() => expect(metas(ws, 'account_switch').some((m) => m.switched)).toBe(true));
    const move = metas(ws, 'account_switch').find((m) => m.switched)!;
    expect(move).toMatchObject({ switched: true, reason: 'limit_hit', tool: 'codex', accountId: SECOND, fromAccountId: CODEX_PRIMARY_ID, resumes: true, sessionPercent: 8 });
    expect(readToolRejections('codex', HOME)[CODEX_PRIMARY_ID]).toBeDefined();
    // Claude's books never saw it.
    expect(readToolRejections('claude', HOME)).toEqual({});
    expect(probes).toContain(SECOND);
  });

  it('ahead of the wall: a message sent with the account past 90 % is held and the move announced before it goes out', async () => {
    recordCodexUsage(CODEX_PRIMARY_ID, windows(85, 30), new Date().toISOString(), 'session', HOME);
    probeAnswers[CODEX_PRIMARY_ID] = { session: 93, weekly: 30 };
    probeAnswers[SECOND] = { session: 3, weekly: 4 };
    const { ws, child } = startCodexPane(CODEX_PRIMARY_ID);
    say(ws, 'next step please');
    await vi.waitFor(() => expect(metas(ws, 'account_switch').some((m) => m.switched)).toBe(true));
    const move = metas(ws, 'account_switch').find((m) => m.switched)!;
    expect(move).toMatchObject({ reason: 'limit_near', accountId: SECOND, tool: 'codex', pendingText: 'next step please' });
    const sentUser = child.stdin.write.mock.calls.map(([c]) => String(c)).filter((c) => c.includes('next step please'));
    expect(sentUser).toEqual([]);
  });

  it('an account removed while its pane runs: no readings come back for it, and a failed turn moves the pane to a signed-in account', async () => {
    const { ws, child } = startCodexPane(SECOND);
    say(ws, 'carry on');
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalled());
    // The owner removes the account in Settings (its row and its sign-in are gone).
    writeFileSync(codexAccountsFile(HOME), JSON.stringify({ accounts: [{ id: CODEX_PRIMARY_ID, email: 'owner@example.test', planType: 'plus', addedAt: 0 }] }));
    rmSync(join(HOME, '.dreamcontext', 'codex-accounts', SECOND), { recursive: true, force: true });
    emit(child, { type: 'system', subtype: 'dc_usage', dc_tool: 'codex', windows: windows(50, 50), checked_at: new Date().toISOString() });
    expect(readCodexUsage(SECOND, HOME)).toBeNull();
    emit(child, { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'unauthorized', dc_tool: 'codex', session_id: 's' });
    await vi.waitFor(() => expect(metas(ws, 'account_switch').some((m) => m.switched)).toBe(true));
    expect(metas(ws, 'account_switch').find((m) => m.switched)).toMatchObject({ reason: 'needs_relogin', accountId: CODEX_PRIMARY_ID, fromAccountId: SECOND, tool: 'codex' });
    expect(readToolSignedOut('codex', HOME)[SECOND]).toBeDefined();
  });

  it('an ordinary failed turn on a signed-in account moves nothing', async () => {
    const { ws, child } = startCodexPane(CODEX_PRIMARY_ID);
    emit(child, { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', dc_tool: 'codex', session_id: 's' });
    await new Promise((r) => setTimeout(r, 50));
    expect(metas(ws, 'account_switch')).toEqual([]);
    expect(readToolSignedOut('codex', HOME)).toEqual({});
  });

  it('with one Codex account nothing moves and nothing is probed', async () => {
    writeFileSync(codexAccountsFile(HOME), JSON.stringify({ accounts: [{ id: CODEX_PRIMARY_ID, email: 'o@example.test', planType: 'plus', addedAt: 0 }] }));
    recordCodexUsage(CODEX_PRIMARY_ID, windows(99, 30), new Date().toISOString(), 'session', HOME);
    const { ws, child } = startCodexPane(CODEX_PRIMARY_ID);
    say(ws, 'hello');
    await vi.waitFor(() => expect(child.stdin.write.mock.calls.some(([c]) => String(c).includes('hello'))).toBe(true));
    expect(metas(ws, 'account_switch').filter((m) => m.switched)).toEqual([]);
    expect(probes).toEqual([]);
  });
});
