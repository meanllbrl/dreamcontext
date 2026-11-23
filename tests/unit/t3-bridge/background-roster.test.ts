/**
 * Owner 2026-11-23: a child whose turn ends while its own work still runs is not done. Claude's CLI
 * says so with `system:background_tasks_changed`; a Codex or Antigravity chat says it through the
 * bridge, which sends the same roster for the calls a FINISHED turn left running (a Codex
 * background terminal, a sub-agent Antigravity runs on), and shrinks it when each one ends.
 */
import { describe, expect, it } from 'vitest';
import { ToWire, type WireFrame } from '../../../src/lib/t3-bridge/to-wire.js';

const MAIN = 'pane-1';
const CHILD = 'child-thread-1';
const wire = (tool: 'codex' | 'antigravity' = 'codex') => new ToWire({ tool, model: 'm', cwd: '/p', permissionMode: 'auto', threadId: MAIN });
const ev = (w: ToWire, e: Record<string, unknown>): WireFrame[] => w.translate(e as never, 1000);
const turnItem = (item: Record<string, unknown>) => ({ type: 'turn_item.updated', turnItem: { threadId: MAIN, nativeItemRef: null, title: null, ...item } });
const running = () => ({ type: 'provider_turn.updated', providerTurn: { status: 'running' } });
const end = (status = 'completed') => ({ type: 'turn.terminal', status, failure: null });
const cmd = (status: string, extra: Record<string, unknown> = {}) => turnItem({ id: 'cmd-1', type: 'command_execution', status, input: 'npm test -- --run', ...extra });
const rosters = (frames: WireFrame[]) => frames.filter((f) => f.type === 'system' && f.subtype === 'background_tasks_changed');

describe('the background roster on a bridge tool', () => {
  it('a Codex command a finished turn left running is the roster, sent before the result', () => {
    const w = wire();
    ev(w, running());
    ev(w, cmd('running'));
    const out = ev(w, end());
    const r = rosters(out);
    expect(r).toHaveLength(1);
    expect(r[0].tasks).toEqual([{ task_id: 'toolu_cmd-1', task_type: 'local_bash', description: 'npm test -- --run' }]);
    expect(out.findIndex((f) => f.subtype === 'background_tasks_changed')).toBeLessThan(out.findIndex((f) => f.type === 'result'));
    expect(w.backgroundCount).toBe(1);
  });

  it('its end reports the shell finished and shrinks the roster to empty', () => {
    const w = wire();
    ev(w, running());
    ev(w, cmd('running'));
    ev(w, end());
    const out = ev(w, cmd('completed', { output: 'ok', exitCode: 0 }));
    expect(out.find((f) => f.subtype === 'task_notification')).toMatchObject({ task_id: 'toolu_cmd-1', status: 'completed' });
    expect(rosters(out)).toEqual([expect.objectContaining({ tasks: [] })]);
    expect(w.backgroundCount).toBe(0);
    // A failed one says failed.
    const w2 = wire();
    ev(w2, running());
    ev(w2, cmd('running'));
    ev(w2, end());
    expect(ev(w2, cmd('completed', { exitCode: 1 })).find((f) => f.subtype === 'task_notification')).toMatchObject({ status: 'failed' });
  });

  it('a turn whose calls all ended sends no roster at all', () => {
    const w = wire();
    ev(w, running());
    ev(w, cmd('running'));
    ev(w, cmd('completed', { exitCode: 0 }));
    expect(rosters(ev(w, end()))).toEqual([]);
  });

  it('a stopped or failed turn carries nothing: its calls are cut with it, and the next turn starts clean', () => {
    const w = wire();
    ev(w, running());
    ev(w, cmd('running'));
    expect(rosters(ev(w, end('interrupted')))).toEqual([]);
    ev(w, running());
    expect(rosters(ev(w, end()))).toEqual([]);
    expect(w.backgroundCount).toBe(0);
  });

  it("a sub-agent's own step is never the chat's background work", () => {
    const w = wire('antigravity');
    ev(w, running());
    ev(w, turnItem({ id: 'sub-1', type: 'subagent', subagentId: 'node-1', status: 'running', title: '/root/reviewer', prompt: 'Review', childThreadId: CHILD, result: null }));
    ev(w, turnItem({ id: 'c-1', threadId: CHILD, type: 'command_execution', status: 'running', input: 'ls' }));
    const r = rosters(ev(w, end()));
    // Only the sub-agent itself runs on (Antigravity), as an agent.
    expect(r[0].tasks).toEqual([expect.objectContaining({ task_type: 'local_agent', description: 'reviewer' })]);
    const out = ev(w, turnItem({ id: 'sub-1', type: 'subagent', subagentId: 'node-1', status: 'completed', title: '/root/reviewer', prompt: 'Review', childThreadId: CHILD, result: 'Fine.' }));
    expect(rosters(out)).toEqual([expect.objectContaining({ tasks: [] })]);
    // Its card sent its own end; no second shell notice.
    expect(out.filter((f) => f.subtype === 'task_notification')).toHaveLength(1);
  });

  it("Codex's persistent tool is marked persistent (a watch with no end does not hold the row)", () => {
    const w = wire();
    ev(w, running());
    ev(w, turnItem({ id: 'dyn-1', type: 'dynamic_tool', status: 'running', toolName: 'watch', input: { persistent: true, description: 'watch deploys' } }));
    expect(rosters(ev(w, end()))[0].tasks).toEqual([{ task_id: 'toolu_dyn-1', task_type: 'local_tool', description: 'watch deploys', persistent: true }]);
  });
});
