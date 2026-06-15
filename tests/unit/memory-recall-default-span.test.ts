import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addVault } from '../../src/lib/vaults.js';
import { writeSetupConfig, type SetupConfig } from '../../src/lib/setup-config.js';
import { addConnection } from '../../src/lib/connections.js';
import { registerMemoryCommand } from '../../src/cli/commands/memory.js';
import { buildCorpus, bm25Search } from '../../src/lib/recall.js';

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
  const path = join(projectRoot, '_dream_context', 'knowledge', `${slug}.md`);
  writeFileSync(path, `---\ntitle: ${slug}\ntype: knowledge\n---\n\n${body}\n`, 'utf-8');
}

/** Build a fresh Command, register `memory`, parse argv from the current cwd. */
async function runMemory(argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerMemoryCommand(program);
  await program.parseAsync(['node', 'dreamcontext', ...argv]);
}

/** Capture console.log output of `fn`, restoring the spy afterwards. */
async function capture(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join('\n');
}

describe('memory recall default-span (cross-project read by default)', () => {
  let home: string;
  let base: string;
  let originalHome: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    home = makeDir('span-home');
    base = makeDir('span-base');
    originalHome = process.env.HOME;
    originalCwd = process.cwd();
    process.env.HOME = home;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  // (a) default recall (no flags) spans connected shareable peers.
  it('spans connected shareable peers BY DEFAULT with no federation flags', async () => {
    const cur = makeVault(base, 'cur', home, false);
    const peer = makeVault(base, 'peer', home, true);
    writeKnowledge(cur, 'cur-doc', 'rate limiting middleware design for the gateway');
    writeKnowledge(peer, 'peer-doc', 'rate limiting middleware design for the gateway');
    // Active out/both connection to a shareable peer → eligible for default span.
    addConnection(join(cur, '_dream_context'), 'cur', 'peer', 'both', null, home);
    process.chdir(cur);

    const out = await capture(() => runMemory(['memory', 'recall', 'rate limiting middleware', '--json']));
    const parsed = JSON.parse(out);

    const vaults = new Set(parsed.hits.map((h: { vault: string }) => h.vault));
    expect(vaults.has('cur')).toBe(true);
    expect(vaults.has('peer')).toBe(true); // peer spanned without any flag
    // Provenance is namespaced so the agent can see where each hit came from.
    const keys: string[] = parsed.hits.map((h: { key: string }) => h.key);
    expect(keys.some((k) => k.startsWith('peer::'))).toBe(true);
    expect(keys.some((k) => k.startsWith('cur::'))).toBe(true);
  });

  // (b) default recall with NO eligible connections stays local-only and is
  //     byte-identical to the legacy single-vault recall path.
  it('stays local-only (byte-identical legacy path) when there are no eligible connections', async () => {
    const cur = makeVault(base, 'cur', home, false);
    // A peer exists and is shareable, but there is NO connection to it.
    const peer = makeVault(base, 'peer', home, true);
    writeKnowledge(cur, 'cur-doc', 'rate limiting middleware design for the gateway');
    writeKnowledge(peer, 'peer-doc', 'rate limiting middleware design for the gateway');
    process.chdir(cur);

    const out = await capture(() => runMemory(['memory', 'recall', 'rate limiting middleware', '--json']));
    const parsed = JSON.parse(out);

    // Local-only JSON shape: includes corpusSize and NO `vault`/`key` fields.
    expect(parsed).toHaveProperty('corpusSize');
    for (const h of parsed.hits) {
      expect(h).not.toHaveProperty('vault');
      expect(h).not.toHaveProperty('key');
    }
    // No peer content served.
    expect(JSON.stringify(parsed.hits)).not.toContain('peer-doc');

    // Byte-for-byte identical to the pre-federation local recall (same builder).
    const corpus = buildCorpus(join(cur, '_dream_context'));
    const localHits = bm25Search('rate limiting middleware', corpus, 10);
    expect(parsed.hits.length).toBe(localHits.length);
    expect(parsed.hits.map((h: { slug: string }) => h.slug)).toEqual(
      localHits.map((h) => h.doc.slug),
    );
  });

  // (b') an in-only connection is NOT eligible → still local-only.
  it('treats an in-only connection as ineligible (local-only)', async () => {
    const cur = makeVault(base, 'cur', home, false);
    const peer = makeVault(base, 'peer', home, true);
    writeKnowledge(cur, 'cur-doc', 'rate limiting middleware design for the gateway');
    writeKnowledge(peer, 'peer-doc', 'rate limiting middleware design for the gateway');
    addConnection(join(cur, '_dream_context'), 'cur', 'peer', 'in', null, home);
    process.chdir(cur);

    const out = await capture(() => runMemory(['memory', 'recall', 'rate limiting middleware', '--json']));
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('corpusSize'); // local-only shape
    expect(JSON.stringify(parsed.hits)).not.toContain('peer-doc');
  });

  // (b'') a connection to a NON-shareable peer is NOT eligible → local-only.
  it('treats an out connection to a non-shareable peer as ineligible (local-only)', async () => {
    const cur = makeVault(base, 'cur', home, false);
    const peer = makeVault(base, 'peer', home, false); // peer NOT shareable
    writeKnowledge(cur, 'cur-doc', 'rate limiting middleware design for the gateway');
    writeKnowledge(peer, 'peer-doc', 'rate limiting middleware design for the gateway');
    addConnection(join(cur, '_dream_context'), 'cur', 'peer', 'both', null, home);
    process.chdir(cur);

    const out = await capture(() => runMemory(['memory', 'recall', 'rate limiting middleware', '--json']));
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('corpusSize'); // local-only shape
    expect(JSON.stringify(parsed.hits)).not.toContain('peer-doc');
  });

  // (c) the always-on hook path stays LOCAL even when eligible connections exist.
  //     The hook executes `bm25Search(prompt, buildCorpus(root), 3)` on a purely
  //     local corpus — it never builds a peer corpus or resolves peer vaults, and
  //     it does NOT route through the default-spanning CLI action. We reproduce
  //     the hook's exact data source (local buildCorpus) WITH an active out/both
  //     connection to a shareable peer present and assert no peer content appears.
  it('hook recall data source stays local-only even with an eligible connection', async () => {
    const cur = makeVault(base, 'cur', home, false);
    const peer = makeVault(base, 'peer', home, true);
    writeKnowledge(cur, 'cur-doc', 'rate limiting middleware design for the gateway');
    const PEER_SENTINEL = 'ZZZ_PEER_SENTINEL_NEVER_IN_HOOK_RECALL';
    writeKnowledge(peer, 'peer-doc', `${PEER_SENTINEL} rate limiting middleware design for the gateway`);
    // The exact situation the default-span CLI would react to — but the hook must not.
    addConnection(join(cur, '_dream_context'), 'cur', 'peer', 'both', null, home);
    process.chdir(cur);

    // The hook builds a LOCAL corpus from the current root only (top 3).
    const corpus = buildCorpus(join(cur, '_dream_context'));
    const hookHits = bm25Search('rate limiting middleware', corpus, 3);

    // No peer doc, no peer sentinel — local corpus has no peer content.
    expect(corpus.some((d) => d.body.includes(PEER_SENTINEL))).toBe(false);
    expect(hookHits.map((h) => h.doc.slug)).not.toContain('peer-doc');
    for (const h of hookHits) expect(h.doc.body).not.toContain(PEER_SENTINEL);
    // The hook's explicit topK stays 3 (NOT the new CLI default of 10).
    expect(hookHits.length).toBeLessThanOrEqual(3);
  });

  // (d) topK default is now 10.
  it('returns up to 10 hits by default (topK 5 → 10)', async () => {
    const cur = makeVault(base, 'cur', home, false);
    // 12 distinct local docs all matching the query.
    for (let i = 0; i < 12; i++) {
      writeKnowledge(cur, `caching-${i}`, `cache invalidation strategy note number ${i}`);
    }
    process.chdir(cur);

    const out = await capture(() => runMemory(['memory', 'recall', 'cache invalidation strategy', '--json']));
    const parsed = JSON.parse(out);
    expect(parsed.hits.length).toBe(10);
  });
});
