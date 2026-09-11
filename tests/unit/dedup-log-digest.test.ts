import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  dedupLogPath,
  summarizeDedupLog,
  readDedupDigest,
  renderDedupDigest,
  appendDedupLogEntry,
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

/**
 * The WRITE half. It used to be a private function in `src/cli/commands/embed.ts`
 * with no coverage at all; it moved here because the task-filing bar is a second
 * writer, and two writers of one JSONL format drift unless they share the code
 * AND the reader is proven to still parse what they emit.
 */
describe('appendDedupLogEntry', () => {
  function readLines(root: string): Array<Record<string, unknown>> {
    return readFileSync(dedupLogPath(root), 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it('writes ONE parseable line per call, appending rather than truncating', () => {
    const root = makeTmpRoot();
    tmpRoots.push(root);

    appendDedupLogEntry(root, { title: 'first', verdict: 'create', source: 'embed-cli' });
    appendDedupLogEntry(root, { title: 'second', verdict: 'merge', source: 'filing-bar' });

    const lines = readLines(root);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.title)).toEqual(['first', 'second']);
    expect(lines.map((l) => l.verdict)).toEqual(['create', 'merge']);
  });

  it('stamps `ts` itself — the writer owns the clock the `since` filter compares against', () => {
    const root = makeTmpRoot();
    tmpRoots.push(root);
    const before = new Date().toISOString();

    appendDedupLogEntry(root, { title: 't', verdict: 'create' });

    const ts = readLines(root)[0].ts as string;
    expect(typeof ts).toBe('string');
    expect(ts >= before).toBe(true);
    expect(ts <= new Date().toISOString()).toBe(true);
  });

  it('creates .embeddings/ and its self-ignoring .gitignore — the dir is credential-class', () => {
    const root = makeTmpRoot();
    tmpRoots.push(root);

    appendDedupLogEntry(root, { title: 't', verdict: 'create' });

    expect(readFileSync(join(root, '.embeddings', '.gitignore'), 'utf-8')).toContain('*');
  });

  it('leaves an existing .gitignore alone instead of appending to it every call', () => {
    const root = makeTmpRoot();
    tmpRoots.push(root);
    mkdirSync(join(root, '.embeddings'), { recursive: true });
    writeFileSync(join(root, '.embeddings', '.gitignore'), '*\n');

    appendDedupLogEntry(root, { title: 't', verdict: 'create' });
    appendDedupLogEntry(root, { title: 't2', verdict: 'create' });

    expect(readFileSync(join(root, '.embeddings', '.gitignore'), 'utf-8')).toBe('*\n');
  });

  it('omits absent optional fields, so the `embed dedup` line keeps the shape it always had', () => {
    const root = makeTmpRoot();
    tmpRoots.push(root);

    appendDedupLogEntry(root, {
      title: 'knowledge candidate',
      verdict: 'review',
      source: 'embed-cli',
      topDocKey: 'knowledge/recall-engine',
      topSim: 0.9312,
      mergeThreshold: 0.97,
      reviewThreshold: 0.91,
      neighbors: [{ docKey: 'knowledge/recall-engine', sim: 0.9312 }],
    });

    const line = readLines(root)[0];
    expect(Object.keys(line)).toEqual([
      'ts', 'title', 'verdict', 'source', 'topDocKey', 'topSim',
      'mergeThreshold', 'reviewThreshold', 'neighbors',
    ]);
    expect(line).not.toHaveProperty('type');
    expect(line).not.toHaveProperty('slug');
    expect(line).not.toHaveProperty('neighborChecked');
  });

  it('round-trips a filing-bar `type: task` entry through the digest the sleep summary prints', () => {
    const root = makeTmpRoot();
    tmpRoots.push(root);

    appendDedupLogEntry(root, {
      title: 'A sleep-filed task',
      verdict: 'review',
      type: 'task',
      slug: 'a-sleep-filed-task',
      source: 'filing-bar',
      topDocKey: 'task/the-neighbor',
      topSim: 0.9312,
      neighborChecked: 'the-neighbor',
    });

    const line = readLines(root)[0];
    expect(line.type).toBe('task');
    expect(line.slug).toBe('a-sleep-filed-task');
    expect(line.neighborChecked).toBe('the-neighbor');

    // The reader keys ONLY on ts + verdict, so a task create needs no reader change.
    const digest = readDedupDigest(root, null);
    expect(digest.review).toBe(1);
    expect(digest.total).toBe(1);
    expect(renderDedupDigest(digest)).toContain('1 review');
  });

  it('keeps `since` a STRICT lower bound over entries it wrote itself', () => {
    const root = makeTmpRoot();
    tmpRoots.push(root);

    appendDedupLogEntry(root, { title: 't', verdict: 'create', type: 'task' });
    const ts = readLines(root)[0].ts as string;

    expect(readDedupDigest(root, ts).total).toBe(0);                       // exactly at the epoch
    expect(readDedupDigest(root, '2000-01-01T00:00:00.000Z').total).toBe(1); // after it
  });

  it('SWALLOWS an unwritable log — the caller already made its decision', () => {
    const root = makeTmpRoot();
    tmpRoots.push(root);
    // `.embeddings` exists as a FILE: mkdirSync throws EEXIST for every user,
    // including root (a chmod-based test would not hold in a root container).
    writeFileSync(join(root, '.embeddings'), 'not a directory');

    expect(() => appendDedupLogEntry(root, { title: 't', verdict: 'create' })).not.toThrow();
    expect(existsSync(dedupLogPath(root))).toBe(false);
  });

  it('reports that failure under DREAMCONTEXT_DEBUG rather than vanishing', () => {
    const root = makeTmpRoot();
    tmpRoots.push(root);
    writeFileSync(join(root, '.embeddings'), 'not a directory');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prev = process.env.DREAMCONTEXT_DEBUG;
    process.env.DREAMCONTEXT_DEBUG = '1';

    try {
      appendDedupLogEntry(root, { title: 't', verdict: 'create' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toContain('[dedup-log]');
    } finally {
      if (prev === undefined) delete process.env.DREAMCONTEXT_DEBUG;
      else process.env.DREAMCONTEXT_DEBUG = prev;
      spy.mockRestore();
    }
  });
});
