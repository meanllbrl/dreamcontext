/**
 * The ports this process owns (jarvis plan r9, T1): every claim has its release, and a port two
 * owners share stays owned until both let go.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { claimOwnedPort, ownedLoopbackPorts, resetOwnedPortsForTests } from '../../src/server/owned-ports.js';

beforeEach(() => resetOwnedPortsForTests());

describe('owned loopback ports', () => {
  it('a claim is owned until its release runs; a second release does nothing', () => {
    const release = claimOwnedPort(4173);
    expect(ownedLoopbackPorts().has(4173)).toBe(true);
    release();
    release();
    expect(ownedLoopbackPorts().has(4173)).toBe(false);
  });

  it('two owners of one port: owned until both release', () => {
    const a = claimOwnedPort(9222);
    const b = claimOwnedPort(9222);
    a();
    a();
    expect(ownedLoopbackPorts().has(9222)).toBe(true);
    b();
    expect(ownedLoopbackPorts().has(9222)).toBe(false);
  });

  it('not a port: nothing claimed', () => {
    claimOwnedPort(0)();
    claimOwnedPort(70000)();
    claimOwnedPort(1.5)();
    expect(ownedLoopbackPorts().size).toBe(0);
  });

  it('the CDP side door of a live browser mirror is owned while its spawn lives', async () => {
    const { prepareBrowserOverride } = await import('../../src/lib/browser-override.js');
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'owned-cdp-'));
    try {
      mkdirSync(join(dir, 'project'));
      writeFileSync(join(dir, 'project', '.mcp.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@latest'] } } }));
      const o = prepareBrowserOverride(join(dir, 'project'), join(dir, 'home'), () => 45999);
      expect(o).not.toBeNull();
      expect(ownedLoopbackPorts().has(45999)).toBe(true);
      o!.dispose();
      expect(ownedLoopbackPorts().has(45999)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
