/**
 * A Super can give its child a claude.ai connector (owner 2026-11-14: `super state` listed no
 * Notion, `--mcp notion` was refused, the child parked on an `mcp` card). Root cause: a lean child
 * spawns with `--strict-mcp-config`, which drops every connector; the fix lists connectors by
 * short name, records their URLs from live readings, and lets a lean child keep exactly the
 * named ones through Claude Code's `allowedMcpServers` (by URL) instead of strict.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectorRowsOf, connectorUrlsPath, readConnectorUrls, recordConnectorUrls } from '../../src/lib/mcp-connectors.js';
import { connectorAlias } from '../../src/lib/mcp-wire.js';
import { childMcpNeedingSignIn, connectorOnAccount, connectorRulesFor, knownConnectors, leanAllowlist } from '../../src/lib/super/lean-mcp.js';
import { findServer, isConnectorAlias, missingRow } from '../../dashboard/src/components/sleepy/chat/mcpRows.js';
import type { McpLiveServer, McpOverview } from '../../dashboard/src/lib/mcpWire.js';

const row = (name: string, url: string, status = 'connected') => ({ name, status, scope: 'claudeai', source: 'claudeai', config: { type: 'claudeai-proxy', url, id: 'mcpsrv_x' } });

describe('connector short names', () => {
  it('claude.ai names map to a-z0-9 slugs; anything else is not a connector', () => {
    expect(connectorAlias('claude.ai Notion')).toBe('notion');
    expect(connectorAlias('claude.ai Google Calendar')).toBe('google-calendar');
    expect(connectorAlias('claude.ai Claude Docs')).toBe('claude-docs');
    expect(connectorAlias('claude.ai monday.com')).toBe('monday-com');
    expect(connectorAlias('claude.ai Fathom – Your Meeting Intelligence Layer').length).toBeLessThanOrEqual(40);
    expect(connectorAlias('posthog')).toBe('');
    expect(connectorAlias('plugin:vercel:vercel')).toBe('');
  });

  it('a local server keeps its name; a clashing connector becomes claudeai-<alias>; so does the second of two twins', () => {
    const urls = { acc: { 'claude.ai Notion': { url: 'https://mcp.notion.com/mcp', at: 1 }, 'claude.ai Fathom': { url: 'https://f.example/mcp', at: 1 },
      'claude.ai Kb': { url: 'https://a.example/mcp', at: 1 }, 'claude.ai KB': { url: 'https://b.example/mcp', at: 1 } } };
    const m = knownConnectors(['fathom'], urls);
    expect(m.get('notion')?.name).toBe('claude.ai Notion');
    expect(m.get('claudeai-fathom')?.name).toBe('claude.ai Fathom');
    expect(m.has('fathom')).toBe(false);
    expect([m.get('kb')?.name, m.get('claudeai-kb')?.name].sort()).toEqual(['claude.ai KB', 'claude.ai Kb']);
  });
});

describe('connector URLs from live readings', () => {
  it('records the claude.ai rows 0600, replaces the account on a new list, keeps it when the list did not load', () => {
    const home = mkdtempSync(join(tmpdir(), 'dc-conn-'));
    expect(recordConnectorUrls('acc', [row('claude.ai Notion', 'https://mcp.notion.com/mcp'), { name: 'posthog', status: 'connected', scope: 'user', config: { url: 'https://x' } }], home, 1000)).toBe(true);
    expect(readConnectorUrls(home)).toEqual({ acc: { 'claude.ai Notion': { url: 'https://mcp.notion.com/mcp', at: 1000 } } });
    expect(statSync(connectorUrlsPath(home)).mode & 0o777).toBe(0o600);
    // No claude.ai row at all: the list did not load, the last one stays.
    expect(recordConnectorUrls('acc', [{ name: 'posthog', scope: 'user' }], home, 2000)).toBe(false);
    expect(Object.keys(readConnectorUrls(home).acc)).toEqual(['claude.ai Notion']);
    // A new list replaces it (Notion removed on claude.ai).
    recordConnectorUrls('acc', [row('claude.ai Gmail', 'https://gmailmcp.googleapis.com/mcp/v1')], home, 3000);
    expect(Object.keys(readConnectorUrls(home).acc)).toEqual(['claude.ai Gmail']);
  });

  it('only https URLs without spaces or wildcards are kept', () => {
    expect(connectorRowsOf([row('claude.ai A', 'http://a.example'), row('claude.ai B', 'https://b.example/*'), row('claude.ai C', 'https://c.example/mcp')])).toEqual([{ name: 'claude.ai C', url: 'https://c.example/mcp' }]);
    expect(connectorRowsOf([{ name: 'x', scope: 'user' }])).toBeNull();
  });
});

describe('a lean child given a connector', () => {
  const connectors = knownConnectors([], {
    a: { 'claude.ai Notion': { url: 'https://mcp.notion.com/mcp', at: 1 } },
    b: { 'claude.ai Notion': { url: 'https://mcp.notion.com/mcp?b', at: 1 }, 'claude.ai Slack': { url: 'https://mcp.slack.com/mcp', at: 1 } },
  });

  const read = new Set(['a', 'b']);
  it('takes its own account URL, else another account\'s (a list read without it may have it since); the promise reads connectorOnAccount', () => {
    expect(connectorRulesFor(['notion', 'posthog'], connectors, 'b', read)).toEqual([{ alias: 'notion', name: 'claude.ai Notion', url: 'https://mcp.notion.com/mcp?b' }]);
    expect(connectorRulesFor(['slack'], connectors, 'c', read)[0].url).toBe('https://mcp.slack.com/mcp');
    expect(connectorRulesFor(['slack'], connectors, 'a', read)[0].url).toBe('https://mcp.slack.com/mcp');
    expect(connectorOnAccount(connectors.get('slack')!, 'a', read)).toBe('no');
    expect(connectorOnAccount(connectors.get('slack')!, 'b', read)).toBe('yes');
    expect(connectorOnAccount(connectors.get('slack')!, 'c', read)).toBe('unknown');
  });

  it('the allowlist names its files\' servers and each connector URL, nothing else', () => {
    expect(leanAllowlist(['posthog', 'playwright', 'posthog'], [{ url: 'https://mcp.notion.com/mcp' }])).toEqual({
      allowedMcpServers: [{ serverName: 'posthog' }, { serverName: 'playwright' }, { serverUrl: 'https://mcp.notion.com/mcp' }],
    });
  });

  it('a connector needing sign-in is named by its short name', () => {
    const cache = { a: { cells: { 'claude.ai Notion|claudeai': { status: 'needs-auth' } } }, b: { cells: { 'claude.ai Slack|claudeai': { status: 'connected' } } } };
    expect(childMcpNeedingSignIn(['notion', 'slack'], connectors, cache)).toEqual(['notion']);
  });
});

describe('the mcp card reads a connector by its short name', () => {
  const live = (name: string, home: McpLiveServer['home'], status: McpLiveServer['status'] = 'connected'): McpLiveServer => ({ name, home, status, transport: 'http' });

  it('notion finds the claude.ai Notion row, never a local server named otherwise', () => {
    const servers = [live('posthog', 'computer'), live('claude.ai Notion', 'claudeai')];
    expect(findServer('notion', servers)?.name).toBe('claude.ai Notion');
    expect(isConnectorAlias('claudeai-notion', servers[1])).toBe(true);
    expect(isConnectorAlias('notion', live('notion-x', 'computer'))).toBe(false);
  });

  it('a connector this chat lacks says where it signs in, never Settings → MCP', () => {
    const overview = { servers: [], live: [{ name: 'claude.ai Notion', home: 'claudeai', transport: 'http' }],
      cells: { 'claude.ai Notion|claudeai': { acc: { status: 'needs-auth' } } } } as unknown as Pick<McpOverview, 'servers' | 'live' | 'cells'>;
    expect(missingRow('notion', overview, 'acc')).toEqual({ text: 'claude.ai connector · needs your sign-in on claude.ai', signIn: false, home: 'claudeai' });
    const ok = { ...overview, cells: { 'claude.ai Notion|claudeai': { acc: { status: 'connected' } } } } as typeof overview;
    expect(missingRow('notion', ok, 'acc').text).toBe('claude.ai connector · this chat was started without it');
    // Multi-account: this chat's account read its list without Notion, or Notion failed there.
    const absent = { ...overview, cells: { 'claude.ai Notion|claudeai': { acc: { status: 'absent' }, other: { status: 'connected' } } } } as unknown as typeof overview;
    expect(missingRow('notion', absent, 'acc').text).toBe("claude.ai connector · not on this chat's account: connect it on claude.ai");
    const failed = { ...overview, cells: { 'claude.ai Notion|claudeai': { acc: { status: 'failed' } } } } as unknown as typeof overview;
    expect(missingRow('notion', failed, 'acc').text).toBe("claude.ai connector · failed on this chat's account");
  });
});
