import { describe, it, expect } from 'vitest';

import { tokenize, stemToken, bm25Search, type CorpusDoc } from '../../src/lib/recall.js';

// ── B4 regression: conservative EN suffix strip + TR suffix folding in
//    tokenize/stemToken, and query-time synonym expansion (rankScore). ──
//
// IMPORTANT (tested = real behavior, not the spec's illustrative example):
//   The spec suggested `databases`/`database` should share a token. They DO NOT
//   under the shipped stemmer: `databases` → `databas` (the EN `-es` strip fires,
//   len>4) while `database` ends in `-e` and is left untouched → `database`.
//   So we lock in pairs that ACTUALLY fold to a shared stem by reading stemEn:
//   `decisions`→`decision`, `hooks`→`hook`, `tasks`→`task`, `searches`→`search`.

function mkDoc(opts: {
  slug: string;
  title?: string;
  body?: string;
}): CorpusDoc {
  const { slug, title = '', body = '' } = opts;
  const allText = [title, body].join(' ');
  const tokens = tokenize(allText);
  const termFreq = new Map<string, number>();
  for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
  return {
    type: 'knowledge',
    path: `/x/${slug}.md`,
    relPath: `knowledge/${slug}.md`,
    slug,
    title,
    body,
    description: '',
    tags: [],
    tokens,
    tokenSet: new Set(tokens),
    termFreq,
    fieldFreq: new Map(termFreq),
    fieldLen: tokens.length,
    links: [],
    identityTokens: tokenize(`${slug} ${title}`),
  };
}

describe('tokenize B4: English plural/inflection folding', () => {
  it('folds a real EN plural to the same token as its singular (decisions/decision)', () => {
    const [plural] = tokenize('decisions');
    const [singular] = tokenize('decision');
    expect(plural).toBe(singular);
  });

  it('folds hooks → hook (matching the synonym map base form)', () => {
    expect(tokenize('hooks')[0]).toBe(tokenize('hook')[0]);
    expect(tokenize('hooks')[0]).toBe('hook');
  });

  it('is conservative: short tokens (len <= 4) are NOT stripped', () => {
    // stemEn early-returns for length <= 4, so a short word keeps its trailing -s.
    expect(stemToken('cats')).toBe('cats');
  });
});

describe('tokenize B4: Turkish agglutinative suffix folding', () => {
  it('folds a TR plural to its stem (kararlar → karar)', () => {
    expect(tokenize('kararlar')[0]).toBe('karar');
    expect(tokenize('kararlar')[0]).toBe(tokenize('karar')[0]);
  });

  it('folds a TR-suffixed loanword to its stem (hooklar → hook)', () => {
    // `hooklar` strips the `lar` plural suffix → `hook`, matching the EN token.
    expect(tokenize('hooklar')[0]).toBe('hook');
  });
});

describe('bm25Search B4: query-time synonym expansion surfaces paraphrases', () => {
  it('a query "auth" surfaces a doc whose body only says "authentication"', () => {
    const docs = [
      mkDoc({
        slug: 'auth-doc',
        title: 'Login flow',
        body: 'The authentication subsystem validates credentials and issues sessions.',
      }),
      mkDoc({
        slug: 'widgets-doc',
        title: 'Widgets',
        body: 'Widgets render colorful charts and graphs for dashboards.',
      }),
    ];
    // 'auth' is NOT a literal token in the auth-doc body, but the synonym group
    // [auth, authentication, …] bridges it at rank time.
    const hits = bm25Search('auth', docs, 5, { now: new Date('2026-06-01T00:00:00Z') });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].doc.slug).toBe('auth-doc');
  });

  it('synonym contribution feeds rankScore but the doc still scores raw .score === 0 for a pure-synonym match', () => {
    // The synonym bridge must NOT leak into the raw `.score` the hook thresholds.
    // 'auth' has zero literal occurrences in the body, so the flat BM25 `.score`
    // is 0 even though the doc is surfaced (rankScore > 0 via the synonym term).
    const docs = [
      mkDoc({
        slug: 'auth-doc',
        title: 'Login flow',
        body: 'The authentication subsystem validates credentials and issues sessions.',
      }),
    ];
    const hits = bm25Search('auth', docs, 5, { now: new Date('2026-06-01T00:00:00Z') });
    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBe(0);          // raw flat BM25: no literal 'auth'
    expect(hits[0].rankScore).toBeGreaterThan(0); // surfaced via synonym contribution
  });
});
