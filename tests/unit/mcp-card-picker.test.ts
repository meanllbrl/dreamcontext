/**
 * The `/mcp` popover and the `mcp` chat card share one set of rules (task mcp-management W2,
 * `dashboard/src/components/sleepy/chat/mcpRows.ts`): needs-you first, a failed server offers
 * Restart and never a sign-in, the keyboard wraps, and a card reports EXACTLY once.
 */
import { describe, it, expect } from 'vitest';
import {
  actionLabel, allConnected, cardPlace, clearRefused, reportedKey, findServer, mcpReport, missingRow, nextCardReport, nextIndex, rowAction, sortNeedsYouFirst, statusLabel,
  type CardReportState,
} from '../../dashboard/src/components/sleepy/chat/mcpRows.js';
import type { McpLiveServer, McpOverview } from '../../dashboard/src/lib/mcpWire.js';
import { mcpNeedingSignIn } from '../../src/lib/super/lean-mcp.js';

const s = (name: string, status: McpLiveServer['status'], extra: Partial<McpLiveServer> = {}): McpLiveServer =>
  ({ name, status, home: 'computer', transport: 'http', ...extra });

describe('the popover', () => {
  it('needs-you first (sign-in before failed), then connecting, then the rest', () => {
    const rows = sortNeedsYouFirst([s('stitch', 'connected'), s('apple-mail', 'failed'), s('zeta', 'pending'), s('posthog', 'needs-auth'), s('gmail', 'needs-auth', { home: 'claudeai' })]);
    expect(rows.map((r) => r.name)).toEqual(['gmail', 'posthog', 'apple-mail', 'zeta', 'stitch']);
  });

  it('a failed stdio row offers Restart, never Sign in; a connector Reconnect; a server Connect', () => {
    expect(rowAction(s('apple-mail', 'failed', { transport: 'stdio' }))).toBe('restart');
    expect(actionLabel('restart')).toBe('Restart');
    expect(rowAction(s('posthog', 'needs-auth'))).toBe('connect');
    expect(rowAction(s('gmail', 'needs-auth', { home: 'claudeai' }))).toBe('reconnect');
    expect(rowAction(s('stitch', 'connected'))).toBeNull();
    expect(rowAction(s('stitch', 'pending'))).toBeNull();
    expect(statusLabel(s('apple-mail', 'failed', { errorKind: 'spawn' }))).toBe('failed to start');
    expect(statusLabel(s('gmail', 'needs-auth', { home: 'claudeai' }))).toBe('expired');
    expect(statusLabel(s('stitch', 'connected', { toolCount: 14 }))).toBe('14 tools');
  });

  it('↑/↓ wrap; other keys keep the row', () => {
    expect(nextIndex(0, 3, 'ArrowUp')).toBe(2);
    expect(nextIndex(2, 3, 'ArrowDown')).toBe(0);
    expect(nextIndex(1, 3, 'x')).toBe(1);
    expect(nextIndex(5, 0, 'ArrowDown')).toBe(0);
  });
});

describe('the card reports exactly once', () => {
  const names = ['posthog', 'claude.ai Gmail'];
  const step = (prev: CardReportState, servers: McpLiveServer[]) => nextCardReport(prev, names, servers);

  it('broken → partly → all green: one `MCP connected` report, and none after', () => {
    let st: CardReportState = { sawBroken: false, reported: null };
    const sends: string[] = [];
    for (const reading of [
      [s('posthog', 'needs-auth'), s('claude.ai Gmail', 'needs-auth', { home: 'claudeai' })],
      [s('posthog', 'connected'), s('claude.ai Gmail', 'needs-auth', { home: 'claudeai' })],
      [s('posthog', 'connected'), s('claude.ai Gmail', 'connected', { home: 'claudeai' })],
      [s('posthog', 'connected'), s('claude.ai Gmail', 'connected', { home: 'claudeai' })],
      [s('posthog', 'needs-auth'), s('claude.ai Gmail', 'connected', { home: 'claudeai' })],
      [s('posthog', 'connected'), s('claude.ai Gmail', 'connected', { home: 'claudeai' })],
    ]) {
      const r = step(st, reading);
      st = r.state;
      if (r.send) sends.push(mcpReport(r.send, names));
    }
    expect(sends).toEqual(['MCP connected: posthog, claude.ai Gmail']);
  });

  it('a transcript re-read with everything already green does not report on its own; one already reported never again', () => {
    expect(step({ sawBroken: false, reported: null }, [s('posthog', 'connected'), s('claude.ai Gmail', 'connected')]).send).toBeNull();
    expect(step({ sawBroken: true, reported: 'skipped' }, [s('posthog', 'connected'), s('claude.ai Gmail', 'connected')]).send).toBeNull();
    // Still connecting is not broken.
    expect(step({ sawBroken: false, reported: null }, [s('posthog', 'pending')]).state.sawBroken).toBe(false);
  });

  it('the skipped report names every server and says which are not connected', () => {
    const t = mcpReport('skipped', names, [s('posthog', 'connected')]);
    expect(t.split('\n')[0]).toBe('MCP skipped: posthog, claude.ai Gmail');
    expect(t).toContain('continue without: claude.ai Gmail');
    expect(allConnected(names, [s('posthog', 'connected')])).toBe(false);
    expect(findServer('PostHog', [s('posthog', 'connected')])?.name).toBe('posthog');
  });
});

