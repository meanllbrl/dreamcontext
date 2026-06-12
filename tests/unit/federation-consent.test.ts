import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { addVault } from '../../src/lib/vaults.js';
import { writeSetupConfig, type SetupConfig } from '../../src/lib/setup-config.js';
import { addConnection, listConnections } from '../../src/lib/connections.js';
import { inboxDir } from '../../src/lib/federation-inbox.js';
import { registerFederationCommand } from '../../src/cli/commands/federation.js';

const BASE: SetupConfig = {
  platforms: [],
  packs: [],
  multiProduct: false,
  setupVersion: '0.7.0',
  disableNativeMemory: true,
};

function makeDir(prefix: string): string {
  const dir = join(tmpdir(), `dc-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeVault(base: string, name: string, home: string, shareable: boolean): string {
  const projectRoot = join(base, name);
  mkdirSync(join(projectRoot, '_dream_context', 'knowledge'), { recursive: true });
  mkdirSync(join(projectRoot, '_dream_context', 'state'), { recursive: true });
  writeSetupConfig(projectRoot, { ...BASE, shareable });
  addVault(name, projectRoot, home);
  return projectRoot;
}

function writeKnowledge(projectRoot: string, slug: string, body: string): void {
  writeFileSync(
    join(projectRoot, '_dream_context', 'knowledge', `${slug}.md`),
    `---\nname: ${slug}\ntype: knowledge\ntags:\n  - caching\n---\n\n${body}\n`,
    'utf-8',
  );
}

/** Run `dreamcontext federation sync` from the sender's project dir. */
async function runSync(senderProjectRoot: string): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerFederationCommand(program);
  await program.parseAsync(['federation', 'sync'], { from: 'user' });
}

describe('federation sync consent rule (P3.4)', () => {
  let home: string;
  let base: string;
  let originalHome: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    home = makeDir('consent-home');
    base = makeDir('consent-base');
    originalHome = process.env.HOME;
    originalCwd = process.cwd();
    process.env.HOME = home;
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  it('writes into a consenting peer inbox and advances the sender watermark', async () => {
    const senderRoot = makeVault(base, 'sender', home, true);
    const peerRoot = makeVault(base, 'peer', home, true);
    writeKnowledge(senderRoot, 'caching-strategy', 'caching strategy notes for the gateway layer');

    const senderCtx = join(senderRoot, '_dream_context');
    const peerCtx = join(peerRoot, '_dream_context');
    // Sender → peer (out) with a topics override so the digest has terms to match;
    // peer declares `in` back to sender → consent granted.
    addConnection(senderCtx, 'sender', 'peer', 'out', ['caching', 'gateway'], home);
    addConnection(peerCtx, 'peer', 'sender', 'in', null, home);

    process.chdir(senderRoot);
    await runSync(senderRoot);

    const peerInbox = inboxDir(peerCtx);
    expect(existsSync(peerInbox)).toBe(true);
    const files = readdirSync(peerInbox).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(1);

    // The sender's watermark advanced.
    const conn = listConnections(senderCtx).find((c) => c.vault === 'peer');
    expect(conn?.last_synced_at).not.toBeNull();
  });

  it('skips a peer without an inbound declaration and writes nothing', async () => {
    const senderRoot = makeVault(base, 'sender', home, true);
    const peerRoot = makeVault(base, 'peer', home, true);
    writeKnowledge(senderRoot, 'caching-strategy', 'caching strategy notes for the gateway layer');

    const senderCtx = join(senderRoot, '_dream_context');
    const peerCtx = join(peerRoot, '_dream_context');
    // Sender → peer (out), but peer has NO connection back → consent denied.
    addConnection(senderCtx, 'sender', 'peer', 'out', null, home);

    process.chdir(senderRoot);
    await runSync(senderRoot);

    // Nothing written into the peer inbox.
    const peerInbox = inboxDir(peerCtx);
    const files = existsSync(peerInbox)
      ? readdirSync(peerInbox).filter((f) => f.endsWith('.json'))
      : [];
    expect(files).toHaveLength(0);

    // A non-consenting peer skip is logged (info goes through console.log).
    expect(console.log).toHaveBeenCalled();
  });
});
