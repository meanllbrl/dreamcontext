import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addVault } from '../../src/lib/vaults.js';
import { writeSetupConfig, type SetupConfig } from '../../src/lib/setup-config.js';
import { addConnection } from '../../src/lib/connections.js';
import { generateSnapshot } from '../../src/cli/commands/snapshot.js';
import { peerSummaryCachePath, type PeerSummaryCache } from '../../src/lib/federation-peer-summary.js';

const BASE: SetupConfig = {
  platforms: [],
  packs: [],
  multiProduct: false,
  setupVersion: '0.8.0',
  disableNativeMemory: true,
};

const PEER_BODY_SENTINEL = 'ZZZ_PEER_BODY_SHOULD_NEVER_BE_RESOLVED_BY_SNAPSHOT';

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

function writeCache(curCtx: string, cache: PeerSummaryCache): void {
  writeFileSync(peerSummaryCachePath(curCtx), JSON.stringify(cache, null, 2) + '\n', 'utf-8');
}

describe('snapshot — Connected projects (cache-only, hot-path safe)', () => {
  let home: string;
  let base: string;
  let originalHome: string | undefined;
  let originalCwd: string;
  let curRoot: string;
  let curCtx: string;

  beforeEach(() => {
    home = makeDir('cp-home');
    base = makeDir('cp-base');
    originalHome = process.env.HOME;
    originalCwd = process.cwd();
    process.env.HOME = home;
    vi.restoreAllMocks();

    curRoot = makeVault(base, 'cur', home);
    curCtx = join(curRoot, '_dream_context');
    const peerRoot = makeVault(base, 'peer', home);
    // A real out/both connection to a shareable peer — cross-vault work would
    // otherwise trigger here.
    addConnection(curCtx, 'cur', 'peer', 'both', null, home);
    // Seed the PEER body with a sentinel that ONLY appears if the snapshot
    // resolved the peer corpus (it must not).
    writeFileSync(
      join(peerRoot, '_dream_context', 'knowledge', 'peer-secret.md'),
      `---\nname: secret\ntype: knowledge\n---\n\n${PEER_BODY_SENTINEL}\n`,
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

  it('omits the section entirely when the cache is absent', () => {
    const snapshot = generateSnapshot();
    expect(snapshot).not.toContain('## Connected projects');
  });

  it('omits the section when the cache has zero peers', () => {
    writeCache(curCtx, { generatedAt: '2026-06-15T00:00:00Z', peers: [] });
    const snapshot = generateSnapshot();
    expect(snapshot).not.toContain('## Connected projects');
  });

  it('renders the section purely from the LOCAL cache — never resolving the peer', () => {
    writeCache(curCtx, {
      generatedAt: '2026-06-15T00:00:00Z',
      peers: [
        {
          vault: 'peer',
          whatItIs: 'Peer is a billing service for invoices.',
          lastActivity: ['2026-06-14 — Shipped refunds endpoint'],
          activeTask: 'refunds-v2',
          topTags: ['billing', 'api'],
          pinnedKnowledge: ['Refund Ledger Model', 'Webhook Retry Policy'],
        },
      ],
    });

    const snapshot = generateSnapshot();
    expect(snapshot).toContain('## Connected projects');
    expect(snapshot).toContain('**peer**');
    expect(snapshot).toContain('billing service for invoices');
    expect(snapshot).toContain('Shipped refunds endpoint');
    expect(snapshot).toContain('In progress: refunds-v2');
    expect(snapshot).toContain('Tags: billing, api');
    expect(snapshot).toContain('Pinned docs: Refund Ledger Model, Webhook Retry Policy');
    // Usage line.
    expect(snapshot).toContain('memory recall <q> --vault <name>');
    // CRITICAL hot-path proof: the peer's ACTUAL corpus was never read — only the
    // local cache. The sentinel that lives ONLY in the peer's files is absent.
    expect(snapshot).not.toContain(PEER_BODY_SENTINEL);
  });

  it('section content comes from the cache even if it disagrees with live peer state', () => {
    // The cache claims a peer named "ghost" that has no connection / no vault.
    // If the snapshot resolved peers live, "ghost" would not appear. Because it
    // reads ONLY the cache, "ghost" DOES appear — proving the section is
    // cache-fed, not peer-resolved.
    writeCache(curCtx, {
      generatedAt: '2026-06-15T00:00:00Z',
      peers: [{ vault: 'ghost', whatItIs: 'cached only', lastActivity: [], activeTask: '', topTags: [] }],
    });
    const snapshot = generateSnapshot();
    expect(snapshot).toContain('**ghost**');
  });
});
