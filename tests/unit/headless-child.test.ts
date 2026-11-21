import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setHeadlessChildStartForTests, startChildHeadless } from '../../src/server/headless-child.js';
import { registerLiveChat, unregisterLiveChat, type LiveChatEntry } from '../../src/server/routes/agent-chat-live.js';

/**
 * A Super's child started by the server when no window is there (plan sirket-yavaslik D12, C6):
 * only a Claude child, the window's fields, the vault's permission switch as the window reads it,
 * a member's crew tied exactly, and a resume of a live child starts nothing.
 */

type StartOpts = Record<string, unknown>;

let dir: string;
let brain: string;
let home: string;
let started: StartOpts[];
let entries: LiveChatEntry[];

const live = (id: string, projectRoot: string): LiveChatEntry => ({
  conversationId: id, projectRoot, busy: true, turnStartedAt: Date.now(), lastTurnEndedAt: null,
  adopt: () => false, supersede: () => () => {}, holder: () => null,
});

/** A start that comes up: it registers the child the way the real spawn does. */
const startsUp = (_ws: unknown, projectRoot: string, opts: StartOpts) => {
  started.push(opts);
  const id = String(opts.sessionId || opts.resumeId);
  const e = live(id, projectRoot);
  entries.push(e);
  registerLiveChat(e);
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-child-')));
  brain = join(dir, '_dream_context');
  home = join(dir, 'home');
  mkdirSync(join(brain, 'state'), { recursive: true });
  mkdirSync(home, { recursive: true });
  started = [];
  entries = [];
});
afterEach(() => {
  _setHeadlessChildStartForTests(null);
  for (const e of entries) unregisterLiveChat(e);
  rmSync(dir, { recursive: true, force: true });
});

const base = { contextRoot: '', mode: 'develop', mcp: [] as string[], member: null as string | null, prompt: 'do the job' };

describe('startChildHeadless', () => {
  it('refuses another tool than Claude, an unknown mode and a new child with no prompt; nothing starts', async () => {
    _setHeadlessChildStartForTests(startsUp as never);
    expect(await startChildHeadless({ ...base, contextRoot: brain, home, tool: 'codex' })).toEqual({ ok: false, why: expect.stringMatching(/codex/) });
    expect((await startChildHeadless({ ...base, contextRoot: brain, home, mode: 'yolo' })).ok).toBe(false);
    expect((await startChildHeadless({ ...base, contextRoot: brain, home, prompt: undefined })).ok).toBe(false);
    expect(started).toHaveLength(0);
  });

  it('a new child comes up with the window\'s fields, in the project the brain belongs to', async () => {
    _setHeadlessChildStartForTests(startsUp as never);
    const r = await startChildHeadless({ ...base, contextRoot: brain, home, model: 'opus', effort: 'high', mcp: ['posthog'] });
    expect(r.ok).toBe(true);
    expect(started).toHaveLength(1);
    const o = started[0];
    expect(o).toMatchObject({ model: 'opus', effort: 'high', mode: 'develop', initialPrompt: 'do the job', leanMcp: ['posthog'], resumeId: '', bypass: false });
    expect(o.sessionId).toBe((r as { sessionId: string }).sessionId);
    expect(o.memberCrew).toBeUndefined();
  });

  it('bypass only when the vault\'s switch says bypass; auto is never bypass', async () => {
    _setHeadlessChildStartForTests(startsUp as never);
    const roster = join(brain, 'state', '.agent-sessions.json');
    writeFileSync(roster, JSON.stringify({ sessions: [], chatPermissionMode: 'auto' }));
    await startChildHeadless({ ...base, contextRoot: brain, home });
    writeFileSync(roster, JSON.stringify({ sessions: [], chatPermissionMode: 'bypass' }));
    await startChildHeadless({ ...base, contextRoot: brain, home });
    expect(started.map((o) => o.bypass)).toEqual([false, true]);
  });

  it('a member\'s child is tied to that member exactly', async () => {
    _setHeadlessChildStartForTests(startsUp as never);
    await startChildHeadless({ ...base, contextRoot: brain, home, member: 'doc' });
    expect(started[0]).toMatchObject({ memberCrew: 'doc', memberCrewCap: ['doc'] });
  });

  it('a resume of a child that is already live starts nothing', async () => {
    _setHeadlessChildStartForTests(startsUp as never);
    const id = '12345678-aaaa-4bbb-8ccc-1234567890ab';
    const e = live(id, dir);
    entries.push(e);
    registerLiveChat(e);
    expect(await startChildHeadless({ ...base, contextRoot: brain, home, prompt: undefined, resumeId: id })).toEqual({ ok: true, sessionId: id });
    expect(started).toHaveLength(0);
  });

  it('a resume goes on with the recorded conversation, no new prompt', async () => {
    _setHeadlessChildStartForTests(startsUp as never);
    const id = '22345678-aaaa-4bbb-8ccc-1234567890ab';
    const r = await startChildHeadless({ ...base, contextRoot: brain, home, prompt: undefined, resumeId: id });
    expect(r).toEqual({ ok: true, sessionId: id });
    expect(started[0]).toMatchObject({ resumeId: id, sessionId: '', initialPrompt: '' });
  });

  it('a child that never comes up, or a start that throws, is a refusal: the caller keeps no_window', async () => {
    _setHeadlessChildStartForTests((() => { /* never registers */ }) as never);
    expect(await startChildHeadless({ ...base, contextRoot: brain, home, waitMs: 300 })).toEqual({ ok: false, why: 'it did not come up in time' });
    _setHeadlessChildStartForTests((() => { throw new Error('boom'); }) as never);
    expect(await startChildHeadless({ ...base, contextRoot: brain, home })).toEqual({ ok: false, why: 'the start failed' });
  });
});
