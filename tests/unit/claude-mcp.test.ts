/**
 * Unit tests for the `/mcp` panel's pure half:
 *   • `parseInitMcpServers` / `canSignIn` / `envForSession` (src/lib/claude-mcp.ts)
 *   • `isMcpCommand` (dashboard/src/lib/agentComposer.ts) — the composer's interception gate.
 *
 * THE FIXTURE IS REAL. Every frame below was captured from CLI 2.1.276 on the machine this was
 * built for, by running the same probe the panel runs. That matters here more than usual,
 * because the whole feature turns on one discovered fact: a session's `system/init` frame
 * carries `mcp_servers: [{ name, status, source }]`, and that — not `claude mcp list` — is
 * what the conversation actually has. The two disagreed about 26 of 32 servers.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  canSignIn, envForSession, parseInitMcpServers, sharedMcpServerNames,
} from '../../src/lib/claude-mcp.js';
import { isMcpCommand } from '../../dashboard/src/lib/agentComposer.js';

/** A real stream, trimmed: hook chatter first, then the init frame, then the result. */
const REAL_STREAM = [
  '{"type":"system","subtype":"hook_started","hook_name":"SessionStart","session_id":"x"}',
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'x',
    mcp_servers: [
      { name: 'plugin:stripe:stripe', status: 'needs-auth', source: 'plugin' },
      { name: 'playwright', status: 'connected', source: 'dynamic' },
      { name: 'designer-pack', status: 'needs-auth', source: 'dynamic' },
      { name: 'claude.ai Figma', status: 'needs-auth', source: 'claudeai' },
      { name: 'claude.ai adspylab', status: 'connected', source: 'claudeai' },
      { name: 'probe-project-scope', status: 'connected', source: 'project' },
    ],
  }),
  '{"type":"result","subtype":"success","num_turns":0,"total_cost_usd":0}',
].join('\n');

describe('parseInitMcpServers', () => {
  it('reads the session\'s own view out of the init frame', () => {
    const rows = parseInitMcpServers(REAL_STREAM);
    expect(rows?.map((r) => r.name)).toEqual([
      'plugin:stripe:stripe', 'playwright', 'designer-pack',
      'claude.ai Figma', 'claude.ai adspylab', 'probe-project-scope',
    ]);
  });

  it('carries the source, which is what decides whether an action is possible', () => {
    const rows = parseInitMcpServers(REAL_STREAM) ?? [];
    expect(rows.find((r) => r.name === 'probe-project-scope')?.source).toBe('project');
    expect(rows.find((r) => r.name === 'designer-pack')?.source).toBe('dynamic');
    expect(rows.find((r) => r.name === 'claude.ai Figma')?.source).toBe('claudeai');
  });

  it('skips the hook chatter and the result frame', () => {
    // The init frame is not the first line of a real run — three hook frames precede it.
    expect(parseInitMcpServers(REAL_STREAM)).toHaveLength(6);
  });

  it('a status or source the engine has not used before is carried, never rounded', () => {
    // The failure this guards: a future CLI inventing a state and the panel drawing it as
    // "Connected" because that was the nearest match.
    const rows = parseInitMcpServers(JSON.stringify({
      type: 'system', subtype: 'init',
      mcp_servers: [{ name: 'future', status: 'reconnecting', source: 'workspace' }],
    }));
    expect(rows?.[0].status).toBe('unknown');
    expect(rows?.[0].statusLabel).toBe('reconnecting');
    expect(rows?.[0].source).toBe('unknown');
    expect(rows?.[0].sourceLabel).toBe('workspace');
  });

  it('a nameless entry is dropped rather than drawn as a blank row', () => {
    const rows = parseInitMcpServers(JSON.stringify({
      type: 'system', subtype: 'init',
      mcp_servers: [{ status: 'connected' }, { name: 'real', status: 'connected', source: 'project' }],
    }));
    expect(rows?.map((r) => r.name)).toEqual(['real']);
  });

  it('NO init frame is null, not an empty list — those are different facts', () => {
    // "We could not read this session" must never be drawn as "you have no servers". A caller
    // that conflated them would tell the user they have nothing when the truth is unknown.
    expect(parseInitMcpServers('')).toBeNull();
    expect(parseInitMcpServers('{"type":"result","subtype":"success"}')).toBeNull();
    expect(parseInitMcpServers('not json at all\nnor this')).toBeNull();
  });

  it('an init frame with an EMPTY list is an empty list — a session really can have none', () => {
    expect(parseInitMcpServers('{"type":"system","subtype":"init","mcp_servers":[]}')).toEqual([]);
  });

  it('an init frame with no mcp field is unreadable, not empty', () => {
    expect(parseInitMcpServers('{"type":"system","subtype":"init","session_id":"x"}')).toBeNull();
  });
});

