import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docKey, type CorpusDoc } from '../../src/lib/recall.js';
import { withStaleIndexLabel } from '../../src/cli/commands/hook.js';
import { noteIndexStop, readIndexStop } from '../../src/lib/embeddings/index-stop.js';
import { listInboxRows } from '../../src/lib/owner-inbox.js';

const doc = (type: CorpusDoc['type'], relPath: string, slug: string): CorpusDoc => ({ type, relPath, slug } as unknown as CorpusDoc);

describe('docKey is unique per file', () => {
  it('keys a task\'s side files by their path under state/, so two tasks\' plan-r1.md never share a key', () => {
    const a = doc('task', 'state/assets/alpha-task/plan-r1.md', 'plan-r1');
    const b = doc('task', 'state/assets/beta-task/plan-r1.md', 'plan-r1');
    expect(docKey(a)).toBe('task/assets/alpha-task/plan-r1');
    expect(docKey(b)).toBe('task/assets/beta-task/plan-r1');
    // an archived copy never takes its live card's key
    expect(docKey(doc('task', 'state/archive/foo.md', 'foo'))).toBe('task/archive/foo');
    expect(docKey(doc('task', 'state/foo.md', 'foo'))).toBe('task/foo');
    expect(docKey(doc('knowledge', 'knowledge/patterns/x.md', 'x'))).toBe('knowledge/x');
  });
});

describe('a stopped index is never silent', () => {
  let tmp: string;
  let home: string;
  let root: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dc-index-stale-'));
    home = join(tmp, 'home');
    root = join(tmp, 'vault', '_dream_context');
    mkdirSync(join(root, '.embeddings'), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(root, '.embeddings', 'voyage-4.meta.json'), JSON.stringify({ updatedAt: '2026-11-01T12:26:30.434Z' }));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('the banner says the meaning index is stale, as of when it last landed', () => {
    const timing = { tier: 'cloud-index' as const, querySource: 'nano' as const, fallback: 'none' as const };
    expect(withStaleIndexLabel('Hybrid · cloud-index', root, timing)).toBe('Hybrid · cloud-index');
    noteIndexStop(root, { reason: 'daily_index_cap' }, home);
    const label = withStaleIndexLabel('Hybrid · cloud-index', root, timing);
    expect(label).toBe('Hybrid · cloud-index · meaning index stale since 2026-11-01');
    expect(withStaleIndexLabel(label, root, timing)).toBe(label);
    // hook-latency parses the header: no parentheses or commas
    expect(label).not.toMatch(/[(),]/);
    // a local tier never read the cloud index
    expect(withStaleIndexLabel('Hybrid · local', root, { ...timing, tier: 'local' })).toBe('Hybrid · local');
  });

  it('raises the owner row once per stop, again only when the reason changes', () => {
    const rows = () => listInboxRows(join(root, '..'), home).filter((r) => r.kind === 'recall-index-stopped');
    noteIndexStop(root, { reason: 'daily_index_cap' }, home);
    noteIndexStop(root, { reason: 'daily_index_cap' }, home);
    expect(rows()).toHaveLength(1);
    expect(JSON.parse(rows()[0].detail!)).toMatchObject({ reason: 'daily_index_cap', asOf: '2026-11-01T12:26:30.434Z' });
    const since = readIndexStop(root)!.since;
    noteIndexStop(root, { reason: 'max_usd', estUsd: 1.4 }, home);
    expect(rows()).toHaveLength(1);
    expect(JSON.parse(rows()[0].detail!)).toMatchObject({ reason: 'max_usd', estUsd: 1.4 });
    expect(readIndexStop(root)!.since).toBe(since);
  });
});
