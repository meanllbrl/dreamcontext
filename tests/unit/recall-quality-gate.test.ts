import { describe, it, expect } from 'vitest';

import {
  bm25Search,
  collapseTaskFamilies,
  isTaskSideFile,
  queryTermCount,
  strongRecallHit,
  taskFamilyOf,
  tokenize,
  RECALL_GATE_MIN_COVERAGE,
  TASK_SIDE_RANK_FACTOR,
  type CorpusDoc,
  type RecallHit,
} from '../../src/lib/recall.js';
import { shouldSkipDense } from '../../src/lib/embeddings/hybrid.js';
import { FUSION_BY_TIER } from '../../src/lib/embeddings/fusion-config.js';
import { renderRecallBlock, toWirePromptHit } from '../../src/cli/commands/hook.js';

// Overnight audit wave 2, W1 "Recall quality": MM-5 (the injection gate), MM-8 (a task's side files
// and one slot per task), MM-12 (the dense gate scales with query length).

function mkDoc(relPath: string, body: string, type: CorpusDoc['type'] = 'task'): CorpusDoc {
  const slug = relPath.split('/').pop()!.replace(/\.md$/, '');
  const tokens = tokenize(body);
  const termFreq = new Map<string, number>();
  for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
  return {
    type, path: `/x/${relPath}`, relPath, slug, title: '', description: '', tags: [], body,
    tokens, tokenSet: new Set(tokens), termFreq, fieldFreq: new Map(termFreq), fieldLen: tokens.length,
    links: [], identityTokens: tokenize(slug),
  };
}

const NOW = new Date('2026-11-12T00:00:00Z');
const filler = [
  mkDoc('knowledge/a.md', 'deployment pipelines and release trains', 'knowledge'),
  mkDoc('knowledge/b.md', 'font loading and image formats', 'knowledge'),
  mkDoc('knowledge/c.md', 'calendar sync and webhook retries', 'knowledge'),
];

describe('MM-5: filler turns carry no search terms', () => {
  it.each(['tamam devam et lütfen', 'ok looks good, continue', 'evet devam', 'thanks, go ahead', 'tamam, aynen öyle yap'])(
    '%s tokenizes to nothing',
    (q) => expect(tokenize(q)).toEqual([]),
  );
});

describe('MM-5: bm25Search reports what share of the query a hit matched', () => {
  it('coverage is the matched share of the query IDF mass; matched counts distinct terms', () => {
    const corpus = [...filler, mkDoc('knowledge/w.md', 'webhook retries backoff jitter', 'knowledge')];
    const [top] = bm25Search('webhook backoff zebra', corpus, 5, { now: NOW });
    expect(top.doc.relPath).toBe('knowledge/w.md');
    expect(top.matched).toBe(2);
    expect(top.coverage).toBeGreaterThan(0.3); // "zebra" (unmatched) is the rarest term, so it holds the largest share
    expect(top.coverage).toBeLessThan(1);
  });

  it('strongRecallHit: raw score, a coverage floor, and two matched words for a short query', () => {
    expect(strongRecallHit({ score: 1.9, coverage: 1, matched: 5 }, 5)).toBe(false);
    expect(strongRecallHit({ score: 9, coverage: RECALL_GATE_MIN_COVERAGE - 0.01, matched: 5 }, 9)).toBe(false);
    expect(strongRecallHit({ score: 9, coverage: 0.2, matched: 1 }, 5)).toBe(true);
    expect(strongRecallHit({ score: 9, coverage: 1, matched: 1 }, queryTermCount('ne durumdayız'))).toBe(false);
    expect(strongRecallHit({ score: 9, coverage: 1, matched: 2 }, 2)).toBe(true);
    // No coverage on the hit (Haiku, an older server): the raw rule.
    expect(strongRecallHit({ score: 2 }, 1)).toBe(true);
  });
});

