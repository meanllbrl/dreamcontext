import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  bm25Search, buildCorpus, docFieldTermFreq, docHasTerm, docTermFreq, type CorpusDoc,
} from '../../src/lib/recall.js';
import { buildCorpusCached, resetCorpusCacheMemo } from '../../src/lib/recall-corpus-cache.js';
import { writeDigest } from '../../src/lib/session-digest.js';

// The corpus cache may only ever make buildCorpus FASTER. Every test here pins that: the
// cached corpus is deep-equal to a plain build, whatever happened to the vault since the
// cache was written.

const NOW = new Date('2026-10-07T00:00:00Z');
const CACHE_FILE = (root: string): string => join(root, '.recall-cache', 'corpus.json');

let tmp: string;
let root: string;

function write(rel: string, content: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function md(title: string, body: string, extra = ''): string {
  return `---\nname: ${title}\ndescription: ${title} description\ntags: [alpha, beta]\n${extra}---\n\n${body}\n`;
}

function seedVault(): void {
  write('knowledge/scheduler.md', md('Scheduler', 'The scheduler runs jobs every morning.\nSecond line about retries.'));
  write('knowledge/gateway.md', md('Gateway', 'Gateway routing and sunucusunda zamanlayıcı notları.'));
  write('knowledge/features/billing.md', md('Billing', 'Billing feature body with invoices.', 'status: in_progress\n'));
  write('state/fix-the-login-bug.md', md('Fix the login bug', 'Task about the login bug and cookies.', 'status: completed\nupdated_at: 2026-09-30\n'));
  write('core/2.memory.md', '# Memory\n\n## Decision one ★★\n\nWe chose the scheduler design.\n');
  write('core/CHANGELOG.json', JSON.stringify([
    { date: '2026-10-01', type: 'feat', scope: 'scheduler', description: 'Added the scheduler', summary: 'scheduler added' },
    { date: '2026-10-02', type: 'fix', scope: 'gateway', description: 'Fixed gateway routing' },
  ]));
}

function search(corpus: CorpusDoc[], query: string) {
  return bm25Search(query, corpus, 5, { now: NOW }).map((h) => ({
    key: `${h.doc.type}/${h.doc.slug}`, score: h.score, rankScore: h.rankScore, snippet: h.snippet,
  }));
}

function expectSameAsPlain(): void {
  const plain = buildCorpus(root);
  const cached = buildCorpusCached(root);
  expect(cached.length).toBe(plain.length);
  expect(cached).toEqual(plain);
  for (const query of ['scheduler jobs', 'gateway routing', 'login bug cookies', 'billing invoices']) {
    expect(search(cached, query)).toEqual(search(plain, query));
  }
}

/** Rewrite one stored doc's title in the cache file — the only way to tell "served from the cache" from "rebuilt". */
function tamperTitle(slug: string, sentinel: string): void {
  const file = CACHE_FILE(root);
  const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { entries: Array<{ docs: Array<Record<string, unknown>> }> };
  let hit = false;
  for (const entry of parsed.entries) for (const doc of entry.docs) {
    if (doc.slug === slug) { doc.title = sentinel; hit = true; }
  }
  expect(hit).toBe(true);
  writeFileSync(file, JSON.stringify(parsed));
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'recall-corpus-cache-'));
  root = join(tmp, '_dream_context');
  mkdirSync(root, { recursive: true });
  seedVault();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('buildCorpusCached: equivalent to buildCorpus', () => {
  it('cold build (writes the cache) equals a plain build', () => {
    expect(existsSync(CACHE_FILE(root))).toBe(false);
    expectSameAsPlain();
    expect(existsSync(CACHE_FILE(root))).toBe(true);
    expect(readFileSync(join(root, '.recall-cache', '.gitignore'), 'utf-8')).toBe('*\n');
  });

  it('warm build (served from the cache) equals a plain build', () => {
    buildCorpusCached(root);
    expectSameAsPlain();
  });

  it('really serves an unchanged file from the cache', () => {
    buildCorpusCached(root);
    tamperTitle('scheduler', 'SERVED-FROM-CACHE');
    const titles = buildCorpusCached(root).map((d) => d.title);
    expect(titles).toContain('SERVED-FROM-CACHE');
  });

  it('a revived doc keeps tokens lazy but equal, and tokenCount out of enumeration', () => {
    buildCorpusCached(root);
    const cached = buildCorpusCached(root);
    const plain = buildCorpus(root);
    const doc = cached.find((d) => d.slug === 'scheduler')!;
    expect(Object.keys(doc)).toContain('tokens');
    expect(Object.keys(doc)).not.toContain('tokenCount');
    expect(doc.tokenCount).toBe(plain.find((d) => d.slug === 'scheduler')!.tokens.length);
    expect(doc.tokens).toEqual(plain.find((d) => d.slug === 'scheduler')!.tokens);
  });
});

