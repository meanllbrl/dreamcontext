/**
 * Who is asking (plan uye-bildirim K3 "Identity", criterion 4's whoAmI table): a binding the
 * server wrote counts only for the process it names (same pid AND start time), reached as the
 * caller itself (bridge) or an ancestor (hook), in the same project, with the hook reporting the
 * binding's CURRENT conversation id. Nothing in the environment is read. A stand-in process table
 * plays `ps`; the bindings live in a temp home.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ANCESTRY, realProcSys, whoAmI, type ProcSys } from '../../src/lib/grants/binding.js';
import { addConversationId, writeBinding } from '../../src/lib/grants/store.js';
import type { Binding } from '../../src/lib/grants/types.js';

const PROJECT = '/work/acme';
const CLAUDE_PID = 500;
const STARTED = 'Tue Nov 10 22:01:00 2026';
let home: string;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-grants-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const binding = (over: Partial<Binding> = {}): Binding => ({
  pid: CLAUDE_PID, startedAt: STARTED, pin: 'pin-scout', project: PROJECT, crew: 'member', member: 'scout',
  conversationIds: ['conv-1'], writtenAt: Date.now(), ...over,
});

/** A process table: `parents` maps pid → parent pid, `starts` pid → start time. */
function procs(selfPid: number, parents: Record<number, number>, starts: Record<number, string> = { [CLAUDE_PID]: STARTED }, projects = [PROJECT, '/work/other']): ProcSys {
  return {
    selfPid,
    parentOf: (pid) => parents[pid] ?? null,
    startTimeOf: (pid) => starts[pid] ?? null,
    realpath: (p) => (projects.includes(p) ? p : p === '/work/acme-link' ? PROJECT : null),
  };
}

/** The measured chain: the hook's parent IS the spawned claude. */
const hookUnderClaude = (selfPid = 900) => procs(selfPid, { [selfPid]: CLAUDE_PID, [CLAUDE_PID]: 400, 400: 1 });

