import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { addVault } from '../../src/lib/vaults.js';
import { writeSetupConfig, type SetupConfig } from '../../src/lib/setup-config.js';
import { addConnection, listConnections } from '../../src/lib/connections.js';
import { inboxDir } from '../../src/lib/federation-inbox.js';
import { registerFederationCommand } from '../../src/cli/commands/federation.js';
import { registerConnectionsCommand } from '../../src/cli/commands/connections.js';

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

/** Write a `federated: true` copy (as the old sync path would have left behind). */
function writeFederatedCopy(projectRoot: string, slug: string, originVault: string): void {
  writeFileSync(
    join(projectRoot, '_dream_context', 'knowledge', `${slug}.md`),
    `---\nname: ${slug}\ntype: knowledge\nfederated: true\norigin:\n  vault: ${originVault}\n  entryId: x\n---\n\nstub\n`,
    'utf-8',
  );
}

async function runFederation(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerFederationCommand(program);
  await program.parseAsync(['federation', ...args], { from: 'user' });
}

async function runConnect(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerConnectionsCommand(program);
  await program.parseAsync(['connect', ...args], { from: 'user' });
}

describe('federation is read-only — sync/drain are inert (copy path disabled)', () => {
  let home: string;
  let base: string;
  let originalHome: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    home = makeDir('readonly-home');
    base = makeDir('readonly-base');
    originalHome = process.env.HOME;
    originalCwd = process.cwd();
    process.env.HOME = home;
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  it('`federation sync` writes NOTHING to a consenting peer and never advances the watermark', async () => {
    const senderRoot = makeVault(base, 'sender', home, true);
    const peerRoot = makeVault(base, 'peer', home, true);
    writeKnowledge(senderRoot, 'caching-strategy', 'caching strategy notes for the gateway layer');

    const senderCtx = join(senderRoot, '_dream_context');
    const peerCtx = join(peerRoot, '_dream_context');
    // Even a fully-consented out→in pair must produce no copy now.
    addConnection(senderCtx, 'sender', 'peer', 'out', ['caching', 'gateway'], home);
    addConnection(peerCtx, 'peer', 'sender', 'in', null, home);

    process.chdir(senderRoot);
    await runFederation(['sync']);

    const peerInbox = inboxDir(peerCtx);
    const files = existsSync(peerInbox)
      ? readdirSync(peerInbox).filter((f) => f.endsWith('.json'))
      : [];
    expect(files).toHaveLength(0);

    // Watermark must NOT advance — sync did nothing.
    const conn = listConnections(senderCtx).find((c) => c.vault === 'peer');
    expect(conn).toBeDefined(); // guard: a missing connection must fail, not silently pass
    expect(conn!.last_synced_at).toBeNull();
  });

  it('`federation sync` does NOT mark a dead peer stale (it never resolves peers)', async () => {
    const senderRoot = makeVault(base, 'sender', home, true);
    const deadRoot = makeVault(base, 'dead', home, true);
    const senderCtx = join(senderRoot, '_dream_context');
    addConnection(senderCtx, 'sender', 'dead', 'out', null, home);
    rmSync(deadRoot, { recursive: true, force: true });

    process.chdir(senderRoot);
    await runFederation(['sync']);

    const conn = listConnections(senderCtx).find((c) => c.vault === 'dead');
    expect(conn?.status).toBe('active'); // unchanged — sync is inert
  });

  it('`federation drain` ingests NOTHING — a pending inbox entry is left untouched', async () => {
    const root = makeVault(base, 'receiver', home, true);
    const ctx = join(root, '_dream_context');
    const inbox = inboxDir(ctx);
    mkdirSync(inbox, { recursive: true });
    const entryFile = join(inbox, 'peer-x.json');
    writeFileSync(entryFile, JSON.stringify({ version: 1, id: 'peer:x', title: 'X', summary: 's' }), 'utf-8');

    process.chdir(root);
    await runFederation(['drain']);

    // Entry still pending (not consumed), and no federated knowledge file created.
    expect(existsSync(entryFile)).toBe(true);
    const knowledge = readdirSync(join(ctx, 'knowledge'));
    expect(knowledge.some((f) => f.includes('--from-'))).toBe(false);
  });
});

describe('federation purge — remove leftover federated copies', () => {
  let home: string;
  let base: string;
  let originalHome: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    home = makeDir('purge-home');
    base = makeDir('purge-base');
    originalHome = process.env.HOME;
    originalCwd = process.cwd();
    process.env.HOME = home;
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  it('--all removes federated copies but leaves native knowledge intact', async () => {
    const root = makeVault(base, 'v', home, true);
    const kdir = join(root, '_dream_context', 'knowledge');
    writeKnowledge(root, 'native-doc', 'my own canonical knowledge');
    writeFederatedCopy(root, 'copy-from-a', 'alpha');
    writeFederatedCopy(root, 'copy-from-b', 'beta');

    process.chdir(root);
    await runFederation(['purge', '--all']);

    expect(existsSync(join(kdir, 'native-doc.md'))).toBe(true);
    expect(existsSync(join(kdir, 'copy-from-a.md'))).toBe(false);
    expect(existsSync(join(kdir, 'copy-from-b.md'))).toBe(false);
  });

  it('with neither --all nor --vault, deletes nothing and sets a non-zero exit code', async () => {
    const root = makeVault(base, 'v', home, true);
    const kdir = join(root, '_dream_context', 'knowledge');
    writeFederatedCopy(root, 'copy-from-a', 'alpha');

    process.chdir(root);
    process.exitCode = 0;
    await runFederation(['purge']); // no flag
    expect(process.exitCode).toBe(1); // refused — guard against accidental mass delete
    expect(existsSync(join(kdir, 'copy-from-a.md'))).toBe(true); // untouched
    process.exitCode = 0; // reset so we don't poison the runner
  });

  it('--vault removes only copies from the named origin; --dry-run removes nothing', async () => {
    const root = makeVault(base, 'v', home, true);
    const kdir = join(root, '_dream_context', 'knowledge');
    writeFederatedCopy(root, 'copy-from-a', 'alpha');
    writeFederatedCopy(root, 'copy-from-b', 'beta');

    process.chdir(root);
    await runFederation(['purge', '--vault', 'beta', '--dry-run']);
    expect(existsSync(join(kdir, 'copy-from-b.md'))).toBe(true); // dry-run kept it

    await runFederation(['purge', '--vault', 'beta']);
    expect(existsSync(join(kdir, 'copy-from-b.md'))).toBe(false); // beta removed
    expect(existsSync(join(kdir, 'copy-from-a.md'))).toBe(true); // alpha untouched
  });
});

describe('connect defaults to a read edge (out)', () => {
  let home: string;
  let base: string;
  let originalHome: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    home = makeDir('connect-home');
    base = makeDir('connect-base');
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

  it('`connect <peer>` with no --direction stores direction "out"', async () => {
    const meRoot = makeVault(base, 'me', home, true);
    makeVault(base, 'peer', home, true);
    process.chdir(meRoot);
    await runConnect(['peer']);

    const conn = listConnections(join(meRoot, '_dream_context')).find((c) => c.vault === 'peer');
    expect(conn?.direction).toBe('out');
  });
});
