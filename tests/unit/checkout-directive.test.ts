/**
 * `checkout-directive.ts` — the checkout an agent DECLARES in its own answer.
 *
 * Driven against frames shaped like the ones the chat bridge actually relays, because the
 * whole module is an assertion about that shape: a complete `assistant` frame carries text
 * blocks, a partial one does not, and reading the wrong one applies a directive twice.
 *
 * The property under most pressure here is the REFUSAL to act. This reader runs on every
 * frame of every turn, and a false positive does not degrade the shelf — it points it at a
 * directory the agent never claimed.
 */
import { describe, it, expect } from 'vitest';
import {
  describeCheckoutClaim, describeCheckoutReset, readCheckoutDirective, readEditPaths,
} from '../../src/server/checkout-directive.js';

/** A complete assistant message carrying one text block — the shape the CLI emits per turn. */
const say = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

const fence = (json: string) => `Here is where I am working.\n\n\`\`\`dream-view\n${json}\n\`\`\`\n`;

describe('readCheckoutDirective', () => {
  it('reads a path claim out of a dream-view fence', () => {
    const frame = say(fence('{"type":"checkout","path":"/repos/app/.worktrees/roster"}'));
    expect(readCheckoutDirective(frame)).toEqual({ kind: 'set', dir: '/repos/app/.worktrees/roster' });
  });

  it('reads a withdrawal', () => {
    expect(readCheckoutDirective(say(fence('{"type":"checkout","reset":true}')))).toEqual({ kind: 'reset' });
  });

  it('a payload asking for BOTH resolves to the reset — the half that cannot point anywhere', () => {
    const frame = say(fence('{"type":"checkout","reset":true,"path":"/repos/app"}'));
    expect(readCheckoutDirective(frame)).toEqual({ kind: 'reset' });
  });

  it('the LAST directive in one answer wins', () => {
    const frame = say(
      fence('{"type":"checkout","path":"/repos/app/.worktrees/a"}')
      + fence('{"type":"checkout","reset":true}'),
    );
    expect(readCheckoutDirective(frame)).toEqual({ kind: 'reset' });
  });

  it('ignores every other view type, and prose that merely talks about checkouts', () => {
    expect(readCheckoutDirective(say(fence('{"type":"pin","id":"dev","facts":[]}')))).toBeNull();
    expect(readCheckoutDirective(say(fence('{"type":"progress","task":"my-task"}')))).toBeNull();
    expect(readCheckoutDirective(say('I moved to the worktree at /repos/app/.worktrees/a.'))).toBeNull();
  });

  it('ignores a malformed or half-written block instead of guessing at it', () => {
    expect(readCheckoutDirective(say(fence('{"type":"checkout","path":')))).toBeNull();
    expect(readCheckoutDirective(say(fence('{"type":"checkout"}')))).toBeNull();
    expect(readCheckoutDirective(say(fence('{"type":"checkout","path":""}')))).toBeNull();
    expect(readCheckoutDirective(say(fence('{"type":"checkout","path":42}')))).toBeNull();
    expect(readCheckoutDirective(say(fence('[{"type":"checkout","path":"/repos/app"}]')))).toBeNull();
    // An unterminated fence is not a directive YET — the same block completes a frame later.
    expect(readCheckoutDirective(say('```dream-view\n{"type":"checkout","reset":true}'))).toBeNull();
  });

  it('reads ONLY complete assistant frames, so a streaming delta cannot apply it twice', () => {
    const json = '{"type":"checkout","path":"/repos/app/.worktrees/a"}';
    // The same characters as a partial-message event, and as a tool result.
    expect(readCheckoutDirective({ type: 'stream_event', message: { content: [{ type: 'text', text: fence(json) }] } })).toBeNull();
    expect(readCheckoutDirective({ type: 'user', message: { content: [{ type: 'text', text: fence(json) }] } })).toBeNull();
    expect(readCheckoutDirective(say(fence(json)))).not.toBeNull();
  });

  it('never throws on the frame shapes that are not messages at all', () => {
    for (const frame of [{}, { type: 'assistant' }, { type: 'assistant', message: null },
      { type: 'assistant', message: { content: 'dream-view' } },
      { type: 'assistant', message: { content: [null, 7, { type: 'text' }] } }]) {
      expect(() => readCheckoutDirective(frame as Record<string, unknown>)).not.toThrow();
      expect(readCheckoutDirective(frame as Record<string, unknown>)).toBeNull();
    }
  });
});

