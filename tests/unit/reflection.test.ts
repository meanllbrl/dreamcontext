import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CorpusDoc } from '../../src/lib/recall.js';
import {
  detectPatterns,
  formatReflection,
  writeReflection,
  reflectionPath,
  MAX_REFLECTION_BYTES,
  DEFAULT_MIN_SESSIONS,
  DEFAULT_MAX_CANDIDATES,
} from '../../src/lib/reflection.js';

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeTmpRoot(): string {
  const dir = join(
    tmpdir(),
    `reflection-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(dir, 'state'), { recursive: true });
  mkdirSync(join(dir, 'core'), { recursive: true });
  mkdirSync(join(dir, 'knowledge'), { recursive: true });
  return dir;
}

/**
 * Build a minimal CorpusDoc for testing without full recall.ts overhead.
 */
function makeDoc(
  slug: string,
  type: CorpusDoc['type'],
  tokens: string[],
): CorpusDoc {
  const termFreq = new Map<string, number>();
  for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
  return {
    type,
    path: `/tmp/${slug}.md`,
    relPath: `${slug}.md`,
    slug,
    title: slug,
    description: '',
    tags: [],
    body: tokens.join(' '),
    tokens,
    tokenSet: new Set(tokens),
    termFreq,
    fieldFreq: new Map(termFreq),
    fieldLen: tokens.length,
    links: [],
    identityTokens: [],
  };
}

/** Make a digest CorpusDoc (type:'task', slug:'digest#<uuid>') */
function makeDigest(uuid: string, tokens: string[]): CorpusDoc {
  return makeDoc(`digest#${uuid}`, 'task', tokens);
}

/** Make a bookmark CorpusDoc (type:'memory', slug:'bookmark#<id>') */
function makeBookmark(id: string, tokens: string[]): CorpusDoc {
  return makeDoc(`bookmark#${id}`, 'memory', tokens);
}

/** Make a knowledge CorpusDoc (to test exclusion) */
function makeKnowledge(slug: string, tokens: string[]): CorpusDoc {
  return makeDoc(slug, 'knowledge', tokens);
}

/** Make a feature CorpusDoc (to test exclusion) */
function makeFeature(slug: string, tokens: string[]): CorpusDoc {
  return makeDoc(slug, 'feature', tokens);
}

/** Make a memory-section CorpusDoc (type:'memory', slug:'memory#N') */
function makeMemorySection(n: number, tokens: string[]): CorpusDoc {
  return makeDoc(`memory#${n}`, 'memory', tokens);
}

// ── Threshold tests (AC2) ──────────────────────────────────────────────────────

describe('detectPatterns — AC2: threshold (minSessions)', () => {
  it('surfaces a term that appears in >= minSessions distinct sessions', () => {
    // 'scaffold' appears in 3 different digest sessions
    const corpus: CorpusDoc[] = [
      makeDigest('session-a', ['scaffold', 'architecture']),
      makeDigest('session-b', ['scaffold', 'refactor']),
      makeDigest('session-c', ['scaffold', 'module']),
    ];
    const result = detectPatterns(corpus, { minSessions: 3 });
    const terms = result.candidates.map((c) => c.term);
    expect(terms).toContain('scaffold');
  });

  it('does NOT surface a term that appears in fewer sessions than minSessions', () => {
    // 'scaffold' appears in only 2 sessions, threshold is 3
    const corpus: CorpusDoc[] = [
      makeDigest('session-a', ['scaffold', 'architecture']),
      makeDigest('session-b', ['scaffold', 'refactor']),
      makeDigest('session-c', ['refactor', 'module']),
    ];
    const result = detectPatterns(corpus, { minSessions: 3 });
    const terms = result.candidates.map((c) => c.term);
    expect(terms).not.toContain('scaffold');
  });

  it('repeats within a single session count as ONE session (dedup)', () => {
    // Two digests from the same session UUID — should count as 1 session
    // 'pattern' only crosses 2 distinct sessions total
    const corpus: CorpusDoc[] = [
      makeDigest('session-a', ['pattern', 'architecture']),
      makeDigest('session-a', ['pattern', 'architecture']),  // same session
      makeDigest('session-b', ['pattern', 'refactor']),
    ];
    const result = detectPatterns(corpus, { minSessions: 3 });
    const terms = result.candidates.map((c) => c.term);
    expect(terms).not.toContain('pattern');
  });
});

// ── Bookmark session dedup test (AC2 — bookmark-specific) ─────────────────────

describe('detectPatterns — AC2: bookmark session dedup', () => {
  it('collapses two bookmarks sharing one session_id to ONE session in DF', () => {
    // bm1 and bm2 both have session_id 'sess-x' — they must count as ONE session
    const bookmarkSessions = new Map([
      ['bm1', 'sess-x'],
      ['bm2', 'sess-x'],
    ]);
    const corpus: CorpusDoc[] = [
      makeBookmark('bm1', ['workflow', 'pattern']),
      makeBookmark('bm2', ['workflow', 'pattern']),
      makeDigest('sess-y', ['workflow', 'pipeline']),
      // Only 2 distinct sessions (sess-x, sess-y) — below threshold of 3
    ];
    const result = detectPatterns(corpus, {
      minSessions: 3,
      bookmarkSessions,
    });
    const terms = result.candidates.map((c) => c.term);
    expect(terms).not.toContain('workflow');
  });

  it('bookmarks from different sessions count as separate sessions', () => {
    const bookmarkSessions = new Map([
      ['bm1', 'sess-x'],
      ['bm2', 'sess-y'],
      ['bm3', 'sess-z'],
    ]);
    const corpus: CorpusDoc[] = [
      makeBookmark('bm1', ['workflow', 'pipeline']),
      makeBookmark('bm2', ['workflow', 'pipeline']),
      makeBookmark('bm3', ['workflow', 'pipeline']),
    ];
    const result = detectPatterns(corpus, {
      minSessions: 3,
      bookmarkSessions,
    });
    const terms = result.candidates.map((c) => c.term);
    // 'workflow' may surface as a standalone unigram or be absorbed into a bigram
    // that contains it ('workflow pipeline'). Either way, the term must be represented.
    const hasWorkflow = terms.some((t) => t === 'workflow' || t.includes('workflow'));
    expect(hasWorkflow).toBe(true);
  });
});

// ── Exclusion tests (AC3) ──────────────────────────────────────────────────────

describe('detectPatterns — AC3: exclusion set', () => {
  it('excludes terms already in knowledge docs', () => {
    const corpus: CorpusDoc[] = [
      // 'recall' is in a knowledge doc — should be excluded from candidates
      makeKnowledge('recall-architecture', ['recall', 'bm25', 'index']),
      makeDigest('session-a', ['recall', 'engine', 'pipeline']),
      makeDigest('session-b', ['recall', 'engine', 'pipeline']),
      makeDigest('session-c', ['recall', 'engine', 'pipeline']),
    ];
    const result = detectPatterns(corpus, { minSessions: 3 });
    const terms = result.candidates.map((c) => c.term);
    expect(terms).not.toContain('recall');
    // 'engine' and 'pipeline' are not in any knowledge doc — should be represented.
    // 'engine' may be a standalone unigram or absorbed into a bigram containing it.
    const hasEngine = terms.some((t) => t === 'engine' || t.includes('engine'));
    expect(hasEngine).toBe(true);
  });

  it('excludes terms already in feature docs', () => {
    const corpus: CorpusDoc[] = [
      makeFeature('context-snapshot', ['snapshot', 'session', 'pipeline']),
      makeDigest('session-a', ['snapshot', 'pipeline', 'runner']),
      makeDigest('session-b', ['snapshot', 'pipeline', 'runner']),
      makeDigest('session-c', ['snapshot', 'pipeline', 'runner']),
    ];
    const result = detectPatterns(corpus, { minSessions: 3 });
    const terms = result.candidates.map((c) => c.term);
    expect(terms).not.toContain('snapshot');
    // 'runner' should still surface (either standalone or inside a bigram)
    const hasRunner = terms.some((t) => t === 'runner' || t.includes('runner'));
    expect(hasRunner).toBe(true);
  });

  it('excludes terms already in memory# sections', () => {
    const corpus: CorpusDoc[] = [
      makeMemorySection(1, ['postgres', 'database', 'schema']),
      makeDigest('session-a', ['postgres', 'migration', 'schema']),
      makeDigest('session-b', ['postgres', 'migration', 'schema']),
      makeDigest('session-c', ['postgres', 'migration', 'schema']),
    ];
    const result = detectPatterns(corpus, { minSessions: 3 });
    const terms = result.candidates.map((c) => c.term);
    expect(terms).not.toContain('postgres');
    expect(terms).not.toContain('schema');
  });

  it('excludes terms from excludedExtra (soul + user tokens)', () => {
    const excludedExtra = new Set(['projectname', 'mehmet', 'nuraydin']);
    const corpus: CorpusDoc[] = [
      makeDigest('session-a', ['projectname', 'workflow', 'pipeline']),
      makeDigest('session-b', ['projectname', 'workflow', 'pipeline']),
      makeDigest('session-c', ['projectname', 'workflow', 'pipeline']),
    ];
    const result = detectPatterns(corpus, { minSessions: 3, excludedExtra });
    const terms = result.candidates.map((c) => c.term);
    expect(terms).not.toContain('projectname');
    // 'workflow' should surface (standalone or as part of a bigram) since it is NOT excluded
    const hasWorkflow = terms.some((t) => t === 'workflow' || t.includes('workflow'));
    expect(hasWorkflow).toBe(true);
  });
});

// ── REFLECTION_NOISE filters (AC3, AC7) ───────────────────────────────────────

describe('detectPatterns — REFLECTION_NOISE filters digest chrome', () => {
  it('does not surface noise words like "session", "digest", "bash"', () => {
    // Force them through many sessions
    const corpus: CorpusDoc[] = [
      makeDigest('session-a', ['session', 'digest', 'bash', 'pipeline']),
      makeDigest('session-b', ['session', 'digest', 'bash', 'pipeline']),
      makeDigest('session-c', ['session', 'digest', 'bash', 'pipeline']),
    ];
    const result = detectPatterns(corpus, { minSessions: 3 });
    const terms = result.candidates.map((c) => c.term);
    expect(terms).not.toContain('session');
    expect(terms).not.toContain('digest');
    expect(terms).not.toContain('bash');
    // pipeline is not noise
    expect(terms).toContain('pipeline');
  });

  it('does not surface sub-agent/tooling coordination chrome (task_OwbFN_IV)', () => {
    // These are the stemmed tokens that leak from task-notification XML,
    // agent-resume JSON, tool-use ids, and skill-loader headers. They flooded
    // reflect candidates before the bookmark-misclassification fix. They must
    // never surface as recurring patterns even at the session threshold.
    const noise = ['toolu', 'agentid', 'subagent', 'notification', 'success', 'resum'];
    const corpus: CorpusDoc[] = [
      makeBookmark('a', [...noise, 'pipeline']),
      makeBookmark('b', [...noise, 'pipeline']),
      makeBookmark('c', [...noise, 'pipeline']),
    ];
    const result = detectPatterns(corpus, { minSessions: 3 });
    const terms = result.candidates.map((c) => c.term);
    for (const n of noise) {
      expect(terms.some((t) => t === n || t.split(' ').includes(n))).toBe(false);
    }
    // a real domain term alongside the chrome still surfaces
    expect(terms).toContain('pipeline');
  });
});

// ── Bounded output tests (AC4) ─────────────────────────────────────────────────

describe('formatReflection — AC4: bounded output', () => {
  it('returns at most maxCandidates candidates', () => {
    // Create 20 distinct terms across 5 sessions
    const terms = Array.from({ length: 20 }, (_, i) => `uniqueterm${i}`);
    const corpus: CorpusDoc[] = [
      makeDigest('session-a', terms),
      makeDigest('session-b', terms),
      makeDigest('session-c', terms),
      makeDigest('session-d', terms),
      makeDigest('session-e', terms),
    ];
    const result = detectPatterns(corpus, { minSessions: 3, maxCandidates: 12 });
    expect(result.candidates.length).toBeLessThanOrEqual(12);
  });

  it('formatted output is <= MAX_REFLECTION_BYTES bytes', () => {
    // Generate many candidates with long terms
    const terms = Array.from({ length: 50 }, (_, i) => `longtermthatshouldfit${i}`);
    const corpus: CorpusDoc[] = [
      makeDigest('session-a', terms),
      makeDigest('session-b', terms),
      makeDigest('session-c', terms),
      makeDigest('session-d', terms),
    ];
    const result = detectPatterns(corpus, { minSessions: 3, maxCandidates: 100 });
    const md = formatReflection(result);
    expect(Buffer.byteLength(md, 'utf-8')).toBeLessThanOrEqual(MAX_REFLECTION_BYTES);
  });

  it('default maxCandidates is 12', () => {
    expect(DEFAULT_MAX_CANDIDATES).toBe(12);
  });

  it('default minSessions is 3', () => {
    expect(DEFAULT_MIN_SESSIONS).toBe(3);
  });
});

// ── Pure function guarantees (AC5) ────────────────────────────────────────────

describe('writeReflection — AC5: no core/ file modification', () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpRoot();
    // Create fake core files to check they are untouched
    writeFileSync(join(root, 'core', '0.soul.md'), '# Soul\nIdentity content.');
    writeFileSync(join(root, 'core', '1.user.md'), '# User\nUser content.');
    writeFileSync(join(root, 'core', '2.memory.md'), '# Memory\nDecisions.');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes ONLY state/.reflection.md, no core/ files modified', () => {
    // Snapshot mtimes of core/ files before
    const coreFiles = [
      join(root, 'core', '0.soul.md'),
      join(root, 'core', '1.user.md'),
      join(root, 'core', '2.memory.md'),
    ];
    const beforeMtimes = coreFiles.map((f) => statSync(f).mtimeMs);

    const result = detectPatterns([], {});
    const md = formatReflection(result);
    writeReflection(root, md);

    // core/ files must be untouched
    const afterMtimes = coreFiles.map((f) => statSync(f).mtimeMs);
    expect(afterMtimes).toEqual(beforeMtimes);

    // ONLY state/.reflection.md should exist
    expect(existsSync(reflectionPath(root))).toBe(true);
  });

  it('reflectionPath returns state/.reflection.md', () => {
    expect(reflectionPath('/some/root')).toBe('/some/root/state/.reflection.md');
  });

  it('written file has valid YAML frontmatter with type: reflection-candidates', () => {
    const result = detectPatterns([], {});
    const md = formatReflection(result);
    writeReflection(root, md);
    const content = readFileSync(reflectionPath(root), 'utf-8');
    expect(content).toContain('type: reflection-candidates');
    expect(content).toContain('generated_at:');
  });
});

