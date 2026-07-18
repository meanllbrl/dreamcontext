import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  dedupLogPath,
  summarizeDedupLog,
  readDedupDigest,
  renderDedupDigest,
} from '../../src/lib/embeddings/dedup-log.js';

function makeTmpRoot(): string {
  const dir = join(tmpdir(), `dedup-log-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function entry(ts: string, verdict: string): string {
  return JSON.stringify({ ts, title: 't', verdict, topDocKey: 'x', topSim: 0.9 });
}

const tmpRoots: string[] = [];
afterEach(() => {
  while (tmpRoots.length) {
    rmSync(tmpRoots.pop()!, { recursive: true, force: true });
  }
});

describe('dedupLogPath', () => {
  it('joins the context root with .embeddings/dedup-log.jsonl', () => {
    expect(dedupLogPath('/some/root')).toBe(join('/some/root', '.embeddings', 'dedup-log.jsonl'));
  });
});

describe('summarizeDedupLog', () => {
  it('tallies verdicts from the real 2-line shape', () => {
    const raw = [
      entry('2026-07-17T09:06:33.489Z', 'create'),
      entry('2026-07-18T11:47:35.682Z', 'create'),
    ].join('\n');
    const d = summarizeDedupLog(raw, null);
    expect(d).toEqual({ merge: 0, review: 0, create: 2, total: 2, since: null });
  });

  it('counts mixed verdicts exactly, ignoring unknown verdicts', () => {
    const raw = [
      entry('2026-07-01T00:00:00.000Z', 'merge'),
      entry('2026-07-01T00:00:01.000Z', 'merge'),
      entry('2026-07-01T00:00:02.000Z', 'merge'),
      entry('2026-07-01T00:00:03.000Z', 'review'),
      entry('2026-07-01T00:00:04.000Z', 'create'),
      entry('2026-07-01T00:00:05.000Z', 'create'),
      entry('2026-07-01T00:00:06.000Z', 'create'),
      entry('2026-07-01T00:00:07.000Z', 'create'),
      entry('2026-07-01T00:00:08.000Z', 'create'),
      entry('2026-07-01T00:00:09.000Z', 'create'),
      entry('2026-07-01T00:00:10.000Z', 'create'),
      entry('2026-07-01T00:00:11.000Z', 'create'),
      entry('2026-07-01T00:00:12.000Z', 'create'),
      entry('2026-07-01T00:00:13.000Z', 'create'),
      entry('2026-07-01T00:00:14.000Z', 'create'),
      entry('2026-07-01T00:00:15.000Z', 'create'),
      entry('2026-07-01T00:00:16.000Z', 'unknown-verdict'),
    ].join('\n');
    const d = summarizeDedupLog(raw, null);
    expect(d.merge).toBe(3);
    expect(d.review).toBe(1);
    expect(d.create).toBe(12);
    expect(d.total).toBe(16); // unknown-verdict excluded entirely
  });

  it('applies a STRICT since filter (ts > since, not >=)', () => {
    const since = '2026-07-10T00:00:00.000Z';
    const raw = [
      entry('2026-07-09T00:00:00.000Z', 'create'), // before
      entry('2026-07-10T00:00:00.000Z', 'create'), // exactly at since — excluded
      entry('2026-07-11T00:00:00.000Z', 'create'), // after — included
    ].join('\n');
    const d = summarizeDedupLog(raw, since);
    expect(d.create).toBe(1);
    expect(d.total).toBe(1);
  });

  it('since: null counts everything regardless of timestamp', () => {
    const raw = [entry('2020-01-01T00:00:00.000Z', 'merge')].join('\n');
    expect(summarizeDedupLog(raw, null).merge).toBe(1);
  });

  it('skips malformed / truncated JSON lines without throwing', () => {
    const raw = [
      entry('2026-07-01T00:00:00.000Z', 'merge'),
      '{not valid json',
      '',
      '   ',
      entry('2026-07-01T00:00:01.000Z', 'create'),
    ].join('\n');
    expect(() => summarizeDedupLog(raw, null)).not.toThrow();
    const d = summarizeDedupLog(raw, null);
    expect(d.merge).toBe(1);
    expect(d.create).toBe(1);
    expect(d.total).toBe(2);
  });

  it('empty file yields a zeroed digest', () => {
    expect(summarizeDedupLog('', null)).toEqual({ merge: 0, review: 0, create: 0, total: 0, since: null });
  });
});

describe('readDedupDigest', () => {
  it('returns a zeroed digest when the log file is missing', () => {
    const root = makeTmpRoot();
    tmpRoots.push(root);
    expect(readDedupDigest(root, null)).toEqual({ merge: 0, review: 0, create: 0, total: 0, since: null });
  });

  it('reads and summarizes an on-disk log', () => {
    const root = makeTmpRoot();
    tmpRoots.push(root);
    mkdirSync(join(root, '.embeddings'), { recursive: true });
    writeFileSync(dedupLogPath(root), entry('2026-07-18T00:00:00.000Z', 'review') + '\n');
    expect(readDedupDigest(root, null).review).toBe(1);
  });
});

describe('renderDedupDigest', () => {
  it('renders the exact one-line summary format', () => {
    const d = { merge: 3, review: 1, create: 12, total: 16, since: '2026-07-01T00:00:00.000Z' };
    expect(renderDedupDigest(d)).toBe('Semantic dedup since epoch: 3 merge / 1 review / 12 create (16 decisions).');
  });
});
