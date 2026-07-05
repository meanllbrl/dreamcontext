import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  haikuRecall,
  buildCorpusIndex,
  type ClaudeExecutor,
} from '../../src/lib/recall-query-extractor.js';

function jsonBlock(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

function mdFile(name: string, desc: string, tags: string[], body: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${desc}`,
    `tags: [${tags.join(', ')}]`,
    '---',
    body,
  ].join('\n');
}

describe('haikuRecall', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ac-haiku-recall-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpDir, 'knowledge'), { recursive: true });
    mkdirSync(join(tmpDir, 'knowledge', 'features'), { recursive: true });
    mkdirSync(join(tmpDir, 'state'), { recursive: true });

    writeFileSync(join(tmpDir, 'knowledge', 'auth-tokens.md'),
      mdFile('Auth Tokens', 'JWT refresh token rotation', ['security', 'backend'], 'Token rotation details'));
    writeFileSync(join(tmpDir, 'knowledge', 'database-schema.md'),
      mdFile('Database Schema', 'PostgreSQL schema design', ['database'], 'Schema details'));
    writeFileSync(join(tmpDir, 'knowledge', 'features', 'user-dashboard.md'),
      mdFile('User Dashboard', 'Dashboard analytics feature', ['frontend'], 'Dashboard details'));
    writeFileSync(join(tmpDir, 'state', 'fix-auth-bug.md'),
      mdFile('Fix Auth Bug', 'Fix token refresh bug', ['security'], 'Bug fix progress'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns relevant docs with reasons from new format', () => {
    const executor: ClaudeExecutor = () => jsonBlock({
      docs: [
        { key: 'knowledge/auth-tokens', reason: 'User is asking about auth flow' },
        { key: 'task/fix-auth-bug', reason: 'Active bug fix related to auth' },
      ],
      skip: false,
    });

    const result = haikuRecall('how does auth work?', tmpDir, { executor });

    expect(result).not.toBe('skip');
    expect(result).not.toBeNull();
    const hits = result as Exclude<typeof result, 'skip' | null>;
    expect(hits).toHaveLength(2);
    expect(hits[0].doc.slug).toBe('auth-tokens');
    expect(hits[0].doc.type).toBe('knowledge');
    expect(hits[0].snippet).toBe('User is asking about auth flow');
    expect(hits[1].doc.slug).toBe('fix-auth-bug');
    expect(hits[1].snippet).toBe('Active bug fix related to auth');
  });

  it('backward compat: accepts old string array format', () => {
    const executor: ClaudeExecutor = () => jsonBlock({
      docs: ['knowledge/auth-tokens', 'task/fix-auth-bug'],
      skip: false,
    });

    const result = haikuRecall('how does auth work?', tmpDir, { executor });

    const hits = result as Exclude<typeof result, 'skip' | null>;
    expect(hits).toHaveLength(2);
    expect(hits[0].doc.slug).toBe('auth-tokens');
    expect(hits[1].doc.slug).toBe('fix-auth-bug');
  });

  it('returns skip when Haiku says skip', () => {
    const executor: ClaudeExecutor = () => jsonBlock({ docs: [], skip: true });

    const result = haikuRecall('evet tamam', tmpDir, { executor });

    expect(result).toBe('skip');
  });

  it('returns empty array when Haiku returns no docs', () => {
    const executor: ClaudeExecutor = () => jsonBlock({ docs: [], skip: false });

    const result = haikuRecall('quantum blockchain AI', tmpDir, { executor });

    expect(result).toEqual([]);
  });

  it('returns null (fallback) when executor throws', () => {
    const executor: ClaudeExecutor = () => { throw new Error('command not found'); };

    const result = haikuRecall('test', tmpDir, { executor });

    expect(result).toBeNull();
  });

  it('returns null on invalid JSON', () => {
    const executor: ClaudeExecutor = () => 'not json at all';

    const result = haikuRecall('test', tmpDir, { executor });

    expect(result).toBeNull();
  });

  it('ignores unknown doc keys', () => {
    const executor: ClaudeExecutor = () => jsonBlock({
      docs: [
        { key: 'knowledge/auth-tokens', reason: 'relevant' },
        { key: 'knowledge/nonexistent', reason: 'does not exist' },
        { key: 'task/fix-auth-bug', reason: 'relevant' },
      ],
      skip: false,
    });

    const result = haikuRecall('auth stuff', tmpDir, { executor });

    const hits = result as Exclude<typeof result, 'skip' | null>;
    expect(hits).toHaveLength(2);
    expect(hits[0].doc.slug).toBe('auth-tokens');
    expect(hits[1].doc.slug).toBe('fix-auth-bug');
  });

  it('caps at 3 docs even if Haiku returns more', () => {
    const executor: ClaudeExecutor = () => jsonBlock({
      docs: [
        'knowledge/auth-tokens',
        'knowledge/database-schema',
        'feature/user-dashboard',
        'task/fix-auth-bug',
      ],
      skip: false,
    });

    const result = haikuRecall('everything', tmpDir, { executor });

    const hits = result as Exclude<typeof result, 'skip' | null>;
    expect(hits).toHaveLength(3);
  });

  it('handles raw JSON without code block wrapper', () => {
    const executor: ClaudeExecutor = () => JSON.stringify({
      docs: ['knowledge/auth-tokens'],
      skip: false,
    });

    const result = haikuRecall('test', tmpDir, { executor });

    const hits = result as Exclude<typeof result, 'skip' | null>;
    expect(hits).toHaveLength(1);
  });

  it('returns null (BM25 fallback) when corpus is empty', () => {
    const emptyDir = join(tmpdir(), `empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    try {
      const executor = vi.fn<ClaudeExecutor>();
      const result = haikuRecall('test', emptyDir, { executor });
      expect(result).toBeNull();
      expect(executor).not.toHaveBeenCalled();
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('passes corpus index in system prompt to executor', () => {
    const executor = vi.fn<ClaudeExecutor>().mockReturnValue(jsonBlock({ docs: [], skip: false }));

    haikuRecall('my prompt', tmpDir, { executor });

    expect(executor).toHaveBeenCalledTimes(1);
    const [prompt, systemPrompt] = executor.mock.calls[0];
    expect(prompt).toBe('my prompt');
    expect(systemPrompt).toContain('[knowledge] auth-tokens');
    expect(systemPrompt).toContain('[task] fix-auth-bug');
    expect(systemPrompt).toContain('[feature] user-dashboard');
  });
});

describe('buildCorpusIndex', () => {
  it('formats docs as type/slug with description and tags', () => {
    const index = buildCorpusIndex([
      {
        type: 'knowledge', path: '/x', relPath: 'knowledge/auth.md', slug: 'auth',
        title: 'Auth', description: 'Auth overview', tags: ['security', 'backend'],
        body: '', tokens: [], tokenSet: new Set(), termFreq: new Map(),
      },
      {
        type: 'task', path: '/y', relPath: 'state/fix.md', slug: 'fix',
        title: 'Fix', description: '', tags: [],
        body: '', tokens: [], tokenSet: new Set(), termFreq: new Map(),
      },
    ]);

    expect(index).toBe(
      '[knowledge] auth — Auth overview. Tags: security, backend\n' +
      '[task] fix',
    );
  });
});
