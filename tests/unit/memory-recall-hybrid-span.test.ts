import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addVault } from '../../src/lib/vaults.js';
import { writeSetupConfig, type SetupConfig } from '../../src/lib/setup-config.js';
import { addConnection } from '../../src/lib/connections.js';
import { registerMemoryCommand } from '../../src/cli/commands/memory.js';
import { buildCorpusCached } from '../../src/lib/recall-corpus-cache.js';
import { NANO_MODEL, VOYAGE_DIMS, setNanoLoader } from '../../src/lib/embeddings/nano.js';
import { axisVector, consentAndIndex, ENV_KEYS } from './_hybrid-fixture.js';

// `memory recall` in a vault with a connected peer used to take the federated path, which is BM25 for
// every vault: a hybrid (cloud-index) vault never ran its own tier there and printed nothing about it.
// These drive the real command against temp vaults and a temp HOME.

vi.mock('../../src/lib/embeddings/embedder.js', () => ({
  EMBED_MODEL: 'test-model',
  EMBED_DIMS: 4,
  embeddingsAvailable: vi.fn(async () => true),
  embedPassages: vi.fn(),
  embedQuery: vi.fn(),
  isEmbedModelDownloaded: vi.fn(() => false),
}));

const BASE: SetupConfig = { platforms: [], packs: [], multiProduct: false, setupVersion: '0.7.0', disableNativeMemory: true };

function makeDir(prefix: string): string {
  const dir = join(tmpdir(), `dc-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeVault(base: string, name: string, home: string): string {
  const projectRoot = join(base, name);
  mkdirSync(join(projectRoot, '_dream_context', 'knowledge'), { recursive: true });
  mkdirSync(join(projectRoot, '_dream_context', 'state'), { recursive: true });
  writeSetupConfig(projectRoot, { ...BASE });
  addVault(name, projectRoot, home);
  return projectRoot;
}

function writeKnowledge(projectRoot: string, slug: string, body: string): void {
  writeFileSync(join(projectRoot, '_dream_context', 'knowledge', `${slug}.md`), `---\ntitle: ${slug}\ntype: knowledge\n---\n\n${body}\n`, 'utf-8');
}

/** The four files `isNanoDownloaded` checks; their content is never read (the loader is injected). */
function fakeNanoOnDisk(home: string): void {
  const dir = join(home, '.dreamcontext', 'models', NANO_MODEL);
  mkdirSync(join(dir, 'onnx'), { recursive: true });
  for (const f of ['onnx/model_quantized.onnx', 'onnx/model_quantized.onnx_data', 'tokenizer.json', 'config.json']) writeFileSync(join(dir, f), 'x');
}

async function runMemory(argv: string[]): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(' ')); });
  try {
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);
    await program.parseAsync(['node', 'dreamcontext', ...argv]);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return { out: out.join('\n'), err: err.join('\n') };
}

describe('memory recall in a hybrid vault with a connected peer', () => {
  let home: string;
  let base: string;
  const saved: Record<string, string | undefined> = {};
  let originalCwd: string;

  beforeEach(() => {
    home = makeDir('hspan-home');
    base = makeDir('hspan-base');
    originalCwd = process.cwd();
    for (const k of [...ENV_KEYS, 'HOME', 'DREAMCONTEXT_RECALL_MODE', 'DREAMCONTEXT_RECALL_TIMING']) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.HOME = home;
    process.env.DREAMCONTEXT_RECALL_MODE = 'hybrid';
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    setNanoLoader(null);
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  it('hybrid selected but not ready: the peer span still runs, and stderr names why BM25 served it', async () => {
    const cur = makeVault(base, 'cur', home);
    const peer = makeVault(base, 'peer', home);
    writeKnowledge(cur, 'cur-doc', 'rate limiting middleware design for the gateway');
    writeKnowledge(peer, 'peer-doc', 'rate limiting middleware design for the gateway');
    addConnection(join(cur, '_dream_context'), 'cur', 'peer', 'both', null, home);
    process.chdir(cur);

    const { out, err } = await runMemory(['memory', 'recall', 'rate limiting middleware', '--json']);
    const keys: string[] = JSON.parse(out).hits.map((h: { key: string }) => h.key);
    expect(keys).toContain('cur::knowledge/cur-doc');
    expect(keys).toContain('peer::knowledge/peer-doc');
    expect(err).toContain('hybrid recall selected but not warmed — using BM25');
  });

  it('--top bounds the whole list: peers take at most half, the current vault fills the rest', async () => {
    const cur = makeVault(base, 'cur', home);
    const peer = makeVault(base, 'peer', home);
    for (let i = 0; i < 8; i++) {
      writeKnowledge(cur, `cur-${i}`, `rate limiting middleware design note ${i}`);
      writeKnowledge(peer, `peer-${i}`, `rate limiting middleware design note ${i}`);
    }
    addConnection(join(cur, '_dream_context'), 'cur', 'peer', 'both', null, home);
    process.chdir(cur);

    const { out } = await runMemory(['memory', 'recall', 'rate limiting middleware', '--top', '5', '--json']);
    const keys: string[] = JSON.parse(out).hits.map((h: { key: string }) => h.key);
    expect(keys).toHaveLength(5);
    expect(keys.filter((k) => k.startsWith('peer::'))).toHaveLength(2);
    expect(keys.slice(0, 3).every((k) => k.startsWith('cur::'))).toBe(true);
  });

  it('cloud-index ready: the current vault runs its own tier, so a doc BM25 cannot match leads, peers follow', async () => {
    const cur = makeVault(base, 'cur', home);
    const peer = makeVault(base, 'peer', home);
    const root = join(cur, '_dream_context');
    for (let i = 0; i < 6; i++) writeKnowledge(cur, `e${i}`, `zzw${i} filler words about the number ${i}`);
    writeKnowledge(peer, 'peer-doc', 'belge numarası dördüncü');
    addConnection(root, 'cur', 'peer', 'both', null, home);
    await consentAndIndex({ tmp: base, home, root, saved: {} }, buildCorpusCached(root), 'cloud-index');
    fakeNanoOnDisk(home);
    // The local query model: whatever the words, the query lands on doc e4's axis (a stand-in for a
    // Turkish query meeting an English doc in the shared embedding space).
    setNanoLoader(async () => ({
      async run() { return { hidden: Float32Array.from(axisVector('zzw4')), mask: [1], tokens: 1, width: VOYAGE_DIMS }; },
    }));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.chdir(cur);
    process.env.DREAMCONTEXT_RECALL_TIMING = '1';

    const { out, err } = await runMemory(['memory', 'recall', 'dördüncü belge numarası', '--json']);
    const keys: string[] = JSON.parse(out).hits.map((h: { key: string }) => h.key);
    expect(keys[0]).toBe('cur::knowledge/e4'); // no shared word with the query: only the dense channel finds it
    expect(keys).toContain('peer::knowledge/peer-doc');
    expect(keys.indexOf('peer::knowledge/peer-doc')).toBeGreaterThan(keys.indexOf('cur::knowledge/e4'));
    expect(fetch).not.toHaveBeenCalled(); // cloud-index: the query never leaves the machine
    expect(JSON.parse(err.split('\n').find((l) => l.startsWith('{'))!)).toMatchObject({ tier: 'cloud-index', querySource: 'nano', fallback: 'none' });
  });
});
