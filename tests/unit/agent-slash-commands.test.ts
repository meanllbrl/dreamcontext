/**
 * Unit tests for the chat composer's `/` autocomplete helpers
 * (dashboard/src/lib/agentComposer.ts) plus the `slash_commands` field on `system:init`
 * that feeds them (dashboard/src/lib/chatProtocol.ts).
 *
 * The command list is NOT hardcoded anywhere: it is whatever the CLI reported for THAT
 * session — built-ins plus the project's own `.claude/commands/` plus plugin/skill
 * commands — so these tests pin the plumbing and the matching rules, not a fixed menu.
 */
import { describe, it, expect } from 'vitest';
import { slashQueryAt, filterSlashCommands, applySlashCommand } from '../../dashboard/src/lib/agentComposer.js';
import { parseChatLine } from '../../dashboard/src/lib/chatProtocol.js';

describe('slashQueryAt', () => {
  it('a bare "/" is an OPEN menu with an empty query, not a closed one', () => {
    expect(slashQueryAt('/', 1)).toBe('');
  });

  it('returns the partial command name being typed', () => {
    expect(slashQueryAt('/comp', 5)).toBe('comp');
    expect(slashQueryAt('/dream-sync', 11)).toBe('dream-sync');
  });

  it('closes once the command name is settled by a space — arguments are the command\'s business', () => {
    expect(slashQueryAt('/compact now', 12)).toBeNull();
    expect(slashQueryAt('/compact ', 9)).toBeNull();
  });

  it('a slash mid-sentence is just a slash — a command is the WHOLE message', () => {
    expect(slashQueryAt('see src/lib', 11)).toBeNull();
    expect(slashQueryAt('and/or', 6)).toBeNull();
    expect(slashQueryAt('hi\n/compact', 11)).toBeNull();
  });

  it('follows the CARET, not the end of the text — clicking back into a leading token reopens it', () => {
    expect(slashQueryAt('/compact', 3)).toBe('co');
    // Caret parked after a space that follows the token → closed, even though text remains.
    expect(slashQueryAt('/compact extra', 9)).toBeNull();
  });

  it('empty input has no query', () => {
    expect(slashQueryAt('', 0)).toBeNull();
  });
});

describe('filterSlashCommands', () => {
  const COMMANDS = ['clear', 'compact', 'context', 'model', 'dream-sync', 'council'];

  it('an empty query offers everything, in the CLI\'s own order', () => {
    expect(filterSlashCommands(COMMANDS, '')).toEqual(COMMANDS);
  });

  it('prefix matches rank above substring matches', () => {
    // 'co' prefixes compact/context/council; 'clear' does not contain it at all.
    expect(filterSlashCommands(COMMANDS, 'co')).toEqual(['compact', 'context', 'council']);
    // 'sync' only appears INSIDE dream-sync.
    expect(filterSlashCommands(COMMANDS, 'sync')).toEqual(['dream-sync']);
    // 'c' prefixes four; 'dream-sync' only CONTAINS one (its final letter), so it trails.
    expect(filterSlashCommands(COMMANDS, 'c')).toEqual(['clear', 'compact', 'context', 'council', 'dream-sync']);
  });

  it('puts a prefix match ahead of an earlier-listed substring match', () => {
    expect(filterSlashCommands(['dream-sync', 'sync-now'], 'sync')).toEqual(['sync-now', 'dream-sync']);
  });

  it('is case-insensitive both ways', () => {
    expect(filterSlashCommands(['Compact'], 'comp')).toEqual(['Compact']);
    expect(filterSlashCommands(['compact'], 'COMP')).toEqual(['compact']);
  });

  it('returns nothing when nothing matches (the menu then stays closed)', () => {
    expect(filterSlashCommands(COMMANDS, 'zzz')).toEqual([]);
  });
});

describe('applySlashCommand', () => {
  it('replaces the typed token and leaves the caret past the trailing space, ready for arguments', () => {
    expect(applySlashCommand('/comp', 5, 'compact')).toEqual({ text: '/compact ', caret: 9 });
  });

  it('keeps whatever followed the caret', () => {
    expect(applySlashCommand('/co rest of it', 3, 'compact')).toEqual({ text: '/compact  rest of it', caret: 9 });
  });

  it('completes from a bare slash', () => {
    expect(applySlashCommand('/', 1, 'clear')).toEqual({ text: '/clear ', caret: 7 });
  });
});

describe('parseChatLine — system:init carries the session\'s slash commands', () => {
  const init = (extra: Record<string, unknown>) => JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: '11111111-2222-3333-4444-555555555555',
    model: 'claude-opus-4-5-20251101',
    ...extra,
  });

  it('surfaces the list verbatim (no leading slashes — that is the CLI\'s shape)', () => {
    const ev = parseChatLine(init({ slash_commands: ['clear', 'compact', 'dream-sync'] }));
    expect(ev).toMatchObject({ kind: 'init', slashCommands: ['clear', 'compact', 'dream-sync'] });
  });

  it('drops non-string entries rather than letting them reach the menu', () => {
    const ev = parseChatLine(init({ slash_commands: ['clear', 42, null, '', 'compact'] }));
    expect(ev).toMatchObject({ slashCommands: ['clear', 'compact'] });
  });

  it('is undefined when the CLI omits it — an older CLI simply has no menu, not an empty one', () => {
    const ev = parseChatLine(init({}));
    expect(ev && 'slashCommands' in ev ? ev.slashCommands : 'missing').toBeUndefined();
  });
});

// The CLI withholds `system:init` until a turn has started, so a brand-new chat would have
// no menu on the message you most want it for. The server replays the project's last known
// list at connect time as a `_meta` frame; this is that channel.
describe('parseChatLine — _meta:slash_commands (the server\'s cached list, sent at connect)', () => {
  const meta = (commands: unknown) => JSON.stringify({ type: '_meta', subtype: 'slash_commands', commands });

  it('surfaces the cached list as its own event', () => {
    expect(parseChatLine(meta(['clear', 'compact']))).toEqual({ kind: 'slash-commands', commands: ['clear', 'compact'] });
  });

  it('drops non-string entries', () => {
    expect(parseChatLine(meta(['clear', 7, null, '', 'compact']))).toEqual({ kind: 'slash-commands', commands: ['clear', 'compact'] });
  });

  it('an empty or malformed list is ignored, never an empty menu', () => {
    expect(parseChatLine(meta([]))).toEqual({ kind: 'ignored', rawType: '_meta:slash_commands' });
    expect(parseChatLine(meta('nope'))).toEqual({ kind: 'ignored', rawType: '_meta:slash_commands' });
  });

  it('leaves the other _meta subtypes alone', () => {
    expect(parseChatLine(JSON.stringify({ type: '_meta', subtype: 'exit', code: 0 }))).toEqual({ kind: 'meta-exit', code: 0 });
  });
});
