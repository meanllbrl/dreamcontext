/**
 * Unit tests for the `/mcp` panel's two halves that can be tested without a CLI:
 *   • `parseMcpListLine` / `parseMcpList` / `parseMcpGetState` (src/lib/claude-mcp.ts) — the
 *     reading of `claude mcp list` and `claude mcp get`, which have no `--json` on this CLI;
 *   • `isMcpCommand` (dashboard/src/lib/agentComposer.ts) — the composer's interception gate.
 *
 * Every listing fixture below is REAL output, captured from CLI 2.1.276 on the machine this
 * was built for (names and hosts left as they came). That matters more than usual here: the
 * parser's two split directions are decided by properties of the real shape — the target
 * always contains `: ` (a URL) while the name may not, and a launch command may contain ` - `
 * while a status never does — so a hand-written fixture that dodged those would prove nothing.
 */
import { describe, it, expect } from 'vitest';
import { parseMcpList, parseMcpListLine, parseMcpGetState } from '../../src/lib/claude-mcp.js';
import { isMcpCommand } from '../../dashboard/src/lib/agentComposer.js';

/** Verbatim `claude mcp list`, trimmed to the shapes that differ from one another. */
const REAL_LIST = `Checking MCP server health…

claude.ai adspylab: https://adspylab.com/mcp - ✔ Connected
claude.ai Vercel: https://mcp.vercel.com - ! Needs authentication
claude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - ✔ Connected
plugin:stripe:stripe: https://mcp.stripe.com (HTTP) - ! Needs authentication
`;

describe('parseMcpListLine', () => {
  it('reads a connected server', () => {
    expect(parseMcpListLine('claude.ai adspylab: https://adspylab.com/mcp - ✔ Connected')).toEqual({
      name: 'claude.ai adspylab',
      target: 'https://adspylab.com/mcp',
      state: 'connected',
      label: 'Connected',
    });
  });

  it('reads the state this panel exists for', () => {
    const row = parseMcpListLine('claude.ai Vercel: https://mcp.vercel.com - ! Needs authentication');
    expect(row?.state).toBe('needs-auth');
    expect(row?.label).toBe('Needs authentication');
  });

  it('a name carrying colons is not split at the wrong one', () => {
    // `plugin:stripe:stripe` is a real name; splitting on the LAST `: ` would lose it, and
    // splitting on any bare `:` would cut the name in three.
    const row = parseMcpListLine('plugin:stripe:stripe: https://mcp.stripe.com (HTTP) - ! Needs authentication');
    expect(row?.name).toBe('plugin:stripe:stripe');
    expect(row?.target).toBe('https://mcp.stripe.com (HTTP)');
    expect(row?.state).toBe('needs-auth');
  });

  it('a stdio launch command containing ` - ` keeps its flags, and the status is still read', () => {
    // The status is taken from the LAST ` - `, which is what makes this survive.
    const row = parseMcpListLine('local-tools: npx some-server --port 3000 - --verbose - ✔ Connected');
    expect(row?.target).toBe('npx some-server --port 3000 - --verbose');
    expect(row?.state).toBe('connected');
  });

  it('the health-check header, blanks and prose are not servers', () => {
    expect(parseMcpListLine('Checking MCP server health…')).toBeNull();
    expect(parseMcpListLine('')).toBeNull();
    expect(parseMcpListLine('   ')).toBeNull();
    expect(parseMcpListLine('No MCP servers configured.')).toBeNull();
  });

  it('a status the CLI has not printed before is carried through, never rounded to a known one', () => {
    // The failure this guards: a future CLI inventing a state, and the panel drawing it as
    // "Connected" because that was the nearest match. Unknown stays unknown, spelled the
    // CLI's way, so the user reads the truth.
    const row = parseMcpListLine('future-server: https://example.test/mcp - ◐ Reconnecting shortly');
    expect(row?.state).toBe('unknown');
    expect(row?.label).toBe('Reconnecting shortly');
  });

  it('a glyph change does not break recognition — the WORDS decide', () => {
    expect(parseMcpListLine('a: https://a.test/mcp - ✓ Connected')?.state).toBe('connected');
    expect(parseMcpListLine('b: https://b.test/mcp - ⏸ Pending approval')?.state).toBe('pending-approval');
    expect(parseMcpListLine('c: https://c.test/mcp - ✘ Failed to connect')?.state).toBe('failed');
    expect(parseMcpListLine('d: https://d.test/mcp - Disabled')?.state).toBe('disabled');
  });
});

describe('parseMcpList', () => {
  it('reads a real listing and drops everything that is not a server row', () => {
    const servers = parseMcpList(REAL_LIST);
    expect(servers.map((s) => s.name)).toEqual([
      'claude.ai adspylab',
      'claude.ai Vercel',
      'claude.ai Google Calendar',
      'plugin:stripe:stripe',
    ]);
    expect(servers.filter((s) => s.state === 'connected')).toHaveLength(2);
    expect(servers.filter((s) => s.state === 'needs-auth')).toHaveLength(2);
  });

  it('an empty transcript is an empty list, not a crash', () => {
    expect(parseMcpList('')).toEqual([]);
  });
});

describe('parseMcpGetState', () => {
  // Verbatim `claude mcp get "claude.ai Pixabay"` on CLI 2.1.276.
  const REAL_GET = 'claude.ai Pixabay:\n  Scope: claude.ai config\n  Status: ✔ Connected\n';

  it('reads the status line out of the detail block', () => {
    expect(parseMcpGetState(REAL_GET)).toEqual({ state: 'connected', label: 'Connected' });
  });

  it('reads a server that still needs its sign-in', () => {
    const state = parseMcpGetState('x:\n  Scope: claude.ai config\n  Status: ! Needs authentication\n');
    expect(state?.state).toBe('needs-auth');
  });

  it('output with no status line yields null — the caller reports unknown rather than success', () => {
    // This is the post-login verdict path: a probe that cannot be read must NOT be allowed to
    // become "Connected", because that would tell the user they have tools they do not have.
    expect(parseMcpGetState('No MCP server found with name: nope')).toBeNull();
    expect(parseMcpGetState('')).toBeNull();
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
