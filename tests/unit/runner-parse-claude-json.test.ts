/**
 * `parseClaudeJson` keeps the refused calls themselves, not only their count (plan K7): a light
 * run that ended ok while its mode refused what it needed shows the owner WHAT was refused.
 * The envelope shape is the recorded one (Claude Code 2.1.322, a dontAsk run's `result`).
 */
import { describe, it, expect, vi } from 'vitest';

// The runner module reads machine state on load in places: never the developer's own HOME.
vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/dc-routine-needs-`);
});

import { DENIED_INPUT_CAP, MAX_DENIED_CALLS, parseClaudeJson } from '../../src/lib/automations/runner.js';

const envelope = (extra: Record<string, unknown>) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: '2cda39a3-a584-44d4-80ea-a7f82ae7e59f', ...extra,
});

describe('parseClaudeJson: the refused calls', () => {
  it('keeps each denial: a Bash call as its command, another tool as stable-key JSON', () => {
    const r = parseClaudeJson(envelope({
      permission_denials: [
        { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'touch probe.txt', description: 'Create empty probe.txt' } },
        { tool_name: 'Write', tool_use_id: 'toolu_2', tool_input: { file_path: '/tmp/x.md', content: 'hi' } },
      ],
    }));
    expect(r.permissionDenials).toBe(2);
    expect(r.deniedCalls).toEqual([
      { tool: 'Bash', input: 'touch probe.txt' },
      // Keys sorted: the same input always reads the same.
      { tool: 'Write', input: '{"content":"hi","file_path":"/tmp/x.md"}' },
    ]);
  });

  it('caps the list and each input, while the count stays the whole count', () => {
    const many = Array.from({ length: MAX_DENIED_CALLS + 5 }, (_, i) => ({ tool_name: 'Bash', tool_input: { command: `echo ${i}` } }));
    const r = parseClaudeJson(envelope({ permission_denials: many }));
    expect(r.permissionDenials).toBe(MAX_DENIED_CALLS + 5);
    expect(r.deniedCalls).toHaveLength(MAX_DENIED_CALLS);
    expect(r.deniedCalls?.[0]).toEqual({ tool: 'Bash', input: 'echo 0' });

    const long = parseClaudeJson(envelope({ permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'x'.repeat(DENIED_INPUT_CAP + 500) } }] }));
    expect(long.deniedCalls?.[0].input).toHaveLength(DENIED_INPUT_CAP);
  });

  it('an absent or malformed field is an empty list; an entry with no tool name is skipped', () => {
    expect(parseClaudeJson(envelope({})).deniedCalls).toEqual([]);
    expect(parseClaudeJson(envelope({ permission_denials: 'nope' })).deniedCalls).toEqual([]);
    const r = parseClaudeJson(envelope({ permission_denials: [null, 3, { tool_input: { command: 'ls' } }, { tool_name: 'Read' }] }));
    expect(r.permissionDenials).toBe(4);
    expect(r.deniedCalls).toEqual([{ tool: 'Read', input: '' }]);
  });

  it('an unparseable envelope carries no list (nothing was read)', () => {
    const r = parseClaudeJson('not json');
    expect(r.parsed).toBe(false);
    expect(r.deniedCalls).toBeUndefined();
    expect(r.permissionDenials).toBe(0);
  });
});