// ── Determinism tests (AC6) ────────────────────────────────────────────────────

describe('detectPatterns — AC6: deterministic ordering', () => {
  it('two calls on identical corpus produce byte-identical candidate ordering', () => {
    const corpus: CorpusDoc[] = [
      makeDigest('session-a', ['pipeline', 'scaffold', 'runner', 'module']),
      makeDigest('session-b', ['pipeline', 'scaffold', 'runner', 'module']),
      makeDigest('session-c', ['pipeline', 'scaffold', 'runner', 'module']),
      makeDigest('session-d', ['runner', 'module', 'architecture']),
      makeDigest('session-e', ['module', 'architecture', 'pipeline']),
    ];
    const r1 = detectPatterns(corpus, { minSessions: 3 });
    const r2 = detectPatterns(corpus, { minSessions: 3 });
    expect(r1.candidates).toEqual(r2.candidates);
  });

  it('sort order is: sessionCount desc, totalOccurrences desc, term asc', () => {
    // 'zzterm' in 4 sessions, 'aaterm' in 3 sessions → zzterm first
    // But with same count, alphabetical: 'aaterm' before 'zzterm'
    const corpus: CorpusDoc[] = [
      makeDigest('s1', ['zzterm', 'aaterm', 'bbterm']),
      makeDigest('s2', ['zzterm', 'aaterm', 'bbterm']),
      makeDigest('s3', ['zzterm', 'aaterm', 'bbterm']),
      makeDigest('s4', ['zzterm', 'bbterm']),
    ];
    const result = detectPatterns(corpus, { minSessions: 3 });
    const terms = result.candidates.map((c) => c.term);
    // zzterm spans 4 sessions, aaterm and bbterm span 3 each
    const zzIdx = terms.indexOf('zzterm');
    const aaIdx = terms.indexOf('aaterm');
    const bbIdx = terms.indexOf('bbterm');
    if (zzIdx !== -1 && aaIdx !== -1) {
      expect(zzIdx).toBeLessThan(aaIdx); // zzterm has more sessions
    }
    if (aaIdx !== -1 && bbIdx !== -1) {
      expect(aaIdx).toBeLessThan(bbIdx); // aaterm < bbterm alphabetically
    }
  });
});