describe('canSignIn', () => {
  const rows = parseInitMcpServers(REAL_STREAM) ?? [];
  const row = (name: string) => rows.find((r) => r.name === name)!;

  it('offers the sign-in for a server the CLI can name in this account', () => {
    expect(canSignIn(row('claude.ai Figma'))).toBe(true);
    expect(canSignIn(row('plugin:stripe:stripe'))).toBe(true);
  });

  it('REFUSES it for a server handed in by reference', () => {
    // Measured: `claude mcp login designer-pack` under a sandbox answers "No MCP server named
    // designer-pack" — it is invisible to the command. A button there would be a button that
    // cannot work, which is worse than no button.
    expect(canSignIn(row('designer-pack'))).toBe(false);
  });

  it('offers nothing for a server that is already connected', () => {
    expect(canSignIn(row('playwright'))).toBe(false);
    expect(canSignIn(row('probe-project-scope'))).toBe(false);
  });
});

describe('isMcpCommand', () => {
  it('the bare command opens the panel', () => {
    expect(isMcpCommand('/mcp')).toBe(true);
    expect(isMcpCommand('  /mcp \n')).toBe(true);
  });

  it('a message that merely mentions it still reaches the model', () => {
    expect(isMcpCommand('what does /mcp do?')).toBe(false);
    expect(isMcpCommand('explain /mcp')).toBe(false);
  });

  it('a longer command sharing the prefix is not it', () => {
    expect(isMcpCommand('/mcpanel')).toBe(false);
    expect(isMcpCommand('/mcp-servers')).toBe(false);
  });

  it('the other intercepted command is not this one', () => {
    expect(isMcpCommand('/login')).toBe(false);
    expect(isMcpCommand('')).toBe(false);
  });
});

/**
 * The account half. Injectable HOME throughout — the real `~/.claude.json` holds oauthAccount
 * and spend history and is never read or written by a test.
 */
describe('the account a leg runs as', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dc-mcp-home-'));
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('a sandboxed session acts as ITS OWN account — a credential must land where it looks', () => {
    const sandbox = join(home, '.dreamcontext', 'claude-accounts', 'someone-example-com');
    expect(envForSession(sandbox, home)).toEqual({ CLAUDE_CONFIG_DIR: sandbox });
  });

  it('account #0 removes the variable rather than setting it to the real home', () => {
    // Setting it would be equivalent, but REMOVING it is what guarantees an inherited value
    // from a parent process cannot redirect the child.
    expect(envForSession(home, home)).toEqual({ CLAUDE_CONFIG_DIR: undefined });
  });

  it('the shared file names exactly the user-scope servers a sandboxed spawn is handed', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      mcpServers: { playwright: { command: 'npx' }, slack: { command: 'npx' } },
      projects: { '/somewhere': { mcpServers: { posthog: { command: 'npx' } } } },
    }));
    // The PROJECT-scoped server is deliberately absent: only the top-level map is carried.
    expect(sharedMcpServerNames(home).sort()).toEqual(['playwright', 'slack']);
  });

  it('a missing or unreadable config shares nothing, and never throws', () => {
    expect(sharedMcpServerNames(home)).toEqual([]);
    writeFileSync(join(home, '.claude.json'), '{ not json');
    expect(sharedMcpServerNames(home)).toEqual([]);
  });
});