describe('MM-8: a task is one slot, its side files rank below the card', () => {
  it('taskFamilyOf names the parent task of a card, an archived card and an asset', () => {
    expect(taskFamilyOf(mkDoc('state/fix-login.md', 'x'))).toBe('fix-login');
    expect(taskFamilyOf(mkDoc('state/archive/fix-login.md', 'x'))).toBe('fix-login');
    expect(taskFamilyOf(mkDoc('state/assets/fix-login/plan-r1.md', 'x'))).toBe('fix-login');
    expect(taskFamilyOf(mkDoc('knowledge/fix-login.md', 'x', 'knowledge'))).toBeNull();
    expect(isTaskSideFile(mkDoc('state/assets/fix-login/plan-r1.md', 'x'))).toBe(true);
    expect(isTaskSideFile(mkDoc('state/fix-login.md', 'x'))).toBe(false);
  });

  it('collapseTaskFamilies keeps the best hit of each task, counts the rest, and fills topK with others', () => {
    const h = (relPath: string): RecallHit => ({ doc: mkDoc(relPath, 'x'), score: 3, rankScore: 3, snippet: '' });
    const ranked = [
      h('state/assets/fix-login/plan-r1.md'),
      h('state/fix-login.md'),
      h('state/assets/fix-login/plan-r2.md'),
      h('state/other.md'),
      h('state/third.md'),
    ];
    const out = collapseTaskFamilies(ranked, 2);
    expect(out.map((x) => x.doc.relPath)).toEqual(['state/assets/fix-login/plan-r1.md', 'state/other.md']);
    expect(out[0].family).toBe(2);
    expect(out[1].family).toBeUndefined();
  });

  it('bm25Search folds a task family only when asked, and ranks an equal-text asset below its card', () => {
    const body = 'snapshot budget demotion ladder order';
    const corpus = [
      ...filler,
      mkDoc('state/assets/snap-plan/plan-v1.md', body),
      mkDoc('state/assets/snap-plan/plan-v2.md', body),
      mkDoc('state/snap-plan.md', body),
    ];
    // Unasked, every file is listed (the search box, the Assistant, federation): nothing vanishes silently.
    expect(bm25Search(body, corpus, 5, { now: NOW }).filter((x) => taskFamilyOf(x.doc) === 'snap-plan')).toHaveLength(3);
    const hits = bm25Search(body, corpus, 5, { now: NOW, collapseFamilies: true });
    expect(hits.filter((x) => taskFamilyOf(x.doc) === 'snap-plan')).toHaveLength(1);
    expect(hits[0].doc.relPath).toBe('state/snap-plan.md');
    expect(hits[0].family).toBe(2);
    // The raw score the gate reads is untouched by the side-file factor.
    const raw = bm25Search(body, corpus, 5, { now: NOW });
    const card = raw.find((x) => x.doc.relPath === 'state/snap-plan.md')!;
    const asset = raw.find((x) => x.doc.relPath === 'state/assets/snap-plan/plan-v1.md')!;
    expect(asset.score).toBeCloseTo(card.score, 10);
    expect(asset.rankScore / card.rankScore).toBeCloseTo(TASK_SIDE_RANK_FACTOR, 5);
  });

  it('the hook prints the folded count beside the hit size, and the wire carries it', () => {
    const doc = mkDoc('state/snap-plan.md', 'snapshot budget');
    const hit: RecallHit = { doc, score: 4, rankScore: 4, snippet: '', coverage: 0.5, matched: 2, family: 3 };
    expect(renderRecallBlock([hit], 'BM25').join('\n')).toContain('+3 more files of this task');
    const wire = toWirePromptHit(hit);
    expect(wire).toMatchObject({ coverage: 0.5, matched: 2, family: 3 });
  });
});

describe('MM-12: the dense gate scales with query length', () => {
  const gate = FUSION_BY_TIER['cloud-index'].denseGate!;
  const hit = (score: number, rankScore: number): RecallHit => ({ doc: filler[0], score, rankScore, snippet: '' });

  it('a query no longer than the tuned length is gated exactly as before', () => {
    expect(gate.refTerms).toBeGreaterThan(0);
    expect(shouldSkipDense([hit(gate.rawSure, 1)], gate, gate.refTerms!)).toBe(true);
    expect(shouldSkipDense([hit(gate.rawSure, 1)], gate, 0)).toBe(true);
  });

  it('a long prompt needs proportionally more raw score before dense is skipped', () => {
    const terms = gate.refTerms! * 4;
    expect(shouldSkipDense([hit(gate.rawSure * 2, 1)], gate, terms)).toBe(false);
    expect(shouldSkipDense([hit(gate.rawSure * 4, 1)], gate, terms)).toBe(true);
    // The lead rule scales too.
    expect(shouldSkipDense([hit(gate.rawLead * 2, 10), hit(1, 1)], gate, terms)).toBe(false);
  });
});

describe('MM-8: every surface that folds says so', () => {
  it('memory recall prints the folded count and its wire carries it', async () => {
    const { familyNote, toWireQueryHit } = await import('../../src/cli/commands/memory.js');
    const hit: RecallHit = { doc: mkDoc('state/snap-plan.md', 'x'), score: 4, rankScore: 4, snippet: '', family: 1 };
    expect(familyNote(hit)).toBe('  (+1 more file of this task)');
    expect(familyNote({ family: undefined })).toBe('');
    expect(toWireQueryHit(hit).family).toBe(1);
  });
});
