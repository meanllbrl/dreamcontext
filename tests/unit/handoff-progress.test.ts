import { describe, it, expect } from 'vitest';
import { startHandoffRun, advanceHandoffRun, failHandoffRun, handoffProgressFrame } from '../../src/lib/handoff-progress.js';

const run0 = () => startHandoffRun({ task: 't-slug', title: 'Task title', contextTokens: 482_000, fromSession: 'old-id', now: 1000 });

const init = (id: string) => ({ type: 'system', subtype: 'init', session_id: id });
const result = () => ({ type: 'result', subtype: 'success' });
const assistant = (usage: Record<string, number>, parent: string | null = null) => ({
  type: 'assistant', parent_tool_use_id: parent, message: { role: 'assistant', content: [], usage },
});

describe('handoff progress', () => {
  it('starts in clearing with the handed-off size', () => {
    const r = run0();
    expect(r).toMatchObject({ id: 1000, stage: 'clearing', task: 't-slug', title: 'Task title', contextTokens: 482_000 });
  });

  it('omits a size nobody measured', () => {
    const r = startHandoffRun({ task: 't', title: '', contextTokens: null, fromSession: '' });
    expect(r.contextTokens).toBeUndefined();
    expect(r.title).toBe('t');
  });

  it('clear result first: clearing → resuming → done on the fresh session\'s first answer', () => {
    let r = run0();
    const a = advanceHandoffRun(r, result(), 2);
    expect(a?.stage).toBe('resuming');
    r = a!;
    expect(advanceHandoffRun(r, init('new-id'), 1)).toBeNull();
    const done = advanceHandoffRun(r, assistant({ input_tokens: 3, cache_creation_input_tokens: 20_000, cache_read_input_tokens: 900, output_tokens: 100 }), 1);
    expect(done).toMatchObject({ stage: 'done', postTokens: 21_003 });
  });

  it('new session id first also counts as the clear landing', () => {
    expect(advanceHandoffRun(run0(), init('new-id'), 2)?.stage).toBe('resuming');
  });

  it('an init that still names the OLD conversation is not the clear landing', () => {
    expect(advanceHandoffRun(run0(), init('old-id'), 2)).toBeNull();
  });

  it('the /clear turn\'s result does not finish a run that is already resuming', () => {
    const resuming = advanceHandoffRun(run0(), init('new-id'), 2)!;
    expect(advanceHandoffRun(resuming, result(), 2)).toBeNull();
    expect(advanceHandoffRun(resuming, result(), 1)?.stage).toBe('done');
  });

  it('a sub-agent\'s assistant frame is not the fresh session answering', () => {
    const resuming = advanceHandoffRun(run0(), result(), 2)!;
    expect(advanceHandoffRun(resuming, assistant({ input_tokens: 5 }, 'toolu_1'), 1)).toBeNull();
  });

  it('a finished run never moves again', () => {
    const done = { ...run0(), stage: 'done' as const };
    expect(advanceHandoffRun(done, result(), 1)).toBeNull();
    expect(failHandoffRun(done, 'x')).toBeNull();
  });

  it('fails with the reason', () => {
    expect(failHandoffRun(run0(), 'exited')).toMatchObject({ stage: 'failed', message: 'exited' });
  });

  it('the wire frame keeps the old session id on the server', () => {
    const f = handoffProgressFrame(run0());
    expect(f).toMatchObject({ subtype: 'handoff_progress', id: 1000, stage: 'clearing', task: 't-slug' });
    expect(f).not.toHaveProperty('fromSession');
  });
});
