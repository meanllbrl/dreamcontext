import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildCorpus,
  bm25Search,
  docLevel,
  CORPUS_TYPES,
  DEFAULT_DOC_LEVEL,
  MAX_INDEXED_AUTOMATION_RUNS,
  type CorpusDoc,
} from '../../src/lib/recall.js';
import { writeFrontmatter } from '../../src/lib/frontmatter.js';
import { TYPE_LABELS, parseTypes, parseLevel, levelBadge } from '../../src/cli/commands/memory.js';

// Coverage for the two halves of "recall must span every channel, at a level you
// choose": the `automation` corpus channel (manifests + run outputs) and the
// derived importance level that `--level` / `?level=` filter on.

let root: string;

function writeAutomation(slug: string, data: Record<string, unknown>, body = ''): void {
  mkdirSync(join(root, 'automations'), { recursive: true });
  writeFrontmatter(join(root, 'automations', `${slug}.md`), { slug, ...data }, body);
}

function writeRunOutput(automation: string, runId: string, body: string, mtime?: Date): void {
  const dir = join(root, 'automations', 'output', automation);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${runId}.md`);
  writeFileSync(path, body, 'utf-8');
  if (mtime) utimesSync(path, mtime, mtime);
}

function writeKnowledge(slug: string, data: Record<string, unknown>, body = ''): void {
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  writeFrontmatter(join(root, 'knowledge', `${slug}.md`), { name: slug, ...data }, body);
}

function writeTask(slug: string, data: Record<string, unknown>, body = ''): void {
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFrontmatter(join(root, 'state', `${slug}.md`), { name: slug, ...data }, body);
}

function of(corpus: CorpusDoc[], slug: string): CorpusDoc {
  const doc = corpus.find((d) => d.slug === slug);
  if (!doc) throw new Error(`no doc ${slug} in corpus (${corpus.map((d) => d.slug).join(', ')})`);
  return doc;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-recall-automation-'));
  mkdirSync(join(root, 'core'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('automation corpus channel', () => {
  it('indexes automation manifests by default (no --types needed)', () => {
    writeAutomation('daily-digest', {
      title: 'Daily digest',
      enabled: true,
      schedule: 'every day at 18:00',
    }, 'Summarise what shipped today and write it to the output dir.');

    const docs = buildCorpus(root).filter((d) => d.type === 'automation');
    expect(docs).toHaveLength(1);
    expect(docs[0].slug).toBe('daily-digest');
    expect(docs[0].title).toBe('Daily digest');
  });

  it('a manifest is findable by its prompt AND by its learned Pattern lessons', () => {
    writeAutomation('daily-digest', { title: 'Daily digest', enabled: true }, [
      'Summarise what shipped today.',
      '',
      '## Pattern',
      '',
      '### Lessons',
      '- The Paddle adapter rate-limits above 4 requests per second; batch them.',
    ].join('\n'));

    const corpus = buildCorpus(root);
    // The whole point of indexing the manifest: a job's accumulated lessons stop
    // being write-only, so a session can find what a previous run learned.
    const hits = bm25Search('paddle rate limit', corpus, 5);
    expect(hits[0]?.doc.slug).toBe('daily-digest');
  });

  it('indexes run outputs as capture-flagged docs, separate from the manifest', () => {
    writeAutomation('daily-digest', { title: 'Daily digest', enabled: true }, 'Summarise.');
    writeRunOutput('daily-digest', '2026-07-27', 'Shipped 3 fixes; the notifier bundle was stale.');

    const docs = buildCorpus(root).filter((d) => d.type === 'automation');
    expect(docs.map((d) => d.slug).sort()).toEqual(['daily-digest', 'run#daily-digest-2026-07-27']);

    const run = of(docs, 'run#daily-digest-2026-07-27');
    // capture: a run log is machine-generated and unreviewed, so it must be
    // rank-penalised against curated docs (same contract as session digests).
    expect(run.capture).toBe(true);
    expect(of(docs, 'daily-digest').capture).not.toBe(true);
  });

  it('a run output is findable by what the run actually reported', () => {
    writeRunOutput('daily-digest', '2026-07-27', '6 insights refreshed; demo-broken-api failed as expected.');
    const hits = bm25Search('broken api failed', buildCorpus(root), 5);
    expect(hits[0]?.doc.slug).toBe('run#daily-digest-2026-07-27');
  });

  it('caps run outputs at MAX_INDEXED_AUTOMATION_RUNS, keeping the NEWEST', () => {
    const total = MAX_INDEXED_AUTOMATION_RUNS + 5;
    // Ascending mtimes: run-0 oldest … run-(total-1) newest.
    for (let i = 0; i < total; i++) {
      writeRunOutput('daily-digest', `run-${i}`, `run number ${i}`, new Date(2026, 0, 1 + i));
    }

    const runs = buildCorpus(root).filter((d) => d.slug.startsWith('run#'));
    expect(runs).toHaveLength(MAX_INDEXED_AUTOMATION_RUNS);
    // The 5 oldest are dropped, not the 5 newest.
    const slugs = new Set(runs.map((d) => d.slug));
    expect(slugs.has(`run#daily-digest-run-${total - 1}`)).toBe(true);
    expect(slugs.has('run#daily-digest-run-0')).toBe(false);
  });

  it('never indexes the machine-local cache dir or its JSON', () => {
    writeAutomation('daily-digest', { title: 'Daily digest', enabled: true }, 'Summarise.');
    const cacheDir = join(root, 'automations', 'cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'daily-digest.json'), '{"lastRun":"2026-07-27"}', 'utf-8');
    // A stray .md inside cache/ must not be mistaken for a manifest.
    writeFileSync(join(cacheDir, 'stray.md'), '# not a manifest', 'utf-8');

    const docs = buildCorpus(root).filter((d) => d.type === 'automation');
    expect(docs.map((d) => d.slug)).toEqual(['daily-digest']);
  });

  it('`automation` is in CORPUS_TYPES, parseTypes and TYPE_LABELS', () => {
    expect(CORPUS_TYPES).toContain('automation');
    expect(parseTypes('automation')).toEqual(['automation']);
    expect(TYPE_LABELS.automation).toBe('automation');
  });

  it('every CORPUS_TYPES member is parseable and labelled (drift lock)', () => {
    // The bug this pins: `objective`/`insight`/`thesis` were live in the engine
    // while a hand-written list elsewhere still filtered them out.
    for (const t of CORPUS_TYPES) {
      expect(parseTypes(t), `parseTypes rejected ${t}`).toEqual([t]);
      expect(TYPE_LABELS[t], `no label for ${t}`).toBeTruthy();
    }
  });
});

