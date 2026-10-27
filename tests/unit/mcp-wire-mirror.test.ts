/**
 * The MCP wire shapes exist on both sides (task mcp-management W1): the server redacts and
 * sends (`src/lib/mcp-wire.ts`), the window draws (`dashboard/src/lib/mcpWire.ts`). A drift is
 * a status the window cannot draw or a name rule the two sides disagree on. Pinned here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as server from '../../src/lib/mcp-wire.js';
import * as client from '../../dashboard/src/lib/mcpWire.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const body = (file: string) => {
  const src = readFileSync(join(ROOT, file), 'utf-8');
  return src.slice(src.indexOf('/** What the live session says'));
};

describe('mcp wire — server <-> window mirror', () => {
  it('the two files are one text below the header', () => {
    expect(body('dashboard/src/lib/mcpWire.ts')).toBe(body('src/lib/mcp-wire.ts'));
  });

  it('every list matches and the name rule agrees', () => {
    expect([...client.MCP_LIVE_STATUSES]).toEqual([...server.MCP_LIVE_STATUSES]);
    expect([...client.MCP_ERROR_KINDS]).toEqual([...server.MCP_ERROR_KINDS]);
    expect([...client.MCP_HOMES]).toEqual([...server.MCP_HOMES]);
    expect([...client.MCP_CONNECT_STATES]).toEqual([...server.MCP_CONNECT_STATES]);
    for (const n of ['posthog', 'claude.ai Gmail', 'plugin:stripe:stripe', '-x', '', 'a\nb', 'x'.repeat(201), 42]) {
      expect(client.isUsableServerName(n)).toBe(server.isUsableServerName(n));
    }
    expect(server.isUsableServerName('claude.ai Gmail')).toBe(true);
    expect(server.isUsableServerName('--help')).toBe(false);
  });
});