describe('end-review fixes', () => {
  it('a refused verb puts its row (or every opening row) back to a button', () => {
    const auth = { posthog: { state: 'opening' as const }, gmail: { state: 'opening' as const }, stitch: { state: 'connected' as const } };
    expect(clearRefused(auth, 'posthog')).toEqual({ posthog: { state: 'failed' }, gmail: { state: 'opening' }, stitch: { state: 'connected' } });
    expect(clearRefused(auth)).toEqual({ posthog: { state: 'failed' }, gmail: { state: 'failed' }, stitch: { state: 'connected' } });
  });

  it('a card\'s place survives a replay (new item ids, same texts); a re-sent id is a new card', () => {
    const card = (id: string) => '```dream-view\n' + JSON.stringify({ type: 'mcp', id, servers: ['posthog'] }) + '\n```';
    const live = [
      { id: 'item-1', kind: 'user', text: 'go' },
      { id: 'item-2', kind: 'text', text: `need it\n\n${card('connect-x')}` },
      { id: 'item-3', kind: 'user', text: 'MCP connected: posthog' },
      { id: 'item-4', kind: 'text', text: `expired again\n\n${card('connect-x')}` },
    ];
    const replayed = live.map((it, i) => ({ ...it, id: `hist-${40 + i}` }));
    expect(cardPlace(live, 'item-2', 'connect-x')).toBe(cardPlace(replayed, 'hist-41', 'connect-x'));
    expect(cardPlace(live, 'item-4', 'connect-x')).toBe(cardPlace(replayed, 'hist-43', 'connect-x'));
    expect(cardPlace(live, 'item-2', 'connect-x')).not.toBe(cardPlace(live, 'item-4', 'connect-x'));
    expect(reportedKey('conv', 'connect-x#0:1')).not.toBe(reportedKey('conv', 'connect-x#1:1'));
    // After a reload the earlier messages are HISTORY and only the newest are live items: the
    // card reads both, in order, so a re-sent id still counts the restored one.
    const history = replayed.slice(0, 3);
    const items = [{ id: 'item-1', kind: 'text', text: `expired again\n\n${card('connect-x')}` }];
    expect(cardPlace([...history, ...items], 'item-1', 'connect-x')).toBe('connect-x#1');
    expect(cardPlace([...history, ...items], 'hist-41', 'connect-x')).toBe('connect-x#0');
  });
});

describe('a named server the chat does not hold (kitUP 2026-11-09: posthog set up, sign-in expired)', () => {
  const def = (name: string) => ({
    name, home: 'computer' as const, transport: 'http', target: 'mcp.posthog.com', headerKeys: [], envKeys: [],
    imported: true, editedInApp: false, differs: false, removedAtSource: false, key: `${name}|abc`,
  });
  const ov = (cells: McpOverview['cells']): Pick<McpOverview, 'servers' | 'live' | 'cells'> =>
    ({ servers: [def('posthog')], live: [{ name: 'Gmail', home: 'claudeai', transport: 'http' }], cells });

  it('set up and needing a sign-in on this chat\'s account: says so and offers the sign-in, never "add it"', () => {
    const r = missingRow('posthog', ov({ 'posthog|abc': { ouro: { status: 'needs-auth' }, gmail: { status: 'connected' } } }), 'ouro');
    expect(r).toEqual({ text: 'on this computer · needs your sign-in', signIn: true });
    expect(r.text).not.toMatch(/add it/);
  });

  it('no account known: needs-auth somewhere and connected nowhere is a sign-in; connected somewhere is not', () => {
    expect(missingRow('PostHog', ov({ 'posthog|abc': { a: { status: 'needs-auth' }, b: { status: 'unchecked' } } })).signIn).toBe(true);
    expect(missingRow('posthog', ov({ 'posthog|abc': { a: { status: 'needs-auth' }, b: { status: 'connected' } } })).signIn).toBe(false);
  });

  it('set up and fine, but this chat started without it (a Super child gets only its --mcp names)', () => {
    expect(missingRow('posthog', ov({ 'posthog|abc': { ouro: { status: 'connected' } } }), 'ouro'))
      .toEqual({ text: 'on this computer · this chat was started without it', signIn: false });
  });

  it('a claude.ai connector seen in a probe is matched too', () => {
    expect(missingRow('gmail', ov({ 'Gmail|claudeai': { ouro: { status: 'needs-auth' } } }), 'ouro'))
      .toEqual({ text: 'claude.ai connector · needs your sign-in', signIn: true });
  });

  it('set up nowhere: add it; the overview not read yet: only that it is missing here', () => {
    expect(missingRow('linear', ov({}), 'ouro')).toEqual({ text: 'not set up yet: add it in Settings → MCP', signIn: false });
    expect(missingRow('posthog', null)).toEqual({ text: 'not in this chat: see Settings → MCP', signIn: false });
  });
});

describe('the Super learns which servers wait on the owner\'s sign-in (super state / delegate)', () => {
  const cache = {
    ouro: { cells: { 'posthog|c064': { status: 'needs-auth' }, 'stitch|9a1': { status: 'connected' }, 'fathom|11': { status: 'needs-auth' } } },
    gmail: { cells: { 'posthog|c064': { status: 'needs-auth' }, 'fathom|11': { status: 'connected' } } },
  };
  it('needs-auth on some account and connected on none', () => {
    expect(mcpNeedingSignIn(['posthog', 'stitch', 'fathom', 'whatsapp'], cache)).toEqual(['posthog']);
  });
  it('the key\'s name part is matched whole (a name that prefixes another is not it)', () => {
    expect(mcpNeedingSignIn(['post'], cache)).toEqual([]);
    expect(mcpNeedingSignIn([], cache)).toEqual([]);
  });
});
