/**
 * A bridge tool's failed turn is said in the pane (2026-11-11): a Codex limit refusal used to end
 * the turn in silence, and the owner read Claude's limit, the only one on screen, as the reason.
 */
import { describe, expect, it } from 'vitest';
import { failureNotice } from '../../../src/lib/t3-bridge/stdio.js';

const failed = (result: unknown, extra: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'error_during_execution', is_error: true, result, session_id: 's1', dc_tool: 'codex', ...extra });
const textOf = (f: Record<string, unknown> | null) => ((f?.message as { content: Array<{ text: string }> }).content[0]!.text);

describe('failureNotice', () => {
  it('says a Codex refusal as a synthetic line, in Codex\'s own words', () => {
    const msg = 'You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Nov 24th, 2026 7:09 PM.';
    const n = failureNotice(failed(msg, { dc_limit: { resetsAtMs: null } }), 'Codex', '');
    expect(n).toMatchObject({ type: 'assistant', parent_tool_use_id: null, session_id: 's1', message: { role: 'assistant', model: '<synthetic>' } });
    expect(textOf(n)).toBe(msg);
  });

  it('names the tool when its words do not', () => {
    expect(textOf(failureNotice(failed('stream disconnected before completion'), 'Codex', ''))).toBe('Codex: stream disconnected before completion');
    expect(textOf(failureNotice(failed('RESOURCE_EXHAUSTED'), 'Antigravity', ''))).toBe('Antigravity: RESOURCE_EXHAUSTED');
  });

  it('stays quiet for a success, a Stop, a sub-agent, an empty failure, or words already shown', () => {
    expect(failureNotice({ type: 'result', is_error: false, result: 'done' }, 'Codex', '')).toBeNull();
    expect(failureNotice(failed('Interrupted', { terminal_reason: 'aborted' }), 'Codex', '')).toBeNull();
    expect(failureNotice(failed('cancelled', { terminal_reason: 'aborted' }), 'Codex', '')).toBeNull();
    expect(failureNotice(failed('boom', { parent_tool_use_id: 'tu1' }), 'Codex', '')).toBeNull();
    expect(failureNotice(failed(''), 'Codex', '')).toBeNull();
    expect(failureNotice(failed(undefined), 'Codex', '')).toBeNull();
    expect(failureNotice(failed('Usage Limit Reached'), 'Antigravity', 'Usage Limit Reached\n\nYou have reached your quota.')).toBeNull();
    expect(failureNotice({ type: 'assistant', is_error: true, result: 'x' }, 'Codex', '')).toBeNull();
  });
});
