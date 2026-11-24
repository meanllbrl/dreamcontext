/**
 * New work on a big idle Super child (plan super-cocuk-tasarruf D2; criteria 4 and 6): the send
 * route reads the pane's current conversation and decides one `[dreamcontext]` line; the window
 * puts it ahead of the text, as ONE user frame, only when it delivers a new turn.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverToChat } from '../../dashboard/src/components/sleepy/chat/postToSession';
import type { ChatSession } from '../../dashboard/src/components/sleepy/chatSession';
import { runWindowVerb, type WindowVerbDeps, type WindowTab } from '../../dashboard/src/components/sleepy/windowVerbs.js';
import { sendLeadFor } from '../../src/server/routes/super.js';
import { writeHandoffRecord, writeTabHandoff } from '../../src/lib/context-watch.js';
import { recordAgentSession } from '../../src/lib/agent-session-map.js';

const LEAD = '[dreamcontext] This session is at ~300k context tokens.';

function fake(state: { busy?: boolean; asking?: boolean }) {
  const s = { busy: !!state.busy, asking: !!state.asking, send: vi.fn(), steer: vi.fn(() => true), enqueue: vi.fn() };
  return s as typeof s & ChatSession;
}

describe('deliverToChat with a lead', () => {
  it('idle: the line, a blank line, then the text, as one frame, answered sent', () => {
    const s = fake({});
    expect(deliverToChat(s, 'Add the footer.', LEAD)).toBe('sent');
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.send).toHaveBeenCalledWith(`${LEAD}\n\nAdd the footer.`);
  });

  it('busy (steered) and asking (queued): the text alone', () => {
    const busy = fake({ busy: true });
    expect(deliverToChat(busy, 'Add the footer.', LEAD)).toBe('steered');
    expect(busy.steer).toHaveBeenCalledWith('Add the footer.');
    const asking = fake({ asking: true });
    expect(deliverToChat(asking, 'Add the footer.', LEAD)).toBe('queued');
    expect(asking.enqueue).toHaveBeenCalledWith('Add the footer.', { steerWhenPossible: true });
  });

  it('no lead: byte-identical to before', () => {
    const s = fake({});
    deliverToChat(s, 'Add the footer.');
    expect(s.send).toHaveBeenCalledWith('Add the footer.');
  });
});

describe('the window send verb passes the lead and says whether it rode', () => {
  const tab = (sid: string): WindowTab => ({ sid, tab: sid, title: sid, kind: 'chat', busy: false, asking: false, dormant: false });
  const deps = (send: WindowVerbDeps['send']): WindowVerbDeps => ({
    self: 'super-1', window: 'Main', panes: [{ id: 'p1', tabs: ['super-1', 'child-1'], active: 'super-1' }], activePaneId: 'p1',
    tabs: [tab('super-1'), tab('child-1')], openNew: vi.fn(async () => 'x'), split: vi.fn(), join: vi.fn(), focus: vi.fn(),
    setMode: vi.fn(() => 'now' as const), setModel: vi.fn(() => true), setEffort: vi.fn(() => true), send, close: vi.fn(),
  });

  it('sent with a lead: lead true; steered: no lead flag; no lead arg: none passed', async () => {
    const sent = vi.fn(() => 'sent' as const);
    expect(await runWindowVerb(deps(sent), 'send', { tab: 'child-1', text: 'hi', lead: LEAD })).toEqual({ ok: true, result: { tab: 'child-1', delivered: 'sent', lead: true } });
    expect(sent).toHaveBeenCalledWith('child-1', 'hi', LEAD);
    const steered = vi.fn(() => 'steered' as const);
    expect(await runWindowVerb(deps(steered), 'send', { tab: 'child-1', text: 'hi', lead: LEAD })).toEqual({ ok: true, result: { tab: 'child-1', delivered: 'steered' } });
    const plain = vi.fn(() => 'sent' as const);
    expect(await runWindowVerb(deps(plain), 'send', { tab: 'child-1', text: 'hi' })).toEqual({ ok: true, result: { tab: 'child-1', delivered: 'sent' } });
    expect(plain).toHaveBeenCalledWith('child-1', 'hi', undefined);
  });
});

describe('sendLeadFor (the route\'s decision, read from the pane\'s current conversation)', () => {
  const CHILD = '33333333-4444-5555-6666-777777777777';
  const LIVE = '55555555-6666-7777-8888-999999999999';
  let home: string;
  let projectRoot: string;
  let contextRoot: string;
  const savedHome = process.env.HOME;

  beforeAll(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-send-lead-home-')));
    process.env.HOME = home;
  });
  afterAll(() => {
    process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });
  beforeEach(() => {
    projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-send-lead-proj-')));
    contextRoot = join(projectRoot, '_dream_context');
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    writeFileSync(join(contextRoot, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], multiProduct: false, setupVersion: '1', contextHandoff: { enabled: true } }));
    rmSync(join(home, '.claude'), { recursive: true, force: true });
  });
  const conversation = (id: string, tokens: number) => {
    const dir = join(home, '.claude', 'projects', '-orbit');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify({ type: 'assistant', message: { usage: { cache_read_input_tokens: tokens } } })}\n`);
  };

  it('a Claude task child at 300k: the tasks handoff line; under 250k: none', () => {
    conversation(CHILD, 300_000);
    const line = sendLeadFor(contextRoot, CHILD, { task: 'orbit-checkout' }, false);
    expect(line).toContain('dreamcontext tasks handoff orbit-checkout --done');
    conversation(CHILD, 200_000);
    expect(sendLeadFor(contextRoot, CHILD, { task: 'orbit-checkout' }, false)).toBeNull();
  });

  it('reads the pane\'s CURRENT conversation (rotated), not its first one', () => {
    conversation(CHILD, 600_000);
    conversation(LIVE, 40_000);
    recordAgentSession(contextRoot, CHILD, LIVE);
    expect(sendLeadFor(contextRoot, CHILD, {}, false)).toBeNull();
  });

  it('none for --keep, a bridge child, Eco off on the pane, or a pending record', () => {
    conversation(CHILD, 300_000);
    expect(sendLeadFor(contextRoot, CHILD, {}, true)).toBeNull();
    expect(sendLeadFor(contextRoot, CHILD, { tool: 'codex' }, false)).toBeNull();
    expect(sendLeadFor(contextRoot, CHILD, {}, false)).toContain('`HANDOFF:`');
    writeHandoffRecord(contextRoot, CHILD, { task: 'orbit-checkout', title: 'Orbit', at: new Date().toISOString(), contextTokens: 300_000, fromSession: CHILD, tab: CHILD });
    expect(sendLeadFor(contextRoot, CHILD, {}, false)).toBeNull();
    rmSync(join(contextRoot, 'state', '.handoff-requests'), { recursive: true, force: true });
    writeTabHandoff(contextRoot, CHILD, { enabled: false, chosen: true });
    expect(sendLeadFor(contextRoot, CHILD, {}, false)).toBeNull();
  });
});