describe('derived importance level', () => {
  it('defaults to DEFAULT_DOC_LEVEL when a doc carries no marker', () => {
    writeKnowledge('plain-doc', {}, 'Nothing special here.');
    expect(docLevel(of(buildCorpus(root), 'plain-doc'))).toBe(DEFAULT_DOC_LEVEL);
  });

  it('pinned knowledge is level 3', () => {
    writeKnowledge('pinned-doc', { pinned: true }, 'Loads every session.');
    expect(docLevel(of(buildCorpus(root), 'pinned-doc'))).toBe(3);
  });

  it('a star marker raises the level, and never lowers it', () => {
    writeKnowledge('starred', {}, 'A ★★★ critical footgun.');
    writeKnowledge('one-star', {}, 'A ★ noted detail.');
    // pinned (3) with a single ★ (2) present stays 3 — stars only raise.
    writeKnowledge('pinned-one-star', { pinned: true }, 'A ★ noted detail.');

    const corpus = buildCorpus(root);
    expect(docLevel(of(corpus, 'starred'))).toBe(3);
    expect(docLevel(of(corpus, 'one-star'))).toBe(2);
    expect(docLevel(of(corpus, 'pinned-one-star'))).toBe(3);
  });

  it('task priority DEMOTES but never promotes', () => {
    // Regression lock for the miscalibration that shipped first: mapping
    // `priority: high` → 3 made 151 of 172 level-3 docs tasks and buried the
    // pinned/starred knowledge the filter exists to surface.
    writeTask('urgent-task', { priority: 'high' }, 'Ship it.');
    writeTask('low-task', { priority: 'low' }, 'Someday.');
    writeTask('starred-task', { priority: 'high' }, 'A ★★ reusable pattern lives here.');

    const corpus = buildCorpus(root);
    expect(docLevel(of(corpus, 'urgent-task'))).toBe(2);
    expect(docLevel(of(corpus, 'low-task'))).toBe(1);
    expect(docLevel(of(corpus, 'starred-task'))).toBe(3);
  });

  it('an explicit `level:` frontmatter override wins over every derived signal', () => {
    writeKnowledge('forced-low', { pinned: true, level: 1 }, 'Pinned but explicitly deprioritised.');
    writeKnowledge('forced-high', { level: 3 }, 'No marker, but the author says it matters.');

    const corpus = buildCorpus(root);
    expect(docLevel(of(corpus, 'forced-low'))).toBe(1);
    expect(docLevel(of(corpus, 'forced-high'))).toBe(3);
  });

  it('a thesis is level 3 once settled, 2 while open, 1 while draft', () => {
    mkdirSync(join(root, 'theses'), { recursive: true });
    for (const [slug, status] of [['done', 'validated'], ['live', 'open'], ['idea', 'draft']]) {
      writeFrontmatter(join(root, 'theses', `${slug}.md`), { claim: `claim ${slug}`, status }, '');
    }
    const corpus = buildCorpus(root);
    expect(docLevel(of(corpus, 'done'))).toBe(3);
    expect(docLevel(of(corpus, 'live'))).toBe(2);
    expect(docLevel(of(corpus, 'idea'))).toBe(1);
  });

  it('an insight bound to an objective KR is level 3; an unbound one is 2', () => {
    mkdirSync(join(root, 'lab', 'insights'), { recursive: true });
    writeFrontmatter(join(root, 'lab', 'insights', 'mrr.md'),
      { title: 'MRR', binding: { objective: 'make-it-a-business', value: 'latest' } }, '## Meaning');
    writeFrontmatter(join(root, 'lab', 'insights', 'dau.md'), { title: 'DAU' }, '## Meaning');

    const corpus = buildCorpus(root);
    expect(docLevel(of(corpus, 'mrr'))).toBe(3);
    expect(docLevel(of(corpus, 'dau'))).toBe(2);
  });

  it('a disabled automation is level 1; an enabled one is 2; run outputs are 1', () => {
    writeAutomation('on', { title: 'On', enabled: true }, 'Run me.');
    writeAutomation('off', { title: 'Off', enabled: false }, 'Paused.');
    writeRunOutput('on', '2026-07-27', 'It ran.');

    const corpus = buildCorpus(root);
    expect(docLevel(of(corpus, 'on'))).toBe(2);
    expect(docLevel(of(corpus, 'off'))).toBe(1);
    expect(docLevel(of(corpus, 'run#on-2026-07-27'))).toBe(1);
  });

  it('changelog entries are level 1 — they point at work, they are not the work', () => {
    writeFileSync(join(root, 'core', 'CHANGELOG.json'), JSON.stringify([
      { date: '2026-07-27', type: 'feat', scope: 'recall', description: 'added the automation channel' },
    ]), 'utf-8');
    const corpus = buildCorpus(root);
    const entry = corpus.find((d) => d.type === 'changelog');
    expect(entry).toBeDefined();
    expect(docLevel(entry as CorpusDoc)).toBe(1);
  });

  it('a bookmark carries its salience through as the level', () => {
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, 'state', '.sleep.json'), JSON.stringify({
      bookmarks: [
        { id: 'a', message: 'critical decision about the notifier', salience: 3 },
        { id: 'b', message: 'a passing observation', salience: 1 },
      ],
    }), 'utf-8');
    const corpus = buildCorpus(root);
    expect(docLevel(of(corpus, 'bookmark#a'))).toBe(3);
    expect(docLevel(of(corpus, 'bookmark#b'))).toBe(1);
  });
});