describe('the sentence the user is shown', () => {
  it('names the worktree and branch when the claim was accepted', () => {
    const msg = describeCheckoutClaim('/repos/app/.worktrees/roster',
      { branch: 'feat/roster', worktree: true, worktreeName: 'roster' });
    expect(msg).toContain('roster');
    expect(msg).toContain('feat/roster');
  });

  it('falls back to the path for a main checkout, and says so for a detached HEAD', () => {
    expect(describeCheckoutClaim('/repos/app', { branch: 'main', worktree: false, worktreeName: null }))
      .toContain('/repos/app');
    expect(describeCheckoutClaim('/repos/app', { branch: null, worktree: false, worktreeName: null }))
      .toContain('detached');
  });

  it('a REFUSAL is stated, not swallowed — the agent would otherwise keep claiming it', () => {
    const msg = describeCheckoutClaim('/somewhere/else', null);
    expect(msg).toContain('/somewhere/else');
    expect(msg).toMatch(/not applied|not a checkout/);
  });

  it('a withdrawal promises no destination, because a reset does not choose one', () => {
    expect(describeCheckoutReset()).not.toMatch(/project root|main/);
  });
});

/**
 * `readEditPaths` — which frames mean "a file changed", for the warning that fires when the
 * agent never declares anything (src/lib/session-edits.ts).
 *
 * The shapes are the ones measured on this machine, 2026-08-28: `Edit` and `Write` tool_use
 * blocks carrying an absolute `file_path` in their input.
 */
describe('readEditPaths', () => {
  const call = (name: string, input: unknown) => ({
    type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name, input }] },
  });

  it('reads the write tools, each from the field it actually uses', () => {
    expect(readEditPaths(call('Edit', { file_path: '/repo/src/a.ts' }))).toEqual(['/repo/src/a.ts']);
    expect(readEditPaths(call('Write', { file_path: '/repo/src/b.ts' }))).toEqual(['/repo/src/b.ts']);
    expect(readEditPaths(call('MultiEdit', { file_path: '/repo/src/c.ts' }))).toEqual(['/repo/src/c.ts']);
    expect(readEditPaths(call('NotebookEdit', { notebook_path: '/repo/n.ipynb' }))).toEqual(['/repo/n.ipynb']);
  });

  it('ignores the tools that only LOOK at a file — reading across checkouts is ordinary', () => {
    for (const name of ['Read', 'Grep', 'Glob', 'Bash']) {
      expect(readEditPaths(call(name, { file_path: '/repo/src/a.ts' })), name).toEqual([]);
    }
  });

  it('ignores a relative path and a non-string one rather than guessing at a root', () => {
    expect(readEditPaths(call('Edit', { file_path: 'src/a.ts' }))).toEqual([]);
    expect(readEditPaths(call('Edit', { file_path: 42 }))).toEqual([]);
    expect(readEditPaths(call('Edit', null))).toEqual([]);
    expect(readEditPaths(call('Edit', {}))).toEqual([]);
  });

  it('reads every write in one frame, and only from complete assistant frames', () => {
    const many = {
      type: 'assistant',
      message: { content: [
        { type: 'tool_use', id: 'a', name: 'Edit', input: { file_path: '/repo/a.ts' } },
        { type: 'text', text: 'and also' },
        { type: 'tool_use', id: 'b', name: 'Write', input: { file_path: '/repo/b.ts' } },
      ] },
    };
    expect(readEditPaths(many)).toEqual(['/repo/a.ts', '/repo/b.ts']);
    expect(readEditPaths({ ...many, type: 'stream_event' })).toEqual([]);
  });

  it('never throws on the shapes that are not messages at all', () => {
    for (const frame of [{}, { type: 'assistant' }, { type: 'assistant', message: { content: 'x' } },
      { type: 'assistant', message: { content: [null, 3, { type: 'tool_use' }] } }]) {
      expect(readEditPaths(frame as Record<string, unknown>)).toEqual([]);
    }
  });
});
