/**
 * Grants at the t3 bridge (uye-bildirim K3, gate G1 for Codex and Antigravity; plan criterion 4).
 *
 * The bridge is its own process (`dreamcontext t3-chat`, spawned by the server like a `claude`
 * child), so it IS the bound process: `whoAmI` in bridge mode finds the binding by its own pid and
 * start time, reading no environment and no argument. Before it asks or denies, its approval
 * handler checks the grant store: a bound bridge with a matching grant allows without asking; a
 * `t3-chat` with a forged environment and no binding gets nothing; plan mode, a question and what
 * `bypassNeedsOwner` names are never answered on a grant. An unattended deny also leaves the
 * pinned refusal frame on the stream K2 reads, so a child stopped there is never silent.
 *
 * The decision is driven through the real handler methods on a stand-in session (no Codex runs).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeSession, bridgeGrantFor, unattendedRefusalFrame, type BridgeGrantDeps } from '../../src/lib/t3-bridge/session.js';
import { bridgeRefusalFrame } from '../../src/lib/assistant/chat-registry.js';
import { listGrants, newGrantId, writeBinding, writeGrant } from '../../src/lib/grants/store.js';
import { realResolver } from '../../src/lib/grants/eligible.js';
import { canonicalInput } from '../../src/lib/grants/canonical.js';
import type { ProcSys } from '../../src/lib/grants/binding.js';
import type { Binding, Grant } from '../../src/lib/grants/types.js';

const BRIDGE = 700;
const STARTED = 'Tue Nov 10 22:10:00 2026';
let home: string;
let project: string;
let beat: string;

const realOr = (p: string): string | null => { try { return realpathSync.native(p); } catch { return null; } };
const procs = (o: { self?: number; starts?: Record<number, string> } = {}): ProcSys => ({
  selfPid: o.self ?? BRIDGE, parentOf: () => 1, startTimeOf: (pid) => (o.starts ?? { [BRIDGE]: STARTED })[pid] ?? null, realpath: realOr,
});
const deps = (over: Partial<BridgeGrantDeps> = {}): BridgeGrantDeps => ({ sys: procs(), resolve: realResolver(), home, roots: () => [project], ...over });

const binding = (over: Partial<Binding> = {}): Binding => ({
  pid: BRIDGE, startedAt: STARTED, pin: 'pin-codex-child', project, crew: 'child', member: 'scout', conversationIds: [], writtenAt: Date.now(), ...over,
});
/** An exact file edit: once and job may take it (a plain shell command takes no job grant). */
const CALL = { get tool_name() { return 'Edit'; }, get input() { return { file_path: join(project, 'notes.txt'), old_string: 'a', new_string: 'b' }; } };
const grant = (over: Partial<Grant> = {}): Grant => ({
  id: newGrantId(over.scope ?? 'job'), scope: 'job', project, pin: 'pin-codex-child', tool: 'Edit', input: canonicalInput('Edit', CALL.input),
  form: 'exact', createdAt: Date.now(), expiresAt: Date.now() + 3_600_000, ...over,
});

