import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { addVault } from '../../src/lib/vaults.js';
import { writeSetupConfig, type SetupConfig } from '../../src/lib/setup-config.js';
import { addConnection } from '../../src/lib/connections.js';
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

function makeVault(base: string, name: string, home: string): string {
  const projectRoot = join(base, name);
  mkdirSync(join(projectRoot, '_dream_context', 'knowledge'), { recursive: true });
  mkdirSync(join(projectRoot, '_dream_context', 'state'), { recursive: true });
  writeSetupConfig(projectRoot, { ...BASE, shareable: true });
  addVault(name, projectRoot, home);
  return projectRoot;
}

function writeKnowledge(projectRoot: string, slug: string, body: string): void {
  // A quoted (string) date gives the doc a real updatedAt so the sync watermark
  // can exclude it on a second pass (the watermark-dedup half of P3.5).
  writeFileSync(
    join(projectRoot, '_dream_context', 'knowledge', `${slug}.md`),
    `---\nname: ${slug}\ntype: knowledge\ndate: "2026-06-10"\ntags:\n  - shared\n---\n\n${body}\n`,
    'utf-8',
  );
}

function pendingFiles(ctxRoot: string): string[] {
  const dir = inboxDir(ctxRoot);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
}

async function runFederation(projectRoot: string, args: string[]): Promise<void> {
  process.chdir(projectRoot);
  const program = new Command();
  program.exitOverride();
  registerFederationCommand(program);
  await program.parseAsync(['federation', ...args], { from: 'user' });
}

describe('federation A↔B cycle (P3.5)', () => {
  let home: string;
  let base: string;
  let originalHome: string | undefined;
  let originalCwd: string;
  let aRoot: string;
  let bRoot: string;

  beforeEach(() => {
    home = makeDir('cycle-home');
    base = makeDir('cycle-base');
    originalHome = process.env.HOME;
    originalCwd = process.cwd();
    process.env.HOME = home;
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    aRoot = makeVault(base, 'A', home);
    bRoot = makeVault(base, 'B', home);
    // A↔B bidirectional consent, with topics overrides so the digest has terms.
    addConnection(join(aRoot, '_dream_context'), 'A', 'B', 'both', ['shared', 'pattern'], home);
    addConnection(join(bRoot, '_dream_context'), 'B', 'A', 'both', ['shared', 'pattern'], home);
    // A has a doc; B starts empty.
    writeKnowledge(aRoot, 'shared-pattern', 'a shared architectural pattern worth federating');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  it('no echo back to A and no re-send on a second A→B sync', async () => {
    const aCtx = join(aRoot, '_dream_context');
    const bCtx = join(bRoot, '_dream_context');

    // 1. A → B sync: B's inbox receives A's doc.
    await runFederation(aRoot, ['sync']);
    const bPending = pendingFiles(bCtx);
    expect(bPending.length).toBeGreaterThanOrEqual(1);

    // 2. B drains + ingests (the doc becomes federated:true in B).
    await runFederation(bRoot, ['drain']);
    expect(pendingFiles(bCtx)).toHaveLength(0);

    // 3. B → A sync: A must NOT receive an echo of its own content (federated
    //    exclusion + provenance). A's inbox stays empty.
    await runFederation(bRoot, ['sync']);
    expect(pendingFiles(aCtx)).toHaveLength(0);

    // 4. Second A → B sync re-sends nothing (watermark + filename dedup).
    await runFederation(aRoot, ['sync']);
    expect(pendingFiles(bCtx)).toHaveLength(0);
  });
});