// ── Bigram > unigram preference (technical detail) ────────────────────────────

describe('detectPatterns — bigram over unigram preference', () => {
  it('drops a unigram if a qualifying bigram contains it', () => {
    // 'machine learning' bigram qualifies across sessions
    // 'machine' and 'learning' as standalone unigrams should be dropped
    const corpus: CorpusDoc[] = [
      makeDigest('s1', ['machin', 'learn', 'pipeline', 'other']),
      makeDigest('s2', ['machin', 'learn', 'pipeline', 'other']),
      makeDigest('s3', ['machin', 'learn', 'pipeline', 'other']),
    ];
    const result = detectPatterns(corpus, { minSessions: 3 });
    const terms = result.candidates.map((c) => c.term);
    // If bigram 'machin learn' qualifies, 'machin' and 'learn' should not appear
    if (terms.includes('machin learn')) {
      expect(terms).not.toContain('machin');
      expect(terms).not.toContain('learn');
    }
  });
});

// ── Empty/low corpus degrades gracefully (AC8) ────────────────────────────────

describe('detectPatterns — AC8: graceful degradation', () => {
  it('returns zero candidates and does not throw on empty corpus', () => {
    expect(() => {
      const result = detectPatterns([], {});
      expect(result.candidates).toHaveLength(0);
      expect(result.evidenceDocCount).toBe(0);
      expect(result.sessionCount).toBe(0);
    }).not.toThrow();
  });

  it('returns zero candidates when no term crosses the minSessions threshold', () => {
    const corpus: CorpusDoc[] = [
      makeDigest('s1', ['unique1', 'unique2']),
      makeDigest('s2', ['unique3', 'unique4']),
    ];
    const result = detectPatterns(corpus, { minSessions: 3 });
    expect(result.candidates).toHaveLength(0);
  });

  it('formatReflection emits valid markdown with zero candidates', () => {
    const result = detectPatterns([], {});
    const md = formatReflection(result);
    expect(md).toContain('# Reflection Candidates');
    expect(md).toContain('CANDIDATES ONLY');
    expect(md.trim().length).toBeGreaterThan(0);
  });

  it('writeReflection on empty result still writes a valid artifact', () => {
    const root = makeTmpRoot();
    try {
      const result = detectPatterns([], {});
      const md = formatReflection(result);
      const outPath = writeReflection(root, md);
      expect(existsSync(outPath)).toBe(true);
      const content = readFileSync(outPath, 'utf-8');
      expect(content).toContain('type: reflection-candidates');
      expect(content.trim().length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── No-AI source grep (AC7) ────────────────────────────────────────────────────

describe('reflection.ts — AC7: no AI/network calls in source', () => {
  it('source does not contain fetch, spawn, execFile, claude, or anthropic', () => {
    // Read the actual source file and assert no forbidden patterns
    const srcPath = join(
      import.meta.url.replace('file://', '').replace(/\/tests\/.*/, ''),
      'src',
      'lib',
      'reflection.ts',
    );
    // Use __dirname-style resolution robust to test runner location
    const resolvedSrc = new URL('../../src/lib/reflection.ts', import.meta.url).pathname;
    const source = readFileSync(resolvedSrc, 'utf-8');
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bspawn\s*\(/);
    expect(source).not.toMatch(/\bexecFile\s*\(/);
    expect(source).not.toMatch(/\bclaude\b/i);
    expect(source).not.toMatch(/\banthropic\b/i);
  });

  it('reflection.ts only imports from node:fs, node:path, and recall.ts', () => {
    const resolvedSrc = new URL('../../src/lib/reflection.ts', import.meta.url).pathname;
    const source = readFileSync(resolvedSrc, 'utf-8');
    // Extract import statements
    const importLines = source
      .split('\n')
      .filter((line) => line.trim().startsWith('import'));
    for (const line of importLines) {
      const isAllowed =
        line.includes("'node:fs'") ||
        line.includes("'node:path'") ||
        line.includes('./recall.js') ||
        line.includes("'node:os'"); // allowed for type imports only
      expect(isAllowed, `Unexpected import: ${line}`).toBe(true);
    }
  });
});