/** A stand-in session the real handler methods run on. */
function fakeSession(o: { mode?: string; grants?: BridgeGrantDeps; gateBeat?: string; hidden?: boolean } = {}) {
  const emitted: Array<Record<string, unknown>> = [];
  const s = {
    hidden: o.hidden ? { text: '', finished: Promise.resolve(), finish: () => {}, stopping: false } : null,
    mode: o.mode ?? 'auto',
    bypassAnswered: new Set<string>(),
    answer: vi.fn(async () => null),
    fatal: vi.fn(),
    opts: { tool: 'antigravity', cwd: project, grants: o.grants ?? deps(), emit: (f: Record<string, unknown>) => emitted.push(f), log: () => {}, ...(o.gateBeat ? { gateBeat: o.gateBeat } : {}) },
  };
  return { s, emitted };
}
const proto = BridgeSession.prototype as unknown as Record<string, (this: unknown, ...a: unknown[]) => boolean>;
const request = (req: Record<string, unknown>, id = 'req-1') => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', ...req } });

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-grants-')));
  project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-t3-')));
  beat = join(project, '.beat');
  writeFileSync(beat, '');
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('the bridge decides once, on the same grants', () => {
  it('a bound bridge with a matching grant allows without asking', () => {
    writeBinding(binding(), { home });
    writeGrant(grant(), { home });
    expect(bridgeGrantFor(CALL, { cwd: project, mode: 'auto' }, deps())?.scope).toBe('job');
    const { s } = fakeSession();
    expect(proto.answeredByGrant.call(s, request(CALL))).toBe(true);
    expect(s.answer).toHaveBeenCalledWith('req-1', { behavior: 'allow' });
    expect(s.bypassAnswered.has('req-1')).toBe(true);
  });

  it('a once grant is spent by the one answer that uses it', () => {
    writeBinding(binding(), { home });
    writeGrant(grant({ scope: 'once' }), { home });
    const { s } = fakeSession();
    expect(proto.answeredByGrant.call(s, request(CALL, 'a'))).toBe(true);
    expect(proto.answeredByGrant.call(s, request(CALL, 'b'))).toBe(false);
    expect(listGrants(project, { home })).toEqual([]);
  });

  it('a t3-chat with a forged environment and no binding: nothing', () => {
    writeGrant(grant(), { home });
    process.env.DREAMCONTEXT_MEMBER_CREW = 'scout';
    try {
      expect(bridgeGrantFor(CALL, { cwd: project, mode: 'auto' }, deps())).toBeNull();
    } finally {
      delete process.env.DREAMCONTEXT_MEMBER_CREW;
    }
    // Another bridge's binding is not this process's.
    writeBinding(binding({ pid: 701 }), { home });
    expect(bridgeGrantFor(CALL, { cwd: project, mode: 'auto' }, deps())).toBeNull();
  });

  it('a reused pid with another start time: nothing', () => {
    writeBinding(binding(), { home });
    writeGrant(grant(), { home });
    expect(bridgeGrantFor(CALL, { cwd: project, mode: 'auto' }, deps({ sys: procs({ starts: { [BRIDGE]: 'Wed Nov 11 08:00:00 2026' } }) }))).toBeNull();
  });

  it('never in plan mode, never for a question, never for what bypassNeedsOwner names, never in a hidden turn', () => {
    writeBinding(binding(), { home });
    writeGrant(grant(), { home });
    expect(bridgeGrantFor(CALL, { cwd: project, mode: 'plan' }, deps())).toBeNull();
    expect(bridgeGrantFor({ tool_name: 'AskUserQuestion', input: {} }, { cwd: project, mode: 'auto' }, deps())).toBeNull();
    const guarded = { tool_name: 'Write', input: { file_path: join(home, '.dreamcontext', 'grants', 'once', 'x.json'), content: '{}' } };
    writeGrant(grant({ scope: 'once', tool: 'Write', input: canonicalInput('Write', guarded.input) }), { home });
    expect(bridgeGrantFor(guarded, { cwd: project, mode: 'auto' }, deps())).toBeNull();
    const { s } = fakeSession({ hidden: true });
    expect(proto.answeredByGrant.call(s, request(CALL))).toBe(false);
  });

  it('a call no grant covers goes on to the owner as before', () => {
    writeBinding(binding(), { home });
    writeGrant(grant(), { home });
    const { s } = fakeSession();
    expect(proto.answeredByGrant.call(s, request({ tool_name: 'Bash', input: { command: 'touch other.txt' } }))).toBe(false);
    expect(s.answer).not.toHaveBeenCalled();
  });
});

describe('an unattended deny leaves the refusal frame K2 reads', () => {
  it('the frame is the registry\'s pinned shape, emitted before the deny', () => {
    const input = { file_path: join(home, '.dreamcontext', 'automations.json'), content: '{}' };
    expect(unattendedRefusalFrame('Write', input, 'm', 'tu-1')).toEqual(bridgeRefusalFrame('Write', input, 'm', 'tu-1'));
    expect(unattendedRefusalFrame('Write', input, 'm')).toEqual(bridgeRefusalFrame('Write', input, 'm'));
    const { s, emitted } = fakeSession({ gateBeat: beat });
    const handled = proto.answeredUnattended.call(s, 'req-9', { tool_name: 'Write', input, tool_use_id: 'tu-9' });
    expect(handled).toBe(true);
    expect(emitted).toEqual([bridgeRefusalFrame('Write', input, expect.stringMatching(/needs the owner/) as unknown as string, 'tu-9')]);
    expect(s.answer).toHaveBeenCalledWith('req-9', expect.objectContaining({ behavior: 'deny' }));
  });

  it('an ordinary unattended call is allowed and leaves no frame', () => {
    const { s, emitted } = fakeSession({ gateBeat: beat });
    expect(proto.answeredUnattended.call(s, 'req-10', CALL)).toBe(true);
    expect(emitted).toEqual([]);
    expect(s.answer).toHaveBeenCalledWith('req-10', { behavior: 'allow' });
  });
});
