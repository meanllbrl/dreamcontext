/** TABLO row 11: a bridge chat's edits are checked as Claude's are, and a type error at the end of the turn sends it on once. */
import { describe, expect, it } from 'vitest';
import { BrainContext, stopBlockReason, type HookRunner } from '../../../src/lib/t3-bridge/context.js';

describe('edit checks on the bridge', () => {
  it('runs the PostToolUse hook for an edit and carries what it said into the next turn, once', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const run: HookRunner = async (name, input) => {
      calls.push([name, input]);
      if (name === 'post-tool-use') return JSON.stringify({ hookSpecificOutput: { additionalContext: 'Type error in a.ts:3' } });
      return '';
    };
    const brain = new BrainContext({ cwd: '/tmp/x-no-brain', env: {}, run });
    brain.edited('thread-1', 'src/a.ts');
    await brain.drain();
    brain.turnEnded('thread-1', null, '');
    await brain.drain();
    expect(calls[0]).toEqual(['post-tool-use', expect.objectContaining({ tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' }, session_id: 'thread-1' })]);
    const ctx = await brain.prompt('next', 'thread-1');
    expect(ctx.find((c) => c.key === 'dreamcontext-checks')?.text).toBe('Type error in a.ts:3');
    expect((await brain.prompt('again', 'thread-1')).find((c) => c.key === 'dreamcontext-checks')).toBeUndefined();
  });

  it('a Stop block sends the turn on once, and the continuation\'s Stop does not block again', async () => {
    const stops: Array<Record<string, unknown>> = [];
    const run: HookRunner = async (name, input) => {
      if (name !== 'stop') return '';
      stops.push(input);
      return input.stop_hook_active ? '' : JSON.stringify({ decision: 'block', reason: 'Type errors remain in a.ts' });
    };
    const brain = new BrainContext({ cwd: '/tmp/x-no-brain', env: {}, run });
    const blocks: string[] = [];
    brain.onStopBlock = (r) => { blocks.push(r); };
    brain.turnEnded('t', null, '');
    await brain.drain();
    brain.turnEnded('t', null, '');
    await brain.drain();
    expect(blocks).toEqual(['Type errors remain in a.ts']);
    expect(stops.map((s) => s.stop_hook_active)).toEqual([false, true]);
  });

  it('reads only a real block answer', () => {
    expect(stopBlockReason('{"decision":"block","reason":"x"}\n')).toBe('x');
    expect(stopBlockReason('{"hookSpecificOutput":{}}')).toBeNull();
    expect(stopBlockReason(null)).toBeNull();
  });
});
