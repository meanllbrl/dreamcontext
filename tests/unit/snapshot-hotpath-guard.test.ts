import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addVault } from '../../src/lib/vaults.js';
import { writeSetupConfig, type SetupConfig } from '../../src/lib/setup-config.js';
import { addConnection } from '../../src/lib/connections.js';
import { writeInboxEntry, type DigestEntry } from '../../src/lib/federation-inbox.js';
import { generateSnapshot } from '../../src/cli/commands/snapshot.js';

const BASE: SetupConfig = {
  platforms: [],
  packs: [],
  multiProduct: false,
  setupVersion: '0.7.0',
  disableNativeMemory: true,
};

const PEER_SENTINEL = 'ZZZ_PEER_SENTINEL_SHOULD_NEVER_APPEAR_IN_LOCAL_SNAPSHOT';

function makeDir(prefix: string): string {
  const dir = join(tmpdir(), `dc-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeVault(base: string, name: string, home: string): string {
  const projectRoot = join(base, name);
  mkdirSync(join(projectRoot, '_dream_context', 'knowledge'), { recursive: true });
  mkdirSync(join(projectRoot, '_dream_context', 'state'), { recursive: true });
  writeSetupConfig(projectRoot, { ...BASE, shareable: true });
  addVault(name, projectRoot, home);
  return projectRoot;
}

function makeEntry(): DigestEntry {
  return {
    version: 1,
    id: 'peer:knowledge/x@2026-06-10',
    origin: { vault: 'peer', entryId: 'knowledge/x@2026-06-10', sourceTimestamp: '2026-06-10' },
    kind: 'knowledge',
    title: 'Pending peer entry',
    summary: 'summary',
    recallScore: 1,
    links: [],
  };
}

describe('snapshot hot-path guard (P1.6 / P3 inbox line)', () => {
  let home: string;
  let base: string;
  let originalHome: string | undefined;
  let originalCwd: string;
  let curRoot: string;

  beforeEach(() => {
    home = makeDir('hotpath-home');
    base = makeDir('hotpath-base');
    originalHome = process.env.HOME;
    originalCwd = process.cwd();
    process.env.HOME = home;
    vi.restoreAllMocks();

    curRoot = makeVault(base, 'cur', home);
    const peerRoot = makeVault(base, 'peer', home);
    // The current vault has an out/both connection to a shareable peer — exactly
    // the situation cross-vault work would otherwise trigger.
    addConnection(join(curRoot, '_dream_context'), 'cur', 'peer', 'both', null, home);

    // Seed the PEER with a sentinel doc that MUST NOT appear in cur's local snapshot.
    writeFileSync(
      join(peerRoot, '_dream_context', 'knowledge', 'peer-secret.md'),
      `---\nname: ${PEER_SENTINEL}\ntype: knowledge\n---\n\n${PEER_SENTINEL} body\n`,
      'utf-8',
    );

    process.chdir(curRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  it('no-arg generateSnapshot never reads peer vaults', () => {
    const snapshot = generateSnapshot();
    expect(snapshot).not.toContain(PEER_SENTINEL);
  });

  it('omits the Federation line when the local inbox is empty', () => {
    const snapshot = generateSnapshot();
    expect(snapshot).not.toContain('## Federation');
  });

  it('includes the pending-inbox line ONLY when the LOCAL inbox has entries', () => {
    // A peer pushed an entry into cur's OWN inbox.
    writeInboxEntry(join(curRoot, '_dream_context'), makeEntry());

    const snapshot = generateSnapshot();
    expect(snapshot).toContain('## Federation');
    expect(snapshot).toContain('pending peer digest');
    // Still no peer corpus content leaked in.
    expect(snapshot).not.toContain(PEER_SENTINEL);
  });
});
