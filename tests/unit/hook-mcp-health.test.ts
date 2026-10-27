/**
 * The hook side of MCP management (task mcp-management). W1: a Settings probe/connect child
 * (`DREAMCONTEXT_MCP_PROBE=1`) short-circuits ONLY session-start, user-prompt-submit and stop;
 * the `.env` deny gate (pre-tool-use) and every other hook run unchanged.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMcpProbeChild } from '../../src/cli/commands/hook.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const SRC = readFileSync(join(ROOT, 'src/cli/commands/hook.ts'), 'utf-8');

/** The body of one `hook <name>` action, up to the next `.command(`. */
function actionOf(name: string): string {
  const start = SRC.indexOf(`.command('${name}')`);
  const end = SRC.indexOf('.command(', start + 10);
  return SRC.slice(start, end === -1 ? undefined : end);
}

describe('hook — the MCP probe child', () => {
  it('is recognised by its env only', () => {
    expect(isMcpProbeChild({ DREAMCONTEXT_MCP_PROBE: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isMcpProbeChild({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isMcpProbeChild({ DREAMCONTEXT_MCP_PROBE: 'yes' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('session-start, user-prompt-submit and stop exit right after reading stdin; pre-tool-use does not', () => {
    for (const name of ['session-start', 'user-prompt-submit', 'stop']) {
      const body = actionOf(name);
      const read = body.indexOf('const input = readStdin();');
      expect(read, name).toBeGreaterThan(0);
      expect(body.slice(read, read + 120), name).toContain('if (isMcpProbeChild()) process.exit(0);');
    }
    for (const name of ['pre-tool-use', 'post-tool-use', 'subagent-start', 'pre-compact']) {
      expect(actionOf(name), name).not.toContain('isMcpProbeChild');
    }
  });
});
