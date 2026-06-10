import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildCorpus, bm25Search } from '../../src/lib/recall.js';
import { buildDigest, writeDigest } from '../../src/lib/session-digest.js';
import { detectSalience } from '../../src/lib/salience.js';
import type { DistilledSection } from '../../src/cli/commands/transcript.js';

/**
 * STEP 3 — prove the FULL continuous-capture loop end-to-end:
 *   distilled session → digest + bookmarks on disk → next-session recall.
 *
 * This is NOT a test of the isolated pieces (those live in session-digest.test.ts
 * / salience.test.ts). It runs the REAL pipeline against a temp context root and
 * asserts that a decision made in "this" session is recallable in the "next" one.
 */

function makeTmpRoot(): string {
  const dir = join(tmpdir(), `cap-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, 'state'), { recursive: true });
  return dir;
}

/**
 * A realistic distilled session: a clear architectural decision about WHERE the
 * auth token lives, plus a user correction. Mirrors what distillTranscript emits.
 */
function authDecisionSession(): DistilledSection {
  return {
    userMessages: [
      'No, localStorage is XSS-exposed — store the auth token in an httpOnly cookie instead.',
    ],
    agentDecisions: [
      '[thinking] weighing where the session token should live for security.',
      'Decided to switch the auth token store from localStorage to httpOnly cookies.',
    ],
    codeChanges: [
      'EDIT src/auth/token-store.ts\n--- OLD ---\nlocalStorage.setItem(token)\n--- NEW ---\nsetCookie(token, { httpOnly: true })',
    ],
    errors: [],
    bookmarks: [],
  };
}

/**
 * Persist detected salient moments into a temp `.sleep.json` the SAME shape the
 * bookmark command writes (id/message/salience/created_at/session_id/task_slug),
 * so loadBookmarkDocs picks them up exactly as in production.
 */
function writeBookmarksFromSalience(root: string, sessionId: string): void {
  const moments = detectSalience(authDecisionSession());
  const bookmarks = moments.map((m, i) => ({
    id: `bm_${sessionId}_${i}`,
    message: m.message,
    salience: m.salience,
    created_at: '2026-06-01T10:00:00.000Z',
    session_id: sessionId,
    task_slug: null,
  }));
  writeFileSync(
    join(root, 'state', '.sleep.json'),
    JSON.stringify({ bookmarks }),
    'utf-8',
  );
}

describe('continuous-capture end-to-end loop (STEP 3)', () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('a decision captured this session is recalled next session (digest path)', () => {
    // SESSION 1: distill → digest → write to disk.
    const md = buildDigest(authDecisionSession());
    writeDigest(root, 'sess-auth-1', md);

    // SESSION 2: build the corpus fresh and recall.
    const corpus = buildCorpus(root);
    const hits = bm25Search('where do we store the auth token', corpus, 5);

    const slugs = hits.map((h) => h.doc.slug);
    expect(slugs).toContain('digest#sess-auth-1');
    // The digest is a capture → penalised, but with no curated competitor in
    // this temp corpus it must still surface near the top.
    expect(slugs.slice(0, 3)).toContain('digest#sess-auth-1');
  });

  it('the same decision is also captured as a bookmark and recalled', () => {
    writeBookmarksFromSalience(root, 'sess-auth-1');

    const corpus = buildCorpus(root);
    const hits = bm25Search('where do we store the auth token', corpus, 5);

    const bookmarkSlugs = hits.map((h) => h.doc.slug).filter((s) => s.startsWith('bookmark#'));
    expect(bookmarkSlugs.length).toBeGreaterThan(0);
    // The decision text ("switch the auth token store … to httpOnly cookies")
    // must be the bookmark body that surfaces.
    const top = hits.find((h) => h.doc.slug.startsWith('bookmark#'));
    expect(top?.doc.body.toLowerCase()).toContain('auth token store');
  });

  it('digest AND bookmark both carry the decision and both are recallable together', () => {
    writeDigest(root, 'sess-auth-1', buildDigest(authDecisionSession()));
    writeBookmarksFromSalience(root, 'sess-auth-1');

    // Unrelated filler docs so IDF is meaningful. Without them every doc in the
    // tmp corpus carries the same auth decision, and the raw-score floor
    // assertion below measures an IDF artifact of a 4-near-duplicate corpus
    // rather than hook behavior. (The original version passed only because the
    // v2 stemmer failed to match `cookie`↔`cookies`, keeping IDF inflated.)
    mkdirSync(join(root, 'knowledge'), { recursive: true });
    const filler = [
      ['deploy-pipeline', 'CI deploy pipeline retries and rollback strategy for the build.'],
      ['design-tokens', 'Color palette and spacing scale for the dashboard UI components.'],
      ['db-indexing', 'Postgres composite index planning for the reporting queries.'],
      ['release-notes', 'Changelog conventions and release notes formatting guide.'],
    ] as const;
    for (const [slug, body] of filler) {
      writeFileSync(
        join(root, 'knowledge', `${slug}.md`),
        `---\nname: ${slug}\ndescription: ${body}\n---\n\n${body}\n`,
        'utf-8',
      );
    }

    const corpus = buildCorpus(root);
    const hits = bm25Search('switch auth token store httpOnly cookies', corpus, 10);
    const slugs = hits.map((h) => h.doc.slug);

    expect(slugs).toContain('digest#sess-auth-1');
    expect(slugs.some((s) => s.startsWith('bookmark#'))).toBe(true);

    // Decoupling sanity: the raw `score` the hook gates on is untouched by the
    // capture penalty — a clear keyword match must clear the hook's 2.0 floor.
    const captureHit = hits.find((h) => h.doc.capture);
    expect(captureHit).toBeDefined();
    expect(captureHit!.score).toBeGreaterThanOrEqual(2.0);
  });
});
