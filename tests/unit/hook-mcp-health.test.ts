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

describe('the MCP block the prompt hook adds (W2)', async () => {
  const { mkdtempSync, rmSync, existsSync: exists, readFileSync: read } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { mcpHealthBlock, writeMcpHealth, removeMcpHealth, mcpHealthDir } = await import('../../src/lib/mcp-health.js');
  const TAB = '11111111-2222-4333-8444-555555555555';
  type Row = { name: string; status: 'connected' | 'needs-auth' | 'pending' | 'failed'; home: 'computer' | 'claudeai'; transport: string };
  const row = (name: string, status: Row['status'], home: Row['home'] = 'computer'): Row => ({ name, status, home, transport: 'http' });

  const withVault = (fn: (contextRoot: string) => void) => {
    const project = mkdtempSync(join(tmpdir(), 'dc-mcp-health-'));
    const contextRoot = join(project, '_dream_context');
    try { fn(contextRoot); } finally { rmSync(project, { recursive: true, force: true }); }
  };

  it('says it once per changed set; pending is ignored; silent when all connected', () => {
    withVault((root) => {
      writeMcpHealth(root, TAB, [row('posthog', 'needs-auth'), row('stitch', 'pending'), row('claude.ai Gmail', 'needs-auth', 'claudeai')]);
      const first = mcpHealthBlock(root, TAB)!;
      expect(first).toContain('"claude.ai Gmail" (needs sign-in, claude.ai)');
      expect(first).toContain('"posthog" (needs sign-in, this computer)');
      expect(first).not.toContain('stitch');
      expect(first).toContain('`mcp` card');
      expect(mcpHealthBlock(root, TAB)).toBeNull();
      writeMcpHealth(root, TAB, [row('posthog', 'needs-auth'), row('stitch', 'failed'), row('claude.ai Gmail', 'needs-auth', 'claudeai')]);
      expect(mcpHealthBlock(root, TAB)).toContain('"stitch" (failed, this computer)');
      writeMcpHealth(root, TAB, [row('posthog', 'connected'), row('stitch', 'connected')]);
      expect(mcpHealthBlock(root, TAB)).toBeNull();
      // Broken again after being fine: said again.
      writeMcpHealth(root, TAB, [row('posthog', 'needs-auth')]);
      expect(mcpHealthBlock(root, TAB)).toContain('posthog');
      // The directory is gitignored before its first write.
      expect(read(join(root, '..', '.gitignore'), 'utf-8')).toContain('_dream_context/state/.mcp-health/');
    });
  });

  it('names are quoted, control characters stripped, 60 chars at most, 8 names then "+N more"', () => {
    withVault((root) => {
      const names = Array.from({ length: 10 }, (_, i) => `srv${i}`);
      writeMcpHealth(root, TAB, [row(`evil"\nname${'x'.repeat(80)}`, 'failed'), ...names.map((n) => row(n, 'needs-auth'))]);
      const b = mcpHealthBlock(root, TAB)!;
      expect(b).not.toContain('\n');
      expect(b).toContain(`"evil' name${'x'.repeat(49)}…"`);
      expect(b).toContain('+3 more');
      expect((b.match(/\(needs sign-in|\(failed/g) ?? []).length).toBe(8);
    });
  });

  it('an unpinned or malformed tab says nothing; the file dies with the chat', () => {
    withVault((root) => {
      expect(mcpHealthBlock(root, undefined)).toBeNull();
      writeMcpHealth(root, '../escape', [row('posthog', 'needs-auth')]);
      expect(exists(mcpHealthDir(root))).toBe(false);
      writeMcpHealth(root, TAB, [row('posthog', 'needs-auth')]);
      removeMcpHealth(root, TAB);
      expect(mcpHealthBlock(root, TAB)).toBeNull();
    });
  });

  it('the prompt hook prints the block for its pinned tab (wired in user-prompt-submit)', () => {
    const body = actionOf('user-prompt-submit');
    expect(body).toContain('mcpHealthBlock(root, process.env.DREAMCONTEXT_TAB_SESSION)');
  });
});
