import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTypedTurns } from '../../src/lib/sleep-packet.js';
import {
  foldErrorLine, knownIssuesText, readToolErrorTally, renderRepeatedErrors, repeatedErrors, tallyToolErrors,
  toolErrorTallyFile, toolErrorsOf, writeToolErrorTally, type ToolErrorTally,
} from '../../src/lib/sleep-learns.js';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'dc-repeated-errors-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

/** The real transcript shape: a `user` record holding a `tool_result`, NOT marked as an error. */
function toolResult(text: string, at: string, isError?: boolean): string {
  return JSON.stringify({
    type: 'user', timestamp: at,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: text, ...(isError ? { is_error: true } : {}) }] },
  });
}

const empty = (): ToolErrorTally => ({ version: 1, lines: {} });

describe('repeated tool errors (criterion 17, D16a)', () => {
  it('zsh:1: and (eval):1: spellings of command-not-found fold to one line', () => {
    expect(foldErrorLine('(eval):1: command not found: timeout')).toBe('command not found: timeout');
    expect(foldErrorLine('zsh:1: command not found: timeout')).toBe('command not found: timeout');
    expect(foldErrorLine('Exit code 1\nError: ENOENT /Users/robin/orchard/a.ts line 42')).toBe('Error: ENOENT <path> line #');
  });

  it('a not-marked tool_result saying command not found is read; a plain result is not', () => {
    const rec = JSON.parse(toolResult('ok\n(eval):1: command not found: timeout', '2026-11-03T10:00:00Z'));
    expect(toolErrorsOf(rec)).toEqual([{ at: '2026-11-03T10:00:00Z', line: 'command not found: timeout' }]);
    expect(toolErrorsOf(JSON.parse(toolResult('all good', '2026-11-03T10:00:00Z')))).toEqual([]);
    expect(toolErrorsOf(JSON.parse(toolResult('boom', '2026-11-03T10:00:00Z', true)))).toEqual([{ at: '2026-11-03T10:00:00Z', line: 'boom' }]);
  });

  it('the transcript pass returns the errors beside the typed turns', () => {
    const file = join(tmp, 's.jsonl');
    writeFileSync(file, [
      JSON.stringify({ type: 'user', timestamp: '2026-11-03T09:00:00Z', message: { role: 'user', content: 'run the tests' } }),
      toolResult('(eval):1: command not found: timeout', '2026-11-03T09:01:00Z'),
    ].join('\n'));
    const r = readTypedTurns(file, null);
    expect(r.turns.map((t) => t.text)).toEqual(['run the tests']);
    expect(r.errors).toEqual([{ at: '2026-11-03T09:01:00Z', line: 'command not found: timeout' }]);
  });

  it('two sessions on two days: listed with count and sessions; one session twice, or two sessions one day: not', () => {
    const now = new Date('2026-11-05T00:00:00Z');
    const line = 'command not found: timeout';
    let t = tallyToolErrors(empty(), 's1', [{ at: '2026-11-03T09:00:00Z', line }, { at: '2026-11-03T11:00:00Z', line }], now);
    expect(repeatedErrors(t)).toEqual([]);
    t = tallyToolErrors(t, 's2', [{ at: '2026-11-03T15:00:00Z', line }], now);
    expect(repeatedErrors(t)).toEqual([]);
    t = tallyToolErrors(t, 's3', [{ at: '2026-11-04T08:00:00Z', line }], now);
    const rows = repeatedErrors(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ line, days: 2, since: '2026-11-03', known: false });
    expect(rows[0]!.sessions.sort()).toEqual(['s1', 's2', 's3']);
    expect(renderRepeatedErrors(rows).join('\n')).toContain('`command not found: timeout` · 3 sessions on 2 days since 2026-11-03');
  });

  it('a line a Known Issues entry already names is marked; an entry not seen for 45 days is dropped', () => {
    const ctx = join(tmp, '_dream_context');
    mkdirSync(join(ctx, 'core'), { recursive: true });
    writeFileSync(join(ctx, 'core', '2.memory.md'), '# Memory\n\n## Known Issues\n\n- `command not found: timeout` in zsh: use gtimeout.\n\n## Other\n');
    const line = 'command not found: timeout';
    let t = tallyToolErrors(empty(), 'a', [{ at: '2026-09-01T09:00:00Z', line }], new Date('2026-09-01T10:00:00Z'));
    t = tallyToolErrors(t, 'b', [{ at: '2026-09-02T09:00:00Z', line }], new Date('2026-09-02T10:00:00Z'));
    expect(repeatedErrors(t, knownIssuesText(ctx))[0]!.known).toBe(true);
    t = tallyToolErrors(t, '', [], new Date('2026-11-01T00:00:00Z'));
    expect(t.lines).toEqual({});
  });

  it('the tally lives outside the vault and round-trips', () => {
    const home = join(tmp, 'home');
    const file = toolErrorTallyFile(join(tmp, '_dream_context'), home);
    expect(file.startsWith(join(home, '.dreamcontext', 'sleep-tool-errors'))).toBe(true);
    writeToolErrorTally(file, tallyToolErrors(empty(), 's1', [{ at: '2026-11-03T09:00:00Z', line: 'x' }]));
    expect(Object.keys(readToolErrorTally(file).lines)).toEqual(['x']);
  });
});
