import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCorpus, docKey } from '../../src/lib/recall.js';
import {
  DELIVER_MIN, PICK_PROMPT_SHIPPED, PICK_PROMPT_V3, confidencePrompt, decide, parsePicks, parseReasons, pickPrompt, picksToKeys, runJudge,
  type JudgeCall, type JudgeCandidate,
} from '../../src/lib/recall-judge.js';
import { judgedRecall, nothingNew } from '../../src/lib/recall-judged.js';
import { markSessionRecall, readPrevOwnerTurn, resetSessionOnce, sessionRecall, writePrevOwnerTurn } from '../../src/lib/hook-delivery.js';
import {
  curatedDocs, pendingDocs, parseWhenAnswer, readWhenLines, runWhenLinesWriter, vaultIdOf, whenLinesLookup,
} from '../../src/lib/when-lines.js';
import { renderJudgedBlock } from '../../src/cli/commands/hook.js';

// No model and no local e5 in the suite: the dense channel is off, the candidates are BM25's.
vi.mock('../../src/lib/embeddings/embedder.js', () => ({
  EMBED_MODEL: 'test-model',
  EMBED_DIMS: 4,
  embeddingsAvailable: vi.fn(async () => false),
  embedPassages: vi.fn(),
  embedQuery: vi.fn(async () => null),
  isEmbedModelDownloaded: vi.fn(() => false),
}));

let dir: string;
let root: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dc-judged-'));
  root = join(dir, 'proj', '_dream_context');
  home = join(dir, 'home');
  mkdirSync(join(root, 'knowledge', 'patterns'), { recursive: true });
  mkdirSync(home, { recursive: true });
  const doc = (slug: string, body: string) => writeFileSync(join(root, 'knowledge', `${slug}.md`), `---\nname: ${slug}\ndescription: about ${slug}\ntags: []\n---\n## Part\n${body}\n`);
  doc('checkout-flow', 'checkout flow payment provider webhook retries');
  doc('checkout-copy', 'checkout page copy and button text');
  doc('billing-ledger', 'billing ledger payment reconciliation');
  writeFileSync(join(root, 'knowledge', 'patterns', 'checkout-rule.md'), '---\nname: checkout-rule\ndescription: checkout pattern\n---\ncheckout flow payment rule\n');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** A judge stub: answers `text` and records the prompt it was given. */
function stub(text: string, seen: string[] = []): typeof runJudge {
  return async (prompt: string): Promise<JudgeCall> => { seen.push(prompt); return { outcome: 'answered', text, usd: 0.006, ms: 5 }; };
}