describe('buildCorpusCached: invalidation', () => {
  it('re-parses a file whose content changed and leaves the others cached', () => {
    buildCorpusCached(root);
    tamperTitle('gateway', 'GATEWAY-STALE');
    tamperTitle('scheduler', 'SCHEDULER-CACHED');
    write('knowledge/gateway.md', md('Gateway', 'Gateway routing rewritten with entirely new content here.'));
    const titles = buildCorpusCached(root).map((d) => d.title);
    expect(titles).not.toContain('GATEWAY-STALE');
    expect(titles).toContain('SCHEDULER-CACHED');
    const gateway = (corpus: CorpusDoc[]): CorpusDoc | undefined => corpus.find((d) => d.slug === 'gateway');
    expect(gateway(buildCorpusCached(root))).toEqual(gateway(buildCorpus(root)));
  });

  it('picks up an added file and drops a deleted one', () => {
    buildCorpusCached(root);
    write('knowledge/newdoc.md', md('Newdoc', 'Brand new document about quasars.'));
    rmSync(join(root, 'knowledge', 'gateway.md'));
    const slugs = buildCorpusCached(root).map((d) => d.slug);
    expect(slugs).toContain('newdoc');
    expect(slugs).not.toContain('gateway');
    expectSameAsPlain();
    // And the deletion reached the cache: a later build does not resurrect it.
    expect(buildCorpusCached(root).map((d) => d.slug)).not.toContain('gateway');
  });

  it('follows the changelog file', () => {
    buildCorpusCached(root);
    write('core/CHANGELOG.json', JSON.stringify([
      { date: '2026-10-03', type: 'feat', scope: 'billing', description: 'Added invoices to billing' },
    ]));
    expectSameAsPlain();
  });

  it('re-applies the dark-sibling rule to a file that did not change', () => {
    write('knowledge/diag/notes.md', md('Notes', 'Tooling notes beside a diagram.').replace('name: Notes\n', ''));
    expectSameAsPlain();
    expect(buildCorpusCached(root).map((d) => d.slug)).toContain('notes');
    // A board appears next to it: notes.md is now tooling and must leave the index — unedited.
    write('knowledge/diag/board.excalidraw.md', md('Board', 'Board label text.'));
    expectSameAsPlain();
    expect(buildCorpusCached(root).map((d) => d.slug)).not.toContain('notes');
    // The board goes away again: notes.md must come back (it was cached as dark, never built).
    rmSync(join(root, 'knowledge', 'diag', 'board.excalidraw.md'));
    expectSameAsPlain();
    expect(buildCorpusCached(root).map((d) => d.slug)).toContain('notes');
  });

  it('caches the session digests as a group and follows every digest change', () => {
    writeDigest(root, 'sess-one', '## Decisions\n\nWe moved the scheduler to a queue.\n');
    expectSameAsPlain();
    expect(buildCorpusCached(root).map((d) => d.slug)).toContain('digest#sess-one');

    tamperTitle('digest#sess-one', 'DIGEST-FROM-CACHE');
    expect(buildCorpusCached(root).map((d) => d.title)).toContain('DIGEST-FROM-CACHE');

    writeDigest(root, 'sess-two', '## Notes\n\nBilling invoices were reworked today.\n');
    expect(buildCorpusCached(root).map((d) => d.title)).not.toContain('DIGEST-FROM-CACHE');
    expectSameAsPlain();
    expect(buildCorpusCached(root).map((d) => d.slug)).toEqual(expect.arrayContaining(['digest#sess-one', 'digest#sess-two']));

    writeDigest(root, 'sess-one', '## Decisions\n\nRewritten with quite a lot of additional words here.\n');
    expectSameAsPlain();
  });

  it('discards a cache written by a different build of the tokenizer or loaders', () => {
    buildCorpusCached(root);
    const file = CACHE_FILE(root);
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { fp: string };
    parsed.fp = 'a-different-build';
    writeFileSync(file, JSON.stringify(parsed));
    tamperTitle('scheduler', 'FROM-OTHER-BUILD');
    // tamperTitle rewrote the file with the stale fingerprint kept, so it must be ignored.
    expect(buildCorpusCached(root).map((d) => d.title)).not.toContain('FROM-OTHER-BUILD');
    expectSameAsPlain();
  });

  it('discards a cache that belongs to a different context root', () => {
    buildCorpusCached(root);
    const moved = join(tmp, 'moved', '_dream_context');
    cpSync(root, moved, { recursive: true });
    const docs = buildCorpusCached(moved);
    expect(docs.every((d) => d.path.startsWith(moved))).toBe(true);
  });

  it('survives a corrupt cache file and heals it', () => {
    buildCorpusCached(root);
    writeFileSync(CACHE_FILE(root), '{ not json');
    expectSameAsPlain();
    expect(() => JSON.parse(readFileSync(CACHE_FILE(root), 'utf-8'))).not.toThrow();
  });

  it('keeps the entries of types a narrower build did not walk', () => {
    buildCorpusCached(root);
    buildCorpusCached(root, { types: ['knowledge'] });
    tamperTitle('fix-the-login-bug', 'TASK-STILL-CACHED');
    expect(buildCorpusCached(root).map((d) => d.title)).toContain('TASK-STILL-CACHED');
  });

  it('honours the types and level filters like buildCorpus', () => {
    buildCorpusCached(root);
    expect(buildCorpusCached(root, { types: ['knowledge', 'feature'] }))
      .toEqual(buildCorpus(root, { types: ['knowledge', 'feature'] }));
    expect(buildCorpusCached(root, { minLevel: 3 })).toEqual(buildCorpus(root, { minLevel: 3 }));
  });
});

