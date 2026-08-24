/**
 * Reading a checkout move out of the `claude` stream.
 *
 * Every frame in the ENTER/EXIT fixtures below is captured from `~/.claude/projects/**\/*.jsonl`
 * (2026-08-24, two independent real sessions), not inferred from the tool's documentation. The
 * STRUCTURE — field names, nesting, the wording of the result sentence, which half carries the
 * path — is exactly as captured; only the directory names are anonymised, because this repo is
 * public and the second capture came from an unrelated private project. That matters more than usual here: the first design
 * of this reader took the path from the tool CALL, and the captures show why that would have
 * been wrong in half the cases — one session called `EnterWorktree` with `{name}` and the
 * other with `{path}`, and `{name}` is not a path at all.
 *
 * The corresponding rule for changing this file: if the CLI's frame shape changes, capture a
 * new frame and paste it in. Do not adjust the fixture to match the parser.
 */
import { describe, it, expect } from 'vitest';
import { createWorktreeWatcher } from '../../src/server/worktree-frames.js';

/** Captured: a session that CREATED a worktree. `input` is `{name}` — no path anywhere in the
 *  call, which is the whole reason the result is what gets parsed. */
const ENTER_CALL_BY_NAME = {
  type: 'assistant',
  message: {
    content: [{
      type: 'tool_use',
      id: 'toolu_0145ZZYKSPssh8mhug4zqdQE',
      name: 'EnterWorktree',
      input: { name: 'chat-question-bubble-stop' },
      caller: { type: 'direct' },
    }],
  },
};
const ENTER_RESULT_CREATED = {
  type: 'user',
  message: {
    content: [{
      type: 'tool_result',
      tool_use_id: 'toolu_0145ZZYKSPssh8mhug4zqdQE',
      content: 'Created worktree at /Users/dev/projects/acme/.claude/worktrees/'
        + 'chat-question-bubble-stop on branch worktree-chat-question-bubble-stop. The session is '
        + 'now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session '
        + 'to be prompted.',
    }],
  },
};
const CREATED_DIR = '/Users/dev/projects/acme/.claude/worktrees/chat-question-bubble-stop';

/** Captured: a second session that ENTERED an existing checkout, calling with `{path}`. Note
 *  the verb is "Entered", not "Created" — both are moves. */
const ENTER_CALL_BY_PATH = {
  type: 'assistant',
  message: {
    content: [{
      type: 'tool_use',
      id: 'toolu_01RMowQfBpd4RmnKBNTzzamp',
      name: 'EnterWorktree',
      input: { path: '/Users/dev/projects/acme-webhooks' },
      caller: { type: 'direct' },
    }],
  },
};
const ENTER_RESULT_ENTERED = {
  type: 'user',
  message: {
    content: [{
      type: 'tool_result',
      tool_use_id: 'toolu_01RMowQfBpd4RmnKBNTzzamp',
      content: 'Entered worktree at /Users/dev/projects/acme-webhooks on branch '
        + 'feat/inbound-hook. The session is now working in the worktree. Use ExitWorktree '
        + 'to leave mid-session, or exit the session to be prompted.',
    }],
  },
};

const exitCall = (id: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name: 'ExitWorktree', input: {} }] },
});
const exitResult = (id: string) => ({
  type: 'user',
  message: {
    content: [{ type: 'tool_result', tool_use_id: id, content: 'Left the worktree.' }],
  },
});