describe('whoAmI in the hook', () => {
  it('a hook under the bound process, reporting its current conversation id: the binding', () => {
    writeBinding(binding(), { home });
    expect(whoAmI({ conversationId: 'conv-1', project: PROJECT }, hookUnderClaude(), { home })).toMatchObject({ pin: 'pin-scout', member: 'scout' });
    // Through a shell in between, and with the project reached by a link.
    const viaShell = procs(901, { 901: 650, 650: CLAUDE_PID, [CLAUDE_PID]: 1 });
    expect(whoAmI({ conversationId: 'conv-1', project: '/work/acme-link' }, viaShell, { home })?.pid).toBe(CLAUDE_PID);
  });

  it('a forged environment with no binding: nothing', () => {
    writeBinding(binding(), { home });
    expect(whoAmI({ conversationId: 'conv-forged', project: PROJECT }, hookUnderClaude(), { home })).toBeNull();
    expect(whoAmI({ project: PROJECT }, hookUnderClaude(), { home })).toBeNull();
  });

  it('the bound conversation id reported from a process not under the bound pid: nothing', () => {
    writeBinding(binding(), { home });
    const elsewhere = procs(902, { 902: 600, 600: 1 }, { [CLAUDE_PID]: STARTED, 600: STARTED });
    expect(whoAmI({ conversationId: 'conv-1', project: PROJECT }, elsewhere, { home })).toBeNull();
  });

  it('a claude started under a bound process, with its own conversation id: nothing', () => {
    writeBinding(binding(), { home });
    const nested = procs(903, { 903: 700, 700: CLAUDE_PID, [CLAUDE_PID]: 1 });
    expect(whoAmI({ conversationId: 'conv-nested', project: PROJECT }, nested, { home })).toBeNull();
  });

  it('a reused pid with another start time: nothing', () => {
    writeBinding(binding(), { home });
    const reused = procs(904, { 904: CLAUDE_PID, [CLAUDE_PID]: 1 }, { [CLAUDE_PID]: 'Wed Nov 11 09:00:00 2026' });
    expect(whoAmI({ conversationId: 'conv-1', project: PROJECT }, reused, { home })).toBeNull();
    const unreadable = procs(904, { 904: CLAUDE_PID, [CLAUDE_PID]: 1 }, {});
    expect(whoAmI({ conversationId: 'conv-1', project: PROJECT }, unreadable, { home })).toBeNull();
  });

  it('another project\'s binding: nothing', () => {
    writeBinding(binding({ project: '/work/other' }), { home });
    expect(whoAmI({ conversationId: 'conv-1', project: PROJECT }, hookUnderClaude(), { home })).toBeNull();
    expect(whoAmI({ conversationId: 'conv-1', project: '/work/unknown' }, hookUnderClaude(), { home })).toBeNull();
  });

  it('after the conversation id rotates, the new one matches once the next init is read, the old one no longer', () => {
    writeBinding(binding(), { home });
    expect(whoAmI({ conversationId: 'conv-2', project: PROJECT }, hookUnderClaude(), { home })).toBeNull();
    addConversationId(CLAUDE_PID, 'conv-2', { home });
    expect(whoAmI({ conversationId: 'conv-2', project: PROJECT }, hookUnderClaude(), { home })?.pin).toBe('pin-scout');
    expect(whoAmI({ conversationId: 'conv-1', project: PROJECT }, hookUnderClaude(), { home })).toBeNull();
  });

  it('the parent walk is bounded', () => {
    writeBinding(binding(), { home });
    const parents: Record<number, number> = {};
    let pid = 1000;
    for (let i = 0; i < MAX_ANCESTRY; i += 1) { parents[pid] = pid + 1; pid += 1; }
    parents[pid] = CLAUDE_PID;
    expect(whoAmI({ conversationId: 'conv-1', project: PROJECT }, procs(1000, parents), { home })).toBeNull();
  });

  it('a stale binding of a dead process under the same conversation does not hide the live one', () => {
    writeBinding(binding({ pid: 777, startedAt: 'Mon Nov  9 08:00:00 2026', writtenAt: Date.now() + 60_000 }), { home });
    writeBinding(binding(), { home });
    expect(whoAmI({ conversationId: 'conv-1', project: PROJECT }, hookUnderClaude(), { home })?.pid).toBe(CLAUDE_PID);
  });
});

describe('whoAmI in the bridge', () => {
  it('the bound bridge process itself: the binding', () => {
    writeBinding(binding({ crew: 'child' }), { home });
    const self = procs(CLAUDE_PID, { [CLAUDE_PID]: 1 });
    expect(whoAmI({ project: PROJECT }, self, { home, mode: 'bridge' })?.crew).toBe('child');
    expect(whoAmI({ conversationId: 'conv-1', project: PROJECT }, self, { home, mode: 'bridge' })?.pid).toBe(CLAUDE_PID);
    expect(whoAmI({ conversationId: 'conv-other', project: PROJECT }, self, { home, mode: 'bridge' })).toBeNull();
  });

  it('a t3-chat an agent started itself (forged environment, no binding): nothing', () => {
    writeBinding(binding(), { home });
    expect(whoAmI({ conversationId: 'conv-1', project: PROJECT }, procs(778, { 778: CLAUDE_PID }), { home, mode: 'bridge' })).toBeNull();
  });

  it('the bound pid reused by another process: nothing', () => {
    writeBinding(binding(), { home });
    const reused = procs(CLAUDE_PID, {}, { [CLAUDE_PID]: 'Wed Nov 11 09:00:00 2026' });
    expect(whoAmI({ project: PROJECT }, reused, { home, mode: 'bridge' })).toBeNull();
  });
});

describe('realProcSys', () => {
  it('off macOS every read is null, so nothing is ever allowed', () => {
    const sys = realProcSys('linux');
    expect(sys.parentOf(process.pid)).toBeNull();
    expect(sys.startTimeOf(process.pid)).toBeNull();
    expect(sys.realpath('/')).toBeNull();
    writeBinding(binding(), { home });
    expect(whoAmI({ conversationId: 'conv-1', project: PROJECT }, sys, { home })).toBeNull();
  });
});