// The real thing: a copy of the frozen dc eval vault, with every derived channel
// (changelog JSON, memory sections, automation runs, whiteboards, digests) present.
// Skipped on machines without the frozen eval roots.
const FROZEN_DC = join(homedir(), '.dreamcontext', 'eval-frozen', 'dc-20261007', '_dream_context');

describe.skipIf(!existsSync(FROZEN_DC))('buildCorpusCached on a copy of the real frozen dc vault', () => {
  it('is deep-equal to buildCorpus cold and warm, and ranks identically', () => {
    const copyRoot = join(tmp, 'frozen-copy', '_dream_context');
    cpSync(FROZEN_DC, copyRoot, { recursive: true, filter: (src) => !src.includes('/.embeddings') && !src.includes('/.recall-cache') });
    const plain = buildCorpus(copyRoot);
    const cold = buildCorpusCached(copyRoot);
    const warm = buildCorpusCached(copyRoot);
    expect(cold.length).toBe(plain.length);
    expect(cold).toEqual(plain);
    expect(warm).toEqual(plain);
    for (const query of ['dashboard sunucusu güvenlik açıkları', 'recall engine bm25 scoring', 'hook latency', 'whiteboard recall channel']) {
      const expected = bm25Search(query, plain, 10, { now: NOW });
      const actual = bm25Search(query, warm, 10, { now: NOW });
      expect(actual.map((h) => [h.doc.type, h.doc.slug, h.score, h.rankScore, h.snippet]))
        .toEqual(expected.map((h) => [h.doc.type, h.doc.slug, h.score, h.rankScore, h.snippet]));
    }
  }, 120_000);
});

