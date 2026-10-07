import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bm25Search, buildCorpus, CORPUS_TYPES, docKey } from '../../src/lib/recall.js';

/** Scratch context root per test (injectable-root isolation): the real brain is never read. */
let root: string;

function write(rel: string, body: string): void {
  const file = join(root, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, body);
}

beforeEach(() => {
  root = join(realpathSync(mkdtempSync(join(tmpdir(), 'dc-core-recall-'))), '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
  write('core/0.soul.md', '---\nname: "acme"\ntype: soul\n---\n\n## Project Identity\n\nAcme ships quokka telemetry.\n');
  write('core/2.memory.md', '---\nname: active-decisions\ntype: memory\n---\n\n## Active Memory\n\n- [2026-01-01] Decided wombat caching.\n');
  write('core/6.system_flow.md', '---\nname: System Flow\nsummary: Session lifecycle and sleep debt.\nupdated: "2026-10-05"\n---\n\nDebt ≥60 means the axolotl must sleep.\n');
  write('core/objectives/ship-it.md', '---\nname: Ship it\n---\n\nObjective about narwhal launch.\n');
});
afterEach(() => {
  rmSync(join(root, '..'), { recursive: true, force: true });
});

describe('buildCorpus — core channel', () => {
  it('indexes each flat core file except 2.memory.md (its own channel) and subfolders', () => {
    expect(CORPUS_TYPES).toContain('core');
    const keys = buildCorpus(root, { types: ['core'] }).map(docKey).sort();
    expect(keys).toEqual(['core/0.soul', 'core/6.system_flow']);
  });

  it('never double-counts: memory and objectives stay in their own channels', () => {
    const keys = buildCorpus(root).map(docKey);
    expect(keys.filter((k) => k.endsWith('/2.memory'))).toEqual([]);
    expect(keys.filter((k) => k.includes('ship-it'))).toEqual(['objective/ship-it']);
    expect(keys.some((k) => k.startsWith('memory/'))).toBe(true);
  });

  it('reads name as title, summary as description, updated as the date', () => {
    const flow = buildCorpus(root, { types: ['core'] }).find((d) => d.slug === '6.system_flow')!;
    expect(flow.title).toBe('System Flow');
    expect(flow.description).toBe('Session lifecycle and sleep debt.');
    expect(flow.updatedAt).toBe('2026-10-05');
    expect(flow.relPath).toBe('core/6.system_flow.md');
  });

  it('makes extended core content findable', () => {
    const [top] = bm25Search('axolotl sleep debt', buildCorpus(root));
    expect(docKey(top.doc)).toBe('core/6.system_flow');
  });
});