describe('createWorktreeWatcher', () => {
  it('reads the directory out of a CREATED result, not out of the call', () => {
    const observe = createWorktreeWatcher();
    // The call names a worktree but carries no path — it must not resolve to a move on its own.
    expect(observe(ENTER_CALL_BY_NAME)).toBeNull();
    expect(observe(ENTER_RESULT_CREATED)).toEqual({ kind: 'enter', dir: CREATED_DIR });
  });

  it('reads an ENTERED result too — entering an existing checkout is also a move', () => {
    const observe = createWorktreeWatcher();
    observe(ENTER_CALL_BY_PATH);
    expect(observe(ENTER_RESULT_ENTERED)).toEqual({
      kind: 'enter', dir: '/Users/dev/projects/acme-webhooks',
    });
  });

  it('prefers the toolUseResult sidecar when the frame carries one', () => {
    const observe = createWorktreeWatcher();
    observe(ENTER_CALL_BY_NAME);
    const move = observe({
      ...ENTER_RESULT_CREATED,
      toolUseResult: { worktreePath: '/tmp/sidecar-wins', worktreeBranch: 'b' },
    });
    expect(move).toEqual({ kind: 'enter', dir: '/tmp/sidecar-wins' });
  });

  it('reports an exit', () => {
    const observe = createWorktreeWatcher();
    observe(exitCall('toolu_exit1'));
    expect(observe(exitResult('toolu_exit1'))).toEqual({ kind: 'exit' });
  });

  it('a result with no matching call is ignored — ids are correlated, not guessed', () => {
    const observe = createWorktreeWatcher();
    // No EnterWorktree call was ever seen for this id.
    expect(observe(ENTER_RESULT_CREATED)).toBeNull();
  });

  it('an ERRORED tool moved nothing', () => {
    const observe = createWorktreeWatcher();
    observe(ENTER_CALL_BY_NAME);
    expect(observe({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_0145ZZYKSPssh8mhug4zqdQE',
          is_error: true,
          content: 'Created worktree at /nope on branch x. ',
        }],
      },
    })).toBeNull();
  });

  it('an id is consumed once — a replayed result does not move the session again', () => {
    const observe = createWorktreeWatcher();
    observe(ENTER_CALL_BY_NAME);
    expect(observe(ENTER_RESULT_CREATED)).not.toBeNull();
    expect(observe(ENTER_RESULT_CREATED)).toBeNull();
  });

  it('two watchers do not see each other’s calls', () => {
    const a = createWorktreeWatcher();
    const b = createWorktreeWatcher();
    a(ENTER_CALL_BY_NAME);
    // b never saw the call, so b must not act on the result.
    expect(b(ENTER_RESULT_CREATED)).toBeNull();
    expect(a(ENTER_RESULT_CREATED)).toEqual({ kind: 'enter', dir: CREATED_DIR });
  });

  it('handles a block-array tool_result as well as a string one', () => {
    const observe = createWorktreeWatcher();
    observe(ENTER_CALL_BY_NAME);
    expect(observe({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_0145ZZYKSPssh8mhug4zqdQE',
          content: [{ type: 'text', text: `Created worktree at ${CREATED_DIR} on branch wt. ` }],
        }],
      },
    })).toEqual({ kind: 'enter', dir: CREATED_DIR });
  });

  it('is silent on every ordinary frame, and never throws on a malformed one', () => {
    const observe = createWorktreeWatcher();
    const noise: unknown[] = [
      {},
      { type: 'system', subtype: 'init', slash_commands: ['/x'] },
      { type: 'result', subtype: 'success' },
      { type: 'assistant', message: { content: 'a plain string' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'EnterWorktree' }] } },
      { type: 'assistant', message: null },
      { type: 'user', message: { content: [null, 7, 'x'] } },
      // A Bash call that merely MENTIONS the tool is not the tool.
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'echo EnterWorktree' } }] } },
    ];
    for (const frame of noise) {
      expect(() => observe(frame as Record<string, unknown>)).not.toThrow();
      expect(observe(frame as Record<string, unknown>)).toBeNull();
    }
  });

  it('a result whose text does not name a path yields no move', () => {
    const observe = createWorktreeWatcher();
    observe(ENTER_CALL_BY_NAME);
    expect(observe({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_0145ZZYKSPssh8mhug4zqdQE',
          content: 'The worktree could not be created.',
        }],
      },
    })).toBeNull();
  });
});
