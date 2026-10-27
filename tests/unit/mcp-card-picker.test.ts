/**
 * The `/mcp` popover and the `mcp` chat card share one set of rules (task mcp-management W2,
 * `dashboard/src/components/sleepy/chat/mcpRows.ts`): needs-you first, a failed server offers
 * Restart and never a sign-in, the keyboard wraps, and a card reports EXACTLY once.
 */
import { describe, it, expect } from 'vitest';
import {
  actionLabel, allConnected, clearRefused, reportedKey, findServer, mcpReport, nextCardReport, nextIndex, rowAction, sortNeedsYouFirst, statusLabel,
  type CardReportState,
} from '../../dashboard/src/components/sleepy/chat/mcpRows.js';
import type { McpLiveServer } from '../../dashboard/src/lib/mcpWire.js';

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

  it('a card remembers its report by its place in the transcript, not the id the agent chose', () => {
    expect(reportedKey('conv', 'msg-1:2:report-sources')).not.toBe(reportedKey('conv', 'msg-9:0:report-sources'));
  });
});