describe('the judge prompt and parser', () => {
  it('ships v3 with the helps level split by confidence, every other line unchanged', () => {
    expect(PICK_PROMPT_SHIPPED).toBe(confidencePrompt(PICK_PROMPT_V3));
    expect(PICK_PROMPT_SHIPPED).toContain('0.5 = might help');
    expect(PICK_PROMPT_SHIPPED).toContain('{"<id>": 2|1|0.5, ...}');
    expect(PICK_PROMPT_SHIPPED).not.toContain('  1 = helps: relevant and useful');
    expect(DELIVER_MIN).toBe(1);
  });

  it('puts the previous turn, the turn and each candidate with its needed-when lines', () => {
    const c: JudgeCandidate = { key: 'knowledge/a', relPath: 'knowledge/a.md', title: 'A', description: 'd', section: { heading: 'H', text: 'body' } };
    const p = pickPrompt({ text: 'now', prev: 'before' }, [c], () => ['when x']);
    expect(p).toContain('<previous_turn>\nbefore\n</previous_turn>');
    expect(p).toContain('<turn>\nnow\n</turn>');
    expect(p).toContain('<candidate id="c0">\npath: knowledge/a.md');
    expect(p).toContain('needed when:\n- when x');
    expect(pickPrompt({ text: 'now' }, [c], () => null)).not.toContain('previous_turn');
  });

  it('reads the last id-only object, levels 0.5/1/2 on real ids only, and one reason per id', () => {
    const cands = [0, 1, 2].map((i) => ({ key: `k${i}`, relPath: '', title: '', description: '', section: { heading: '', text: '' } }));
    const text = 'c0: needed because x\nc2: maybe\n{"other": 1}\n{"c0": 2, "c1": 3, "c2": 0.5, "c9": 2}';
    const raw = parsePicks(text)!;
    expect(picksToKeys(raw, cands)).toEqual({ k0: 2, k2: 0.5 });
    expect(parseReasons(text)).toEqual({ c0: 'needed because x', c2: 'maybe' });
    expect(parsePicks('no json here')).toBeNull();
  });

  it('decide: an unusable answer is retried inside the deadline; a timeout or failure has no picks', async () => {
    const cands = [{ key: 'k0', relPath: '', title: '', description: '', section: { heading: '', text: '' } }];
    let n = 0;
    const flaky: typeof runJudge = async () => ({ outcome: 'answered', text: n++ === 0 ? 'garbled' : 'c0: why\n{"c0": 1}', usd: 0.001, ms: 1 });
    const d = await decide('p', cands, Date.now() + 30_000, { run: flaky });
    expect(d).toMatchObject({ outcome: 'picked', picks: { k0: 1 }, reasons: { k0: 'why' } });
    expect(d.usd).toBeCloseTo(0.002);
    expect((await decide('p', cands, Date.now() + 30_000, { run: async () => ({ outcome: 'timeout', text: '', usd: 0, ms: 30_000 }) })).outcome).toBe('judge_timeout');
    expect((await decide('p', cands, Date.now() + 30_000, { run: async () => ({ outcome: 'failed', text: '', usd: 0, ms: 1, cause: 'rate limited' }) }))).toMatchObject({ outcome: 'judge_failed', cause: 'rate limited' });
    expect((await decide('p', cands, Date.now() + 500, { run: stub('{}') })).outcome).toBe('judge_no_time');
  });

  it('runJudge kills a judge that passes its deadline and reports a timeout', async () => {
    const bin = join(dir, 'slow-judge.sh');
    writeFileSync(bin, '#!/bin/sh\nsleep 5\necho \'{"result":"{}"}\'\n');
    chmodSync(bin, 0o755);
    const t0 = Date.now();
    const r = await runJudge('p', Date.now() + 400, { commandFor: (p) => ({ file: bin, args: [], stdin: p }), cwd: dir });
    expect(r.outcome).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('judged recall', () => {
  it('shortlists BM25 candidates (never a pattern), delivers must then confident, drops might-help', async () => {
    const corpus = buildCorpus(root);
    const prompts: string[] = [];
    // c-ids follow the shortlist order; map by the key the prompt shows.
    const run: typeof runJudge = async (prompt) => {
      prompts.push(prompt);
      const ids = new Map<string, string>();
      for (const m of prompt.matchAll(/<candidate id="(c\d+)">\npath: knowledge\/([^\n]+)\.md/g)) ids.set(m[2]!, m[1]!);
      return { outcome: 'answered', text: `${ids.get('checkout-flow')}: the flow\n{"${ids.get('checkout-flow')}": 1, "${ids.get('checkout-copy')}": 2, "${ids.get('billing-ledger')}": 0.5}`, usd: 0.006, ms: 3 };
    };
    const r = await judgedRecall('checkout flow payment', null, corpus, root, { home, judge: { run } });
    expect(r.outcome).toBe('picked');
    expect(r.channel).toBe('none');
    expect(prompts[0]).not.toContain('patterns/checkout-rule');
    expect(r.hits.map((h) => [h.doc.slug, h.level])).toEqual([['checkout-copy', 2], ['checkout-flow', 1]]);
    expect(r.hits[1]!.reason).toBe('the flow');
    const block = renderJudgedBlock(r.hits, 'Haiku · keyword search').join('\n');
    expect(block).toContain('— Memory recall (Haiku · keyword search, top 2) —');
    expect(block).toContain('[knowledge · must] knowledge/checkout-copy.md');
    expect(block).toContain('Why: the flow');
  });

  it('a file already in context is neither shown nor delivered; nothing new skips the judge', async () => {
    const corpus = buildCorpus(root);
    const prompts: string[] = [];
    const inContext = new Set(['knowledge/checkout-flow']);
    const r = await judgedRecall('checkout flow payment', null, corpus, root, { home, inContext, judge: { run: stub('{}', prompts) } });
    expect(r.shown).not.toContain('knowledge/checkout-flow');
    expect(prompts[0]).not.toContain('checkout-flow.md');

    const all = new Set(corpus.map(docKey));
    const calls: string[] = [];
    const skipped = await judgedRecall('checkout flow payment', null, corpus, root, { home, passedOver: all, judge: { run: stub('{}', calls) } });
    expect(skipped).toMatchObject({ outcome: 'nothing_new', wouldSkip: true, usd: 0, shown: [] });
    expect(calls).toHaveLength(0);
    const forced = await judgedRecall('checkout flow payment', null, corpus, root, { home, passedOver: all, forceJudge: true, judge: { run: stub('{}', calls) } });
    expect(forced.wouldSkip).toBe(true);
    expect(calls).toHaveLength(1);
    expect(nothingNew([], new Set(), new Set())).toBe(false);
  });

  it('a turn that matches nothing makes no call', async () => {
    const calls: string[] = [];
    const r = await judgedRecall('zzqx unrelated', null, buildCorpus(root), root, { home, judge: { run: stub('{}', calls) } });
    expect(r.outcome).toBe('no_candidates');
    expect(calls).toHaveLength(0);
  });
});

describe('the session context set', () => {
  it('remembers delivered and passed-over files until SessionStart resets them; the previous turn survives', () => {
    markSessionRecall('s-1', ['knowledge/a'], ['knowledge/a', 'knowledge/b'], home);
    expect(sessionRecall('s-1', home)).toEqual({ inContext: new Set(['knowledge/a']), passedOver: new Set(['knowledge/b']) });
    markSessionRecall('s-1', ['knowledge/b'], [], home);
    expect(sessionRecall('s-1', home)).toEqual({ inContext: new Set(['knowledge/a', 'knowledge/b']), passedOver: new Set() });
    writePrevOwnerTurn('s-1', 'the last thing he said', home);
    resetSessionOnce('s-1', home);
    expect(sessionRecall('s-1', home)).toEqual({ inContext: new Set(), passedOver: new Set() });
    expect(readPrevOwnerTurn('s-1', home)).toBe('the last thing he said');
    expect(sessionRecall('', home).inContext.size).toBe(0);
  });
});

describe('needed-when lines', () => {
  it('the writer covers curated files only, writes the lines once per content and the lookup reads them', async () => {
    const corpus = buildCorpus(root);
    expect(curatedDocs(corpus).some((d) => d.relPath.startsWith('knowledge/patterns/'))).toBe(false);
    const call = vi.fn(async (prompt: string) => {
      const n = (prompt.match(/<file id=/g) ?? []).length;
      return { ok: true, text: JSON.stringify(Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, [`line ${i}`]]))), costUsd: 0.01 };
    });
    const r = await runWhenLinesWriter(root, { home, corpus, call });
    expect(r.written).toBe(curatedDocs(corpus).length);
    const id = vaultIdOf(root);
    expect(pendingDocs(corpus, readWhenLines(id, home))).toEqual([]);
    expect(whenLinesLookup(root, home)(docKey(curatedDocs(corpus)[0]!))).toEqual([expect.stringMatching(/^line \d$/)]);
    await runWhenLinesWriter(root, { home, corpus, call });
    expect(call).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(home, '.dreamcontext', 'when-lines', `${id}.jsonl`), 'utf-8').trim().split('\n')).toHaveLength(r.written);
  });

  it('an answer that leaves an id out leaves that file pending', () => {
    expect(parseWhenAnswer('{"f0": ["a"], "f1": "x"}', 3)).toEqual([['a'], null, null]);
    expect(parseWhenAnswer('nope', 1)).toBeNull();
  });
});
