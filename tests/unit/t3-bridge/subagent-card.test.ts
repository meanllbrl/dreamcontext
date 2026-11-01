/**
 * TABLO row 41: a Codex or Antigravity sub-agent reads as Claude's does. One card with its
 * prompt, its own steps under it (never flat in the chat), its result; its turn never ends the
 * chat's turn; its steps land where the drill-in reads them.
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToWire, type WireFrame } from '../../../src/lib/t3-bridge/to-wire.js';
import { appendSubagentStep, readSubagentLog } from '../../../src/lib/t3-bridge/subagent-log.js';
import { parseTranscriptHistory } from '../../../src/lib/transcript-history.js';

const MAIN = 'pane-1';
const CHILD = 'child-thread-1';

function wire(steps: Array<[string, WireFrame]> = []) {
  return new ToWire({ tool: 'codex', model: 'm', cwd: '/p', permissionMode: 'auto', threadId: MAIN, onSidechain: (id, f) => { steps.push([id, f]); } });
}
const ev = (w: ToWire, e: Record<string, unknown>): WireFrame[] => w.translate(e as never, 1000);
const turnItem = (item: Record<string, unknown>) => ({ type: 'turn_item.updated', turnItem: { threadId: MAIN, nativeItemRef: null, title: null, ...item } });
const running = (threadId?: string) => ({ type: 'provider_turn.updated', ...(threadId ? { threadId } : {}), providerTurn: { status: 'running' } });
const sub = (status: string, extra: Record<string, unknown> = {}) => turnItem({ id: 'sub-1', type: 'subagent', subagentId: 'node-1', status, title: '/root/context_check', prompt: '', childThreadId: null, result: null, ...extra });

describe('a sub-agent card on a bridge tool', () => {
  it('opens one Agent card with task_started, then fills the prompt when the tool tells it', () => {
    const w = wire();
    ev(w, running());
    const first = ev(w, sub('running'));
    const started = first.find((f) => f.type === 'system' && f.subtype === 'task_started')!;
    expect(started).toMatchObject({ description: 'context check', task_type: 'local_agent', tool_use_id: 'toolu_sub-1' });
    expect(String(started.task_id)).toMatch(/^t3-[0-9a-f]{20}$/);
    expect(first.filter((f) => f.type === 'assistant')).toHaveLength(1);
    // The prompt arrives on a later update (Codex sends it empty first): the card is re-announced.
    const filled = ev(w, sub('running', { prompt: 'Say what is in your context.', childThreadId: CHILD }));
    expect(filled.find((f) => f.subtype === 'task_started')).toMatchObject({ prompt: 'Say what is in your context.', task_id: started.task_id });
  });

  it("keeps the sub-agent's steps off the chat and on its card", () => {
    const steps: Array<[string, WireFrame]> = [];
    const w = wire(steps);
    ev(w, running());
    const taskId = ev(w, sub('running', { childThreadId: CHILD })).find((f) => f.subtype === 'task_started')!.task_id;
    // Its turn starting is not a turn of the chat.
    expect(ev(w, running(CHILD))).toEqual([]);
    const call = ev(w, turnItem({ id: 'c-1', threadId: CHILD, type: 'command_execution', status: 'running', input: 'ls' }));
    expect(call).toEqual([expect.objectContaining({ type: 'system', subtype: 'task_progress', task_id: taskId, description: 'Bash ls', last_tool_name: 'Bash' })]);
    ev(w, turnItem({ id: 'c-1', threadId: CHILD, type: 'command_execution', status: 'completed', input: 'ls', output: 'a.txt', exitCode: 0 }));
    // Its words: progress on the card, never an assistant frame in the chat.
    const said = ev(w, turnItem({ id: 'c-2', threadId: CHILD, type: 'assistant_message', status: 'completed', streaming: false, text: 'There is a brain.\nMore.' }));
    expect(said.every((f) => f.type === 'system')).toBe(true);
    expect(said[0]).toMatchObject({ summary: 'There is a brain.' });
    expect(steps.map(([id]) => id)).toEqual([taskId, taskId, taskId]);
    expect(steps.every(([, f]) => f.parent_tool_use_id === 'toolu_sub-1')).toBe(true);
  });

  it('takes the prompt from the sub-agent\'s own first message (Antigravity)', () => {
    const w = wire();
    ev(w, running());
    ev(w, sub('running', { prompt: 'Run invoke_subagent?', childThreadId: CHILD }));
    const out = ev(w, turnItem({ id: 'u-1', threadId: CHILD, type: 'user_message', status: 'completed', text: 'Check the brain.' }));
    expect(out.find((f) => f.subtype === 'task_started')).toMatchObject({ prompt: 'Check the brain.' });
    // Nothing overwrites it afterwards.
    expect(ev(w, sub('running', { prompt: 'Something else', childThreadId: CHILD })).find((f) => f.subtype === 'task_started')).toBeUndefined();
  });

  it("a sub-agent's turn ending does not end the chat's turn; the card closes with its result", () => {
    const w = wire();
    w.providerThreadId = 'pt-main';
    ev(w, running());
    ev(w, sub('running', { childThreadId: CHILD }));
    expect(ev(w, { type: 'turn.terminal', providerThreadId: 'pt-child', status: 'completed', failure: null })).toEqual([]);
    expect(w.busy).toBe(true);
    const done = ev(w, sub('completed', { childThreadId: CHILD, result: 'Yes, a brain.' }));
    expect(done.find((f) => f.subtype === 'task_notification')).toMatchObject({ status: 'completed', summary: 'Yes, a brain.' });
    const result = done.find((f) => f.type === 'user')!;
    expect(JSON.stringify(result)).toContain('Yes, a brain.');
    expect(result.parent_tool_use_id).toBeNull();
    expect(ev(w, { type: 'turn.terminal', providerThreadId: 'pt-main', status: 'completed', failure: null }).find((f) => f.type === 'result')).toBeTruthy();
  });

  it('a card that ends after the chat turn did opens no turn (Antigravity runs on)', () => {
    const w = wire();
    w.providerThreadId = 'pt-main';
    ev(w, running());
    ev(w, sub('running', { childThreadId: CHILD }));
    ev(w, { type: 'turn.terminal', providerThreadId: 'pt-main', status: 'completed', failure: null });
    const late = ev(w, sub('completed', { childThreadId: CHILD, result: 'done' }));
    expect(late.some((f) => f.type === 'system' && f.subtype === 'init')).toBe(false);
    expect(late.some((f) => f.subtype === 'task_notification')).toBe(true);
  });

  it('holds a step that comes before its card, and Antigravity\'s idle closes the card', () => {
    const w = wire();
    ev(w, running());
    // ACP sends the sub-agent's prompt on its own thread before the card exists.
    expect(ev(w, turnItem({ id: 'u-1', threadId: CHILD, type: 'user_message', status: 'completed', text: 'List the folders.' }))).toEqual([]);
    ev(w, { type: 'subagent.updated', subagent: { id: 'node-1', prompt: 'Run invoke_subagent?', title: null, childThreadId: CHILD, result: null } });
    const first = ev(w, sub('pending', { prompt: 'Run invoke_subagent?', childThreadId: CHILD }));
    const started = first.filter((f) => f.subtype === 'task_started');
    expect(started[started.length - 1]).toMatchObject({ prompt: 'List the folders.' });
    ev(w, sub('running', { childThreadId: CHILD }));
    const done = ev(w, sub('idle', { childThreadId: CHILD, result: 'Folders: .claude' }));
    expect(done.find((f) => f.subtype === 'task_notification')).toMatchObject({ status: 'completed', summary: 'Folders: .claude' });
  });

  it("a sub-agent's question still reaches the owner", () => {
    const w = wire();
    ev(w, running());
    ev(w, sub('running', { childThreadId: CHILD }));
    const ask = ev(w, turnItem({ id: 'q-1', threadId: CHILD, type: 'user_input_request', status: 'pending', requestId: 'r1', questions: [{ id: 'a', question: 'Go?', header: 'Go', options: [{ label: 'Yes' }, { label: 'No' }] }] }));
    expect(ask[0]).toMatchObject({ type: 'control_request', request: { tool_name: 'AskUserQuestion' } });
  });

  it('without a thread id every item is the chat\'s (older callers)', () => {
    const w = new ToWire({ tool: 'codex', model: 'm', cwd: '/p', permissionMode: 'auto' });
    ev(w, running());
    const out = ev(w, turnItem({ id: 'c-1', threadId: CHILD, type: 'command_execution', status: 'running', input: 'ls' }));
    expect(out[0]).toMatchObject({ type: 'assistant' });
  });
});

describe('the drill-in file', () => {
  let home = '';
  afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); });

  it('replays a step log for its own project only', () => {
    home = mkdtempSync(join(tmpdir(), 'dc-sublog-'));
    const proj = join(home, 'proj');
    mkdirSync(proj);
    const thread = '019a1990-b2ef-7bf2-a592-ba5c2ac51a09';
    appendSubagentStep(home, thread, proj, 't3-abc', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } });
    appendSubagentStep(home, thread, proj, 't3-abc', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.txt' }] }] } });
    const raw = readSubagentLog(home, thread, 't3-abc', proj)!;
    const items = parseTranscriptHistory(raw, { sidechain: true });
    expect(items).toEqual([expect.objectContaining({ kind: 'tool', name: 'Bash', status: 'done' })]);
    expect(readSubagentLog(home, thread, 't3-abc', join(home, 'other'))).toBeNull();
    expect(readSubagentLog(home, '../etc', 't3-abc', proj)).toBeNull();
    expect(readSubagentLog(home, thread, '../x', proj)).toBeNull();
  });

  it('never follows a link', () => {
    home = mkdtempSync(join(tmpdir(), 'dc-sublog-'));
    const proj = join(home, 'proj');
    mkdirSync(proj);
    const outside = join(home, 'outside.jsonl');
    writeFileSync(outside, JSON.stringify({ type: 'dc_subagent', cwd: proj }) + '\n');
    const dir = join(home, '.dreamcontext', 't3', 'subagents', 'thread-1');
    mkdirSync(dir, { recursive: true });
    symlinkSync(outside, join(dir, 'agent-t3-x.jsonl'));
    expect(readSubagentLog(home, 'thread-1', 't3-x', proj)).toBeNull();
  });
});

describe("Antigravity's quota reply", () => {
  it('is read as a limit with the reset it names, not as a turn that went through', async () => {
    const { antigravityQuotaReply } = await import('../../../src/lib/t3-bridge/to-wire.js');
    const now = Date.UTC(2026, 10, 2);
    expect(antigravityQuotaReply('Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 6 days, 17 hours.', now))
      .toEqual({ resetsAtMs: now + (6 * 24 + 17) * 3_600_000 });
    expect(antigravityQuotaReply('The usage limit reached a new high', now)).toBeNull();
    const w = new ToWire({ tool: 'antigravity', model: 'm', cwd: '/p', permissionMode: 'auto' });
    w.translate({ type: 'provider_turn.updated', providerTurn: { status: 'running' } } as never, now);
    w.translate({ type: 'turn_item.updated', turnItem: { id: 'a', type: 'assistant_message', status: 'completed', streaming: false, text: 'Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 2 hours.' } } as never, now);
    const result = w.translate({ type: 'turn.terminal', status: 'completed', failure: null } as never, now).find((f) => f.type === 'result')!;
    expect(result.dc_limit).toEqual({ resetsAtMs: now + 2 * 3_600_000 });
  });
});

describe("the tool's own plan", () => {
  it('is drawn as a plan card with its markdown, updated in place, and closed with the turn', () => {
    const w = new ToWire({ tool: 'codex', model: 'm', cwd: '/p', permissionMode: 'plan', threadId: MAIN });
    w.translate({ type: 'provider_turn.updated', providerTurn: { status: 'running' } } as never, 1);
    const plan = (markdown: string) => w.translate({ type: 'plan.updated', plan: { id: 'p1', threadId: MAIN, kind: 'proposed_plan', status: 'active', markdown } } as never, 1);
    const first = plan('1. Blue lid');
    expect(first[0]).toMatchObject({ message: { content: [{ type: 'tool_use', id: 'toolu_plan_p1', name: 'ExitPlanMode', input: { plan: '1. Blue lid' } }] } });
    expect(plan('1. Blue lid\n2. Ship')[0]).toMatchObject({ message: { content: [{ id: 'toolu_plan_p1', input: { plan: '1. Blue lid\n2. Ship' } }] } });
    const end = w.translate({ type: 'turn.terminal', status: 'completed', failure: null } as never, 2);
    expect(JSON.stringify(end[0])).toContain('toolu_plan_p1');
    expect(end[end.length - 1]!.type).toBe('result');
  });
});
