import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCorpus } from '../../src/lib/recall.js';
import { buildCorpusCached, peerCacheDir } from '../../src/lib/recall-corpus-cache.js';
import { crossVaultRecall } from '../../src/lib/federation-recall.js';
import { addVault } from '../../src/lib/vaults.js';
import { writeSetupConfig, type SetupConfig } from '../../src/lib/setup-config.js';
import { DREAM_EXCLUDED_DIRS } from '../../src/lib/handsfree/manifest.js';

// A connected peer is READ, never written. Its corpus cache lives under the reader's home
// (`<home>/.dreamcontext/recall-cache/<hash>/corpus.json`); the current vault keeps its own
// `<root>/.recall-cache/`. Federation filtering must stay exactly as it was.

const BASE: SetupConfig = {
  platforms: [], packs: [], multiProduct: false, setupVersion: '0.7.0', disableNativeMemory: true,
};

let tmp: string;
let home: string;

function makeVault(name: string): string {
  const project = join(tmp, name);
  mkdirSync(join(project, '_dream_context', 'knowledge'), { recursive: true });
  writeSetupConfig(project, { ...BASE });
  addVault(name, project, home);
  return join(project, '_dream_context');
}

function writeDoc(root: string, rel: string, body: string, extra = ''): void {
  const file = join(root, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `---\ntitle: ${rel}\n${extra}---\n\n${body}\n`);
}

function treeEntries(root: string): string[] {
  return readdirSync(root, { recursive: true }).map(String).sort();
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'recall-peer-cache-'));
  home = join(tmp, 'home');
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('peerCacheDir', () => {
  it('lives under the given home, one directory per real peer path', () => {
    const a = makeVault('alpha');
    const b = makeVault('beta');
    const dir = peerCacheDir(a, home);
    expect(dir.startsWith(join(home, '.dreamcontext', 'recall-cache') + '/')).toBe(true);
    expect(dir.slice(dir.lastIndexOf('/') + 1)).toMatch(/^[0-9a-f]{16}$/);
    expect(peerCacheDir(a, home)).toBe(dir);
    expect(peerCacheDir(b, home)).not.toBe(dir);
  });

  it('resolves symlinks, so two spellings of one vault share a cache', () => {
    const a = makeVault('alpha');
    const link = join(tmp, 'alpha-link');
    symlinkSync(join(tmp, 'alpha'), link);
    expect(peerCacheDir(join(link, '_dream_context'), home)).toBe(peerCacheDir(a, home));
  });

  it('is never inside the vault it caches', () => {
    const a = makeVault('alpha');
    expect(peerCacheDir(a, home).startsWith(a)).toBe(false);
  });
});

describe('buildCorpusCached with a cacheDir', () => {
  it('writes the cache there, nothing inside the vault, and equals a plain build', () => {
    const root = makeVault('alpha');
    writeDoc(root, 'knowledge/gateway.md', 'Gateway routing notes.');
    const before = treeEntries(root);
    const cacheDir = peerCacheDir(root, home);

    const cold = buildCorpusCached(root, { cacheDir });
    expect(cold).toEqual(buildCorpus(root));
    expect(existsSync(join(cacheDir, 'corpus.json'))).toBe(true);
    expect(readFileSync(join(cacheDir, '.gitignore'), 'utf-8')).toBe('*\n');
    expect(treeEntries(root)).toEqual(before);
    expect(existsSync(join(root, '.recall-cache'))).toBe(false);
  });

  it('serves an unchanged file from that cache and follows edits', () => {
    const root = makeVault('alpha');
    writeDoc(root, 'knowledge/gateway.md', 'Gateway routing notes.');
    const cacheDir = peerCacheDir(root, home);
    buildCorpusCached(root, { cacheDir });

    const file = join(cacheDir, 'corpus.json');
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { entries: Array<{ docs: Array<Record<string, unknown>> }> };
    for (const entry of parsed.entries) for (const doc of entry.docs) doc.title = 'FROM-PEER-CACHE';
    writeFileSync(file, JSON.stringify(parsed));
    expect(buildCorpusCached(root, { cacheDir }).map((d) => d.title)).toContain('FROM-PEER-CACHE');

    writeDoc(root, 'knowledge/gateway.md', 'Gateway routing notes, rewritten with a lot more text now.');
    expect(buildCorpusCached(root, { cacheDir })).toEqual(buildCorpus(root));
  });

  it('falls back to a plain build when the cache directory cannot be written', () => {
    const root = makeVault('alpha');
    writeDoc(root, 'knowledge/gateway.md', 'Gateway routing notes.');
    const blocker = join(tmp, 'not-a-dir');
    writeFileSync(blocker, 'a file where the cache directory should go');
    expect(buildCorpusCached(root, { cacheDir: join(blocker, 'cache') })).toEqual(buildCorpus(root));
  });
});

describe('crossVaultRecall through the cache', () => {
  it('never writes into a peer; the current vault keeps its own cache', () => {
    const cur = makeVault('cur');
    const peer = makeVault('peer');
    writeDoc(cur, 'knowledge/cur-doc.md', 'caching strategy notes for the gateway');
    writeDoc(peer, 'knowledge/peer-doc.md', 'caching strategy notes for the gateway');
    const peerBefore = treeEntries(peer);

    const run = () => crossVaultRecall('caching strategy gateway', {
      vaults: [{ name: 'cur', current: true }, { name: 'peer' }],
      home,
      topK: 10,
    });
    const cold = run();
    const warm = run();

    expect(treeEntries(peer)).toEqual(peerBefore);
    expect(existsSync(join(peer, '.recall-cache'))).toBe(false);
    expect(existsSync(join(peerCacheDir(peer, home), 'corpus.json'))).toBe(true);
    expect(existsSync(join(cur, '.recall-cache', 'corpus.json'))).toBe(true);
    expect(existsSync(join(peerCacheDir(cur, home), 'corpus.json'))).toBe(false);
    expect(cold.hits.map((h) => h.vault).sort()).toEqual(['cur', 'peer']);
    expect(warm.hits.map((h) => [h.key, h.score, h.rankScore, h.snippet]))
      .toEqual(cold.hits.map((h) => [h.key, h.score, h.rankScore, h.snippet]));
  });

  it('keeps the federation filters: no peer automations, own automations stay, no ingested docs', () => {
    const cur = makeVault('cur');
    const peer = makeVault('peer');
    writeDoc(cur, 'automations/own-job.md', 'nightly orchard harvest report', 'enabled: true\n');
    writeDoc(peer, 'automations/peer-job.md', 'nightly orchard harvest report', 'enabled: true\n');
    writeDoc(peer, 'knowledge/ingested.md', 'nightly orchard harvest report', 'federated: true\n');
    writeDoc(peer, 'knowledge/native.md', 'nightly orchard harvest report');

    for (const pass of ['cold', 'warm']) {
      const { hits } = crossVaultRecall('nightly orchard harvest report', {
        vaults: [{ name: 'cur', current: true }, { name: 'peer' }],
        home,
        topK: 20,
      });
      const keys = hits.map((h) => h.key);
      expect(keys, pass).toContain('cur::automation/own-job');
      expect(keys, pass).not.toContain('peer::automation/peer-job');
      expect(keys, pass).not.toContain('peer::knowledge/ingested');
      expect(keys, pass).toContain('peer::knowledge/native');
    }
  });
});

describe('hands-free manifest', () => {
  it('never travels the recall cache', () => {
    expect(DREAM_EXCLUDED_DIRS).toContain('.recall-cache');
    expect(DREAM_EXCLUDED_DIRS).toContain('.embeddings');
  });
});
