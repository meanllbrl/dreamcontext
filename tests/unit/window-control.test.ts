/**
 * Window control: a chat's own agent drives the window showing it (`dreamcontext window …`).
 *
 * Server: a token names ONE chat's socket; a verb goes down it and only that socket's answer
 * settles it. Route: every argument is validated before anything is sent. Surface: verbs
 * resolve tabs by id, default to the calling chat, never restart a chat mid-turn, and refuse
 * to close the caller or a working chat without --force.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  mintWindowToken, sendWindowCommand, deliverWindowResult, channelFor, setWindowControlBase, resetWindowControl,
} from '../../src/lib/window-control.js';
import { pickWindowArgs } from '../../src/server/routes/window-control.js';
import { windowEnv, callWindow } from '../../src/cli/commands/window.js';
import { CHAT_SURFACE_BRIEFING } from '../../src/server/chat-surface.js';
import { runWindowVerb, type WindowVerbDeps, type WindowTab } from '../../dashboard/src/components/sleepy/windowVerbs';

describe('window-control relay (one token, one socket)', () => {
  beforeEach(() => resetWindowControl());

  it('injects no env until the server port is known, then a loopback URL + token', () => {
    expect(mintWindowToken({ send: () => true }).env).toEqual({});
    setWindowControlBase('http://127.0.0.1:4173');
    const m = mintWindowToken({ send: () => true });
    expect(m.env).toEqual({ DREAMCONTEXT_WINDOW_URL: 'http://127.0.0.1:4173', DREAMCONTEXT_WINDOW_TOKEN: m.token });
  });

  it('sends the verb down the chat socket and settles on that socket\'s answer only', async () => {
    const frames: Array<Record<string, unknown>> = [];
    const a = mintWindowToken({ send: (f) => { frames.push(f); return true; } });
    const b = mintWindowToken({ send: () => true });
    const p = sendWindowCommand(a.token, 'state', {});
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ subtype: 'window_command', verb: 'state', args: {} });
    const id = frames[0].id as string;
    expect(deliverWindowResult(b.token, id, { ok: true, result: 'forged' })).toBe(false);
    expect(deliverWindowResult(a.token, id, { ok: true, result: { panes: [] } })).toBe(true);
    await expect(p).resolves.toEqual({ ok: true, result: { panes: [] } });
  });

  it('answers no_window for an unknown token, a closed socket, or a chat that ended mid-wait', async () => {
    await expect(sendWindowCommand('f'.repeat(48), 'state', {})).resolves.toEqual({ ok: false, error: 'no_window' });
    const closed = mintWindowToken({ send: () => false });
    await expect(sendWindowCommand(closed.token, 'state', {})).resolves.toEqual({ ok: false, error: 'no_window' });
    const live = mintWindowToken({ send: () => true });
    const p = sendWindowCommand(live.token, 'state', {});
    live.release();
    await expect(p).resolves.toEqual({ ok: false, error: 'no_window' });
    expect(channelFor(live.token)).toBeNull();
  });

  it('times out to no_window when the window never answers', async () => {
    vi.useFakeTimers();
    try {
      const m = mintWindowToken({ send: () => true });
      const p = sendWindowCommand(m.token, 'state', {}, { timeoutMs: 50 });
      vi.advanceTimersByTime(60);
      await expect(p).resolves.toEqual({ ok: false, error: 'no_window' });
    } finally { vi.useRealTimers(); }
  });

  it('recognises only well-formed, live tokens', () => {
    const m = mintWindowToken({ send: () => true });
    expect(channelFor(m.token)).toBe(m.token);
    expect(channelFor(undefined)).toBeNull();
    expect(channelFor(['x'])).toBeNull();
    expect(channelFor('nope')).toBeNull();
  });
});

describe('pickWindowArgs (the route validates before sending)', () => {
  it('fills new-chat defaults and refuses bad modes, models and efforts', () => {
    expect(pickWindowArgs('new', {})).toEqual({ mode: 'basic', model: '', effort: '', prompt: '', split: false, terminal: false });
    expect(pickWindowArgs('new', { mode: 'develop', model: 'sonnet', split: true })).toMatchObject({ mode: 'develop', model: 'sonnet', split: true });
    expect(pickWindowArgs('new', { mode: 'assistant' })).toMatch(/mode must be/);
    expect(pickWindowArgs('new', { mode: 'train' })).toMatch(/mode must be/);
    expect(pickWindowArgs('new', { model: 'opus; rm -rf' })).toMatch(/model/);
    expect(pickWindowArgs('new', { effort: 'ultra' })).toMatch(/effort/);
    expect(pickWindowArgs('new', { terminal: true, prompt: 'hi' })).toMatch(/terminal/);
  });

  it('requires the tab where a verb cannot default to the caller', () => {
    expect(pickWindowArgs('focus', {})).toMatch(/name the tab/);
    expect(pickWindowArgs('close', {})).toMatch(/name the tab/);
    expect(pickWindowArgs('send', { text: 'hi' })).toMatch(/name the tab/);
    expect(pickWindowArgs('join', {})).toMatch(/--into/);
    expect(pickWindowArgs('split', { tab: '../etc' })).toMatch(/tab must be/);
    expect(pickWindowArgs('split', {})).toEqual({ tab: undefined });
    expect(pickWindowArgs('mode', { mode: 'plan' })).toEqual({ tab: undefined, mode: 'plan' });
    expect(pickWindowArgs('close', { tab: 'c-1', force: 'yes' })).toEqual({ tab: 'c-1', force: false });
  });
});

describe('the CLI outside a chat', () => {
  it('refuses without the chat env, naming why', async () => {
    expect(windowEnv({})).toBeNull();
    expect(windowEnv({ DREAMCONTEXT_WINDOW_URL: 'http://evil.example:80', DREAMCONTEXT_WINDOW_TOKEN: 'x' })).toBeNull();
    const r = await callWindow('state', {}, {});
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('not_a_chat');
  });

  it('is in the Chat briefing, so every chat agent knows it can', () => {
    expect(CHAT_SURFACE_BRIEFING).toContain('dreamcontext window');
    expect(CHAT_SURFACE_BRIEFING).toMatch(/new \[--split\]/);
  });
});

describe('runWindowVerb (the surface half)', () => {
  const tab = (sid: string, over: Partial<WindowTab> = {}): WindowTab => ({
    sid, tab: `conv-${sid}`, title: sid, kind: 'chat', mode: 'basic', busy: false, asking: false, dormant: false, ...over,
  });
  let deps: WindowVerbDeps;
  beforeEach(() => {
    deps = {
      self: 'a',
      panes: [{ id: 'p1', tabs: ['a', 'b'], active: 'a' }, { id: 'p2', tabs: ['c'], active: 'c' }],
      activePaneId: 'p1',
      tabs: [tab('a', { busy: true }), tab('b', { model: 'sonnet' }), tab('c', { kind: 'shell', mode: undefined })],
      openNew: vi.fn(async () => 'conv-new'),
      split: vi.fn(),
      join: vi.fn(),
      focus: vi.fn(),
      setMode: vi.fn(() => 'after-turn' as const),
      setModel: vi.fn(() => true),
      setEffort: vi.fn(() => true),
      send: vi.fn(() => 'sent' as const),
      close: vi.fn(),
    };
  });

  it('state lists panes left to right and marks the caller', async () => {
    const r = await runWindowVerb(deps, 'state', {});
    expect(r).toEqual({
      ok: true,
      result: {
        panes: [
          { pane: 1, focused: true, tabs: [
            { tab: 'conv-a', title: 'a', kind: 'chat', mode: 'basic', status: 'working', visible: true, self: true },
            { tab: 'conv-b', title: 'b', kind: 'chat', mode: 'basic', model: 'sonnet', status: 'idle' },
          ] },
          { pane: 2, focused: false, tabs: [{ tab: 'conv-c', title: 'c', kind: 'shell', status: 'idle', visible: true }] },
        ],
      },
    });
  });

  it('new opens a chat with its options and returns the tab id', async () => {
    const r = await runWindowVerb(deps, 'new', { mode: 'develop', model: 'opus', effort: 'high', prompt: 'go', split: true, terminal: false });
    expect(deps.openNew).toHaveBeenCalledWith({ prompt: 'go', mode: 'develop', model: 'opus', effort: 'high', split: true, terminal: false });
    expect(r).toEqual({ ok: true, result: { tab: 'conv-new', placed: 'new pane' } });
  });

  it('split defaults to the caller; a lone tab is left alone', async () => {
    await runWindowVerb(deps, 'split', {});
    expect(deps.split).toHaveBeenCalledWith('a', 'p1');
    const r = await runWindowVerb(deps, 'split', { tab: 'conv-c' });
    expect(r).toMatchObject({ ok: true, result: { unchanged: expect.any(String) } });
    expect(deps.split).toHaveBeenCalledTimes(1);
  });

  it('join moves a tab into the pane of --into', async () => {
    await runWindowVerb(deps, 'join', { tab: 'conv-c', into: 'conv-b' });
    expect(deps.join).toHaveBeenCalledWith('c', 'p1');
  });

  it('a mode switch on a busy chat is deferred, and the same mode is not a restart', async () => {
    const r = await runWindowVerb(deps, 'mode', { mode: 'plan' });
    expect(deps.setMode).toHaveBeenCalledWith('a', 'plan');
    expect(r).toMatchObject({ ok: true, result: { when: expect.stringContaining('turn ends') } });
    const same = await runWindowVerb(deps, 'mode', { tab: 'conv-b', mode: 'basic' });
    expect(same).toMatchObject({ ok: true, result: { unchanged: true } });
    expect(deps.setMode).toHaveBeenCalledTimes(1);
  });

  it('model and mode refuse a terminal tab', async () => {
    expect(await runWindowVerb(deps, 'model', { tab: 'conv-c', model: 'opus' })).toMatchObject({ ok: false });
    expect(await runWindowVerb(deps, 'model', { tab: 'conv-b', model: 'opus' })).toMatchObject({ ok: true });
    expect(deps.setModel).toHaveBeenCalledWith('b', 'opus');
  });

  it('close refuses the caller and a working chat without --force', async () => {
    expect(await runWindowVerb(deps, 'close', { tab: 'conv-a' })).toMatchObject({ ok: false, error: expect.stringContaining('cannot close itself') });
    deps.self = 'b';
    expect(await runWindowVerb(deps, 'close', { tab: 'conv-a' })).toMatchObject({ ok: false, error: expect.stringContaining('--force') });
    expect(await runWindowVerb(deps, 'close', { tab: 'conv-a', force: true })).toMatchObject({ ok: true });
    expect(deps.close).toHaveBeenCalledWith('a');
  });

  it('send reaches another tab, never the caller; an unknown tab is named', async () => {
    expect(await runWindowVerb(deps, 'send', { tab: 'conv-a', text: 'x' })).toMatchObject({ ok: false });
    expect(await runWindowVerb(deps, 'send', { tab: 'conv-b', text: 'x' })).toEqual({ ok: true, result: { tab: 'conv-b', delivered: 'sent' } });
    (deps.send as ReturnType<typeof vi.fn>).mockReturnValueOnce('steered');
    expect(await runWindowVerb(deps, 'send', { tab: 'conv-b', text: 'y' })).toEqual({ ok: true, result: { tab: 'conv-b', delivered: 'steered' } });
    expect(await runWindowVerb(deps, 'focus', { tab: 'conv-zzz' })).toMatchObject({ ok: false, error: expect.stringContaining('window state') });
  });
});
