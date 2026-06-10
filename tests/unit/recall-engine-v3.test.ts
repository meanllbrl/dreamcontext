import { describe, it, expect } from 'vitest';

import { bm25Search, stemToken, tokenize, CHANGELOG_RANK_FACTOR, type CorpusDoc } from '../../src/lib/recall.js';
import { expandQueryTerms, DIRECTED_BRIDGES } from '../../src/lib/recall-synonyms.js';

// ── v3 engine regression locks ───────────────────────────────────────────────
// 1. Two-hop conservative Turkish stemming (possessive + case stacking).
// 2. Turkish question/filler stopwords.
// 3. DIRECTED synonym bridges (paraphrase → canonical, never the reverse).
// 4. CHANGELOG_RANK_FACTOR: canonical-first on near-ties, rankScore ONLY.
//
// All tuned on eval/gold.jsonl (train) and validated on eval/gold-heldout.jsonl
// (authored blind). See eval/RESULTS.md for the measured before/after.

function mkDoc(opts: {
  slug: string;
  title?: string;
  body?: string;
  type?: CorpusDoc['type'];
  updatedAt?: string;
}): CorpusDoc {
  const { slug, title = '', body = '' } = opts;
  const tokens = tokenize([title, body].join(' '));
  const termFreq = new Map<string, number>();
  for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
  return {
    type: opts.type ?? 'knowledge',
    path: `/x/${slug}.md`,
    relPath: `knowledge/${slug}.md`,
    slug,
    title,
    description: '',
    tags: [],
    body,
    tokens,
    tokenSet: new Set(tokens),
    termFreq,
    fieldFreq: new Map(termFreq),
    fieldLen: tokens.length,
    updatedAt: opts.updatedAt,
    links: [],
    identityTokens: [],
  };
}

describe('v3 Turkish stemming: two-hop suffix folding', () => {
  it('folds possessive + locative stacks down to the lemma', () => {
    expect(stemToken('sunucusunda')).toBe('sunucu');   // sunucu-su-nda
    expect(stemToken('sunucusu')).toBe('sunucu');      // sunucu-su
    // seviye-ler-i: folds to the SAME stem as the bare form (final-e fold is
    // applied symmetrically after a TR strip, so index and query stay aligned).
    expect(stemToken('seviyeleri')).toBe(stemToken('seviye'));
    expect(stemToken('açıkları')).toBe('açık');        // açık-lar-ı
    expect(stemToken('oturumdaki')).toBe('oturum');    // -daki relative
    expect(stemToken('kutusunun')).toBe('kutu');       // kutu-su-nun compound
    expect(stemToken('başında')).toBe('baş');          // -ında locative
  });

  it('keeps short tokens and unsuffixed words intact', () => {
    expect(stemToken('veri')).toBe('veri');
    expect(stemToken('uyku')).toBe('uyku');
    expect(stemToken('baş')).toBe('baş');
  });

  it('never double-mangles plain English tokens (second hop gated on first)', () => {
    expect(stemToken('data')).toBe('data');
    expect(stemToken('mini')).toBe('mini');
    expect(stemToken('often')).toBe('often');
    expect(stemToken('style')).toBe('style');
    expect(stemToken('sessions')).toBe('session');
  });

  it('merges EN singular/plural/verb families onto one stem (v3 -e fold fix)', () => {
    // The v2 `-es` rule left these families permanently split — a query for
    // "database" could never match a doc that only said "databases".
    expect(stemToken('databases')).toBe(stemToken('database'));
    expect(stemToken('releases')).toBe(stemToken('release'));
    expect(stemToken('features')).toBe(stemToken('feature'));
    expect(stemToken('updates')).toBe(stemToken('update'));
    expect(stemToken('created')).toBe(stemToken('create'));
    expect(stemToken('consolidating')).toBe(stemToken('consolidate'));
  });
});