describe('minLevel corpus filter', () => {
  beforeEach(() => {
    writeKnowledge('pinned-doc', { pinned: true }, 'Important.');
    writeKnowledge('plain-doc', {}, 'Normal.');
    writeTask('low-task', { priority: 'low' }, 'Someday.');
  });

  it('undefined minLevel is a no-op — the default corpus is unchanged', () => {
    expect(buildCorpus(root)).toHaveLength(buildCorpus(root, {}).length);
    expect(buildCorpus(root).map((d) => d.slug).sort())
      .toEqual(['low-task', 'pinned-doc', 'plain-doc']);
  });

  it('minLevel keeps docs at that level AND above', () => {
    expect(buildCorpus(root, { minLevel: 1 }).map((d) => d.slug).sort())
      .toEqual(['low-task', 'pinned-doc', 'plain-doc']);
    expect(buildCorpus(root, { minLevel: 2 }).map((d) => d.slug).sort())
      .toEqual(['pinned-doc', 'plain-doc']);
    expect(buildCorpus(root, { minLevel: 3 }).map((d) => d.slug))
      .toEqual(['pinned-doc']);
  });

  it('composes with the types filter', () => {
    expect(buildCorpus(root, { types: ['knowledge'], minLevel: 3 }).map((d) => d.slug))
      .toEqual(['pinned-doc']);
    expect(buildCorpus(root, { types: ['task'], minLevel: 3 })).toEqual([]);
  });

  it('filters BEFORE scoring, so a level-scoped search never returns a low hit', () => {
    // The invariant that keeps `--level` honest: it is a corpus scope, not a
    // re-ranker — nothing derived may touch `hit.score` (decoupling invariant).
    const hits = bm25Search('normal important someday', buildCorpus(root, { minLevel: 3 }), 10);
    expect(hits.map((h) => h.doc.slug)).toEqual(['pinned-doc']);
  });
});

describe('level CLI helpers', () => {
  it('parseLevel accepts 1-3 and rejects everything else', () => {
    expect(parseLevel('1')).toBe(1);
    expect(parseLevel('2')).toBe(2);
    expect(parseLevel('3')).toBe(3);
    // Out-of-range is ignored, NOT clamped: `--level 9` means the caller
    // misread the scale, and silently treating it as 3 would hide results.
    expect(parseLevel('0')).toBeUndefined();
    expect(parseLevel('4')).toBeUndefined();
    expect(parseLevel('high')).toBeUndefined();
    expect(parseLevel(undefined)).toBeUndefined();
  });

  it('levelBadge renders the project star notation', () => {
    expect(levelBadge(1)).toBe('★');
    expect(levelBadge(2)).toBe('★★');
    expect(levelBadge(3)).toBe('★★★');
  });
});
