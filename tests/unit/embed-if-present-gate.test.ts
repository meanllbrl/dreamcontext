// `--if-present` and the post-sleep refresh promise "never triggers a first-time model download /
// full re-embed". A cache left by ANOTHER model exists on disk but loadCache discards it, so the
// gate must be embeddingCacheUsable, not mere existence (AC-I4).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

const spies = vi.hoisted(() => ({ available: vi.fn(async () => true), embed: vi.fn(async (t: string[]) => t.map(() => new Float32Array([1, 0]))) }));

vi.mock('../../src/lib/embeddings/embedder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/embeddings/embedder.js')>();
  return { ...actual, embeddingsAvailable: spies.available, embedPassages: spies.embed };
});

import { registerEmbedCommand } from '../../src/cli/commands/embed.js';
import { EMBED_MODEL } from '../../src/lib/embeddings/embedder.js';
import { embeddingCacheExists, embeddingCacheUsable } from '../../src/lib/embeddings/store.js';

let project: string;
let root: string;
const cwd = process.cwd();

function seedCache(model: string): void {
  mkdirSync(join(root, '.embeddings'), { recursive: true });
  writeFileSync(join(root, '.embeddings', 'cache.json'), JSON.stringify({ version: 1, model, docs: {}, vectors: { abc: 'AAAA' } }));
}

async function run(...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  registerEmbedCommand(program);
  await program.parseAsync(['node', 'dreamcontext', 'embed', ...args]);
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'dc-embed-gate-'));
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  writeFileSync(join(root, 'knowledge', 'a.md'), '---\nname: A\ndescription: d\n---\n\nbody\n');
  process.chdir(project);
  spies.available.mockClear();
  spies.embed.mockClear();
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(project, { recursive: true, force: true });
});

describe('--if-present gates on a USABLE cache', () => {
  it('a cache built by another model exists but is not usable', () => {
    seedCache('some/other-model#q8');
    expect(embeddingCacheExists(root)).toBe(true);
    expect(embeddingCacheUsable(root)).toBe(false);
  });

  it('embed refresh --if-present does nothing for a foreign-model cache', async () => {
    seedCache('some/other-model#q8');
    await run('refresh', '--if-present');
    expect(spies.available).not.toHaveBeenCalled();
    expect(spies.embed).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(root, '.embeddings', 'cache.json'), 'utf8')).model).toBe('some/other-model#q8');
  });

  it('embed dedup --if-present answers unknown for a foreign-model cache', async () => {
    seedCache('some/other-model#q8');
    const out: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { out.push(String(m)); });
    await run('dedup', '--title', 'A', '--if-present', '--json');
    log.mockRestore();
    expect(JSON.parse(out.join('\n'))).toEqual({ verdict: 'unknown', reason: 'no-embedding-cache' });
    expect(spies.embed).not.toHaveBeenCalled();
  });

  it('control: a cache of the CURRENT model passes the gate', async () => {
    seedCache(EMBED_MODEL);
    expect(embeddingCacheUsable(root)).toBe(true);
    await run('refresh', '--if-present');
    expect(spies.available).toHaveBeenCalled();
  });

  it('sleep done gates its post-sleep refresh on usability, not existence', () => {
    const src = readFileSync(join(cwd, 'src/cli/commands/sleep.ts'), 'utf8');
    // The guard may carry more terms (a detached refresh spawn); usability must lead it.
    expect(src).toMatch(/if \(embeddingCacheUsable\(root\)[ )&]/);
    expect(src).not.toContain('embeddingCacheExists');
  });
});