describe('v3 Turkish question/filler stopwords', () => {
  it('drops question words that carry no content signal', () => {
    const toks = tokenize('dashboard sunucusu güvenlik açıkları nelerdi');
    expect(toks).not.toContain('nelerdi');
    expect(toks).toContain('sunucu');
    expect(toks).toContain('güvenlik');
    expect(toks).toContain('açık');
  });

  it('drops nasıl / hangi / şey across inflections listed', () => {
    const toks = tokenize('bu şey nasıl çalışıyor hangi dosyada');
    expect(toks).not.toContain('nasıl');
    expect(toks).not.toContain('hangi');
    expect(toks).not.toContain('şey');
  });
});

describe('v3 directed synonym bridges', () => {
  it('paraphrase term expands INTO canonical vocabulary', () => {
    const exp = expandQueryTerms(['fold'].map(stemToken), stemToken);
    expect(exp.has(stemToken('consolidation'))).toBe(true);
    expect(exp.has(stemToken('sleep'))).toBe(true);
  });

  it('canonical term does NOT expand back into the paraphrase term', () => {
    const exp = expandQueryTerms(['sleep'].map(stemToken), stemToken);
    expect(exp.has(stemToken('fold'))).toBe(false);
    expect(exp.has(stemToken('promote'))).toBe(false);
    // bidirectional group members still expand:
    expect(exp.has(stemToken('consolidation'))).toBe(true);
  });

  it('TR bridge keys are authored in the form the stemmer produces', () => {
    // `dizini` (accusative) is not stripped by the conservative stemmer, so the
    // bridge lists it as its own surface form — verify the pipeline-folded form
    // of every bridge key actually resolves.
    const folded = stemToken('dizini');
    expect(DIRECTED_BRIDGES[folded]).toBeDefined();
    const exp = expandQueryTerms([folded], stemToken);
    expect(exp.has(stemToken('vault'))).toBe(true);
    // Inflected query word reaches the canonical concept end-to-end:
    const expTr = expandQueryTerms(tokenize('uyku konsolidasyonu seviyeleri'), stemToken);
    expect(expTr.has(stemToken('sleep'))).toBe(true);
    expect(expTr.has(stemToken('level'))).toBe(true);
  });
});

describe('v3 CHANGELOG_RANK_FACTOR: canonical-first on near-ties', () => {
  const BODY = 'loopback bind csrf guard cors lockdown for the dashboard server security';
  const QUERY = 'dashboard server security csrf';

  it('ranks the canonical doc above an identical changelog entry', () => {
    const docs = [
      mkDoc({ slug: 'changelog#x', title: 'server security', body: BODY, type: 'changelog' }),
      mkDoc({ slug: 'dashboard-server-security', title: 'server security', body: BODY, type: 'knowledge' }),
    ];
    const hits = bm25Search(QUERY, docs, 2);
    expect(hits[0].doc.type).toBe('knowledge');
    expect(hits[1].doc.type).toBe('changelog');
  });

  it('never touches the raw `.score` (decoupling invariant)', () => {
    const asChangelog = mkDoc({ slug: 'a', title: 'server security', body: BODY, type: 'changelog' });
    const asKnowledge = mkDoc({ slug: 'a', title: 'server security', body: BODY, type: 'knowledge' });
    const [hitC] = bm25Search(QUERY, [asChangelog], 1);
    const [hitK] = bm25Search(QUERY, [asKnowledge], 1);
    expect(hitC.score).toBeCloseTo(hitK.score, 10);
    expect(hitC.rankScore).toBeCloseTo(hitK.rankScore * CHANGELOG_RANK_FACTOR, 10);
  });

  it('a changelog with a clearly stronger match still outranks a weak canonical doc', () => {
    const docs = [
      mkDoc({ slug: 'changelog#strong', title: 'dashboard server security csrf', body: BODY, type: 'changelog' }),
      mkDoc({ slug: 'weak-doc', title: 'unrelated notes', body: 'mentions the dashboard once', type: 'knowledge' }),
    ];
    const hits = bm25Search(QUERY, docs, 2);
    expect(hits[0].doc.type).toBe('changelog');
  });
});
