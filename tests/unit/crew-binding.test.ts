/**
 * The server side of a Super crew process (uye-bildirim K3 "Identity", "Allow once", "Level").
 *
 * The server spawned the process, so it writes who it is: a binding by pid (start time, pin,
 * project, crew, member), the conversation id added at every `init`, removed at exit BEFORE the
 * crew handle goes. The registry is told the process's mode and that it is crew. A crew handle
 * lets the server write its own turn (an Allow once) into a live process with no window, marked
 * as the server's. A narrower member level reaches its running sessions at once.
 *
 * Part one drives crew-binding.ts directly; part two the REAL `startChatSession` with a stand-in
 * `claude` (the telegram-turn harness).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const env = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, realpathSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const home = realpathSync(mkdtempSync(`${tmpdir()}/dc-grants-`));
  process.env.HOME = home;
  return { home };
});

const spawned: Array<{ child: FakeChild }> = [];
class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(() => true), end: vi.fn(), on: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 4261;
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

const { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { startChatSession } = await import('../../src/server/routes/agent-chat.js');
const reg = await import('../../src/lib/assistant/chat-registry.js');
const crew = await import('../../src/server/routes/crew-binding.js');
const grants = await import('../../src/lib/grants/store.js');
const { SUPER_STATE_REL, readSuperState, resetSuperIndex } = await import('../../src/lib/super/store.js');
const { emptySuperState } = await import('../../src/lib/super/types.js');
const { _resetSuperInbox } = await import('../../src/lib/super/inbox.js');
const { levelApplies } = await import('../../src/server/routes/agents.js');
type ProcSys = import('../../src/lib/grants/binding.js').ProcSys;

const STARTED = 'Tue Nov 10 22:20:00 2026';
const sys = (starts: Record<number, string> = { 4261: STARTED, 600: STARTED }): ProcSys => ({
  selfPid: 1, parentOf: () => null, startTimeOf: (pid) => starts[pid] ?? null, realpath: (p) => { try { return realpathSync(p); } catch { return null; } },
});
let project: string;

beforeEach(() => {
  spawned.length = 0;
  project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-hook-')));
  mkdirSync(join(project, '_dream_context', 'state'), { recursive: true });
  rmSync(join(env.home, '.dreamcontext'), { recursive: true, force: true });
  crew._resetCrewSeats();
  // Hermetic: no real login shell is read for a seat's PATH here (its own block below drives it).
  crew._setCrewDeps({ sys: sys(), probePath: async () => null });
  reg._resetChatRegistry();
});
afterEach(() => {
  crew._setCrewDeps(null);
  crew._resetCrewSeats();
  rmSync(project, { recursive: true, force: true });
});

const facts = (over: Partial<Parameters<typeof crew.openCrewSeat>[0]> = {}) => ({
  pid: 600, pin: 'pin-a', projectRoot: project, isSuper: false, superCrew: true, excluded: false, mode: 'auto', ...over,
});

describe('the PATH a crew process really runs with (its login shell\'s)', () => {
  it('reads the PATH after the last mark, ignoring what rc files print around it', () => {
    expect(crew.parseLoginPath('welcome\n__DC_SESSION_PATH__/opt/a/bin:/usr/bin\n')).toBe('/opt/a/bin:/usr/bin');
    expect(crew.parseLoginPath('__DC_SESSION_PATH__/x\nnoise __DC_SESSION_PATH__/y:/usr/bin\nbye')).toBe('/y:/usr/bin');
    expect(crew.parseLoginPath('no mark at all')).toBeNull();
    expect(crew.parseLoginPath('__DC_SESSION_PATH__\n')).toBeNull();
    expect(crew.parseLoginPath('__DC_SESSION_PATH__relative:/usr/bin\n')).toBeNull();
  });

  it('a real login shell started with the process environment reports its PATH', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dc-loginpath-')));
    try {
      const got = await crew.readLoginPath({ file: '/bin/sh', env: { HOME: dir, PATH: `${dir}:/usr/bin:/bin` }, cwd: dir });
      expect(got).not.toBeNull();
      expect(got!.split(':')).toContain(dir);
      expect(await crew.readLoginPath({ file: join(dir, 'no-such-shell'), env: {}, cwd: dir })).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a seat knows the PATH once the read is back, and forgets it when the process exits', async () => {
    let finish: (v: string | null) => void = () => undefined;
    const probePath = vi.fn(() => new Promise<string | null>((r) => { finish = r; }));
    crew._setCrewDeps({ sys: sys(), probePath });
    const probe = { file: '/bin/zsh', env: { PATH: '/srv/bin' }, cwd: project };
    const seat = crew.openCrewSeat(facts({ shellProbe: probe }))!;
    expect(probePath).toHaveBeenCalledWith(probe);
    expect(seat.sessionPath()).toBeNull();
    finish('/Users/x/.nvm/bin:/usr/bin');
    await Promise.resolve(); await Promise.resolve();
    expect(seat.sessionPath()).toBe('/Users/x/.nvm/bin:/usr/bin');
    seat.exited();
    expect(seat.sessionPath()).toBeNull();
    // No probe when the spawn gave none (win32) or the process has no pid.
    probePath.mockClear();
    crew.openCrewSeat(facts({ pid: 602 }));
    crew.openCrewSeat(facts({ pid: undefined, shellProbe: probe }));
    expect(probePath).not.toHaveBeenCalled();
  });
});

describe('who a crew process is (crewKindOf)', () => {
  it('main Super, a member Super, a member\'s child, main\'s child; never a non-crew process', () => {
    expect(crew.crewKindOf({ isSuper: true, superCrew: true, excluded: false })).toEqual({ crew: 'main' });
    expect(crew.crewKindOf({ isSuper: true, superCrew: true, excluded: false, agent: 'scout' })).toEqual({ crew: 'member', member: 'scout' });
    expect(crew.crewKindOf({ isSuper: false, superCrew: true, excluded: false, memberCrew: 'scout' })).toEqual({ crew: 'child', member: 'scout' });
    expect(crew.crewKindOf({ isSuper: false, superCrew: true, excluded: false })).toEqual({ crew: 'child' });
    // The ambiguous mark names no member: never a member binding.
    expect(crew.crewKindOf({ isSuper: false, superCrew: true, excluded: false, memberCrew: '*' })).toEqual({ crew: 'child' });
    expect(crew.crewKindOf({ isSuper: false, superCrew: false, excluded: false })).toBeNull();
    expect(crew.crewKindOf({ isSuper: true, superCrew: true, excluded: true })).toBeNull();
  });
});

describe('the binding lives exactly as long as the process', () => {
  it('written at spawn with what the OS says, the conversation added at init, gone at exit', () => {
    const seat = crew.openCrewSeat(facts({ memberCrew: 'scout' }))!;
    expect(seat.bound).toBe(true);
    expect(grants.readBinding(600)).toMatchObject({ pid: 600, startedAt: STARTED, pin: 'pin-a', project, crew: 'child', member: 'scout', conversationIds: [] });
    seat.init({ type: 'system', subtype: 'init', session_id: 'conv-1', permissionMode: 'auto' });
    // A sub-agent's frame is no rotation.
    seat.init({ type: 'system', subtype: 'init', session_id: 'conv-sub', parent_tool_use_id: 'tu' });
    seat.init({ type: 'system', subtype: 'init', session_id: 'conv-2' });
    expect(grants.readBinding(600)?.conversationIds).toEqual(['conv-1', 'conv-2']);
    seat.exited();
    expect(grants.readBinding(600)).toBeNull();
    expect(() => seat.exited()).not.toThrow();
    expect(crew.liveCrewSeats()).toEqual([]);
  });

  it('no start time from the OS (another platform): no binding, the owner is asked each time', () => {
    crew._setCrewDeps({ sys: sys({}) });
    const seat = crew.openCrewSeat(facts())!;
    expect(seat.bound).toBe(false);
    expect(grants.readBinding(600)).toBeNull();
  });

  it('not a crew process: no seat and no binding', () => {
    expect(crew.openCrewSeat(facts({ superCrew: false }))).toBeNull();
    expect(crew.openCrewSeat(facts({ excluded: true }))).toBeNull();
    expect(grants.readBinding(600)).toBeNull();
  });

  it('a server turn is the server\'s, once', () => {
    const seat = crew.openCrewSeat(facts())!;
    seat.noteServerTurn('The owner allowed exactly this call, once.');
    expect(seat.takeServerTurn('The owner allowed exactly this call, once.')).toBe(true);
    expect(seat.takeServerTurn('The owner allowed exactly this call, once.')).toBe(false);
    expect(seat.takeServerTurn('his own words')).toBe(false);
  });
});

describe('a narrower level reaches the running member now; a wider one at its next start', () => {
  it('moves every running session of that member, in that project, to the narrower mode', () => {
    const setA = vi.fn(() => true);
    const setB = vi.fn(() => true);
    const setOther = vi.fn(() => true);
    crew.openCrewSeat(facts({ pid: 601, pin: 'super-scout', isSuper: true, agent: 'scout', mode: 'auto', setMode: setA }));
    crew.openCrewSeat(facts({ pid: 602, pin: 'child-scout', memberCrew: 'scout', mode: 'bypassPermissions', setMode: setB }));
    crew.openCrewSeat(facts({ pid: 603, pin: 'child-writer', memberCrew: 'writer', mode: 'auto', setMode: setOther }));
    // Balanced → Ask: the chat mode narrows to `default`.
    expect(levelApplies('scout', 'balanced', 'ask', project)).toBe('now');
    expect(setA).toHaveBeenCalledWith('default');
    expect(setB).toHaveBeenCalledWith('default');
    expect(setOther).not.toHaveBeenCalled();
    expect(crew.liveCrewSeats().filter((s) => s.member === 'scout').map((s) => s.mode)).toEqual(['default', 'default']);
  });

  it('widening applies at the next session start and touches nothing running', () => {
    const set = vi.fn(() => true);
    crew.openCrewSeat(facts({ memberCrew: 'scout', mode: 'default', setMode: set }));
    expect(levelApplies('scout', 'ask', 'free', project)).toBe('next_session');
    expect(set).not.toHaveBeenCalled();
  });

  it('a process that cannot take the switch now: next session', () => {
    crew.openCrewSeat(facts({ memberCrew: 'scout', mode: 'bypassPermissions', setMode: () => false }));
    expect(levelApplies('scout', 'free', 'balanced', project)).toBe('next_session');
  });
});

describe('through the real spawn (agent-chat.ts)', () => {
  const SUPER = '11111111-2222-4333-8444-555555555555';
  class FakeWs extends EventEmitter { OPEN = 1; readyState = 1; send = vi.fn(); close = vi.fn(); }
  const frame = (child: FakeChild, f: Record<string, unknown>) => child.stdout.emit('data', Buffer.from(`${JSON.stringify(f)}\n`));
  const userTexts = (child: FakeChild): string[] => child.stdin.write.mock.calls
    .map(([chunk]) => { try { return JSON.parse(String(chunk)); } catch { return null; } })
    .filter((f) => f?.type === 'user')
    .flatMap((f) => (f.message.content as Array<{ text: string }>).map((b) => b.text));

  beforeEach(async () => {
    resetSuperIndex();
    _resetSuperInbox();
    writeFileSync(join(project, '_dream_context', SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER }));
    await readSuperState(join(project, '_dream_context'));
  });
  afterEach(() => { _resetSuperInbox(); });

  it('a Super: bound by its pid, crew in the registry, conversation and mode from init, a crew handle; all gone at exit', async () => {
    const ws = new FakeWs();
    startChatSession(ws as unknown as import('ws').WebSocket, project, {
      bypass: false, sessionId: SUPER, resumeId: '', model: '', effort: '', initialPrompt: '', deferPrompt: false,
      account: '', mode: 'super' as never, vault: 'acme',
    });
    const { child } = spawned[spawned.length - 1];
    expect(grants.readBinding(4261)).toMatchObject({ pid: 4261, startedAt: STARTED, pin: SUPER, project, crew: 'main' });
    expect(reg.getChat(SUPER)?.crew).toBe(true);
    expect(typeof reg.getChat(SUPER)?.permissionMode).toBe('string');

    frame(child, { type: 'system', subtype: 'init', session_id: 'conv-super', permissionMode: 'auto' });
    expect(grants.readBinding(4261)?.conversationIds).toEqual(['conv-super']);
    expect(reg.getChat(SUPER)?.permissionMode).toBe('auto');

    // The server's own turn: written into the process, and never his words.
    const heard: Array<{ text: string; server: boolean }> = [];
    const off = reg.onChatUserSent((sid, text, _source, server) => { if (sid === SUPER) heard.push({ text, server }); });
    const handle = reg.crewHandle(SUPER);
    expect(handle).not.toBeNull();
    const TURN = 'The owner allowed exactly this call, once. Run it unchanged, then go on.';
    expect(handle!.sendServerTurn(TURN)).toBe(true);
    await vi.waitFor(() => expect(userTexts(child).some((t) => t.includes(TURN))).toBe(true), { timeout: 4000 });
    expect(heard.find((h) => h.text === TURN)?.server).toBe(true);
    off();

    child.emit('close', 0);
    expect(grants.readBinding(4261)).toBeNull();
    expect(reg.crewHandle(SUPER)).toBeNull();
    expect(handle!.sendServerTurn(TURN)).toBe(false);
  });

  it('a plain chat: no binding, not crew, no crew handle', () => {
    const ws = new FakeWs();
    startChatSession(ws as unknown as import('ws').WebSocket, project, {
      bypass: false, sessionId: '22222222-2222-4333-8444-555555555555', resumeId: '', model: '', effort: '', initialPrompt: '', deferPrompt: false,
      account: '', mode: 'basic' as never, vault: 'acme',
    });
    expect(grants.readBinding(4261)).toBeNull();
    expect(reg.getChat('22222222-2222-4333-8444-555555555555')?.crew).toBeUndefined();
    expect(reg.crewHandle('22222222-2222-4333-8444-555555555555')).toBeNull();
  });
});
