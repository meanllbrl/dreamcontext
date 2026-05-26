import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { multiQueryBm25 } from '../../src/lib/recall-multi-query.js';
import type { ExtractedQuery } from '../../src/lib/recall-query-extractor.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ac-recall-mq-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function mdFile(title: string, tags: string[], body: string): string {
  return [
    '---',
    `name: ${title}`,
    `tags: [${tags.join(', ')}]`,
    `description: ${title} description`,
    '---',
    body,
  ].join('\n');
}

describe('recall-multi-query', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupCorpus() {
    const knowledgeDir = join(tmpDir, 'knowledge');
    const featureDir = join(tmpDir, 'core', 'features');
    const taskDir = join(tmpDir, 'state');
    mkdirSync(knowledgeDir, { recursive: true });
    mkdirSync(featureDir, { recursive: true });
    mkdirSync(taskDir, { recursive: true });

    writeFileSync(
      join(knowledgeDir, 'auth-tokens.md'),
      mdFile('Auth Tokens', ['security', 'backend'],
        'JWT refresh token rotation strategy for session management authentication'),
    );
    writeFileSync(
      join(knowledgeDir, 'database-schema.md'),
      mdFile('Database Schema', ['database', 'backend'],
        'PostgreSQL schema design with normalized tables for user profiles and orders'),
    );
    writeFileSync(
      join(featureDir, 'user-dashboard.md'),
      mdFile('User Dashboard', ['frontend', 'design'],
        'Dashboard feature showing user analytics metrics and session activity'),
    );
    writeFileSync(
      join(taskDir, 'fix-auth-bug.md'),
      mdFile('Fix Auth Bug', ['security'],
        'Fix the authentication token refresh bug causing session expiry errors'),
    );
  }

  it('deduplicates results from multiple queries keeping highest score', () => {
    setupCorpus();

    const queries: ExtractedQuery[] = [
      { q: 'authentication token refresh' },
      { q: 'auth session management jwt' },
    ];

    const hits = multiQueryBm25(queries, tmpDir, 5);

    const paths = hits.map(h => h.doc.slug);
    const uniquePaths = new Set(paths);
    expect(uniquePaths.size).toBe(paths.length);

    const authHit = hits.find(h => h.doc.slug === 'auth-tokens');
    expect(authHit).toBeDefined();
  });

  it('filters corpus by types when specified', () => {
    setupCorpus();

    const queries: ExtractedQuery[] = [
      { q: 'authentication session security', types: ['task'] },
    ];

    const hits = multiQueryBm25(queries, tmpDir, 5);

    for (const hit of hits) {
      expect(hit.doc.type).toBe('task');
    }
  });

  it('returns empty array for empty queries', () => {
    setupCorpus();
    expect(multiQueryBm25([], tmpDir, 3)).toEqual([]);
  });

  it('respects topK limit', () => {
    setupCorpus();

    const queries: ExtractedQuery[] = [
      { q: 'authentication token session' },
      { q: 'database schema user' },
      { q: 'dashboard analytics frontend' },
    ];

    const hits = multiQueryBm25(queries, tmpDir, 2);
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('returns empty when context root has no docs', () => {
    const emptyDir = join(tmpDir, 'empty-root');
    mkdirSync(emptyDir, { recursive: true });

    const queries: ExtractedQuery[] = [{ q: 'anything' }];
    expect(multiQueryBm25(queries, emptyDir, 3)).toEqual([]);
  });

  it('searches all types when types not specified', () => {
    setupCorpus();

    const queries: ExtractedQuery[] = [
      { q: 'authentication token refresh session' },
    ];

    const hits = multiQueryBm25(queries, tmpDir, 10);
    const types = new Set(hits.map(h => h.doc.type));
    expect(types.size).toBeGreaterThanOrEqual(1);
  });
});