describe('buildCorpusCached: the lazy on-disk shape (format 5)', () => {
  it('writes a pure-ASCII file whose non-ASCII text (and astral characters) survive the round trip', () => {
    write('knowledge/emoji.md', md('Emoji', 'Zamanlayıcı notları — «quoted» 🚀 and café.'));
    buildCorpusCached(root);
    const raw = readFileSync(CACHE_FILE(root));
    expect(raw.every((byte) => byte < 0x80)).toBe(true);
    const warm = buildCorpusCached(root);
    expect(warm).toEqual(buildCorpus(root));
    expect(warm.find((d) => d.slug === 'emoji')!.body).toContain('Zamanlayıcı notları — «quoted» 🚀 and café.');
  });

  it('stores each doc\'s term columns sorted, in step with each other', () => {
    buildCorpusCached(root);
    const parsed = JSON.parse(readFileSync(CACHE_FILE(root), 'utf-8')) as {
      v: number; entries: Array<{ docs: Array<{ terms: string[]; tf: number[]; ff: number[] }> }>;
    };
    expect(parsed.v).toBe(5);
    for (const entry of parsed.entries) for (const doc of entry.docs) {
      expect(doc.terms).toEqual([...doc.terms].sort());
      expect(doc.tf).toHaveLength(doc.terms.length);
      expect(doc.ff).toHaveLength(doc.terms.length);
    }
  });

  it('answers has / tf / field-tf from the columns, without materialising the collections, and matches the maps', () => {
    buildCorpusCached(root);
    const revived = buildCorpusCached(root).find((d) => d.slug === 'scheduler')!;
    const plain = buildCorpus(root).find((d) => d.slug === 'scheduler')!;
    expect(revived.termColumns).toBeDefined();
    const own = (key: string): PropertyDescriptor => Object.getOwnPropertyDescriptor(revived, key)!;
    for (const key of ['tokenSet', 'termFreq', 'fieldFreq']) expect(own(key).get).toBeTypeOf('function');

    for (const term of [...plain.termFreq.keys(), 'absentterm', 'zzz', 'a']) {
      expect(docHasTerm(revived, term)).toBe(plain.tokenSet.has(term));
      expect(docTermFreq(revived, term)).toBe(plain.termFreq.get(term) ?? 0);
      expect(docFieldTermFreq(revived, term)).toBe(plain.fieldFreq?.get(term) ?? plain.termFreq.get(term) ?? 0);
    }
    // searching never forced the collections
    search([revived], 'scheduler jobs retries');
    for (const key of ['tokenSet', 'termFreq', 'fieldFreq']) expect(own(key).get).toBeTypeOf('function');

    // reading one materialises it, equal to the plain one
    expect(revived.termFreq).toEqual(plain.termFreq);
    expect(own('termFreq').get).toBeUndefined();
  });

  it('keeps bodies and token lists out of the JSON, in one named text file', () => {
    buildCorpusCached(root);
    const json = readFileSync(CACHE_FILE(root), 'utf-8');
    const parsed = JSON.parse(json) as { text: string; entries: Array<{ docs: Array<Record<string, unknown>> }> };
    expect(json).not.toContain('The scheduler runs jobs every morning.');
    expect(parsed.text).toMatch(/^corpus-[A-Za-z0-9_-]+\.text$/);
    for (const entry of parsed.entries) for (const doc of entry.docs) {
      expect(doc).not.toHaveProperty('body');
      expect(doc).not.toHaveProperty('tk');
    }
    expect(readFileSync(join(root, '.recall-cache', parsed.text), 'utf-8')).toContain('The scheduler runs jobs every morning.');
  });

  it('decodes a body only when it is read', () => {
    buildCorpusCached(root);
    const revived = buildCorpusCached(root).find((d) => d.slug === 'scheduler')!;
    expect(Object.getOwnPropertyDescriptor(revived, 'body')!.get).toBeTypeOf('function');
    expect(Object.keys(revived)).toContain('body');
    expect(revived.body).toBe(buildCorpus(root).find((d) => d.slug === 'scheduler')!.body);
    expect(Object.getOwnPropertyDescriptor(revived, 'body')!.get).toBeUndefined();
  });

  it('removes the text file a rewrite replaced, and keeps exactly one', () => {
    buildCorpusCached(root);
    const first = (JSON.parse(readFileSync(CACHE_FILE(root), 'utf-8')) as { text: string }).text;
    write('knowledge/gateway.md', md('Gateway', 'Gateway routing rewritten.'));
    expect(buildCorpusCached(root)).toEqual(buildCorpus(root));
    const texts = readdirSync(join(root, '.recall-cache')).filter((n) => n.endsWith('.text'));
    expect(texts).toHaveLength(1);
    expect(texts[0]).not.toBe(first);
  });

  it('sweeps an unnamed text file left by a lost race once it is old, never a fresh one', () => {
    buildCorpusCached(root);
    const dir = join(root, '.recall-cache');
    writeFileSync(join(dir, 'corpus-old-race.text'), 'x');
    writeFileSync(join(dir, 'corpus-new-race.text'), 'x');
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(join(dir, 'corpus-old-race.text'), old, old);
    write('knowledge/gateway.md', md('Gateway', 'Gateway routing rewritten again.'));
    buildCorpusCached(root);
    expect(existsSync(join(dir, 'corpus-old-race.text'))).toBe(false);
    expect(existsSync(join(dir, 'corpus-new-race.text'))).toBe(true);
  });

  it('rebuilds correctly when the text file the JSON names is gone', () => {
    buildCorpusCached(root);
    const name = (JSON.parse(readFileSync(CACHE_FILE(root), 'utf-8')) as { text: string }).text;
    unlinkSync(join(root, '.recall-cache', name));
    resetCorpusCacheMemo();
    expectSameAsPlain();
  });

  it('ignores a text name that would leave the cache directory', () => {
    buildCorpusCached(root);
    const parsed = JSON.parse(readFileSync(CACHE_FILE(root), 'utf-8')) as { text: string; entries: Array<{ docs: Array<Record<string, unknown>> }> };
    parsed.text = '../../knowledge/scheduler.md';
    for (const entry of parsed.entries) for (const doc of entry.docs) doc.title = 'MUST-NOT-SERVE';
    writeFileSync(CACHE_FILE(root), JSON.stringify(parsed));
    expect(buildCorpusCached(root).map((d) => d.title)).not.toContain('MUST-NOT-SERVE');
  });

  it('drops a doc whose offsets run past the text file', () => {
    buildCorpusCached(root);
    const parsed = JSON.parse(readFileSync(CACHE_FILE(root), 'utf-8')) as { entries: Array<{ docs: Array<Record<string, unknown>> }> };
    for (const entry of parsed.entries) for (const doc of entry.docs) {
      if (doc.slug === 'scheduler') { doc.bl = 10_000_000; doc.title = 'MUST-NOT-SERVE'; }
    }
    writeFileSync(CACHE_FILE(root), JSON.stringify(parsed));
    const corpus = buildCorpusCached(root);
    expect(corpus.map((d) => d.title)).not.toContain('MUST-NOT-SERVE');
    expect(corpus).toEqual(buildCorpus(root));
  });

  it('a long-lived process parses the file once and follows a rewrite of it', () => {
    buildCorpusCached(root);
    resetCorpusCacheMemo();
    buildCorpusCached(root); // parsed and memoised
    tamperTitle('scheduler', 'AFTER-REWRITE');
    expect(buildCorpusCached(root).map((d) => d.title)).toContain('AFTER-REWRITE');
    // Two revives of the memoised file never share a doc object.
    const a = buildCorpusCached(root).find((d) => d.slug === 'gateway')!;
    const b = buildCorpusCached(root).find((d) => d.slug === 'gateway')!;
    expect(a).not.toBe(b);
    a.title = 'MUTATED';
    expect(b.title).toBe('Gateway');
  });

  it('assigning a term collection drops the columns, so the helpers follow the new value', () => {
    buildCorpusCached(root);
    const revived = buildCorpusCached(root).find((d) => d.slug === 'scheduler')!;
    revived.termFreq = new Map([['onlyterm', 7]]);
    expect(revived.termColumns).toBeUndefined();
    expect(docTermFreq(revived, 'onlyterm')).toBe(7);
    expect(docTermFreq(revived, 'scheduler')).toBe(0);
  });
});
